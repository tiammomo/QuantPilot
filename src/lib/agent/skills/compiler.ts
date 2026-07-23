import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { JSON_SCHEMA, load as loadYaml } from 'js-yaml';
import * as tar from 'tar';
import type {
  CompileMoAgentSkillsOptions,
  CompileMoAgentSkillsResult,
  CompiledMoAgentSkill,
  MoAgentSkillCapsuleRegistry,
  MoAgentSkillCapsuleResource,
  MoAgentSkillLockEntry,
  MoAgentSkillPhase,
  MoAgentSkillRegistryEntry,
  MoAgentSkillRuntimeCapsule,
  MoAgentSkillsInstallReceipt,
  MoAgentSkillsLock,
  MoAgentSkillsRegistry,
} from './types';

const DEFAULT_CONTEXT_BUDGET = 6_000;
const MIN_CONTEXT_BUDGET = 256;
const MAX_PACKAGE_ENTRIES = 500;
const MAX_PACKAGE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PACKAGE_TOTAL_BYTES = 50 * 1024 * 1024;
const MOAGENT_DIRECTORY = '.moagent';
const DEFAULT_CAPSULE_REGISTRY_PATH = 'config/moagent-skill-capsules.json';
const DEFAULT_SKILL_PHASE: MoAgentSkillPhase = 'data-preparation';
const FORBIDDEN_RUNTIME_SKILL_PATTERNS = [
  /mcp__/i,
  /\.moagent\/skills\//i,
  /\bcurl\b/i,
  /\bbash\b/i,
  /\bpython3?\b/i,
  /\bnpm\s+run\b/i,
  /\bcat\s*>/i,
  /\bheredoc\b/i,
];

type LoadedSkill = {
  registry: MoAgentSkillRegistryEntry;
  lock: MoAgentSkillLockEntry;
  markdown: string;
  source: 'source' | 'package';
  sourceDirectory: string | null;
  packagePath: string | null;
};

type LoadedSkillResource = {
  id: string;
  path: string;
  text: string;
  sha256: string;
};

type CompiledSkillBlock = {
  text: string;
  capsuleSha256: string;
  includedResources: LoadedSkillResource[];
};

type MarkdownSection = {
  title: string;
  text: string;
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

const SKILL_PHASES = new Set<MoAgentSkillPhase>([
  'planning',
  'data-preparation',
  'workspace-generation',
  'validation-repair',
  'platform-ui',
]);

function assertStringArray(value: unknown, label: string, allowEmpty = true): asserts value is string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`MoAgent Skills Capsule 配置无效：${label} 必须是字符串数组。`);
  }
  for (const [index, entry] of value.entries()) {
    assertString(entry, `${label}[${index}]`);
  }
}

function parseCapsuleResource(value: unknown, label: string): MoAgentSkillCapsuleResource {
  if (!isRecord(value)) {
    throw new Error(`MoAgent Skills Capsule 配置无效：${label} 必须是对象。`);
  }
  assertString(value.id, `${label}.id`);
  assertString(value.path, `${label}.path`);
  assertStringArray(value.profiles, `${label}.profiles`, false);
  if (!value.profiles.every((phase) => SKILL_PHASES.has(phase as MoAgentSkillPhase))) {
    throw new Error(`MoAgent Skills Capsule 配置无效：${label}.profiles 包含未知阶段。`);
  }
  if (!['template-heading', 'named-headings'].includes(String(value.selector))) {
    throw new Error(`MoAgent Skills Capsule 配置无效：${label}.selector 无效。`);
  }
  if (!Number.isSafeInteger(value.maxChars) || Number(value.maxChars) < 256) {
    throw new Error(`MoAgent Skills Capsule 配置无效：${label}.maxChars 必须至少为 256。`);
  }
  if (typeof value.required !== 'boolean') {
    throw new Error(`MoAgent Skills Capsule 配置无效：${label}.required 必须是布尔值。`);
  }
  if (value.headings !== undefined) assertStringArray(value.headings, `${label}.headings`, false);
  if (value.selector === 'named-headings' && value.headings === undefined) {
    throw new Error(`MoAgent Skills Capsule 配置无效：${label}.headings 为必填项。`);
  }
  return value as unknown as MoAgentSkillCapsuleResource;
}

function parseCapsuleRegistry(value: unknown): MoAgentSkillCapsuleRegistry {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.skills)) {
    throw new Error('MoAgent Skills Capsule registry schema 无效。');
  }
  const responseContract = value.workspaceResponseContract;
  if (!isRecord(responseContract) || responseContract.schemaVersion !== 1 ||
    responseContract.owner !== 'platform') {
    throw new Error('MoAgent Skills Capsule workspaceResponseContract 无效。');
  }
  assertStringArray(
    responseContract.stageLabels,
    'workspaceResponseContract.stageLabels',
    false,
  );
  if (responseContract.stageLabels.length !== 5) {
    throw new Error('MoAgent Skills Capsule workspaceResponseContract 必须包含五个阶段。');
  }
  assertStringArray(responseContract.rules, 'workspaceResponseContract.rules', false);
  for (const [skillId, raw] of Object.entries(value.skills)) {
    if (!isRecord(raw)) {
      throw new Error(`MoAgent Skill ${skillId} 的 runtime capsule 无效。`);
    }
    if (FORBIDDEN_RUNTIME_SKILL_PATTERNS.some((pattern) => pattern.test(JSON.stringify(raw)))) {
      throw new Error(`MoAgent Skill ${skillId} 的 runtime capsule 包含不兼容执行指令。`);
    }
    if (!Number.isSafeInteger(raw.priority) || Number(raw.priority) < 1) {
      throw new Error(`MoAgent Skill ${skillId} 的 capsule priority 无效。`);
    }
    assertStringArray(raw.phases, `${skillId}.phases`, false);
    if (!raw.phases.every((phase) => SKILL_PHASES.has(phase as MoAgentSkillPhase))) {
      throw new Error(`MoAgent Skill ${skillId} 的 capsule phases 包含未知阶段。`);
    }
    const capsulePhases = raw.phases;
    assertStringArray(raw.requiresTools, `${skillId}.requiresTools`);
    if (!raw.requiresTools.every((toolName) => /^[a-z][a-z0-9_]*$/.test(toolName))) {
      throw new Error(`MoAgent Skill ${skillId} 的 capsule requiresTools 包含非法工具名。`);
    }
    if (raw.requiresOneOfToolSets !== undefined) {
      if (!Array.isArray(raw.requiresOneOfToolSets) || raw.requiresOneOfToolSets.length === 0) {
        throw new Error(
          `MoAgent Skill ${skillId} 的 capsule requiresOneOfToolSets 必须是非空工具集合数组。`,
        );
      }
      raw.requiresOneOfToolSets.forEach((toolSet, index) => {
        assertStringArray(
          toolSet,
          `${skillId}.requiresOneOfToolSets[${index}]`,
          false,
        );
        if (!toolSet.every((toolName) => /^[a-z][a-z0-9_]*$/.test(toolName))) {
          throw new Error(
            `MoAgent Skill ${skillId} 的 capsule requiresOneOfToolSets 包含非法工具名。`,
          );
        }
      });
    }
    assertString(raw.objective, `${skillId}.objective`);
    assertStringArray(raw.invariants, `${skillId}.invariants`, false);
    assertStringArray(raw.workflow, `${skillId}.workflow`, false);
    assertStringArray(raw.doneWhen, `${skillId}.doneWhen`, false);
    if (!Array.isArray(raw.resources)) {
      throw new Error(`MoAgent Skill ${skillId} 的 capsule resources 必须是数组。`);
    }
    const resourceIds = new Set<string>();
    raw.resources.forEach((resource, index) => {
      const parsed = parseCapsuleResource(resource, `${skillId}.resources[${index}]`);
      if (resourceIds.has(parsed.id)) {
        throw new Error(`MoAgent Skill ${skillId} 的 capsule 包含重复 resource：${parsed.id}。`);
      }
      resourceIds.add(parsed.id);
      if (parsed.profiles.some((phase) => !capsulePhases.includes(phase))) {
        throw new Error(
          `MoAgent Skill ${skillId} 的 resource ${parsed.id} 使用了 capsule 未声明的阶段。`,
        );
      }
    });
  }
  return value as unknown as MoAgentSkillCapsuleRegistry;
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

async function readTextEntryFromPackage(
  packagePath: string,
  entryPath: string,
  label: string,
): Promise<string> {
  let found = false;
  let tooLarge = false;
  let totalBytes = 0;
  const chunks: Buffer[] = [];
  await tar.t({
    file: packagePath,
    onentry: (entry) => {
      const normalized = entry.path.replace(/^(?:\.\/)+/, '').replace(/\/$/, '');
      if (normalized !== entryPath || entry.type !== 'File') return;
      found = true;
      entry.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.byteLength;
        if (totalBytes > 4 * 1024 * 1024) {
          tooLarge = true;
          return;
        }
        chunks.push(buffer);
      });
    },
  });
  if (!found) throw new Error(`${label} 不存在或不是普通文件`);
  if (tooLarge) throw new Error(`${label} 超过 4MB 读取上限`);
  const content = Buffer.concat(chunks).toString('utf8');
  if (!content.trim()) throw new Error(`${label} 为空`);
  return content;
}

async function readSkillMarkdownFromPackage(packagePath: string, skillId: string): Promise<string> {
  try {
    return await readTextEntryFromPackage(
      packagePath,
      `${skillId}/SKILL.md`,
      'SKILL.md',
    );
  } catch (error) {
    throw new Error(
      `MoAgent Skill ${skillId} 无法从已验证安装包读取：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function markdownSections(markdown: string): MarkdownSection[] {
  const heading = /^##\s+(.+)$/gm;
  const matches = Array.from(markdown.matchAll(heading));
  return matches.map((match, index) => ({
    title: match[1].trim(),
    text: markdown.slice(match.index, matches[index + 1]?.index ?? markdown.length).trim(),
  }));
}

function normalizeSkillResourcePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    !normalized.startsWith('references/') ||
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    normalized.split('/').includes('..') ||
    !normalized.endsWith('.md')
  ) {
    throw new Error(`MoAgent Skill resource 路径无效：${value}`);
  }
  return normalized;
}

async function readSkillResource(skill: LoadedSkill, relativePath: string): Promise<string> {
  const normalized = normalizeSkillResourcePath(relativePath);
  if (skill.sourceDirectory) {
    const candidate = path.resolve(skill.sourceDirectory, normalized);
    assertInside(skill.sourceDirectory, candidate, `${skill.registry.id} resource`);
    const stat = await fs.lstat(candidate).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new Error(`MoAgent Skill ${skill.registry.id} resource 不可用：${normalized}`);
    }
    return fs.readFile(candidate, 'utf8');
  }
  if (!skill.packagePath) {
    throw new Error(`MoAgent Skill ${skill.registry.id} 缺少可验证 resource 来源。`);
  }
  await assertSafePackageEntries(
    skill.packagePath,
    skill.registry.id,
    skill.lock.sourceSha256,
    skill.lock.fileCount,
  );
  try {
    return await readTextEntryFromPackage(
      skill.packagePath,
      `${skill.registry.id}/${normalized}`,
      normalized,
    );
  } catch (error) {
    throw new Error(
      `MoAgent Skill ${skill.registry.id} 无法读取 resource ${normalized}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function packWholeSections(sections: readonly MarkdownSection[], maxChars: number): string {
  const selected: string[] = [];
  let characters = 0;
  for (const section of sections) {
    const separator = selected.length > 0 ? 2 : 0;
    if (characters + separator + section.text.length > maxChars) continue;
    selected.push(section.text);
    characters += separator + section.text.length;
  }
  return selected.join('\n\n');
}

async function compileCapsuleResources(params: {
  skill: LoadedSkill;
  capsule: MoAgentSkillRuntimeCapsule;
  phase: MoAgentSkillPhase;
  templateId?: string | null;
}): Promise<LoadedSkillResource[]> {
  const resources: LoadedSkillResource[] = [];
  for (const resource of params.capsule.resources) {
    if (!resource.profiles.includes(params.phase)) continue;
    const raw = await readSkillResource(params.skill, resource.path);
    const sections = markdownSections(raw);
    let candidates: MarkdownSection[] = [];
    if (resource.selector === 'template-heading') {
      const templateId = params.templateId?.trim();
      // Governance/install calls can compile without a task template. A
      // required resource must resolve when a selector is supplied; it must
      // not guess a scenario or inject every scenario when the signal is absent.
      if (!templateId) continue;
      candidates = sections.filter((section) =>
        section.title === templateId || section.title.startsWith(`${templateId}：`));
    } else {
      const headings = new Set(resource.headings ?? []);
      candidates = sections.filter((section) => headings.has(section.title));
    }
    const expectedHeadings = resource.selector === 'named-headings'
      ? new Set(resource.headings ?? [])
      : null;
    for (const section of candidates) expectedHeadings?.delete(section.title);
    if (resource.required && expectedHeadings && expectedHeadings.size > 0) {
      throw new Error(
        `MoAgent Skill ${params.skill.registry.id} 的 runtime resource ${resource.id} 缺少标题：${Array.from(expectedHeadings).join('、')}。`,
      );
    }
    const completeText = candidates.map((section) => section.text).join('\n\n');
    if (resource.required && completeText.length > resource.maxChars) {
      throw new Error(
        `MoAgent Skill ${params.skill.registry.id} 的 runtime resource ${resource.id} 需要 ${completeText.length} 字符，超过原子预算 ${resource.maxChars}。`,
      );
    }
    const text = resource.required
      ? completeText
      : packWholeSections(candidates, resource.maxChars);
    if (!text && resource.required) {
      throw new Error(
        `MoAgent Skill ${params.skill.registry.id} 缺少必需的 runtime resource 片段：${resource.id}`,
      );
    }
    if (!text) continue;
    resources.push({
      id: resource.id,
      path: resource.path,
      text,
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    });
  }
  return resources;
}

function capsuleLines(skill: LoadedSkill, capsule: MoAgentSkillRuntimeCapsule): string[] {
  return [
    `## ${skill.registry.id} — ${skill.registry.name}`,
    `目标：${capsule.objective}`,
    ...capsule.invariants.map((item) => `必须：${item}`),
    ...capsule.workflow.map((item, index) => `步骤 ${index + 1}：${item}`),
    ...capsule.doneWhen.map((item) => `完成条件：${item}`),
  ];
}

function compileSkillBlock(params: {
  skill: LoadedSkill;
  capsule: MoAgentSkillRuntimeCapsule;
  resources: LoadedSkillResource[];
  maxChars: number;
}): CompiledSkillBlock {
  const baseLines = capsuleLines(params.skill, params.capsule);
  const base = baseLines.join('\n');
  const resourceBlocks = params.resources.map((resource) =>
    `### ${resource.id}\n${resource.text}`);
  const full = [base, ...resourceBlocks].join('\n\n');
  if (FORBIDDEN_RUNTIME_SKILL_PATTERNS.some((pattern) => pattern.test(full))) {
    throw new Error(
      `MoAgent Skill ${params.skill.registry.id} 的 runtime capsule/resource 包含不兼容执行指令。`,
    );
  }
  if (full.length > params.maxChars) {
    throw new Error(
      `MoAgent Skill ${params.skill.registry.id} 的原子 runtime capsule 需要 ${full.length} 字符，超过分配预算 ${params.maxChars}；拒绝截断关键步骤。`,
    );
  }
  return {
    text: full,
    capsuleSha256: createHash('sha256').update(full, 'utf8').digest('hex'),
    includedResources: params.resources,
  };
}

async function loadSkill(params: {
  root: string;
  sourceSkillsPath: string;
  registry: MoAgentSkillRegistryEntry;
  lock: MoAgentSkillLockEntry | undefined;
}): Promise<LoadedSkill> {
  const { root, registry } = params;
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
    : path.resolve(root, MOAGENT_DIRECTORY, 'skill-packages', `${registry.id}.tgz`);
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
      markdown: sourceMarkdown,
      source: 'source',
      sourceDirectory,
      packagePath: packageExists ? packageCandidate : null,
    };
  }
  if (!packageExists) {
    throw new Error(`MoAgent Skill ${registry.id} 既没有可验证源目录，也没有可验证安装包。`);
  }
  if (!lock.sourceSha256 || !Number.isSafeInteger(lock.fileCount)) {
    throw new Error(`MoAgent Skill ${registry.id} package-only 模式缺少 sourceSha256/fileCount。`);
  }
  await assertSafePackageEntries(
    packageCandidate,
    registry.id,
    lock.sourceSha256,
    lock.fileCount,
  );
  return {
    registry,
    lock,
    markdown: await readSkillMarkdownFromPackage(packageCandidate, registry.id),
    source: 'package',
    sourceDirectory: null,
    packagePath: packageCandidate,
  };
}

async function assertSafePackageEntries(
  packagePath: string,
  skillId: string,
  expectedSourceSha256?: string,
  expectedFileCount?: number,
): Promise<void> {
  const prefix = `${skillId}/`;
  const canonicalEntries: string[] = [];
  const seen = new Set<string>();
  const files = new Map<string, Buffer>();
  let totalBytes = 0;
  let validationError: Error | null = null;
  await tar.t({
    file: packagePath,
    onentry: (entry) => {
      if (validationError) return;
      const normalized = entry.path.replace(/^(?:\.\/)+/, '');
      const canonical = normalized.replace(/\/$/, '');
      const segments = canonical.split('/');
      if (
        !canonical ||
        normalized.includes('\\') ||
        path.posix.isAbsolute(normalized) ||
        segments.some((segment) => !segment || segment === '.' || segment === '..') ||
        (canonical !== skillId && !canonical.startsWith(prefix))
      ) {
        validationError = new Error(
          `MoAgent Skill ${skillId} 安装包包含越界条目：${normalized}`,
        );
        return;
      }
      if (seen.has(canonical)) {
        validationError = new Error(`MoAgent Skill ${skillId} 安装包包含重复条目。`);
        return;
      }
      seen.add(canonical);
      canonicalEntries.push(canonical);
      if (!['File', 'Directory'].includes(entry.type)) {
        validationError = new Error(
          `MoAgent Skill ${skillId} 安装包包含不安全类型：${entry.type}`,
        );
        return;
      }
      if (entry.type === 'File') {
        if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_PACKAGE_FILE_BYTES) {
          validationError = new Error(`MoAgent Skill ${skillId} 安装包包含尺寸无效的文件。`);
          return;
        }
        totalBytes += entry.size;
        if (totalBytes > MAX_PACKAGE_TOTAL_BYTES) {
          validationError = new Error(`MoAgent Skill ${skillId} 安装包展开后超过 50MB。`);
        }
        const relativePath = canonical.slice(prefix.length);
        if (!relativePath) {
          validationError = new Error(`MoAgent Skill ${skillId} 安装包文件路径无效。`);
          return;
        }
        if (relativePath.startsWith('scripts/') && ((entry.mode ?? 0) & 0o111) === 0) {
          validationError = new Error(
            `MoAgent Skill ${skillId} 安装包脚本不可执行：${relativePath}`,
          );
          return;
        }
        const chunks: Buffer[] = [];
        entry.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        entry.on('end', () => files.set(relativePath, Buffer.concat(chunks)));
      }
    },
  });
  if (validationError !== null) throw validationError;
  if (canonicalEntries.length === 0 || canonicalEntries.length > MAX_PACKAGE_ENTRIES) {
    throw new Error(`MoAgent Skill ${skillId} 安装包条目数量无效。`);
  }
  const entrySet = new Set(canonicalEntries);
  const requiredEntries = [
    `${skillId}/SKILL.md`,
    `${skillId}/agents/openai.yaml`,
    `${skillId}/references`,
    `${skillId}/scripts`,
  ];
  const missing = requiredEntries.find((entry) => !entrySet.has(entry));
  if (missing) {
    throw new Error(`MoAgent Skill ${skillId} 安装包缺少完整包条目：${missing}`);
  }
  if (!canonicalEntries.some((entry) =>
    entry.startsWith(`${skillId}/references/`) && entry.endsWith('.md'))) {
    throw new Error(`MoAgent Skill ${skillId} 安装包缺少 references/*.md。`);
  }
  if (!canonicalEntries.some((entry) =>
    entry.startsWith(`${skillId}/scripts/`) && /\.(?:py|js|mjs|sh)$/.test(entry))) {
    throw new Error(`MoAgent Skill ${skillId} 安装包缺少确定性脚本。`);
  }
  if (expectedSourceSha256 !== undefined || expectedFileCount !== undefined) {
    const hash = createHash('sha256');
    for (const relativePath of [...files.keys()].sort()) {
      const content = files.get(relativePath);
      if (!content) continue;
      hash.update(relativePath);
      hash.update('\0');
      hash.update(content);
      hash.update('\0');
    }
    const sourceSha256 = hash.digest('hex');
    if (expectedSourceSha256 !== sourceSha256 || expectedFileCount !== files.size) {
      throw new Error(`MoAgent Skill ${skillId} 安装包内容与 source lock 不一致。`);
    }
  }
}

async function assertCompleteInstalledSkillDirectory(
  directory: string,
  registry: MoAgentSkillRegistryEntry,
): Promise<void> {
  const directoryStat = await fs.lstat(directory).catch(() => null);
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`MoAgent Skill ${registry.id} 安装结果不是普通目录。`);
  }
  const files = await listSourceFiles(directory);
  const relativeFiles = files.map((filePath) =>
    path.relative(directory, filePath).replaceAll(path.sep, '/'));
  const fileSet = new Set(relativeFiles);
  for (const required of ['SKILL.md', 'agents/openai.yaml']) {
    if (!fileSet.has(required)) {
      throw new Error(`MoAgent Skill ${registry.id} 安装后缺少 ${required}。`);
    }
  }
  const agentSource = await fs.readFile(path.join(directory, 'agents', 'openai.yaml'), 'utf8');
  let agentDocument: unknown;
  try {
    agentDocument = loadYaml(agentSource, { schema: JSON_SCHEMA });
  } catch {
    throw new Error(`MoAgent Skill ${registry.id} 安装后的 agents/openai.yaml 无效。`);
  }
  if (!isRecord(agentDocument) || !isRecord(agentDocument.interface)) {
    throw new Error(`MoAgent Skill ${registry.id} 安装后的 agents/openai.yaml 缺少 interface。`);
  }
  const agentInterface = agentDocument.interface;
  for (const field of ['display_name', 'short_description', 'default_prompt']) {
    if (typeof agentInterface[field] !== 'string' || !agentInterface[field].trim()) {
      throw new Error(`MoAgent Skill ${registry.id} 安装后的 interface.${field} 无效。`);
    }
  }
  const shortLength = Array.from(agentInterface.short_description as string).length;
  if (shortLength < 25 || shortLength > 64 ||
    !(agentInterface.default_prompt as string).includes(`$${registry.id}`)) {
    throw new Error(`MoAgent Skill ${registry.id} 安装后的 Agent 元数据不符合完整包合同。`);
  }

  const references = relativeFiles.filter((entry) => entry.startsWith('references/'));
  const scripts = relativeFiles.filter((entry) => entry.startsWith('scripts/'));
  if (references.length === 0 || references.some((entry) => !entry.endsWith('.md'))) {
    throw new Error(`MoAgent Skill ${registry.id} 安装后 references/ 不完整。`);
  }
  if (scripts.length === 0 || scripts.some((entry) => !/\.(?:py|js|mjs|sh)$/.test(entry))) {
    throw new Error(`MoAgent Skill ${registry.id} 安装后 scripts/ 不完整。`);
  }
  if (process.platform !== 'win32') {
    for (const script of scripts) {
      const stat = await fs.lstat(path.join(directory, script));
      if ((stat.mode & 0o111) === 0) {
        throw new Error(`MoAgent Skill ${registry.id} 安装后脚本不可执行：${script}。`);
      }
    }
  }
  const registeredReferences = [...(registry.references ?? [])].sort();
  const registeredScripts = [...(registry.scripts ?? [])].sort();
  if (JSON.stringify([...references].sort()) !== JSON.stringify(registeredReferences)) {
    throw new Error(`MoAgent Skill ${registry.id} 安装后的 references 与 registry 不一致。`);
  }
  if (JSON.stringify([...scripts].sort()) !== JSON.stringify(registeredScripts)) {
    throw new Error(`MoAgent Skill ${registry.id} 安装后的 scripts 与 registry 不一致。`);
  }
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
    const stagingRoot = await fs.mkdtemp(path.join(runtimeDirectory, '.skill-install-'));
    const stagedDestination = path.join(stagingRoot, skill.registry.id);
    let keepStagingForRecovery = false;
    try {
      if (skill.sourceDirectory) {
        await fs.cp(skill.sourceDirectory, stagedDestination, { recursive: true, errorOnExist: true });
      } else if (skill.packagePath) {
        await assertSafePackageEntries(
          skill.packagePath,
          skill.registry.id,
          skill.lock.sourceSha256,
          skill.lock.fileCount,
        );
        await tar.x({
          file: skill.packagePath,
          cwd: stagingRoot,
          preserveOwner: false,
          preservePaths: false,
          strict: true,
          filter: (_entryPath, entry) =>
            'type' in entry && ['File', 'Directory'].includes(String(entry.type)),
        });
      }
      await assertCompleteInstalledSkillDirectory(stagedDestination, skill.registry);
      await fs.writeFile(path.join(stagedDestination, 'SKILL.md'), skill.markdown, 'utf8');
      const previousStat = await fs.lstat(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (previousStat?.isSymbolicLink()) {
        throw new Error(`MoAgent Skill 目标目录不允许符号链接：${destination}`);
      }
      const backupDestination = path.join(stagingRoot, '.previous');
      if (previousStat) await fs.rename(destination, backupDestination);
      try {
        await fs.rename(stagedDestination, destination);
      } catch (error) {
        if (previousStat) {
          try {
            await fs.rename(backupDestination, destination);
          } catch (restoreError) {
            keepStagingForRecovery = true;
            throw new AggregateError(
              [error, restoreError],
              `MoAgent Skill ${skill.registry.id} 替换与恢复均失败；备份保留在 ${backupDestination}`,
            );
          }
        }
        throw error;
      }
    } finally {
      if (!keepStagingForRecovery) {
        await fs.rm(stagingRoot, { recursive: true, force: true });
      }
    }
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
  capsuleRegistry: MoAgentSkillCapsuleRegistry,
  options: CompileMoAgentSkillsOptions,
): {
  capabilityId: string | null;
  phase: MoAgentSkillPhase;
  requested: string[];
  installationRequested: string[];
} {
  if (
    options.capability &&
    options.capabilityId &&
    options.capability.id !== options.capabilityId
  ) {
    throw new Error(
      `MoAgent Skill capability identity mismatch: ${options.capabilityId} != ${options.capability.id}.`,
    );
  }
  const phase = options.phase ?? DEFAULT_SKILL_PHASE;
  let capabilityId: string | null = null;
  let requested: string[];
  if (options.requiredSkillIds !== undefined) {
    requested = [...options.requiredSkillIds];
    capabilityId = options.capability?.id ?? options.capabilityId ?? null;
  } else if (options.capability) {
    capabilityId = options.capability.id;
    requested = [...options.capability.requiredSkillIds];
  } else if (options.capabilityId) {
    throw new Error(
      `MoAgent capability ${options.capabilityId} requires a domain-owned capability descriptor.`,
    );
  } else {
    requested = registry.coreSkills
      .filter((skill) => skill.status === 'stable')
      .map((skill) => skill.id);
  }
  requested.push(...(options.additionalSkillIds ?? []));
  requested.push(...(options.activatedSkillIds ?? []));
  const installationRequested = Array.from(new Set(requested.filter(Boolean)));
  const excludedSkillIds = new Set(options.excludedSkillIds ?? []);
  if (options.requiredSkillIds === undefined) {
    requested = requested.filter((requestedId) => {
      const capsule = capsuleRegistry.skills[requestedId];
      if (!capsule?.phases.includes(phase)) return false;
      if (excludedSkillIds.has(requestedId)) return false;
      return true;
    });
  }
  return {
    capabilityId,
    phase,
    requested: Array.from(new Set(requested.filter(Boolean))),
    installationRequested,
  };
}

/**
 * Compiles verified domain skill packages into a bounded MoAgent system context.
 * Compiles the canonical `.moagent` registry and packages; runtime discovery is never used.
 */
export async function compileMoAgentSkills(
  options: CompileMoAgentSkillsOptions = {},
): Promise<CompileMoAgentSkillsResult> {
  const root = path.resolve(options.repositoryRoot ?? process.cwd());
  const registryPath = resolveFromRoot(
    root,
    options.registryPath ?? path.join(MOAGENT_DIRECTORY, 'skills.registry.json'),
  );
  const lockPath = resolveFromRoot(
    root,
    options.lockPath ?? path.join(MOAGENT_DIRECTORY, 'skills.lock.json'),
  );
  const sourceSkillsPath = resolveFromRoot(
    root,
    options.sourceSkillsPath ?? path.join(MOAGENT_DIRECTORY, 'skills'),
  );
  const capsuleRegistryPath = resolveFromRoot(
    root,
    options.capsuleRegistryPath ?? DEFAULT_CAPSULE_REGISTRY_PATH,
  );
  assertInside(root, registryPath, 'registryPath');
  assertInside(root, lockPath, 'lockPath');
  assertInside(root, sourceSkillsPath, 'sourceSkillsPath');
  assertInside(root, capsuleRegistryPath, 'capsuleRegistryPath');

  const [registryValue, lockValue, capsuleRegistryValue] = await Promise.all([
    readJsonFile(registryPath, 'registry'),
    readJsonFile(lockPath, 'lock'),
    readJsonFile(capsuleRegistryPath, 'runtime capsule registry'),
  ]);
  const registry = parseRegistry(registryValue);
  const lock = parseLock(lockValue);
  const capsuleRegistry = parseCapsuleRegistry(capsuleRegistryValue);
  const registeredSkillIds = new Set(registry.coreSkills.map((skill) => skill.id));
  for (const capsuleId of Object.keys(capsuleRegistry.skills)) {
    if (!registeredSkillIds.has(capsuleId)) {
      throw new Error(`MoAgent runtime capsule 指向未注册 Skill：${capsuleId}。`);
    }
  }
  for (const skill of registry.coreSkills) {
    if (!capsuleRegistry.skills[skill.id]) {
      throw new Error(`MoAgent Skill ${skill.id} 缺少 runtime capsule。`);
    }
  }
  const selection = selectRequestedSkillIds(registry, capsuleRegistry, options);
  if (selection.requested.length === 0) {
    throw new Error('MoAgent Skills 未选择任何 skill。');
  }

  const registryById = new Map(registry.coreSkills.map((skill) => [skill.id, skill]));
  if (options.capability?.status === 'ready') {
    const plannedDependencies = options.capability.requiredSkillIds
      .filter((skillId) => registryById.get(skillId)?.status === 'planned');
    if (plannedDependencies.length > 0) {
      throw new Error(
        `Ready capability ${options.capability.id} 不能依赖 planned Skill：${Array.from(new Set(plannedDependencies)).join('、')}。`,
      );
    }
  }
  const loaded: LoadedSkill[] = [];
  for (const skillId of selection.requested) {
    const skill = registryById.get(skillId);
    if (!skill) throw new Error(`MoAgent Skill ${skillId} 未在 registry 注册。`);
    if (skill.status === 'deprecated') {
      throw new Error(`MoAgent Skill ${skillId} 已废弃，拒绝编译。`);
    }
    const capsule = capsuleRegistry.skills[skillId];
    if (!capsule?.phases.includes(selection.phase)) {
      throw new Error(`MoAgent Skill ${skillId} 不允许在 ${selection.phase} 阶段加载。`);
    }
    if (options.availableToolNames) {
      const availableTools = new Set(options.availableToolNames);
      const missingTools = capsule.requiresTools.filter((toolName) => !availableTools.has(toolName));
      if (missingTools.length > 0) {
        throw new Error(
          `MoAgent Skill ${skillId} 与当前工具面不兼容，缺少：${missingTools.join('、')}。`,
        );
      }
      const alternatives = capsule.requiresOneOfToolSets ?? [];
      if (
        alternatives.length > 0 &&
        !alternatives.some((toolSet) => toolSet.every((toolName) => availableTools.has(toolName)))
      ) {
        throw new Error(
          `MoAgent Skill ${skillId} 与当前工具面不兼容，至少需要一组完整替代工具：${alternatives
            .map((toolSet) => `[${toolSet.join('、')}]`)
            .join(' 或 ')}。`,
        );
      }
    }
    loaded.push(await loadSkill({
      root,
      sourceSkillsPath,
      registry: skill,
      lock: lock.skills[skillId],
    }));
  }

  const requestedBudget = options.maxSystemContextChars ?? DEFAULT_CONTEXT_BUDGET;
  if (!Number.isInteger(requestedBudget) || requestedBudget < MIN_CONTEXT_BUDGET) {
    throw new Error(`MoAgent Skills 上下文预算必须是至少 ${MIN_CONTEXT_BUDGET} 的整数。`);
  }
  const systemContext = [
    '# MoAgent Skill Manifest',
    `phase=${selection.phase}; capability=${selection.capabilityId ?? 'explicit/default'}`,
    '以下能力已经 registry/version/SHA-256 与 runtime capsule 校验；全局安全、权限和终止规则由 Kernel 负责，Skill 只补充领域步骤。',
    ...loaded.map((skill) => {
      const capsule = capsuleRegistry.skills[skill.registry.id];
      return `- ${skill.registry.id}@${skill.registry.version} priority=${capsule.priority}: ${skill.registry.boundary}`;
    }),
  ].join('\n');

  const compiledBlocks: CompiledSkillBlock[] = [];
  for (const skill of loaded) {
    const capsule = capsuleRegistry.skills[skill.registry.id];
    const resources = await compileCapsuleResources({
      skill,
      capsule,
      phase: selection.phase,
      templateId: options.templateId,
    });
    compiledBlocks.push(compileSkillBlock({
      skill,
      capsule,
      resources,
      maxChars: requestedBudget,
    }));
  }
  const taskContext = [
    '# MoAgent Skill Capsules',
    `执行阶段：${selection.phase}${options.templateId ? `；模板：${options.templateId}` : ''}${options.variantId ? `；变体：${options.variantId}` : ''}`,
    '按以下原子步骤执行；不要从 SKILL.md 猜测未声明工具，也不要自行读取相对 reference 路径。',
    ...compiledBlocks.map((block) => block.text),
  ].join('\n\n');
  const totalCharacters = systemContext.length + taskContext.length;
  if (totalCharacters > requestedBudget) {
    throw new Error(
      `MoAgent Skills 原子上下文需要 ${totalCharacters} 字符，超过总预算 ${requestedBudget}；拒绝截断关键 Skill Capsule。`,
    );
  }

  const skills: CompiledMoAgentSkill[] = loaded.map((skill, index) => ({
    id: skill.registry.id,
    name: skill.registry.name,
    version: skill.registry.version,
    status: skill.registry.status,
    source: skill.source,
    sourceSha256: skill.lock.sourceSha256 ?? null,
    packageSha256: skill.lock.packageSha256 ?? null,
    originalCharacters: skill.markdown.length,
    compiledCharacters: compiledBlocks[index].text.length,
    truncated: false,
    capsuleSha256: compiledBlocks[index].capsuleSha256,
    includedResources: compiledBlocks[index].includedResources.map((resource) => ({
      id: resource.id,
      path: resource.path,
      sha256: resource.sha256,
      characters: resource.text.length,
    })),
  }));

  let installReceipt: MoAgentSkillsInstallReceipt | null = null;
  if (options.installToWorkspace) {
    const installableById = new Map(loaded.map((skill) => [skill.registry.id, skill]));
    for (const skillId of selection.installationRequested) {
      if (installableById.has(skillId)) continue;
      const skill = registryById.get(skillId);
      if (!skill) throw new Error(`MoAgent Skill ${skillId} 未在 registry 注册。`);
      if (skill.status === 'deprecated') {
        throw new Error(`MoAgent Skill ${skillId} 已废弃，拒绝安装。`);
      }
      installableById.set(skillId, await loadSkill({
        root,
        sourceSkillsPath,
        registry: skill,
        lock: lock.skills[skillId],
      }));
    }
    installReceipt = await installSkills({
      workspace: options.installToWorkspace,
      capabilityId: selection.capabilityId,
      skills: Array.from(installableById.values()),
    });
  }
  return {
    runtime: 'MoAgent',
    capabilityId: selection.capabilityId,
    selectedSkillIds: loaded.map((skill) => skill.registry.id),
    phase: selection.phase,
    systemContext,
    taskContext,
    maxSystemContextChars: requestedBudget,
    systemContextCharacters: systemContext.length,
    taskContextCharacters: taskContext.length,
    totalCharacters,
    truncated: false,
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
