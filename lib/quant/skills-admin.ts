import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
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

const ROOT = process.cwd();
const SKILLS_DIR = path.join(ROOT, '.claude', 'skills');
const REGISTRY_PATH = path.join(ROOT, '.claude', 'skills.registry.json');
const CHANGELOG_PATH = path.join(ROOT, '.claude', 'skills.changelog.json');
const LOCK_PATH = path.join(ROOT, '.claude', 'skills.lock.json');
const TEMP_DIR = path.join(ROOT, 'tmp', 'skill-uploads');
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_EDITABLE_FILE_BYTES = 512 * 1024;
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
  return path.join(ROOT, String(policy.packageDir ?? '.claude/skill-packages'));
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
  return readSkillFile(params.skillId, resolved.relativePath);
}

export async function deleteSkillFile(params: DeleteSkillFileParams): Promise<SkillsDashboardData> {
  const resolved = await resolveSkillFilePath(params.skillId, params.filePath);
  if (resolved.relativePath === 'SKILL.md') {
    throw new Error('不能删除 SKILL.md。');
  }
  const stat = await fs.stat(resolved.absolutePath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`文件不存在：${resolved.relativePath}`);
  }
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
  const stat = await fs.lstat(resolved.absolutePath).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`文件夹不存在：${resolved.relativePath}`);
  }
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
  const policy = isRecord(resolved.registry.policy) ? resolved.registry.policy : {};
  const packageDir = path.join(ROOT, String(policy.packageDir ?? '.claude/skill-packages'));
  const packagePath = path.join(packageDir, `${params.skillId}.tgz`);
  const [registryBackup, changelogBackup, lockBackup, packageBackup] = await Promise.all([
    fs.readFile(REGISTRY_PATH, 'utf8'),
    fs.readFile(CHANGELOG_PATH, 'utf8').catch(() => null),
    fs.readFile(LOCK_PATH, 'utf8').catch(() => null),
    fs.readFile(packagePath).catch(() => null),
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
  await fs.copyFile(sourcePackage, snapshotPath);
  return snapshotPath;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function assertNoUnsafeExtractedPath(dir: string) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (!isInside(dir, fullPath)) {
      throw new Error('压缩包包含不安全路径。');
    }
    if (entry.isSymbolicLink()) {
      throw new Error('压缩包不得包含软链接。');
    }
    if (entry.isDirectory()) {
      await assertNoUnsafeExtractedPath(fullPath);
    }
  }
}

async function validateTarArchive(archivePath: string, extractDir: string) {
  const listing = await runCommand('tar', ['-tzf', archivePath], ROOT);
  for (const rawEntry of listing.split('\n')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const normalized = entry.replace(/^\.\//, '');
    const destination = path.resolve(extractDir, normalized);
    if (!normalized || path.isAbsolute(normalized) || !isInside(extractDir, destination)) {
      throw new Error('压缩包包含不安全路径。');
    }
  }

  const verboseListing = await runCommand('tar', ['-tvzf', archivePath], ROOT);
  const hasLinkEntry = verboseListing
    .split('\n')
    .some((line) => line.startsWith('l') || line.startsWith('h'));
  if (hasLinkEntry) {
    throw new Error('压缩包不得包含软链接或硬链接。');
  }
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
  await runCommand('tar', ['--no-same-owner', '-xzf', packagePath, '-C', targetDir], ROOT);
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
  const [registryBackup, lockBackup, packageBackup] = await Promise.all([
    fs.readFile(REGISTRY_PATH, 'utf8'),
    fs.readFile(LOCK_PATH, 'utf8').catch(() => null),
    fs.readFile(await getCurrentPackagePath(params.skillId)).catch(() => null),
  ]);

  try {
    await copyDir(targetDir, backupDir).catch(() => undefined);
    const restoredRoot = await unpackSkillPackage(params.skillId, snapshotPath, path.join(workDir, 'extract'));
    await fs.rm(targetDir, { recursive: true, force: true });
    await copyDir(restoredRoot, targetDir);

    const resolved = await resolveCoreSkill(params.skillId);
    resolved.skill.version = params.version;
    await writeJson(REGISTRY_PATH, resolved.registry);
    await packageSkill(params.skillId);
    await ensureVersionSnapshot(params.skillId, params.version);
    return getSkillsDashboardData();
  } catch (error) {
    await Promise.all([
      fs.rm(targetDir, { recursive: true, force: true }).then(() => copyDir(backupDir, targetDir)).catch(() => undefined),
      fs.writeFile(REGISTRY_PATH, registryBackup, 'utf8'),
      lockBackup === null ? fs.rm(LOCK_PATH, { force: true }) : fs.writeFile(LOCK_PATH, lockBackup, 'utf8'),
      packageBackup === null
        ? getCurrentPackagePath(params.skillId).then((packagePath) => fs.rm(packagePath, { force: true }))
        : getCurrentPackagePath(params.skillId).then((packagePath) => fs.mkdir(path.dirname(packagePath), { recursive: true }).then(() => fs.writeFile(packagePath, packageBackup))),
    ]);
    throw error;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
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

  try {
    if (fileName.endsWith('.zip')) {
      await runCommand('python3', [
        '-c',
        [
          'import stat, sys, zipfile',
          'from pathlib import Path',
          'archive=Path(sys.argv[1])',
          'target=Path(sys.argv[2]).resolve()',
          'with zipfile.ZipFile(archive) as z:',
          '    for item in z.infolist():',
          '        destination=(target / item.filename).resolve()',
          '        mode=item.external_attr >> 16',
          '        if stat.S_ISLNK(mode):',
          '            raise SystemExit("zip symlink is not allowed")',
          '        try:',
          '            destination.relative_to(target)',
          '        except ValueError:',
          '            raise SystemExit("unsafe zip path")',
          '    z.extractall(target)',
        ].join('\n'),
        archivePath,
        extractDir,
      ], ROOT);
    } else {
      await validateTarArchive(archivePath, extractDir);
      await runCommand('tar', ['--no-same-owner', '-xzf', archivePath, '-C', extractDir], ROOT);
    }
    await assertNoUnsafeExtractedPath(extractDir);
    const sourceRoot = await findExtractedSkillRoot(extractDir, params.skillId);
    const files = await listFiles(sourceRoot);
    if (files.length === 0 || files.length > 200) {
      throw new Error('压缩包文件数量不合理。');
    }

    const targetDir = path.join(SKILLS_DIR, params.skillId);
    const backupDir = path.join(workDir, 'backup');
    await fs.rm(backupDir, { recursive: true, force: true });
    await copyDir(targetDir, backupDir).catch(() => undefined);
    await fs.rm(targetDir, { recursive: true, force: true });
    await copyDir(sourceRoot, targetDir);

    try {
      return await publishSkillVersion({
        skillId: params.skillId,
        version: release.version,
        summary: release.summary,
        changes: release.changes,
        status: params.status,
      });
    } catch (error) {
      await fs.rm(targetDir, { recursive: true, force: true });
      await copyDir(backupDir, targetDir).catch(() => undefined);
      throw error;
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
