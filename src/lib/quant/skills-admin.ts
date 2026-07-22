import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { JSON_SCHEMA, load as loadYaml } from 'js-yaml';
import * as tar from 'tar';
import { getSkillsDashboardData, type SkillsDashboardData } from '@/lib/quant/skills-dashboard';

type JsonRecord = Record<string, unknown>;

export interface SkillSourceData {
  skillId: string;
  filePath: string;
  content: string;
  relativePath: string;
  size: number;
  updatedAt: string | null;
  editable: boolean;
  skillMd?: string;
}

export interface SaveSkillSourceParams {
  skillId: string;
  filePath?: string;
  content?: string;
  skillMd?: string;
}

export interface DeleteSkillFileParams {
  skillId: string;
  filePath: string;
}

export interface SkillFolderParams {
  skillId: string;
  folderPath: string;
}

export interface PublishSkillVersionParams {
  skillId: string;
  version: string;
  summary: string;
  changes: string[];
  status?: string | null;
}

export interface UploadSkillPackageParams extends PublishSkillVersionParams {
  file: File;
}

export interface SkillDiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  previousSize: number | null;
  currentSize: number | null;
  previousUpdatedAt: string | null;
  currentUpdatedAt: string | null;
  addedLines: number;
  removedLines: number;
  preview: string[];
}

export interface SkillDiffData {
  skillId: string;
  baseVersion: string | null;
  basePackagePath: string | null;
  changed: boolean;
  files: SkillDiffFile[];
  totals: {
    added: number;
    modified: number;
    deleted: number;
    addedLines: number;
    removedLines: number;
  };
}

const ROOT = path.resolve(/*turbopackIgnore: true*/ process.cwd());
const SKILLS_DIR = path.join(ROOT, '.moagent', 'skills');
const REGISTRY_PATH = path.join(ROOT, '.moagent', 'skills.registry.json');
const CHANGELOG_PATH = path.join(ROOT, '.moagent', 'skills.changelog.json');
const LOCK_PATH = path.join(ROOT, '.moagent', 'skills.lock.json');
const TEMP_DIR = path.join(ROOT, 'tmp', 'skill-uploads');
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_EDITABLE_FILE_BYTES = 512 * 1024;
const MAX_ARCHIVE_ENTRIES = 250;
const MAX_EXTRACTED_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_TOTAL_BYTES = 50 * 1024 * 1024;
const REQUIRED_SKILL_DIRECTORIES = ['references', 'scripts', 'agents'] as const;
const FORBIDDEN_SKILL_FILENAMES = new Set([
  'README.md',
  'CHANGELOG.md',
  'INSTALLATION_GUIDE.md',
  'QUICK_REFERENCE.md',
]);
const EDITABLE_SOURCE_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.py',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function readJson(filePath: string): Promise<JsonRecord> {
  const content = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(content);
  if (!isRecord(parsed)) {
    throw new Error(`${path.relative(ROOT, filePath)} 必须是 JSON 对象。`);
  }
  return parsed;
}

async function writeJson(filePath: string, value: unknown) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function assertSemver(version: string) {
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error('版本号必须使用 semver，例如 0.3.3。');
  }
}

function assertSafeSkillId(skillId: string) {
  if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(skillId)) {
    throw new Error('skillId 不合法。');
  }
}

async function resolveCoreSkill(skillId: string) {
  assertSafeSkillId(skillId);
  const registry = await readJson(REGISTRY_PATH);
  const coreSkills = Array.isArray(registry.coreSkills) ? registry.coreSkills : [];
  const index = coreSkills.findIndex((skill) => isRecord(skill) && skill.id === skillId);
  if (index < 0) {
    throw new Error(`未找到核心 skill：${skillId}`);
  }

  return {
    registry,
    coreSkills: coreSkills as JsonRecord[],
    index,
    skill: coreSkills[index] as JsonRecord,
  };
}

async function getSkillMdPath(skillId: string) {
  await resolveCoreSkill(skillId);
  return path.join(SKILLS_DIR, skillId, 'SKILL.md');
}

async function getPackageDir() {
  const registry = await readJson(REGISTRY_PATH);
  const policy = isRecord(registry.policy) ? registry.policy : {};
  const configured = typeof policy.packageDir === 'string'
    ? policy.packageDir.replaceAll('\\', '/')
    : '.moagent/skill-packages';
  if (!configured || path.isAbsolute(configured) || configured.split('/').includes('..')) {
    throw new Error('registry.policy.packageDir 必须是仓库内安全相对路径。');
  }
  return path.resolve(ROOT, configured);
}

async function getSkillVersion(skillId: string) {
  const resolved = await resolveCoreSkill(skillId);
  return typeof resolved.skill.version === 'string' ? resolved.skill.version : null;
}

async function getCurrentPackagePath(skillId: string) {
  return path.join(await getPackageDir(), `${skillId}.tgz`);
}

async function getVersionPackagePath(skillId: string, version: string) {
  return path.join(await getPackageDir(), 'versions', skillId, `${version}.tgz`);
}

function normalizeSkillFilePath(filePath: string | undefined | null): string {
  const normalized = String(filePath || 'SKILL.md')
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .trim();
  if (!normalized || normalized.endsWith('/')) {
    throw new Error('文件路径不能为空。');
  }
  if (
    normalized.includes('\0') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..') ||
    path.isAbsolute(normalized)
  ) {
    throw new Error('文件路径不安全。');
  }
  return normalized;
}

function normalizeSkillFolderPath(folderPath: string | undefined | null): string {
  const normalized = String(folderPath || '')
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .trim();
  if (!normalized) {
    throw new Error('文件夹路径不能为空。');
  }
  if (
    normalized.includes('\0') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..') ||
    path.isAbsolute(normalized)
  ) {
    throw new Error('文件夹路径不安全。');
  }
  return normalized;
}

async function resolveSkillFilePath(skillId: string, filePath?: string | null) {
  await resolveCoreSkill(skillId);
  const relativePath = normalizeSkillFilePath(filePath);
  const sourceDir = path.join(SKILLS_DIR, skillId);
  const absolutePath = path.resolve(sourceDir, relativePath);
  if (!isInside(sourceDir, absolutePath)) {
    throw new Error('文件路径必须位于当前 skill 目录内。');
  }
  await assertSafeSkillTree(sourceDir, sourceDir, skillId);
  return {
    sourceDir,
    relativePath,
    absolutePath,
  };
}

async function resolveSkillFolderPath(skillId: string, folderPath?: string | null) {
  await resolveCoreSkill(skillId);
  const relativePath = normalizeSkillFolderPath(folderPath);
  const sourceDir = path.join(SKILLS_DIR, skillId);
  const absolutePath = path.resolve(sourceDir, relativePath);
  if (absolutePath === sourceDir || !isInside(sourceDir, absolutePath)) {
    throw new Error('文件夹路径必须位于当前 skill 目录内。');
  }
  await assertSafeSkillTree(sourceDir, sourceDir, skillId);
  return {
    sourceDir,
    relativePath,
    absolutePath,
  };
}

function isEditableSkillFile(relativePath: string): boolean {
  if (relativePath === 'SKILL.md') return true;
  return EDITABLE_SOURCE_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function validateTextFileContent(relativePath: string, content: string) {
  if (!isEditableSkillFile(relativePath)) {
    throw new Error(`不支持在线编辑该文件类型：${relativePath}`);
  }
  if (FORBIDDEN_SKILL_FILENAMES.has(path.basename(relativePath))) {
    throw new Error(`Skill 包中不允许创建 ${path.basename(relativePath)}。`);
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_EDITABLE_FILE_BYTES) {
    throw new Error('文件超过 512KB，不适合在线编辑。');
  }
  if (relativePath === 'SKILL.md') {
    const trimmed = content.trim();
    if (!trimmed.includes('#')) {
      throw new Error('SKILL.md 内容过短或缺少标题。');
    }
    if (!/^---\n[\s\S]*?\n---\n/.test(trimmed)) {
      throw new Error('SKILL.md 必须包含 YAML frontmatter。');
    }
  }
  if (relativePath.endsWith('.json')) {
    try {
      JSON.parse(content);
    } catch {
      throw new Error(`${relativePath} 不是合法 JSON。`);
    }
  }
}

async function assertSafeSkillTree(dir: string, sourceDir: string, skillId: string): Promise<void> {
  if (dir === sourceDir) {
    const rootStat = await fs.lstat(sourceDir).catch(() => null);
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`${skillId} 的源码根目录必须是普通目录。`);
    }
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const absolutePath = path.join(dir, entry.name);
    const relativePath = path.relative(sourceDir, absolutePath).replaceAll(path.sep, '/');
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`${skillId} 不允许包含软链接：${relativePath}。`);
    }
    if (stat.isDirectory()) {
      await assertSafeSkillTree(absolutePath, sourceDir, skillId);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`${skillId} 包含不支持的文件系统条目：${relativePath}。`);
    }
  }
}

function isReferenceResource(relativePath: string) {
  return relativePath.startsWith('references/') && relativePath.endsWith('.md');
}

function isScriptResource(relativePath: string) {
  return relativePath.startsWith('scripts/') && /\.(?:py|js|mjs|sh)$/.test(relativePath);
}

async function ensureSkillScriptsExecutable(sourceDir: string) {
  for (const filePath of await listFiles(path.join(sourceDir, 'scripts'))) {
    const relativePath = path.relative(sourceDir, filePath).replaceAll(path.sep, '/');
    if (isScriptResource(relativePath)) await fs.chmod(filePath, 0o755);
  }
}

function validateAgentMetadata(agentSource: string, skillId: string) {
  let document: unknown;
  try {
    document = loadYaml(agentSource, { schema: JSON_SCHEMA });
  } catch (error) {
    throw new Error(
      `${skillId} 的 agents/openai.yaml 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(document) || !isRecord(document.interface)) {
    throw new Error(`${skillId} 的 agents/openai.yaml 必须包含根级 interface 对象。`);
  }
  const interfaceBlock = agentSource.match(
    /^interface:\s*(?:#.*)?\r?\n((?:^[ \t]+.*(?:\r?\n|$))*)/m,
  )?.[1] ?? '';
  for (const field of ['display_name', 'short_description', 'default_prompt']) {
    const value = document.interface[field];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${skillId} 的 interface.${field} 必须是非空字符串。`);
    }
    if (!new RegExp(`^  ${field}:\\s*".+"\\s*$`, 'm').test(interfaceBlock)) {
      throw new Error(`${skillId} 的 interface.${field} 必须使用双引号。`);
    }
  }
  const shortDescription = String(document.interface.short_description);
  const shortLength = Array.from(shortDescription).length;
  if (shortLength < 25 || shortLength > 64) {
    throw new Error(`${skillId} 的 interface.short_description 必须为 25–64 个字符。`);
  }
  if (!String(document.interface.default_prompt).includes(`$${skillId}`)) {
    throw new Error(`${skillId} 的 interface.default_prompt 必须显式引用 $${skillId}。`);
  }
}

async function assertRequiredResourcesSurviveRemoval(sourceDir: string, removalPath: string) {
  const files = await listFiles(sourceDir);
  const remaining = files
    .filter((filePath) => !isInside(removalPath, filePath))
    .map((filePath) => path.relative(sourceDir, filePath).replaceAll(path.sep, '/'));
  if (!remaining.some(isReferenceResource)) {
    throw new Error('不能删除最后一个 reference；每个 Skill 必须保留 references/*.md。');
  }
  if (!remaining.some(isScriptResource)) {
    throw new Error('不能删除最后一个 script；每个 Skill 必须保留确定性脚本。');
  }
}

async function validateCompleteSkillDirectory(skillId: string) {
  const sourceDir = path.join(SKILLS_DIR, skillId);
  const skillFile = path.join(sourceDir, 'SKILL.md');
  const agentFile = path.join(sourceDir, 'agents', 'openai.yaml');
  const skillStat = await fs.lstat(skillFile).catch(() => null);
  if (!skillStat?.isFile() || skillStat.isSymbolicLink()) {
    throw new Error(`${skillId} 必须包含普通文件 SKILL.md。`);
  }
  const skillSource = await fs.readFile(skillFile, 'utf8').catch(() => null);
  if (!skillSource) throw new Error(`${skillId} 缺少 SKILL.md。`);
  await assertSafeSkillTree(sourceDir, sourceDir, skillId);

  for (const directory of REQUIRED_SKILL_DIRECTORIES) {
    const stat = await fs.lstat(path.join(sourceDir, directory)).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${skillId} 必须包含普通目录 ${directory}/。`);
    }
  }
  const agentStat = await fs.lstat(agentFile).catch(() => null);
  if (!agentStat?.isFile() || agentStat.isSymbolicLink()) {
    throw new Error(`${skillId} 必须包含 agents/openai.yaml。`);
  }

  const referenceDir = path.join(sourceDir, 'references');
  const scriptDir = path.join(sourceDir, 'scripts');
  const sourceFiles = await listFiles(sourceDir);
  const relativeFiles = sourceFiles.map((filePath) =>
    path.relative(sourceDir, filePath).replaceAll(path.sep, '/'));
  const allReferences = relativeFiles.filter((relativePath) => relativePath.startsWith('references/'));
  const allScripts = relativeFiles.filter((relativePath) => relativePath.startsWith('scripts/'));
  const references = allReferences.filter(isReferenceResource).sort();
  const scripts = allScripts.filter(isScriptResource).sort();
  if (references.length === 0) throw new Error(`${skillId} 至少需要一个 references/*.md。`);
  if (scripts.length === 0) throw new Error(`${skillId} 至少需要一个确定性 script。`);
  if (references.length !== allReferences.length) {
    throw new Error(`${skillId} 的 references/ 只能包含 Markdown reference。`);
  }
  if (scripts.length !== allScripts.length) {
    throw new Error(`${skillId} 的 scripts/ 包含不支持的脚本类型。`);
  }
  for (const script of scripts) {
    const stat = await fs.lstat(path.join(sourceDir, script));
    if ((stat.mode & 0o111) === 0) {
      throw new Error(`${skillId} 的脚本必须可执行：${script}。`);
    }
  }
  const { skill: registrySkill } = await resolveCoreSkill(skillId);
  const registeredReferences = Array.isArray(registrySkill.references)
    ? registrySkill.references.map(String).sort()
    : [];
  const registeredScripts = Array.isArray(registrySkill.scripts)
    ? registrySkill.scripts.map(String).sort()
    : [];
  if (JSON.stringify(registeredReferences) !== JSON.stringify(references)) {
    throw new Error(`${skillId} 的 registry.references 必须完整登记所有 reference。`);
  }
  if (JSON.stringify(registeredScripts) !== JSON.stringify(scripts)) {
    throw new Error(`${skillId} 的 registry.scripts 必须完整登记所有 script。`);
  }

  for (const filePath of sourceFiles) {
    if (FORBIDDEN_SKILL_FILENAMES.has(path.basename(filePath))) {
      throw new Error(`${skillId} 不应包含 ${path.basename(filePath)}。`);
    }
  }
  for (const reference of references) {
    if (!skillSource.includes(`](${reference})`)) {
      throw new Error(`${skillId} 的 SKILL.md 必须直接链接 ${reference}。`);
    }
  }
  for (const script of scripts) {
    if (!skillSource.includes(script)) {
      throw new Error(`${skillId} 的 SKILL.md 必须说明 ${script} 的使用方式。`);
    }
  }

  const frontmatter = skillSource.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) throw new Error(`${skillId} 的 SKILL.md 缺少 YAML frontmatter。`);
  const entries = frontmatter.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const separator = line.indexOf(':');
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const;
  });
  const keys = new Set(entries.map(([key]) => key));
  if (entries.length !== 2 || keys.size !== 2 || !keys.has('name') || !keys.has('description')) {
    throw new Error(`${skillId} 的 frontmatter 只能包含 name 和 description。`);
  }
  const name = entries.find(([key]) => key === 'name')?.[1].replace(/^["']|["']$/g, '');
  if (name !== skillId) throw new Error(`${skillId} 的 frontmatter name 必须与目录一致。`);
  const description = entries.find(([key]) => key === 'description')?.[1].replace(/^["']|["']$/g, '');
  if (!description) throw new Error(`${skillId} 的 frontmatter description 不能为空。`);

  validateAgentMetadata(await fs.readFile(agentFile, 'utf8'), skillId);
}

export async function readSkillSource(skillId: string): Promise<SkillSourceData> {
  return readSkillFile(skillId, 'SKILL.md');
}

export async function readSkillFile(skillId: string, filePath?: string | null): Promise<SkillSourceData> {
  const resolved = await resolveSkillFilePath(skillId, filePath);
  const stat = await fs.stat(resolved.absolutePath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`文件不存在：${resolved.relativePath}`);
  }
  if (!isEditableSkillFile(resolved.relativePath)) {
    throw new Error(`该文件不是可在线编辑的文本文件：${resolved.relativePath}`);
  }
  if (stat.size > MAX_EDITABLE_FILE_BYTES) {
    throw new Error('文件超过 512KB，不适合在线编辑。');
  }
  const content = await fs.readFile(resolved.absolutePath, 'utf8');
  return {
    skillId,
    filePath: resolved.relativePath,
    content,
    skillMd: resolved.relativePath === 'SKILL.md' ? content : undefined,
    relativePath: path.relative(ROOT, resolved.absolutePath).replaceAll(path.sep, '/'),
    size: stat.size,
    updatedAt: stat?.mtime.toISOString() ?? null,
    editable: true,
  };
}

export async function saveSkillSource(params: SaveSkillSourceParams): Promise<SkillSourceData> {
  return saveSkillFile({
    skillId: params.skillId,
    filePath: params.filePath ?? 'SKILL.md',
    content: params.content ?? params.skillMd ?? '',
  });
}

export async function saveSkillFile(params: SaveSkillSourceParams): Promise<SkillSourceData> {
  const resolved = await resolveSkillFilePath(params.skillId, params.filePath);
  const content = (params.content ?? params.skillMd ?? '').trimEnd();
  validateTextFileContent(resolved.relativePath, content);
  await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
  await fs.writeFile(resolved.absolutePath, `${content}\n`, 'utf8');
  if (isScriptResource(resolved.relativePath)) await fs.chmod(resolved.absolutePath, 0o755);
  return readSkillFile(params.skillId, resolved.relativePath);
}

export async function deleteSkillFile(params: DeleteSkillFileParams): Promise<SkillsDashboardData> {
  const resolved = await resolveSkillFilePath(params.skillId, params.filePath);
  if (resolved.relativePath === 'SKILL.md' || resolved.relativePath === 'agents/openai.yaml') {
    throw new Error('不能删除 Skill 的必需入口或 Agent 元数据。');
  }
  const stat = await fs.stat(resolved.absolutePath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`文件不存在：${resolved.relativePath}`);
  }
  await assertRequiredResourcesSurviveRemoval(resolved.sourceDir, resolved.absolutePath);
  await fs.rm(resolved.absolutePath, { force: true });
  return getSkillsDashboardData();
}

export async function createSkillFolder(params: SkillFolderParams): Promise<SkillsDashboardData> {
  const resolved = await resolveSkillFolderPath(params.skillId, params.folderPath);
  const existing = await fs.lstat(resolved.absolutePath).catch(() => null);
  if (existing?.isFile()) {
    throw new Error(`同名文件已存在：${resolved.relativePath}`);
  }
  if (existing?.isSymbolicLink()) {
    throw new Error('不能操作软链接目录。');
  }
  await fs.mkdir(resolved.absolutePath, { recursive: true });
  return getSkillsDashboardData();
}

export async function deleteSkillFolder(params: SkillFolderParams): Promise<SkillsDashboardData> {
  const resolved = await resolveSkillFolderPath(params.skillId, params.folderPath);
  if (REQUIRED_SKILL_DIRECTORIES.includes(resolved.relativePath as typeof REQUIRED_SKILL_DIRECTORIES[number])) {
    throw new Error('不能删除 references、scripts 或 agents 必需目录。');
  }
  const stat = await fs.lstat(resolved.absolutePath).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`文件夹不存在：${resolved.relativePath}`);
  }
  await assertRequiredResourcesSurviveRemoval(resolved.sourceDir, resolved.absolutePath);
  await fs.rm(resolved.absolutePath, { recursive: true, force: true });
  return getSkillsDashboardData();
}

function normalizeRelease(params: PublishSkillVersionParams) {
  const version = params.version.trim();
  const summary = params.summary.trim();
  const changes = params.changes.map((change) => change.trim()).filter(Boolean);
  assertSemver(version);
  if (!summary) {
    throw new Error('发布摘要不能为空。');
  }
  if (changes.length === 0) {
    throw new Error('至少需要一条变更说明。');
  }
  return { version, summary, changes };
}

export async function publishSkillVersion(params: PublishSkillVersionParams): Promise<SkillsDashboardData> {
  const release = normalizeRelease(params);
  const resolved = await resolveCoreSkill(params.skillId);
  const previousVersion = typeof resolved.skill.version === 'string' ? resolved.skill.version : null;
  const packageDir = await getPackageDir();
  const packagePath = path.join(packageDir, `${params.skillId}.tgz`);
  const releaseSnapshotPath = await getVersionPackagePath(params.skillId, release.version);
  const [registryBackup, changelogBackup, lockBackup, packageBackup, releaseSnapshotBackup] = await Promise.all([
    fs.readFile(REGISTRY_PATH, 'utf8'),
    fs.readFile(CHANGELOG_PATH, 'utf8').catch(() => null),
    fs.readFile(LOCK_PATH, 'utf8').catch(() => null),
    fs.readFile(packagePath).catch(() => null),
    fs.readFile(releaseSnapshotPath).catch(() => null),
  ]);

  try {
    await ensureVersionSnapshot(params.skillId, previousVersion);
    resolved.skill.version = release.version;
    if (params.status && ['stable', 'planned', 'deprecated'].includes(params.status)) {
      resolved.skill.status = params.status;
    }
    await writeJson(REGISTRY_PATH, resolved.registry);

    const changelog = await readJson(CHANGELOG_PATH).catch(() => ({ schemaVersion: 1, skills: {} }));
    if (!isRecord(changelog.skills)) {
      changelog.skills = {};
    }
    const skills = changelog.skills as Record<string, JsonRecord>;
    const skillChangelog = isRecord(skills[params.skillId]) ? skills[params.skillId] : {};
    const releases = Array.isArray(skillChangelog.releases) ? skillChangelog.releases as JsonRecord[] : [];
    const nextRelease = {
      version: release.version,
      date: new Date().toISOString().slice(0, 10),
      summary: release.summary,
      changes: release.changes,
    };
    const existingIndex = releases.findIndex((item) => item.version === release.version);
    if (existingIndex >= 0) {
      releases[existingIndex] = nextRelease;
    } else {
      releases.unshift(nextRelease);
    }
    skillChangelog.releases = releases;
    skills[params.skillId] = skillChangelog;
    await writeJson(CHANGELOG_PATH, changelog);

    await packageSkill(params.skillId);
    await ensureVersionSnapshot(params.skillId, release.version);
    await runCommand('npm', ['run', 'check:skills'], ROOT);
    return getSkillsDashboardData();
  } catch (error) {
    await Promise.all([
      fs.writeFile(REGISTRY_PATH, registryBackup, 'utf8'),
      changelogBackup === null
        ? fs.rm(CHANGELOG_PATH, { force: true })
        : fs.writeFile(CHANGELOG_PATH, changelogBackup, 'utf8'),
      lockBackup === null
        ? fs.rm(LOCK_PATH, { force: true })
        : fs.writeFile(LOCK_PATH, lockBackup, 'utf8'),
      packageBackup === null
        ? fs.rm(packagePath, { force: true })
        : fs.mkdir(path.dirname(packagePath), { recursive: true }).then(() => fs.writeFile(packagePath, packageBackup)),
      releaseSnapshotBackup === null
        ? fs.rm(releaseSnapshotPath, { force: true })
        : fs.mkdir(path.dirname(releaseSnapshotPath), { recursive: true })
          .then(() => fs.writeFile(releaseSnapshotPath, releaseSnapshotBackup)),
    ]);
    throw error;
  }
}

async function runCommand(command: string, args: string[], cwd: string) {
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });

  if (result.code !== 0) {
    throw new Error(result.output.trim() || `${command} ${args.join(' ')} 执行失败。`);
  }
  return result.output;
}

async function packageSkill(skillId: string) {
  await validateCompleteSkillDirectory(skillId);
  await runCommand('npm', ['run', 'package:skills', '--', skillId], ROOT);
}

async function ensureVersionSnapshot(skillId: string, version?: string | null) {
  const targetVersion = version ?? await getSkillVersion(skillId);
  if (!targetVersion) return null;
  const sourcePackage = await getCurrentPackagePath(skillId);
  const sourceStat = await fs.stat(sourcePackage).catch(() => null);
  if (!sourceStat?.isFile()) return null;
  const snapshotPath = await getVersionPackagePath(skillId, targetVersion);
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  const existingStat = await fs.lstat(snapshotPath).catch(() => null);
  if (existingStat) {
    if (!existingStat.isFile() || existingStat.isSymbolicLink()) {
      throw new Error(`${skillId}@${targetVersion} 的版本快照不是普通文件。`);
    }
    const [sourceBuffer, snapshotBuffer] = await Promise.all([
      fs.readFile(sourcePackage),
      fs.readFile(snapshotPath),
    ]);
    if (!sourceBuffer.equals(snapshotBuffer)) {
      throw new Error(`${skillId}@${targetVersion} 的版本快照已存在且不可覆盖。`);
    }
    return snapshotPath;
  }
  const temporaryPath = `${snapshotPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.copyFile(sourcePackage, temporaryPath);
  try {
    await fs.rename(temporaryPath, snapshotPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return snapshotPath;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function assertNoUnsafeExtractedPath(
  dir: string,
  root = dir,
  state = { entries: 0, totalBytes: 0 },
) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (!isInside(root, fullPath)) {
      throw new Error('压缩包包含不安全路径。');
    }
    state.entries += 1;
    if (state.entries > MAX_ARCHIVE_ENTRIES) {
      throw new Error(`压缩包展开条目不得超过 ${MAX_ARCHIVE_ENTRIES} 个。`);
    }
    const stat = await fs.lstat(fullPath);
    if (stat.isSymbolicLink()) {
      throw new Error('压缩包不得包含软链接。');
    }
    if (stat.isDirectory()) {
      await assertNoUnsafeExtractedPath(fullPath, root, state);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error('压缩包只能包含普通文件和目录。');
    }
    if (stat.size > MAX_EXTRACTED_FILE_BYTES) {
      throw new Error('压缩包包含超过 10MB 的单个文件。');
    }
    state.totalBytes += stat.size;
    if (state.totalBytes > MAX_EXTRACTED_TOTAL_BYTES) {
      throw new Error('压缩包展开后的文件总量不得超过 50MB。');
    }
  }
  return state;
}

async function validateTarArchive(archivePath: string, extractDir: string) {
  const entries = new Set<string>();
  let totalBytes = 0;
  let validationError: Error | null = null;
  await tar.t({
    file: archivePath,
    onentry: (entry) => {
      if (validationError) return;
      const normalized = entry.path.replace(/^(?:\.\/)+/, '').replace(/\/$/, '');
      const destination = path.resolve(extractDir, normalized);
      if (
        !normalized ||
        normalized.includes('\\') ||
        path.isAbsolute(normalized) ||
        normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
        !isInside(extractDir, destination)
      ) {
        validationError = new Error('压缩包包含不安全路径。');
        return;
      }
      if (entries.has(normalized)) {
        validationError = new Error('压缩包不得包含重复条目。');
        return;
      }
      entries.add(normalized);
      if (entries.size > MAX_ARCHIVE_ENTRIES) {
        validationError = new Error(`压缩包条目不得超过 ${MAX_ARCHIVE_ENTRIES} 个。`);
        return;
      }
      if (!['File', 'Directory'].includes(entry.type)) {
        validationError = new Error('压缩包只能包含普通文件和目录。');
        return;
      }
      if (entry.type === 'File') {
        if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_EXTRACTED_FILE_BYTES) {
          validationError = new Error('压缩包包含尺寸无效或超过 10MB 的文件。');
          return;
        }
        totalBytes += entry.size;
        if (totalBytes > MAX_EXTRACTED_TOTAL_BYTES) {
          validationError = new Error('压缩包展开后的文件总量不得超过 50MB。');
        }
      }
    },
  });
  if (validationError !== null) throw validationError;
  if (entries.size === 0) throw new Error('压缩包不能为空。');
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.name === '.DS_Store') return [];
      if (entry.isDirectory()) return [listFiles(fullPath)];
      if (entry.isFile()) return [Promise.resolve([fullPath])];
      return [];
    })
  );
  return nested.flat().sort();
}

async function findExtractedSkillRoot(extractDir: string, skillId: string) {
  const direct = path.join(extractDir, skillId);
  const directSkillFile = path.join(direct, 'SKILL.md');
  if (await fs.stat(directSkillFile).then((stat) => stat.isFile()).catch(() => false)) {
    return direct;
  }
  const rootSkillFile = path.join(extractDir, 'SKILL.md');
  if (await fs.stat(rootSkillFile).then((stat) => stat.isFile()).catch(() => false)) {
    return extractDir;
  }
  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(extractDir, entry.name);
    const skillFile = path.join(candidate, 'SKILL.md');
    if (await fs.stat(skillFile).then((stat) => stat.isFile()).catch(() => false)) {
      return candidate;
    }
  }
  throw new Error('压缩包中未找到 SKILL.md。');
}

async function copyDir(source: string, target: string) {
  await fs.mkdir(target, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDir(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

async function readTextIfSmall(filePath: string) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.size > MAX_EDITABLE_FILE_BYTES) {
    return { content: null, size: stat?.size ?? null, updatedAt: stat?.mtime.toISOString() ?? null };
  }
  return {
    content: await fs.readFile(filePath, 'utf8').catch(() => null),
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
  };
}

function countLineChanges(previousContent: string | null, currentContent: string | null) {
  const previousLines = previousContent === null ? [] : previousContent.split('\n');
  const currentLines = currentContent === null ? [] : currentContent.split('\n');
  const previousCounts = new Map<string, number>();
  const currentCounts = new Map<string, number>();
  previousLines.forEach((line) => previousCounts.set(line, (previousCounts.get(line) ?? 0) + 1));
  currentLines.forEach((line) => currentCounts.set(line, (currentCounts.get(line) ?? 0) + 1));
  const allLines = new Set([...previousCounts.keys(), ...currentCounts.keys()]);
  let addedLines = 0;
  let removedLines = 0;
  allLines.forEach((line) => {
    const previous = previousCounts.get(line) ?? 0;
    const current = currentCounts.get(line) ?? 0;
    if (current > previous) addedLines += current - previous;
    if (previous > current) removedLines += previous - current;
  });
  return { addedLines, removedLines };
}

function buildDiffPreview(previousContent: string | null, currentContent: string | null) {
  if (previousContent === null && currentContent === null) {
    return ['二进制文件或文件过大，跳过文本预览。'];
  }
  const previousLines = previousContent === null ? [] : previousContent.split('\n');
  const currentLines = currentContent === null ? [] : currentContent.split('\n');
  const preview: string[] = [];
  const maxLines = Math.max(previousLines.length, currentLines.length);
  for (let index = 0; index < maxLines && preview.length < 14; index += 1) {
    const previous = previousLines[index];
    const current = currentLines[index];
    if (previous === current) continue;
    if (previous !== undefined) preview.push(`- ${previous}`);
    if (current !== undefined) preview.push(`+ ${current}`);
  }
  return preview.length > 0 ? preview : ['文件内容有变化。'];
}

async function unpackSkillPackage(skillId: string, packagePath: string, targetDir: string) {
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });
  await validateTarArchive(packagePath, targetDir);
  await tar.x({
    file: packagePath,
    cwd: targetDir,
    preserveOwner: false,
    preservePaths: false,
    strict: true,
    filter: (_entryPath, entry) =>
      'type' in entry && ['File', 'Directory'].includes(String(entry.type)),
  });
  await assertNoUnsafeExtractedPath(targetDir);
  return findExtractedSkillRoot(targetDir, skillId);
}

async function collectRelativeFiles(dir: string) {
  const files = await listFiles(dir);
  return files.map((filePath) => path.relative(dir, filePath).replaceAll(path.sep, '/')).sort();
}

export async function diffSkillVersion(skillId: string): Promise<SkillDiffData> {
  await resolveCoreSkill(skillId);
  const baseVersion = await getSkillVersion(skillId);
  const snapshotPath = baseVersion ? await getVersionPackagePath(skillId, baseVersion) : null;
  const currentPackagePath = await getCurrentPackagePath(skillId);
  const basePackagePath = snapshotPath && await fs.stat(snapshotPath).then((stat) => stat.isFile()).catch(() => false)
    ? snapshotPath
    : await fs.stat(currentPackagePath).then((stat) => stat.isFile()).catch(() => false)
      ? currentPackagePath
      : null;
  const workDir = path.join(TEMP_DIR, 'diff', `${skillId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  const sourceDir = path.join(SKILLS_DIR, skillId);

  try {
    let baseRoot: string | null = null;
    if (basePackagePath) {
      baseRoot = await unpackSkillPackage(skillId, basePackagePath, path.join(workDir, 'base'));
    }
    const previousFiles = baseRoot ? await collectRelativeFiles(baseRoot) : [];
    const currentFiles = await collectRelativeFiles(sourceDir);
    const allFiles = [...new Set([...previousFiles, ...currentFiles])].sort();
    const files: SkillDiffFile[] = [];

    for (const relativePath of allFiles) {
      const previousPath = baseRoot ? path.join(baseRoot, relativePath) : null;
      const currentPath = path.join(sourceDir, relativePath);
      const previousExists = previousPath
        ? await fs.stat(previousPath).then((stat) => stat.isFile()).catch(() => false)
        : false;
      const currentExists = await fs.stat(currentPath).then((stat) => stat.isFile()).catch(() => false);
      if (!previousExists && !currentExists) continue;
      const previous = previousExists && previousPath ? await readTextIfSmall(previousPath) : { content: null, size: null, updatedAt: null };
      const current = currentExists ? await readTextIfSmall(currentPath) : { content: null, size: null, updatedAt: null };
      if (previousExists && currentExists && previous.content !== null && previous.content === current.content) continue;
      if (previousExists && currentExists && previous.content === null && current.content === null && previous.size === current.size) continue;
      const lineChanges = countLineChanges(previous.content, current.content);
      files.push({
        path: relativePath,
        status: previousExists ? currentExists ? 'modified' : 'deleted' : 'added',
        previousSize: previous.size,
        currentSize: current.size,
        previousUpdatedAt: previous.updatedAt,
        currentUpdatedAt: current.updatedAt,
        addedLines: lineChanges.addedLines,
        removedLines: lineChanges.removedLines,
        preview: buildDiffPreview(previous.content, current.content),
      });
    }

    return {
      skillId,
      baseVersion,
      basePackagePath: basePackagePath ? path.relative(ROOT, basePackagePath).replaceAll(path.sep, '/') : null,
      changed: files.length > 0,
      files,
      totals: {
        added: files.filter((file) => file.status === 'added').length,
        modified: files.filter((file) => file.status === 'modified').length,
        deleted: files.filter((file) => file.status === 'deleted').length,
        addedLines: files.reduce((total, file) => total + file.addedLines, 0),
        removedLines: files.reduce((total, file) => total + file.removedLines, 0),
      },
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function rollbackSkillVersion(params: { skillId: string; version: string }): Promise<SkillsDashboardData> {
  await resolveCoreSkill(params.skillId);
  assertSemver(params.version);
  const snapshotPath = await getVersionPackagePath(params.skillId, params.version);
  const snapshotStat = await fs.stat(snapshotPath).catch(() => null);
  if (!snapshotStat?.isFile()) {
    throw new Error(`版本 ${params.version} 缺少可回退快照。`);
  }

  const workDir = path.join(TEMP_DIR, 'rollback', `${params.skillId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  const targetDir = path.join(SKILLS_DIR, params.skillId);
  const backupDir = path.join(workDir, 'backup');
  const currentPackagePath = await getCurrentPackagePath(params.skillId);
  const [registryBackup, lockBackup, packageBackup] = await Promise.all([
    fs.readFile(REGISTRY_PATH, 'utf8'),
    fs.readFile(LOCK_PATH, 'utf8').catch(() => null),
    fs.readFile(currentPackagePath).catch(() => null),
  ]);
  let sourceMoved = false;
  let preserveWorkDirForRecovery = false;

  try {
    const restoredRoot = await unpackSkillPackage(params.skillId, snapshotPath, path.join(workDir, 'extract'));
    const targetStat = await fs.lstat(targetDir).catch(() => null);
    if (!targetStat?.isDirectory() || targetStat.isSymbolicLink()) {
      throw new Error(`${params.skillId} 的现有源码目录不安全，拒绝回退。`);
    }
    await fs.rename(targetDir, backupDir);
    sourceMoved = true;
    await copyDir(restoredRoot, targetDir);

    const resolved = await resolveCoreSkill(params.skillId);
    resolved.skill.version = params.version;
    await writeJson(REGISTRY_PATH, resolved.registry);
    await packageSkill(params.skillId);
    await ensureVersionSnapshot(params.skillId, params.version);
    await runCommand('npm', ['run', 'check:skills'], ROOT);
    return getSkillsDashboardData();
  } catch (error) {
    const recoveryTasks: Promise<unknown>[] = [
      fs.writeFile(REGISTRY_PATH, registryBackup, 'utf8'),
      lockBackup === null ? fs.rm(LOCK_PATH, { force: true }) : fs.writeFile(LOCK_PATH, lockBackup, 'utf8'),
      packageBackup === null
        ? fs.rm(currentPackagePath, { force: true })
        : fs.mkdir(path.dirname(currentPackagePath), { recursive: true })
          .then(() => fs.writeFile(currentPackagePath, packageBackup)),
    ];
    if (sourceMoved) {
      recoveryTasks.push(
        fs.rm(targetDir, { recursive: true, force: true })
          .then(() => fs.rename(backupDir, targetDir)),
      );
    }
    const recovery = await Promise.allSettled(recoveryTasks);
    const recoveryErrors = recovery
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (recoveryErrors.length > 0) {
      preserveWorkDirForRecovery = sourceMoved;
      throw new AggregateError(
        [error, ...recoveryErrors],
        `Skill 回退失败且自动恢复不完整；恢复材料位于 ${workDir}`,
      );
    }
    throw error;
  } finally {
    if (!preserveWorkDirForRecovery) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function uploadSkillPackage(params: UploadSkillPackageParams): Promise<SkillsDashboardData> {
  await resolveCoreSkill(params.skillId);
  const release = normalizeRelease(params);
  if (params.file.size <= 0 || params.file.size > MAX_UPLOAD_BYTES) {
    throw new Error('上传包大小必须在 1B 到 5MB 之间。');
  }
  const fileName = params.file.name.toLowerCase();
  if (!fileName.endsWith('.zip') && !fileName.endsWith('.tgz') && !fileName.endsWith('.tar.gz')) {
    throw new Error('仅支持 .zip、.tgz 或 .tar.gz。');
  }

  const uploadId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const workDir = path.join(TEMP_DIR, `${params.skillId}-${uploadId}`);
  const archivePath = path.join(workDir, params.file.name.replace(/[^a-zA-Z0-9._-]/g, '_'));
  const extractDir = path.join(workDir, 'extract');
  await fs.mkdir(extractDir, { recursive: true });
  await fs.writeFile(archivePath, Buffer.from(await params.file.arrayBuffer()));
  let preserveWorkDirForRecovery = false;

  try {
    if (fileName.endsWith('.zip')) {
      await runCommand('python3', [
        '-c',
        [
          'import stat, sys, zipfile',
          'from pathlib import Path',
          'archive=Path(sys.argv[1])',
          'target=Path(sys.argv[2]).resolve()',
          'max_entries=int(sys.argv[3])',
          'max_file=int(sys.argv[4])',
          'max_total=int(sys.argv[5])',
          'with zipfile.ZipFile(archive) as z:',
          '    items=z.infolist()',
          '    if not items or len(items) > max_entries:',
          '        raise SystemExit("zip entry count is invalid")',
          '    names=set()',
          '    total=0',
          '    for item in items:',
          '        normalized=item.filename.rstrip("/")',
          '        parts=normalized.split("/")',
          '        if not normalized or item.filename.startswith("/") or any(p in ("", ".", "..") for p in parts) or ":" in parts[0]:',
          '            raise SystemExit("unsafe zip path segments")',
          '        if item.filename in names:',
          '            raise SystemExit("duplicate zip entry")',
          '        names.add(item.filename)',
          '        if "\\\\" in item.filename or item.flag_bits & 1:',
          '            raise SystemExit("unsafe or encrypted zip entry")',
          '        destination=(target / item.filename).resolve()',
          '        mode=item.external_attr >> 16',
          '        if mode and not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):',
          '            raise SystemExit("zip may contain only regular files and directories")',
          '        if item.file_size > max_file:',
          '            raise SystemExit("zip member exceeds size limit")',
          '        total += item.file_size',
          '        if total > max_total:',
          '            raise SystemExit("zip expanded size exceeds limit")',
          '        try:',
          '            destination.relative_to(target)',
          '        except ValueError:',
          '            raise SystemExit("unsafe zip path")',
          '    z.extractall(target)',
        ].join('\n'),
        archivePath,
        extractDir,
        String(MAX_ARCHIVE_ENTRIES),
        String(MAX_EXTRACTED_FILE_BYTES),
        String(MAX_EXTRACTED_TOTAL_BYTES),
      ], ROOT);
    } else {
      await validateTarArchive(archivePath, extractDir);
      await tar.x({
        file: archivePath,
        cwd: extractDir,
        preserveOwner: false,
        preservePaths: false,
        strict: true,
        filter: (_entryPath, entry) =>
          'type' in entry && ['File', 'Directory'].includes(String(entry.type)),
      });
    }
    await assertNoUnsafeExtractedPath(extractDir);
    const sourceRoot = await findExtractedSkillRoot(extractDir, params.skillId);
    const files = await listFiles(sourceRoot);
    if (files.length === 0 || files.length > 200) {
      throw new Error('压缩包文件数量不合理。');
    }

    const targetDir = path.join(SKILLS_DIR, params.skillId);
    const backupDir = path.join(workDir, 'backup');
    const targetStat = await fs.lstat(targetDir).catch(() => null);
    if (!targetStat?.isDirectory() || targetStat.isSymbolicLink()) {
      throw new Error(`${params.skillId} 的现有源码目录不安全，拒绝替换。`);
    }
    await fs.rename(targetDir, backupDir);
    try {
      await copyDir(sourceRoot, targetDir);
      await ensureSkillScriptsExecutable(targetDir);
      return await publishSkillVersion({
        skillId: params.skillId,
        version: release.version,
        summary: release.summary,
        changes: release.changes,
        status: params.status,
      });
    } catch (error) {
      await fs.rm(targetDir, { recursive: true, force: true });
      try {
        await fs.rename(backupDir, targetDir);
      } catch (restoreError) {
        preserveWorkDirForRecovery = true;
        throw new AggregateError(
          [error, restoreError],
          `Skill 发布失败且自动恢复失败；原目录保留在 ${backupDir}`,
        );
      }
      throw error;
    }
  } finally {
    if (!preserveWorkDirForRecovery) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
