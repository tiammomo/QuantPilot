import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  getQuantCapability,
  isQuantCapabilityId,
} from '@/lib/quant/capabilities';
import type {
  CompileMoAgentSkillsOptions,
  CompileMoAgentSkillsResult,
  CompiledMoAgentSkill,
  MoAgentSkillLockEntry,
  MoAgentSkillRegistryEntry,
  MoAgentSkillsInstallReceipt,
  MoAgentSkillsLock,
  MoAgentSkillsRegistry,
} from './types';

const execFileAsync = promisify(execFile);
const DEFAULT_CONTEXT_BUDGET = 24_000;
const MIN_CONTEXT_BUDGET = 256;
const COMPATIBILITY_STATE_DIRECTORY = '.claude';
const MOAGENT_DIRECTORY = '.moagent';

type LoadedSkill = {
  registry: MoAgentSkillRegistryEntry;
  lock: MoAgentSkillLockEntry;
  requestedIds: string[];
  markdown: string;
  source: 'source' | 'package';
  sourceDirectory: string | null;
  packagePath: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`MoAgent Skills 配置无效：${label} 必须是非空字符串。`);
  }
}

function resolveFromRoot(root: string, candidate: string): string {
  return path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
}

function assertInside(parent: string, candidate: string, label: string): void {
  const relative = path.relative(parent, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`MoAgent Skills ${label} 必须位于 repositoryRoot 内：${candidate}`);
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `MoAgent Skills ${label} 不可用：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseRegistry(value: unknown): MoAgentSkillsRegistry {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.coreSkills)) {
    throw new Error('MoAgent Skills registry schema 无效。');
  }
  if (!isRecord(value.policy)) {
    throw new Error('MoAgent Skills registry 缺少 policy。');
  }

  const seen = new Set<string>();
  for (const [index, raw] of value.coreSkills.entries()) {
    if (!isRecord(raw)) {
      throw new Error(`MoAgent Skills registry coreSkills[${index}] 无效。`);
    }
    assertString(raw.id, `coreSkills[${index}].id`);
    assertString(raw.name, `coreSkills[${index}].name`);
    assertString(raw.version, `coreSkills[${index}].version`);
    assertString(raw.boundary, `coreSkills[${index}].boundary`);
    if (!['stable', 'planned', 'deprecated'].includes(String(raw.status))) {
      throw new Error(`MoAgent Skills registry 中 ${raw.id} 的 status 无效。`);
    }
    if (seen.has(raw.id)) {
      throw new Error(`MoAgent Skills registry 包含重复 ID：${raw.id}。`);
    }
    seen.add(raw.id);
  }
  return value as unknown as MoAgentSkillsRegistry;
}

function parseLock(value: unknown): MoAgentSkillsLock {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.skills)) {
    throw new Error('MoAgent Skills lock schema 无效。');
  }
  return value as unknown as MoAgentSkillsLock;
}

async function listSourceFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue;
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`MoAgent Skill 源目录不允许符号链接：${absolute}`);
      }
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) output.push(absolute);
    }
  }
  await visit(directory);
  return output.sort();
}

async function hashSkillSource(directory: string): Promise<{ hash: string; fileCount: number }> {
  const files = await listSourceFiles(directory);
  const hash = createHash('sha256');
  for (const filePath of files) {
    hash.update(path.relative(directory, filePath).replaceAll(path.sep, '/'));
    hash.update('\0');
    hash.update(await fs.readFile(filePath));
    hash.update('\0');
  }
  return { hash: hash.digest('hex'), fileCount: files.length };
}

async function hashFile(filePath: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

async function readSkillMarkdownFromPackage(packagePath: string, skillId: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'tar',
      ['-xOzf', packagePath, `${skillId}/SKILL.md`],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    if (!stdout.trim()) throw new Error('SKILL.md 为空');
    return stdout;
  } catch (error) {
    throw new Error(
      `MoAgent Skill ${skillId} 无法从已验证安装包读取：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function stripFrontMatter(markdown: string): string {
  return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
}

function adaptSkillTextForMoAgent(value: string): string {
  return value
    .replaceAll('.claude/skills/', '.moagent/skills/')
    .replaceAll('mcp__QuantPilotImage__quant_extract_uploaded_image', 'quant_extract_uploaded_image')
    .replaceAll(
      'mcp__MiniMax__understand_image',
      '可选视觉识别工具（仅在 MoAgent ToolRegistry 显式注册时）',
    );
}

function sectionPriority(title: string): number {
  if (/禁止|安全|只读|边界/.test(title)) return 100;
  if (/契约|门禁|原则|质量|规则/.test(title)) return 95;
  if (/平台预取|自动修复/.test(title)) return 92;
  if (/标准流程|标准工作流|工作流|后续衔接/.test(title)) return 85;
  if (/何时必须|何时使用|必须使用/.test(title)) return 80;
  return 20;
}

function prioritizedMarkdown(markdown: string): string {
  const body = stripFrontMatter(markdown);
  const heading = /^##\s+(.+)$/gm;
  const matches = Array.from(body.matchAll(heading));
  if (matches.length === 0) return body;

  const preamble = body.slice(0, matches[0].index).trim();
  const sections = matches.map((match, index) => ({
    index,
    title: match[1].trim(),
    text: body.slice(match.index, matches[index + 1]?.index ?? body.length).trim(),
  }));
  sections.sort((left, right) =>
    sectionPriority(right.title) - sectionPriority(left.title) || left.index - right.index,
  );
  return [preamble, ...sections.map((section) => section.text)].filter(Boolean).join('\n\n');
}

function clipWithNotice(text: string, maxChars: number, notice: string): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  if (maxChars <= notice.length + 2) {
    return { text: `${text.slice(0, Math.max(0, maxChars - 1))}…`, truncated: true };
  }
  const available = maxChars - notice.length - 2;
  const prefix = text.slice(0, available).replace(/\s+\S*$/, '').trimEnd();
  return { text: `${prefix}\n\n${notice}`, truncated: true };
}

function compactList(label: string, values: string[] | undefined): string | null {
  return values?.length ? `${label}：${values.map(adaptSkillTextForMoAgent).join('；')}` : null;
}

function compileSkillBlock(skill: LoadedSkill, maxChars: number): { text: string; truncated: boolean } {
  const metadata = [
    `## ${skill.registry.id} — ${skill.registry.name}`,
    `版本/状态：v${skill.registry.version} / ${skill.registry.status}`,
    `职责边界：${adaptSkillTextForMoAgent(skill.registry.boundary)}`,
    compactList('输入', skill.registry.inputs),
    compactList('输出', skill.registry.outputs),
    compactList('允许接口', skill.registry.endpoints),
    compactList('硬性验收', skill.registry.validation),
  ].filter((line): line is string => Boolean(line)).join('\n');
  const markdown = prioritizedMarkdown(skill.markdown);
  const full = `${metadata}\n\n### Skill 指令（安全、契约与流程优先）\n${markdown}`;
  return clipWithNotice(
    full,
    maxChars,
    `[MoAgent 截断说明] ${skill.registry.id} 原始指令共 ${skill.markdown.length} 字符；受总上下文预算限制，仅保留以上高优先级内容。`,
  );
}

async function loadSkill(params: {
  root: string;
  sourceSkillsPath: string;
  registry: MoAgentSkillRegistryEntry;
  lock: MoAgentSkillLockEntry | undefined;
  requestedIds: string[];
}): Promise<LoadedSkill> {
  const { root, registry, requestedIds } = params;
  const lock = params.lock;
  if (!lock) throw new Error(`MoAgent Skills lock 缺少 ${registry.id}。`);
  if (lock.version !== registry.version) {
    throw new Error(
      `MoAgent Skill ${registry.id} 版本不一致：registry=${registry.version}，lock=${lock.version ?? 'missing'}。`,
    );
  }
  if (!lock.sourceSha256 && !lock.packageSha256) {
    throw new Error(`MoAgent Skill ${registry.id} 在 lock 中缺少完整性哈希。`);
  }

  const sourceDirectory = path.join(params.sourceSkillsPath, registry.id);
  const sourceExists = await pathExists(sourceDirectory);
  let sourceMarkdown: string | null = null;
  if (sourceExists) {
    const sourceStat = await fs.lstat(sourceDirectory);
    if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
      throw new Error(`MoAgent Skill ${registry.id} 源路径必须是普通目录且不能是符号链接。`);
    }
    assertInside(root, await fs.realpath(sourceDirectory), `${registry.id} source directory`);
    if (!lock.sourceSha256) throw new Error(`MoAgent Skill ${registry.id} 缺少 sourceSha256。`);
    const actual = await hashSkillSource(sourceDirectory);
    if (actual.hash !== lock.sourceSha256) {
      throw new Error(`MoAgent Skill ${registry.id} 源目录哈希不一致，拒绝编译。`);
    }
    if (typeof lock.fileCount === 'number' && actual.fileCount !== lock.fileCount) {
      throw new Error(`MoAgent Skill ${registry.id} 源文件数量与 lock 不一致，拒绝编译。`);
    }
    sourceMarkdown = await fs.readFile(path.join(sourceDirectory, 'SKILL.md'), 'utf8').catch((error) => {
      throw new Error(
        `MoAgent Skill ${registry.id} 缺少 SKILL.md：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  const packageCandidate = lock.packagePath
    ? resolveFromRoot(root, lock.packagePath)
    : path.resolve(root, COMPATIBILITY_STATE_DIRECTORY, 'skill-packages', `${registry.id}.tgz`);
  assertInside(root, packageCandidate, 'packagePath');
  const packageExists = await pathExists(packageCandidate);
  if (packageExists) {
    const packageStat = await fs.lstat(packageCandidate);
    if (packageStat.isSymbolicLink() || !packageStat.isFile()) {
      throw new Error(`MoAgent Skill ${registry.id} packagePath 必须是普通文件且不能是符号链接。`);
    }
    if (!lock.packageSha256) throw new Error(`MoAgent Skill ${registry.id} 缺少 packageSha256。`);
    if ((await hashFile(packageCandidate)) !== lock.packageSha256) {
      throw new Error(`MoAgent Skill ${registry.id} 安装包哈希不一致，拒绝编译。`);
    }
  }

  if (sourceMarkdown) {
    return {
      registry,
      lock,
      requestedIds,
      markdown: adaptSkillTextForMoAgent(sourceMarkdown),
      source: 'source',
      sourceDirectory,
      packagePath: packageExists ? packageCandidate : null,
    };
  }
  if (!packageExists) {
    throw new Error(`MoAgent Skill ${registry.id} 既没有可验证源目录，也没有可验证安装包。`);
  }
  return {
    registry,
    lock,
    requestedIds,
    markdown: adaptSkillTextForMoAgent(
      await readSkillMarkdownFromPackage(packageCandidate, registry.id),
    ),
    source: 'package',
    sourceDirectory: null,
    packagePath: packageCandidate,
  };
}

async function assertSafePackageEntries(packagePath: string, skillId: string): Promise<void> {
  const { stdout } = await execFileAsync('tar', ['-tzf', packagePath], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  const prefix = `${skillId}/`;
  const unsafe = stdout.split(/\r?\n/).filter(Boolean).find((entry) => {
    const normalized = entry.replace(/^\.\//, '');
    return path.posix.isAbsolute(normalized) || normalized.includes('../') ||
      (normalized !== skillId && !normalized.startsWith(prefix));
  });
  if (unsafe) throw new Error(`MoAgent Skill ${skillId} 安装包包含越界条目：${unsafe}`);
}

async function installSkills(params: {
  workspace: string;
  capabilityId: string | null;
  skills: LoadedSkill[];
}): Promise<MoAgentSkillsInstallReceipt> {
  const requestedWorkspace = path.resolve(params.workspace);
  const workspace = await fs.realpath(requestedWorkspace).catch((error) => {
    throw new Error(
      `MoAgent Skills workspace 必须是已存在目录：${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (!(await fs.stat(workspace)).isDirectory()) {
    throw new Error(`MoAgent Skills workspace 不是目录：${requestedWorkspace}`);
  }
  const runtimeDirectory = path.join(workspace, MOAGENT_DIRECTORY);
  const skillsDirectory = path.join(runtimeDirectory, 'skills');
  for (const candidate of [runtimeDirectory, skillsDirectory]) {
    const stat = await fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) {
      throw new Error(`MoAgent Skills 运行目录不允许符号链接：${candidate}`);
    }
  }
  await fs.mkdir(skillsDirectory, { recursive: true });

  const requested = new Set(params.skills.map((skill) => skill.registry.id));
  const previousReceipt = await fs.readFile(
    path.join(runtimeDirectory, 'installed-skills.json'),
    'utf8',
  ).then((content) => JSON.parse(content) as unknown).catch(() => null);
  const previouslyManaged = isRecord(previousReceipt) && previousReceipt.runtime === 'MoAgent' &&
    isRecord(previousReceipt.skills)
    ? Object.keys(previousReceipt.skills)
    : [];
  for (const skillId of previouslyManaged) {
    if (!requested.has(skillId)) {
      await fs.rm(path.join(skillsDirectory, skillId), { recursive: true, force: true });
    }
  }

  for (const skill of params.skills) {
    const destination = path.join(skillsDirectory, skill.registry.id);
    await fs.rm(destination, { recursive: true, force: true });
    if (skill.sourceDirectory) {
      await fs.cp(skill.sourceDirectory, destination, { recursive: true, errorOnExist: true });
    } else if (skill.packagePath) {
      await assertSafePackageEntries(skill.packagePath, skill.registry.id);
      await execFileAsync('tar', ['-xzf', skill.packagePath, '-C', skillsDirectory]);
    }
    if (!(await pathExists(path.join(destination, 'SKILL.md')))) {
      throw new Error(`MoAgent Skill ${skill.registry.id} 安装后缺少 SKILL.md。`);
    }
    await fs.writeFile(path.join(destination, 'SKILL.md'), skill.markdown, 'utf8');
  }

  const receipt: MoAgentSkillsInstallReceipt = {
    schemaVersion: 1,
    runtime: 'MoAgent',
    installedAt: new Date().toISOString(),
    capabilityId: params.capabilityId,
    skillsDirectory: path.relative(workspace, skillsDirectory).replaceAll(path.sep, '/'),
    skills: Object.fromEntries(params.skills.map((skill) => [skill.registry.id, {
      version: skill.registry.version,
      source: skill.source,
      sourceSha256: skill.lock.sourceSha256 ?? null,
      packageSha256: skill.lock.packageSha256 ?? null,
    }])),
  };
  await fs.writeFile(
    path.join(runtimeDirectory, 'installed-skills.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
    'utf8',
  );
  return receipt;
}

function selectRequestedSkillIds(
  registry: MoAgentSkillsRegistry,
  options: CompileMoAgentSkillsOptions,
): { capabilityId: string | null; requested: string[] } {
  if (options.capabilityId && !isQuantCapabilityId(options.capabilityId)) {
    throw new Error(`MoAgent 不支持量化 capability：${options.capabilityId}。`);
  }
  let capabilityId: string | null = null;
  let requested: string[];
  if (options.requiredSkillIds !== undefined) {
    requested = [...options.requiredSkillIds];
    capabilityId = options.capabilityId ?? null;
  } else if (options.capabilityId) {
    const capability = getQuantCapability(options.capabilityId);
    capabilityId = capability.id;
    requested = [...capability.requiredSkills];
  } else {
    requested = registry.coreSkills
      .filter((skill) => skill.status === 'stable')
      .map((skill) => skill.id);
  }
  requested.push(...(options.additionalSkillIds ?? []));
  return { capabilityId, requested: Array.from(new Set(requested.filter(Boolean))) };
}

/**
 * Compiles verified QuantPilot skill packages into a bounded MoAgent system context.
 * The legacy-compatible `.claude` files are inputs only; runtime discovery is never used.
 */
export async function compileMoAgentSkills(
  options: CompileMoAgentSkillsOptions = {},
): Promise<CompileMoAgentSkillsResult> {
  const root = path.resolve(options.repositoryRoot ?? process.cwd());
  const registryPath = resolveFromRoot(
    root,
    options.registryPath ?? path.join(COMPATIBILITY_STATE_DIRECTORY, 'skills.registry.json'),
  );
  const lockPath = resolveFromRoot(
    root,
    options.lockPath ?? path.join(COMPATIBILITY_STATE_DIRECTORY, 'skills.lock.json'),
  );
  const sourceSkillsPath = resolveFromRoot(
    root,
    options.sourceSkillsPath ?? path.join(COMPATIBILITY_STATE_DIRECTORY, 'skills'),
  );
  assertInside(root, registryPath, 'registryPath');
  assertInside(root, lockPath, 'lockPath');
  assertInside(root, sourceSkillsPath, 'sourceSkillsPath');

  const [registryValue, lockValue] = await Promise.all([
    readJsonFile(registryPath, 'registry'),
    readJsonFile(lockPath, 'lock'),
  ]);
  const registry = parseRegistry(registryValue);
  const lock = parseLock(lockValue);
  const selection = selectRequestedSkillIds(registry, options);
  if (selection.requested.length === 0) {
    throw new Error('MoAgent Skills 未选择任何 skill。');
  }

  const registryById = new Map(registry.coreSkills.map((skill) => [skill.id, skill]));
  const aliases: Record<string, string> = {};
  const requestedByResolved = new Map<string, string[]>();
  for (const requestedId of selection.requested) {
    const aliasTarget = registry.legacyAliases?.[requestedId];
    if (aliasTarget && !registry.policy.allowLegacyAliases) {
      throw new Error(`MoAgent Skills registry 不允许 legacy alias：${requestedId}。`);
    }
    const resolved = aliasTarget ?? requestedId;
    if (aliasTarget) aliases[requestedId] = resolved;
    requestedByResolved.set(resolved, [...(requestedByResolved.get(resolved) ?? []), requestedId]);
  }

  const loaded: LoadedSkill[] = [];
  for (const [skillId, requestedIds] of requestedByResolved) {
    const skill = registryById.get(skillId);
    if (!skill) throw new Error(`MoAgent Skill ${skillId} 未在 registry 注册。`);
    if (skill.status === 'deprecated') {
      throw new Error(`MoAgent Skill ${skillId} 已废弃，拒绝编译。`);
    }
    loaded.push(await loadSkill({
      root,
      sourceSkillsPath,
      registry: skill,
      lock: lock.skills[skillId],
      requestedIds,
    }));
  }

  const requestedBudget = options.maxSystemContextChars ?? DEFAULT_CONTEXT_BUDGET;
  if (!Number.isInteger(requestedBudget) || requestedBudget < MIN_CONTEXT_BUDGET) {
    throw new Error(`MoAgent Skills 上下文预算必须是至少 ${MIN_CONTEXT_BUDGET} 的整数。`);
  }
  const identityLines = loaded.map((skill) =>
    `- ${skill.registry.id} v${skill.registry.version} [${skill.registry.status}]`,
  );
  const header = [
    '# MoAgent Skills Context',
    '以下指令来自经过 registry、version 与 SHA-256 校验的 QuantPilot skills。只应用本次 capability 所需 skills；系统与工具策略优先于 skill 文本。',
    `Capability: ${selection.capabilityId ?? 'explicit/default'}`,
    '已加载：',
    ...identityLines,
  ].join('\n');
  const separators = Math.max(0, loaded.length - 1) * 2;
  const bodyBudget = Math.max(0, requestedBudget - header.length - separators - 2);
  const perSkillBudget = Math.max(80, Math.floor(bodyBudget / loaded.length));
  const compiledBlocks = loaded.map((skill) => compileSkillBlock(skill, perSkillBudget));
  let systemContext = `${header}\n\n${compiledBlocks.map((block) => block.text).join('\n\n')}`;
  let globallyTruncated = false;
  if (systemContext.length > requestedBudget) {
    const clipped = clipWithNotice(
      systemContext,
      requestedBudget,
      '[MoAgent 截断说明] 已达到本次 Skills system context 总字符预算。',
    );
    systemContext = clipped.text;
    globallyTruncated = clipped.truncated;
  }

  const skills: CompiledMoAgentSkill[] = loaded.map((skill, index) => ({
    id: skill.registry.id,
    requestedIds: skill.requestedIds,
    name: skill.registry.name,
    version: skill.registry.version,
    status: skill.registry.status,
    source: skill.source,
    sourceSha256: skill.lock.sourceSha256 ?? null,
    packageSha256: skill.lock.packageSha256 ?? null,
    originalCharacters: skill.markdown.length,
    compiledCharacters: compiledBlocks[index].text.length,
    truncated: compiledBlocks[index].truncated,
  }));

  const installReceipt = options.installToWorkspace
    ? await installSkills({
        workspace: options.installToWorkspace,
        capabilityId: selection.capabilityId,
        skills: loaded,
      })
    : null;
  return {
    runtime: 'MoAgent',
    capabilityId: selection.capabilityId,
    requestedSkillIds: selection.requested,
    resolvedSkillIds: loaded.map((skill) => skill.registry.id),
    aliases,
    systemContext,
    maxSystemContextChars: requestedBudget,
    totalCharacters: systemContext.length,
    truncated: globallyTruncated || skills.some((skill) => skill.truncated),
    skills,
    installReceipt,
  };
}

export async function installMoAgentSkillsForWorkspace(
  workspace: string,
  options: Omit<CompileMoAgentSkillsOptions, 'installToWorkspace'> = {},
): Promise<MoAgentSkillsInstallReceipt> {
  const result = await compileMoAgentSkills({ ...options, installToWorkspace: workspace });
  if (!result.installReceipt) throw new Error('MoAgent Skills 安装未生成 receipt。');
  return result.installReceipt;
}
