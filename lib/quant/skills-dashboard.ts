import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

type JsonRecord = Record<string, unknown>;

export type SkillHealthStatus = 'ok' | 'warning' | 'error';

export interface SkillRelease {
  version: string;
  date: string;
  summary: string;
  changes: string[];
  snapshot?: {
    exists: boolean;
    packagePath: string;
  };
}

interface RegistrySkill {
  id: string;
  name: string;
  version: string;
  status: 'stable' | 'planned' | 'deprecated';
  boundary: string;
  inputs?: string[];
  outputs?: string[];
  scripts?: string[];
  endpoints?: string[];
  legacyAliases?: string[];
  validation?: string[];
}

interface SkillLockEntry {
  version?: string | null;
  packagePath?: string;
  sourceSha256?: string;
  packageSha256?: string;
  fileCount?: number;
}

interface SkillsLockFile extends JsonRecord {
  schemaVersion?: number;
  packageFormat?: string;
  skills?: Record<string, SkillLockEntry>;
}

export interface SkillItem {
  id: string;
  name: string;
  version: string;
  status: 'stable' | 'planned' | 'deprecated';
  boundary: string;
  inputs: string[];
  outputs: string[];
  scripts: string[];
  endpoints: string[];
  validation: string[];
  legacyAliases: string[];
  changelog: {
    currentRelease: SkillRelease | null;
    releases: SkillRelease[];
    latestVersion: string | null;
    releaseCount: number;
  };
  lock: {
    version: string | null;
    packagePath: string;
    sourceSha256: string | null;
    packageSha256: string | null;
    fileCount: number | null;
  };
  source: {
    path: string;
    skillFilePath: string;
    fileCount: number;
    directoryCount: number;
    editableFileCount: number;
    referenceFileCount: number;
    scriptFileCount: number;
    assetFileCount: number;
    sourceSha256: string;
    sourceSha256Short: string | null;
    hasScripts: boolean;
    hasReferences: boolean;
    hasAssets: boolean;
    hasAgents: boolean;
    directories: SkillSourceDirectory[];
    files: SkillSourceFile[];
  };
  package: {
    exists: boolean;
    path: string;
    size: number;
    updatedAt: string | null;
    packageSha256: string | null;
    packageSha256Short: string | null;
  };
  health: {
    status: SkillHealthStatus;
    missing: string[];
    sourceChanged: boolean;
    packageChanged: boolean;
    versionMismatch: boolean;
  };
}

export interface SkillsDashboardData {
  generatedAt: string;
  policy: JsonRecord;
  totals: {
    total: number;
    ok: number;
    warning: number;
    error: number;
    stable: number;
    planned: number;
  };
  skills: SkillItem[];
  legacyAliases: Record<string, string>;
  lock: {
    schemaVersion: number;
    packageFormat: string;
  };
}

export type SkillSourceFileKind = 'instruction' | 'reference' | 'script' | 'asset' | 'agent' | 'other';

export interface SkillSourceFile {
  path: string;
  name: string;
  kind: SkillSourceFileKind;
  editable: boolean;
  size: number;
  updatedAt: string | null;
  sha256: string;
  sha256Short: string | null;
}

export interface SkillSourceDirectory {
  path: string;
  name: string;
  kind: SkillSourceFileKind;
  fileCount: number;
  updatedAt: string | null;
}

const ROOT = process.cwd();
const SKILLS_DIR = path.join(ROOT, '.claude', 'skills');
const REGISTRY_PATH = path.join(ROOT, '.claude', 'skills.registry.json');
const CHANGELOG_PATH = path.join(ROOT, '.claude', 'skills.changelog.json');
const LOCK_PATH = path.join(ROOT, '.claude', 'skills.lock.json');

async function readJson(filePath: string): Promise<JsonRecord> {
  const content = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(content);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as JsonRecord)
    : {};
}

async function readJsonAs<T extends JsonRecord>(filePath: string, fallback: T): Promise<T> {
  try {
    return (await readJson(filePath)) as T;
  } catch {
    return fallback;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sha256(buffer: Buffer | string): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.flatMap((entry) => {
      if (entry.name === '.DS_Store') return [];
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) return [listFiles(absolutePath)];
      if (entry.isFile()) return [Promise.resolve([absolutePath])];
      return [];
    })
  );
  return nested.flat().sort();
}

async function listDirectories(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.flatMap((entry) => {
      if (entry.name === '.DS_Store') return [];
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) return [Promise.resolve([absolutePath]), listDirectories(absolutePath)];
      return [];
    })
  );
  return nested.flat().sort();
}

async function hashSkillSource(skillId: string) {
  const sourceDir = path.join(SKILLS_DIR, skillId);
  const files = await listFiles(sourceDir);
  const hash = crypto.createHash('sha256');

  for (const filePath of files) {
    const relativePath = path.relative(sourceDir, filePath).replaceAll(path.sep, '/');
    hash.update(relativePath);
    hash.update('\0');
    hash.update(await fs.readFile(filePath));
    hash.update('\0');
  }

  return {
    fileCount: files.length,
    sourceSha256: hash.digest('hex'),
  };
}

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

function classifySkillFile(relativePath: string): SkillSourceFileKind {
  if (relativePath === 'SKILL.md') return 'instruction';
  if (relativePath.startsWith('references/')) return 'reference';
  if (relativePath.startsWith('scripts/')) return 'script';
  if (relativePath.startsWith('assets/')) return 'asset';
  if (relativePath.startsWith('agents/')) return 'agent';
  return 'other';
}

function classifySkillDirectory(relativePath: string): SkillSourceFileKind {
  if (relativePath === 'references' || relativePath.startsWith('references/')) return 'reference';
  if (relativePath === 'scripts' || relativePath.startsWith('scripts/')) return 'script';
  if (relativePath === 'assets' || relativePath.startsWith('assets/')) return 'asset';
  if (relativePath === 'agents' || relativePath.startsWith('agents/')) return 'agent';
  return 'other';
}

function isEditableSkillFile(relativePath: string): boolean {
  if (relativePath === 'SKILL.md') return true;
  return EDITABLE_SOURCE_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

async function listSkillSourceFiles(skillId: string): Promise<SkillSourceFile[]> {
  const sourceDir = path.join(SKILLS_DIR, skillId);
  const files = await listFiles(sourceDir);
  const items = await Promise.all(files.map(async (filePath) => {
    const relativePath = path.relative(sourceDir, filePath).replaceAll(path.sep, '/');
    const [buffer, stat] = await Promise.all([
      fs.readFile(filePath),
      fs.stat(filePath).catch(() => null),
    ]);
    const digest = sha256(buffer);
    return {
      path: relativePath,
      name: path.basename(relativePath),
      kind: classifySkillFile(relativePath),
      editable: isEditableSkillFile(relativePath),
      size: stat?.size ?? buffer.byteLength,
      updatedAt: stat?.mtime.toISOString() ?? null,
      sha256: digest,
      sha256Short: compactHash(digest),
    };
  }));

  return items.sort((a, b) => {
    const order: Record<SkillSourceFileKind, number> = {
      instruction: 0,
      reference: 1,
      script: 2,
      agent: 3,
      asset: 4,
      other: 5,
    };
    return order[a.kind] - order[b.kind] || a.path.localeCompare(b.path);
  });
}

async function listSkillSourceDirectories(skillId: string): Promise<SkillSourceDirectory[]> {
  const sourceDir = path.join(SKILLS_DIR, skillId);
  const directories = await listDirectories(sourceDir);
  const items = await Promise.all(directories.map(async (directoryPath) => {
    const relativePath = path.relative(sourceDir, directoryPath).replaceAll(path.sep, '/');
    const [stat, files] = await Promise.all([
      fs.stat(directoryPath).catch(() => null),
      listFiles(directoryPath),
    ]);
    return {
      path: relativePath,
      name: path.basename(relativePath),
      kind: classifySkillDirectory(relativePath),
      fileCount: files.length,
      updatedAt: stat?.mtime.toISOString() ?? null,
    };
  }));

  return items.sort((a, b) => {
    const order: Record<SkillSourceFileKind, number> = {
      instruction: 0,
      reference: 1,
      script: 2,
      agent: 3,
      asset: 4,
      other: 5,
    };
    return order[a.kind] - order[b.kind] || a.path.localeCompare(b.path);
  });
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function compactHash(value?: string | null): string | null {
  return value ? `${value.slice(0, 10)}...${value.slice(-8)}` : null;
}

export async function getSkillsDashboardData(): Promise<SkillsDashboardData> {
  const [registry, changelog, lock] = await Promise.all([
    readJson(REGISTRY_PATH),
    readJsonAs(CHANGELOG_PATH, { schemaVersion: 1, skills: {} } as JsonRecord),
    readJsonAs(LOCK_PATH, { schemaVersion: 1, skills: {} } as SkillsLockFile),
  ]);

  const policy = registry.policy && typeof registry.policy === 'object'
    ? (registry.policy as JsonRecord)
    : {};
  const packageDir = path.join(ROOT, String(policy.packageDir ?? '.claude/skill-packages'));
  const coreSkills = Array.isArray(registry.coreSkills) ? registry.coreSkills as RegistrySkill[] : [];
  const changelogSkills = changelog.skills && typeof changelog.skills === 'object'
    ? changelog.skills as Record<string, { releases?: SkillRelease[] }>
    : {};
  const lockSkills = lock.skills && typeof lock.skills === 'object'
    ? lock.skills as Record<string, SkillLockEntry>
    : {};
  const legacyAliases = registry.legacyAliases && typeof registry.legacyAliases === 'object'
    ? registry.legacyAliases as Record<string, string>
    : {};

  const skills = await Promise.all(coreSkills.map(async (skill) => {
    const sourceDir = path.join(SKILLS_DIR, skill.id);
    const skillFilePath = path.join(sourceDir, 'SKILL.md');
    const [sourceHash, sourceFiles, sourceDirectories] = await Promise.all([
      hashSkillSource(skill.id),
      listSkillSourceFiles(skill.id),
      listSkillSourceDirectories(skill.id),
    ]);
    const lockEntry = lockSkills[skill.id] ?? null;
    const packagePath = lockEntry?.packagePath
      ? path.join(ROOT, lockEntry.packagePath)
      : path.join(packageDir, `${skill.id}.tgz`);
    const packageExists = await pathExists(packagePath);
    const packageBuffer = packageExists ? await fs.readFile(packagePath) : null;
    const packageStat = packageExists ? await fs.stat(packagePath) : null;
    const packageSha256 = packageBuffer ? sha256(packageBuffer) : null;
    const releases = await Promise.all((changelogSkills[skill.id]?.releases ?? []).map(async (release) => {
      const snapshotPath = path.join(packageDir, 'versions', skill.id, `${release.version}.tgz`);
      return {
        ...release,
        snapshot: {
          exists: await pathExists(snapshotPath),
          packagePath: path.relative(ROOT, snapshotPath).replaceAll(path.sep, '/'),
        },
      };
    }));
    const currentRelease = releases.find((release) => release.version === skill.version) ?? null;
    const sourceChanged = Boolean(lockEntry?.sourceSha256 && lockEntry.sourceSha256 !== sourceHash.sourceSha256);
    const packageChanged = Boolean(lockEntry?.packageSha256 && packageSha256 && lockEntry.packageSha256 !== packageSha256);
    const versionMismatch = Boolean(lockEntry?.version && lockEntry.version !== skill.version);
    const missing: string[] = [];

    if (!(await pathExists(skillFilePath))) missing.push('SKILL.md');
    if (!currentRelease) missing.push('changelog');
    if (!lockEntry) missing.push('lock');
    if (!packageExists) missing.push('package');
    for (const scriptPath of asStringArray(skill.scripts)) {
      if (!sourceFiles.some((file) => file.path === scriptPath)) {
        missing.push(`script:${scriptPath}`);
      }
    }
    if (sourceChanged) missing.push('source_hash');
    if (packageChanged) missing.push('package_hash');
    if (versionMismatch) missing.push('version_lock');

    const healthStatus: SkillHealthStatus = missing.some((item) => item !== 'source_hash' && item !== 'package_hash')
      ? 'error'
      : missing.length > 0
        ? 'warning'
        : 'ok';

    return {
      ...skill,
      inputs: asStringArray(skill.inputs),
      outputs: asStringArray(skill.outputs),
      scripts: asStringArray(skill.scripts),
      endpoints: asStringArray(skill.endpoints),
      validation: asStringArray(skill.validation),
      legacyAliases: [
        ...asStringArray(skill.legacyAliases),
        ...Object.entries(legacyAliases)
          .filter(([, target]) => target === skill.id)
          .map(([alias]) => alias),
      ],
      changelog: {
        currentRelease,
        releases,
        latestVersion: releases[0]?.version ?? null,
        releaseCount: releases.length,
      },
      lock: {
        version: lockEntry?.version ?? null,
        packagePath: lockEntry?.packagePath ?? path.relative(ROOT, packagePath).replaceAll(path.sep, '/'),
        sourceSha256: lockEntry?.sourceSha256 ?? null,
        packageSha256: lockEntry?.packageSha256 ?? null,
        fileCount: lockEntry?.fileCount ?? null,
      },
      source: {
        path: path.relative(ROOT, sourceDir).replaceAll(path.sep, '/'),
        skillFilePath: path.relative(ROOT, skillFilePath).replaceAll(path.sep, '/'),
        fileCount: sourceHash.fileCount,
        directoryCount: sourceDirectories.length,
        editableFileCount: sourceFiles.filter((file) => file.editable).length,
        referenceFileCount: sourceFiles.filter((file) => file.kind === 'reference').length,
        scriptFileCount: sourceFiles.filter((file) => file.kind === 'script').length,
        assetFileCount: sourceFiles.filter((file) => file.kind === 'asset').length,
        sourceSha256: sourceHash.sourceSha256,
        sourceSha256Short: compactHash(sourceHash.sourceSha256),
        hasScripts: await pathExists(path.join(sourceDir, 'scripts')),
        hasReferences: await pathExists(path.join(sourceDir, 'references')),
        hasAssets: await pathExists(path.join(sourceDir, 'assets')),
        hasAgents: await pathExists(path.join(sourceDir, 'agents')),
        directories: sourceDirectories,
        files: sourceFiles,
      },
      package: {
        exists: packageExists,
        path: path.relative(ROOT, packagePath).replaceAll(path.sep, '/'),
        size: packageStat?.size ?? 0,
        updatedAt: packageStat?.mtime.toISOString() ?? null,
        packageSha256,
        packageSha256Short: compactHash(packageSha256),
      },
      health: {
        status: healthStatus,
        missing,
        sourceChanged,
        packageChanged,
        versionMismatch,
      },
    };
  }));

  const totals = skills.reduce(
    (acc, skill) => {
      acc.total += 1;
      acc[skill.health.status as SkillHealthStatus] += 1;
      if (skill.status === 'stable') acc.stable += 1;
      if (skill.status === 'planned') acc.planned += 1;
      return acc;
    },
    { total: 0, ok: 0, warning: 0, error: 0, stable: 0, planned: 0 }
  );

  return {
    generatedAt: new Date().toISOString(),
    policy,
    totals,
    skills,
    legacyAliases,
    lock: {
      schemaVersion: lock.schemaVersion ?? 1,
      packageFormat: lock.packageFormat ?? String(policy.packageFormat ?? 'tgz'),
    },
  };
}
