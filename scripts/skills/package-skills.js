const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const root = process.cwd();
const registryPath = path.join(root, '.moagent', 'skills.registry.json');
const skillsDir = path.join(root, '.moagent', 'skills');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const configuredPackageDir = registry.policy?.packageDir || '.moagent/skill-packages';
if (
  typeof configuredPackageDir !== 'string' ||
  !configuredPackageDir ||
  path.isAbsolute(configuredPackageDir) ||
  configuredPackageDir.replaceAll('\\', '/').split('/').includes('..')
) {
  fail('registry.policy.packageDir must be a safe repository-relative path');
}
const packageDir = path.resolve(root, configuredPackageDir);
const lockPath = path.join(root, '.moagent', 'skills.lock.json');
const transactionId = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;

function fail(message) {
  console.error(`[package-skills] ${message}`);
  process.exit(1);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    if (entry.name === '.DS_Store') {
      return [];
    }

    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listFiles(absolutePath);
    }
    if (!entry.isFile()) {
      return [];
    }
    return [absolutePath];
  }).sort();
}

const forbiddenSkillFiles = new Set([
  'README.md',
  'CHANGELOG.md',
  'INSTALLATION_GUIDE.md',
  'QUICK_REFERENCE.md',
]);

function assertRegularDirectory(dir, label) {
  const stat = fs.existsSync(dir) ? fs.lstatSync(dir) : null;
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular directory`);
  }
}

function assertRegularFile(filePath, label) {
  const stat = fs.existsSync(filePath) ? fs.lstatSync(filePath) : null;
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular file`);
  }
}

function assertSafeSkillTree(dir, sourceDir, skillId) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const absolutePath = path.join(dir, entry.name);
    const relativePath = path.relative(sourceDir, absolutePath).replaceAll(path.sep, '/');
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) fail(`skill ${skillId} contains a symlink: ${relativePath}`);
    if (stat.isDirectory()) {
      assertSafeSkillTree(absolutePath, sourceDir, skillId);
      continue;
    }
    if (!stat.isFile()) fail(`skill ${skillId} contains an unsupported filesystem entry: ${relativePath}`);
    if (forbiddenSkillFiles.has(path.basename(absolutePath))) {
      fail(`skill ${skillId} contains a forbidden auxiliary file: ${relativePath}`);
    }
  }
}

function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function validateAgentMetadata(agentSource, skillId) {
  let document;
  try {
    document = yaml.load(agentSource, { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    fail(`skill ${skillId} agents/openai.yaml is invalid YAML: ${error.message}`);
  }
  if (
    !document ||
    typeof document !== 'object' ||
    Array.isArray(document) ||
    !document.interface ||
    typeof document.interface !== 'object' ||
    Array.isArray(document.interface)
  ) {
    fail(`skill ${skillId} agents/openai.yaml must contain a root interface mapping`);
  }
  const interfaceBlock = agentSource.match(
    /^interface:\s*(?:#.*)?\r?\n((?:^[ \t]+.*(?:\r?\n|$))*)/m,
  )?.[1] ?? '';
  for (const field of ['display_name', 'short_description', 'default_prompt']) {
    const value = document.interface[field];
    if (typeof value !== 'string' || value.trim() === '') {
      fail(`skill ${skillId} agents/openai.yaml interface.${field} must be a non-empty string`);
    }
    if (!new RegExp(`^  ${field}:\\s*".+"\\s*$`, 'm').test(interfaceBlock)) {
      fail(`skill ${skillId} agents/openai.yaml must quote interface.${field}`);
    }
  }
  const shortLength = Array.from(document.interface.short_description).length;
  if (shortLength < 25 || shortLength > 64) {
    fail(`skill ${skillId} interface.short_description must contain 25-64 characters`);
  }
  if (!document.interface.default_prompt.includes(`$${skillId}`)) {
    fail(`skill ${skillId} interface.default_prompt must mention $${skillId}`);
  }
}

function validateCompleteSkillPackage(skillId) {
  const sourceDir = path.join(skillsDir, skillId);
  const skillFile = path.join(sourceDir, 'SKILL.md');
  const referenceDir = path.join(sourceDir, 'references');
  const scriptDir = path.join(sourceDir, 'scripts');
  const agentDir = path.join(sourceDir, 'agents');
  const agentFile = path.join(agentDir, 'openai.yaml');

  assertRegularDirectory(sourceDir, `skill ${skillId}`);
  assertSafeSkillTree(sourceDir, sourceDir, skillId);
  assertRegularFile(skillFile, `skill ${skillId} SKILL.md`);
  assertRegularDirectory(referenceDir, `skill ${skillId} references/`);
  assertRegularDirectory(scriptDir, `skill ${skillId} scripts/`);
  assertRegularDirectory(agentDir, `skill ${skillId} agents/`);
  assertRegularFile(agentFile, `skill ${skillId} agents/openai.yaml`);

  const referenceFiles = listFiles(referenceDir);
  const scriptFiles = listFiles(scriptDir);
  if (referenceFiles.length === 0 || referenceFiles.some((filePath) => !filePath.endsWith('.md'))) {
    fail(`skill ${skillId} must contain only one or more references/*.md resources`);
  }
  if (
    scriptFiles.length === 0 ||
    scriptFiles.some((filePath) => !/\.(?:py|js|mjs|sh)$/.test(filePath))
  ) {
    fail(`skill ${skillId} must contain one or more supported script resources`);
  }
  for (const scriptFile of scriptFiles) {
    if (process.platform !== 'win32' && (fs.statSync(scriptFile).mode & 0o111) === 0) {
      fail(`skill ${skillId} script must be executable: ${path.relative(sourceDir, scriptFile)}`);
    }
  }

  const skillSource = fs.readFileSync(skillFile, 'utf8');
  const frontmatterMatch = skillSource.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatterMatch) fail(`skill ${skillId} must start with YAML frontmatter`);
  const entries = frontmatterMatch[1]
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
    .map((line) => {
      const separator = line.indexOf(':');
      return separator < 1
        ? [line.trim(), '']
        : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    });
  const keys = new Set(entries.map(([key]) => key));
  const frontmatter = Object.fromEntries(entries);
  if (entries.length !== 2 || keys.size !== 2 || !keys.has('name') || !keys.has('description')) {
    fail(`skill ${skillId} frontmatter must contain only name and description`);
  }
  if (unquoteYamlScalar(frontmatter.name) !== skillId || !unquoteYamlScalar(frontmatter.description)) {
    fail(`skill ${skillId} frontmatter name/description is invalid`);
  }

  for (const filePath of referenceFiles) {
    const relativePath = path.relative(sourceDir, filePath).replaceAll(path.sep, '/');
    if (!skillSource.includes(`](${relativePath})`)) {
      fail(`skill ${skillId} SKILL.md must directly link ${relativePath}`);
    }
  }
  for (const filePath of scriptFiles) {
    const relativePath = path.relative(sourceDir, filePath).replaceAll(path.sep, '/');
    if (!skillSource.includes(relativePath)) {
      fail(`skill ${skillId} SKILL.md must document ${relativePath}`);
    }
  }

  validateAgentMetadata(fs.readFileSync(agentFile, 'utf8'), skillId);

  const coreSkill = registry.coreSkills.find((skill) => skill.id === skillId);
  if (coreSkill) {
    const discoveredReferences = referenceFiles
      .map((filePath) => path.relative(sourceDir, filePath).replaceAll(path.sep, '/'))
      .sort();
    const discoveredScripts = scriptFiles
      .map((filePath) => path.relative(sourceDir, filePath).replaceAll(path.sep, '/'))
      .sort();
    const registeredReferences = Array.isArray(coreSkill.references)
      ? [...coreSkill.references].sort()
      : [];
    const registeredScripts = Array.isArray(coreSkill.scripts)
      ? [...coreSkill.scripts].sort()
      : [];
    if (JSON.stringify(discoveredReferences) !== JSON.stringify(registeredReferences)) {
      fail(`skill ${skillId} registry.references must list every packaged reference`);
    }
    if (JSON.stringify(discoveredScripts) !== JSON.stringify(registeredScripts)) {
      fail(`skill ${skillId} registry.scripts must list every packaged script`);
    }
  }
}

function hashSkillSource(skillId) {
  const sourceDir = path.join(skillsDir, skillId);
  const files = listFiles(sourceDir);
  const hash = crypto.createHash('sha256');
  for (const filePath of files) {
    const relativePath = path.relative(sourceDir, filePath).replaceAll(path.sep, '/');
    hash.update(relativePath);
    hash.update('\0');
    hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  }
  return {
    fileCount: files.length,
    sourceSha256: hash.digest('hex'),
  };
}

function readLockFile() {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (!lock || typeof lock !== 'object' || Array.isArray(lock) ||
      lock.schemaVersion !== 1 || !lock.skills || typeof lock.skills !== 'object' || Array.isArray(lock.skills)) {
      fail(`${path.relative(root, lockPath)} has an invalid schema`);
    }
    return lock;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      fail(`${path.relative(root, lockPath)} cannot be read: ${error.message}`);
    }
    return {
      schemaVersion: 1,
      packageFormat: registry.policy.packageFormat || 'tgz',
      skills: {},
    };
  }
}

function getSkillVersion(skillId) {
  const coreSkill = registry.coreSkills.find((skill) => skill.id === skillId);
  return coreSkill?.version || null;
}

function packageSkill(skillId) {
  const sourceDir = path.join(skillsDir, skillId);
  validateCompleteSkillPackage(skillId);

  const sourceHash = hashSkillSource(skillId);
  fs.mkdirSync(packageDir, { recursive: true });
  const outputPath = path.join(packageDir, `${skillId}.tgz`);
  const stagedPath = path.join(packageDir, `.${skillId}.${transactionId}.tgz.tmp`);
  const result = spawnSync(
    'tar',
    [
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '-czf',
      stagedPath,
      '-C',
      skillsDir,
      skillId,
    ],
    { cwd: root, stdio: 'inherit' }
  );
  if (result.status !== 0) {
    fs.rmSync(stagedPath, { force: true });
    fail(`tar failed for ${skillId}`);
  }
  const packageSha256 = sha256(fs.readFileSync(stagedPath));
  return {
    outputPath,
    stagedPath,
    packageSha256,
    ...sourceHash,
  };
}

function commitArtifacts(outputs, lock) {
  const lockTemp = `${lockPath}.${transactionId}.tmp`;
  const lockBackup = `${lockPath}.${transactionId}.backup`;
  const states = outputs.map((output) => ({
    ...output,
    backupPath: `${output.outputPath}.${transactionId}.backup`,
    hadExisting: fs.existsSync(output.outputPath),
    installed: false,
  }));
  const hadLock = fs.existsSync(lockPath);
  let lockInstalled = false;
  let commitSucceeded = false;
  let recoveryFailed = false;
  fs.writeFileSync(lockTemp, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  try {
    for (const state of states) {
      if (state.hadExisting) fs.renameSync(state.outputPath, state.backupPath);
      fs.renameSync(state.stagedPath, state.outputPath);
      state.installed = true;
    }
    if (hadLock) fs.renameSync(lockPath, lockBackup);
    fs.renameSync(lockTemp, lockPath);
    lockInstalled = true;
    commitSucceeded = true;
  } catch (error) {
    const recoveryErrors = [];
    try {
      if (lockInstalled) fs.rmSync(lockPath, { force: true });
      if (hadLock && fs.existsSync(lockBackup)) fs.renameSync(lockBackup, lockPath);
    } catch (recoveryError) {
      recoveryErrors.push(recoveryError);
    }
    for (const state of [...states].reverse()) {
      try {
        if (state.installed) fs.rmSync(state.outputPath, { force: true });
        if (state.hadExisting && fs.existsSync(state.backupPath)) {
          fs.renameSync(state.backupPath, state.outputPath);
        }
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError);
      }
    }
    if (recoveryErrors.length > 0) {
      recoveryFailed = true;
      throw new AggregateError(
        [error, ...recoveryErrors],
        `package commit and recovery failed; backups with transaction ${transactionId} were preserved`,
      );
    }
    throw error;
  } finally {
    fs.rmSync(lockTemp, { force: true });
    if (commitSucceeded) fs.rmSync(lockBackup, { force: true });
    for (const state of states) {
      fs.rmSync(state.stagedPath, { force: true });
      if (commitSucceeded) fs.rmSync(state.backupPath, { force: true });
    }
    if (recoveryFailed) {
      console.error(`[package-skills] recovery artifacts preserved for transaction ${transactionId}`);
    }
  }
}

const rawArgs = process.argv.slice(2);
const requested = rawArgs;
const coreIds = registry.coreSkills.map((skill) => skill.id);
for (const skillId of requested) {
  if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(skillId)) {
    fail(`unsafe skill id: ${skillId}`);
  }
  if (!coreIds.includes(skillId)) {
    fail(`unknown skill id: ${skillId}`);
  }
}
const scriptCheck = spawnSync(
  process.execPath,
  [path.join(root, 'scripts', 'checks', 'check-skill-scripts.js')],
  { cwd: root, stdio: 'inherit' },
);
if (scriptCheck.status !== 0) fail('skill script validation failed');
const skillIds = Array.from(new Set(requested.length ? requested : coreIds));
const lock = readLockFile();
lock.schemaVersion = 1;
lock.packageFormat = registry.policy.packageFormat || 'tgz';
lock.skills = lock.skills && typeof lock.skills === 'object' ? lock.skills : {};

const outputs = [];
for (const skillId of skillIds) {
  const output = packageSkill(skillId);
  outputs.push(output);
  lock.skills[skillId] = {
    version: getSkillVersion(skillId),
    packagePath: path.relative(root, output.outputPath).replaceAll(path.sep, '/'),
    sourceSha256: output.sourceSha256,
    packageSha256: output.packageSha256,
    fileCount: output.fileCount,
  };
}

try {
  commitArtifacts(outputs, lock);
} catch (error) {
  fail(`atomic package commit failed: ${error.message}`);
}
for (const output of outputs) {
  console.log(`[package-skills] ${path.basename(output.outputPath, '.tgz')} -> ${path.relative(root, output.outputPath)}`);
}
console.log(`[package-skills] lock -> ${path.relative(root, lockPath)}`);
