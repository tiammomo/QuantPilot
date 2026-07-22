const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const tar = require('tar');

const root = process.cwd();
const registryPath = path.join(root, '.moagent', 'skills.registry.json');
const skillsDir = path.join(root, '.moagent', 'skills');
const changelogPath = path.join(root, '.moagent', 'skills.changelog.json');
const lockPath = path.join(root, '.moagent', 'skills.lock.json');
const capsuleRegistryPath = path.join(root, 'config', 'moagent-skill-capsules.json');

function fail(message) {
  console.error(`[skills-registry] ${message}`);
  process.exit(1);
}

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
const checkLock = process.argv.includes('--check-lock');

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

const obsoleteSkillIds = [
  'quant-a-share-history',
  'quant-index-etf-market',
  'quant-comparison',
  'quant-fundamental-financials',
  'quant-fundamental-indicators',
  'quant-announcement-events',
  'quant-technical-indicators',
  'quant-run-planner',
  'quant-image-extraction',
  'quant-data-quality',
  'quant-visualization-html',
];

const obsoleteContractFragments = [
  '.quantpilot/',
  '.claude/skills/',
];

function assertCurrentSkillContract(filePath, sourceDir, skillId) {
  const source = fs.readFileSync(filePath, 'utf8');
  const relativePath = path.relative(sourceDir, filePath).replaceAll(path.sep, '/');
  for (const obsoleteSkillId of obsoleteSkillIds) {
    if (source.includes(obsoleteSkillId)) {
      fail(`skill ${skillId} references removed Skill ID ${obsoleteSkillId} in ${relativePath}`);
    }
  }
  for (const fragment of obsoleteContractFragments) {
    if (source.includes(fragment)) {
      fail(`skill ${skillId} references removed contract path ${fragment} in ${relativePath}`);
    }
  }
}

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
    if (stat.isSymbolicLink()) {
      fail(`skill ${skillId} contains a symlink: ${relativePath}`);
    }
    if (stat.isDirectory()) {
      assertSafeSkillTree(absolutePath, sourceDir, skillId);
      continue;
    }
    if (!stat.isFile()) {
      fail(`skill ${skillId} contains an unsupported filesystem entry: ${relativePath}`);
    }
    if (forbiddenSkillFiles.has(path.basename(absolutePath))) {
      fail(`skill ${skillId} contains an auxiliary file that does not belong in a skill: ${relativePath}`);
    }
  }
}

function resourceFiles(dir, predicate) {
  return listFiles(dir).filter((filePath) => predicate(path.basename(filePath)));
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
  assertRegularDirectory(sourceDir, `skill ${skillId}`);
  assertSafeSkillTree(sourceDir, sourceDir, skillId);

  const skillFile = path.join(sourceDir, 'SKILL.md');
  const referenceDir = path.join(sourceDir, 'references');
  const scriptDir = path.join(sourceDir, 'scripts');
  const agentDir = path.join(sourceDir, 'agents');
  const agentFile = path.join(sourceDir, 'agents', 'openai.yaml');
  assertRegularFile(skillFile, `complete skill ${skillId} SKILL.md`);
  assertRegularDirectory(referenceDir, `complete skill ${skillId} references/`);
  assertRegularDirectory(scriptDir, `complete skill ${skillId} scripts/`);
  assertRegularDirectory(agentDir, `complete skill ${skillId} agents/`);
  assertRegularFile(agentFile, `complete skill ${skillId} agents/openai.yaml`);

  const allReferenceFiles = listFiles(referenceDir);
  const allScriptFiles = listFiles(scriptDir);
  const referenceFiles = resourceFiles(referenceDir, (name) => name.endsWith('.md'));
  const scriptFiles = resourceFiles(scriptDir, (name) => /\.(?:py|js|mjs|sh)$/.test(name));
  if (referenceFiles.length !== allReferenceFiles.length) {
    fail(`complete skill ${skillId} references/ may only contain Markdown reference files`);
  }
  if (scriptFiles.length !== allScriptFiles.length) {
    fail(`complete skill ${skillId} scripts/ contains an unsupported script type`);
  }
  if (referenceFiles.length === 0) {
    fail(`complete skill ${skillId} must contain at least one references/*.md file`);
  }
  if (scriptFiles.length === 0) {
    fail(`complete skill ${skillId} must contain at least one executable script resource`);
  }

  for (const filePath of [skillFile, agentFile, ...referenceFiles, ...scriptFiles]) {
    assertCurrentSkillContract(filePath, sourceDir, skillId);
  }

  const skillSource = fs.readFileSync(skillFile, 'utf8');
  const frontmatterMatch = skillSource.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatterMatch) fail(`skill ${skillId} must start with YAML frontmatter`);
  const frontmatterEntries = frontmatterMatch[1]
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
    .map((line) => {
      const separator = line.indexOf(':');
      return separator < 1
        ? [line.trim(), '']
        : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    });
  const frontmatterKeys = new Set(frontmatterEntries.map(([key]) => key));
  if (
    frontmatterEntries.length !== 2 ||
    frontmatterKeys.size !== 2 ||
    !frontmatterKeys.has('name') ||
    !frontmatterKeys.has('description')
  ) {
    fail(`skill ${skillId} frontmatter must contain only name and description`);
  }
  const frontmatter = Object.fromEntries(frontmatterEntries);
  if (unquoteYamlScalar(frontmatter.name) !== skillId) {
    fail(`skill ${skillId} frontmatter name must match its directory`);
  }
  if (!unquoteYamlScalar(frontmatter.description)) {
    fail(`skill ${skillId} frontmatter description must be non-empty`);
  }

  for (const referenceFile of referenceFiles) {
    const relativePath = path.relative(sourceDir, referenceFile).replaceAll(path.sep, '/');
    if (!skillSource.includes(`](${relativePath})`)) {
      fail(`skill ${skillId} must directly link reference ${relativePath} from SKILL.md`);
    }
  }
  for (const scriptFile of scriptFiles) {
    const relativePath = path.relative(sourceDir, scriptFile).replaceAll(path.sep, '/');
    if (!skillSource.includes(relativePath)) {
      fail(`skill ${skillId} must document script ${relativePath} in SKILL.md`);
    }
  }

  validateAgentMetadata(fs.readFileSync(agentFile, 'utf8'), skillId);

  return {
    references: referenceFiles.map((filePath) =>
      path.relative(sourceDir, filePath).replaceAll(path.sep, '/')),
    scripts: scriptFiles.map((filePath) =>
      path.relative(sourceDir, filePath).replaceAll(path.sep, '/')),
  };
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

function hashPackagedSkillSource(packagePath, skillId) {
  const prefix = `${skillId}/`;
  const files = new Map();
  let entryCount = 0;
  let totalBytes = 0;
  try {
    tar.t({
      file: packagePath,
      sync: true,
      onentry(entry) {
        entryCount += 1;
        if (entryCount > 500) fail(`package ${skillId} contains too many entries`);
        const normalized = entry.path.replace(/^(?:\.\/)+/, '').replace(/\/$/, '');
        const segments = normalized.split('/');
        if (
          !normalized ||
          normalized.includes('\\') ||
          path.posix.isAbsolute(normalized) ||
          segments.some((segment) => !segment || segment === '.' || segment === '..') ||
          (normalized !== skillId && !normalized.startsWith(prefix))
        ) {
          fail(`package ${skillId} contains an unsafe entry: ${entry.path}`);
        }
        if (!['File', 'Directory'].includes(entry.type)) {
          fail(`package ${skillId} contains an unsafe entry type: ${entry.type}`);
        }
        if (entry.type !== 'File') return;
        const relativePath = normalized.slice(prefix.length);
        if (!relativePath || files.has(relativePath)) {
          fail(`package ${skillId} contains a duplicate or invalid file entry: ${relativePath}`);
        }
        if (relativePath.startsWith('scripts/') && ((entry.mode ?? 0) & 0o111) === 0) {
          fail(`package ${skillId} contains a non-executable script: ${relativePath}`);
        }
        if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 10 * 1024 * 1024) {
          fail(`package ${skillId} contains a file with an invalid expanded size: ${relativePath}`);
        }
        const chunks = [];
        entry.on('data', (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.byteLength;
          if (totalBytes > 50 * 1024 * 1024) {
            fail(`package ${skillId} exceeds expanded size limits`);
          }
          chunks.push(buffer);
        });
        entry.on('end', () => files.set(relativePath, Buffer.concat(chunks)));
      },
    });
  } catch (error) {
    fail(`package ${skillId} cannot be inspected: ${error.message}`);
  }
  const hash = crypto.createHash('sha256');
  for (const relativePath of [...files.keys()].sort()) {
    const content = files.get(relativePath);
    hash.update(relativePath);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return { fileCount: files.size, sourceSha256: hash.digest('hex') };
}

function parseJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function isSemver(version) {
  return /^\d+\.\d+\.\d+$/.test(version);
}

function validateLockPackagePath(skillId, lockEntry, expectedPackagePath) {
  const normalized = typeof lockEntry?.packagePath === 'string'
    ? lockEntry.packagePath.replaceAll('\\', '/')
    : '';
  const expected = path.relative(root, expectedPackagePath).replaceAll(path.sep, '/');
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    normalized.split('/').includes('..') ||
    normalized !== expected
  ) {
    fail(`lock packagePath mismatch for ${skillId}: expected=${expected}, lock=${normalized || '<missing>'}`);
  }
}

const validScopes = new Set(['workflow', 'quant', 'input', 'evidence', 'platform', 'visualization']);
const validCapsulePhases = new Set([
  'planning',
  'data-preparation',
  'workspace-generation',
  'validation-repair',
  'platform-ui',
]);
const forbiddenCapsuleInstructions = [
  /mcp__/i,
  /\.moagent\/skills\//i,
  /\bcurl\b/i,
  /\bbash\b/i,
  /\bpython3?\b/i,
  /\bnpm\s+run\b/i,
  /\bcat\s*>/i,
  /\bheredoc\b/i,
];

function assertStringArray(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(`${label} must be ${allowEmpty ? 'a' : 'a non-empty'} string array`);
  }
  if (value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    fail(`${label} must contain only non-empty strings`);
  }
}

function validateCapsuleRegistry(coreSkillIds) {
  const capsules = parseJsonFile(capsuleRegistryPath);
  if (!capsules || capsules.schemaVersion !== 1 || !capsules.skills ||
    typeof capsules.skills !== 'object' || Array.isArray(capsules.skills)) {
    fail('config/moagent-skill-capsules.json must use schemaVersion 1 and contain skills');
  }
  const responseContract = capsules.workspaceResponseContract;
  if (!responseContract || responseContract.schemaVersion !== 1 ||
    responseContract.owner !== 'platform') {
    fail('workspaceResponseContract must be a platform-owned schemaVersion 1 contract');
  }
  assertStringArray(
    responseContract.stageLabels,
    'workspaceResponseContract.stageLabels',
    { allowEmpty: false },
  );
  if (responseContract.stageLabels.length !== 5) {
    fail('workspaceResponseContract must define exactly five stage labels');
  }
  assertStringArray(
    responseContract.rules,
    'workspaceResponseContract.rules',
    { allowEmpty: false },
  );

  for (const capsuleId of Object.keys(capsules.skills)) {
    if (!coreSkillIds.has(capsuleId)) {
      fail(`runtime capsule points to unknown core skill: ${capsuleId}`);
    }
  }

  for (const skillId of coreSkillIds) {
    const capsule = capsules.skills[skillId];
    if (!capsule || typeof capsule !== 'object' || Array.isArray(capsule)) {
      fail(`missing MoAgent runtime capsule for core skill: ${skillId}`);
    }
    if (!Number.isSafeInteger(capsule.priority) || capsule.priority < 1) {
      fail(`runtime capsule ${skillId} priority must be a positive integer`);
    }
    assertStringArray(capsule.phases, `runtime capsule ${skillId}.phases`, { allowEmpty: false });
    if (capsule.phases.some((phase) => !validCapsulePhases.has(phase))) {
      fail(`runtime capsule ${skillId} contains an invalid phase`);
    }
    assertStringArray(capsule.requiresTools, `runtime capsule ${skillId}.requiresTools`);
    if (capsule.requiresTools.some((tool) => !/^[a-z][a-z0-9_]*$/.test(tool))) {
      fail(`runtime capsule ${skillId} contains an invalid typed-tool name`);
    }
    if (typeof capsule.objective !== 'string' || capsule.objective.trim() === '') {
      fail(`runtime capsule ${skillId}.objective must be a non-empty string`);
    }
    for (const field of ['invariants', 'workflow', 'doneWhen']) {
      assertStringArray(capsule[field], `runtime capsule ${skillId}.${field}`, { allowEmpty: false });
    }
    if (!Array.isArray(capsule.resources)) {
      fail(`runtime capsule ${skillId}.resources must be an array`);
    }

    const serialized = JSON.stringify(capsule);
    if (forbiddenCapsuleInstructions.some((pattern) => pattern.test(serialized))) {
      fail(`runtime capsule ${skillId} contains instructions incompatible with MoAgent typed tools`);
    }

    const resourceIds = new Set();
    for (const resource of capsule.resources) {
      if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
        fail(`runtime capsule ${skillId} contains an invalid resource`);
      }
      if (typeof resource.id !== 'string' || resource.id.trim() === '' || resourceIds.has(resource.id)) {
        fail(`runtime capsule ${skillId} resource ids must be unique non-empty strings`);
      }
      resourceIds.add(resource.id);
      const normalizedPath = typeof resource.path === 'string'
        ? resource.path.replaceAll('\\', '/')
        : '';
      if (!normalizedPath.startsWith('references/') || !normalizedPath.endsWith('.md') ||
        normalizedPath.startsWith('/') || normalizedPath.split('/').includes('..')) {
        fail(`runtime capsule ${skillId} has an unsafe resource path: ${String(resource.path)}`);
      }
      const sourcePath = path.join(skillsDir, skillId, normalizedPath);
      const stat = fs.existsSync(sourcePath) ? fs.lstatSync(sourcePath) : null;
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        fail(`runtime capsule ${skillId} resource is missing or unsafe: ${normalizedPath}`);
      }
      assertStringArray(resource.profiles, `runtime capsule ${skillId}.${resource.id}.profiles`, {
        allowEmpty: false,
      });
      if (resource.profiles.some((phase) =>
        !validCapsulePhases.has(phase) || !capsule.phases.includes(phase))) {
        fail(`runtime capsule ${skillId}.${resource.id} uses a phase outside its capsule`);
      }
      if (!['template-heading', 'named-headings'].includes(resource.selector)) {
        fail(`runtime capsule ${skillId}.${resource.id} has an invalid selector`);
      }
      if (!Number.isSafeInteger(resource.maxChars) || resource.maxChars < 256) {
        fail(`runtime capsule ${skillId}.${resource.id}.maxChars must be at least 256`);
      }
      if (typeof resource.required !== 'boolean') {
        fail(`runtime capsule ${skillId}.${resource.id}.required must be boolean`);
      }
      if (resource.selector === 'named-headings') {
        assertStringArray(resource.headings, `runtime capsule ${skillId}.${resource.id}.headings`, {
          allowEmpty: false,
        });
      }
    }
  }
}

function validateSkillNaming(skill) {
  if (!validScopes.has(skill.scope)) {
    fail(`core skill ${skill.id} must declare a valid scope: ${Array.from(validScopes).join(', ')}`);
  }
  if (skill.id.startsWith('quantpilot-')) {
    fail(`core skill ${skill.id} should not use quantpilot- prefix; use a scope-based name instead`);
  }
  if (skill.scope === 'quant' && !skill.id.startsWith('quant-')) {
    fail(`quant scoped core skill ${skill.id} must use quant- prefix`);
  }
  if (skill.scope !== 'quant' && skill.id.startsWith('quant-')) {
    fail(`non-quant core skill ${skill.id} must not use quant- prefix`);
  }
  if (skill.scope === 'platform' && !skill.id.startsWith('platform-')) {
    fail(`platform scoped core skill ${skill.id} must use platform- prefix`);
  }
  if (skill.scope !== 'platform' && skill.id.startsWith('platform-')) {
    fail(`non-platform core skill ${skill.id} must not use platform- prefix`);
  }
}

const changelog = parseJsonFile(changelogPath, { schemaVersion: 1, skills: {} });
const lock = parseJsonFile(lockPath, { schemaVersion: 1, skills: {} });
if (registry.schemaVersion !== 1) {
  fail('schemaVersion must be 1');
}

if (!Array.isArray(registry.coreSkills) || registry.coreSkills.length === 0) {
  fail('coreSkills must be a non-empty array');
}

const ids = new Set();
for (const skill of registry.coreSkills) {
  if (!skill.id || !skill.name || !skill.version || !skill.status || !skill.scope || !skill.boundary) {
    fail(`core skill is missing required fields: ${JSON.stringify(skill)}`);
  }
  validateSkillNaming(skill);
  if (!isSemver(skill.version)) {
    fail(`core skill ${skill.id} version must be semver x.y.z, got: ${skill.version}`);
  }
  if (ids.has(skill.id)) {
    fail(`duplicate core skill id: ${skill.id}`);
  }
  ids.add(skill.id);

  for (const resourceField of ['scripts', 'references']) {
    assertStringArray(skill[resourceField], `core skill ${skill.id}.${resourceField}`, {
      allowEmpty: false,
    });
    for (const resourcePath of skill[resourceField]) {
      const normalizedPath = resourcePath.replaceAll('\\', '/');
      const expectedPrefix = `${resourceField}/`;
      if (
        !normalizedPath.startsWith(expectedPrefix) ||
        normalizedPath.startsWith('/') ||
        normalizedPath.split('/').includes('..')
      ) {
        fail(`core skill ${skill.id} has an unsafe ${resourceField} path: ${resourcePath}`);
      }
      const absolutePath = path.join(skillsDir, skill.id, normalizedPath);
      const stat = fs.existsSync(absolutePath) ? fs.lstatSync(absolutePath) : null;
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        fail(`core skill ${skill.id} resource is missing or unsafe: ${normalizedPath}`);
      }
    }
  }

  const skillFile = path.join(skillsDir, skill.id, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    fail(`core skill SKILL.md not found: ${skill.id}`);
  }

  const packagePath = path.join(packageDir, `${skill.id}.tgz`);
  if (fs.existsSync(packageDir) && !fs.existsSync(packagePath)) {
    fail(`core skill package not found: ${path.relative(root, packagePath)}`);
  }

  const skillChangelog = changelog.skills?.[skill.id];
  if (!skillChangelog || !Array.isArray(skillChangelog.releases)) {
    fail(`missing changelog releases for core skill: ${skill.id}`);
  }
  const currentRelease = skillChangelog.releases.find((release) => release.version === skill.version);
  if (!currentRelease) {
    fail(`missing changelog release ${skill.version} for core skill: ${skill.id}`);
  }
  if (!currentRelease.date || !currentRelease.summary || !Array.isArray(currentRelease.changes) || currentRelease.changes.length === 0) {
    fail(`invalid changelog release ${skill.id}@${skill.version}; date, summary and changes are required`);
  }
  const snapshotPath = path.join(packageDir, 'versions', skill.id, `${skill.version}.tgz`);
  if (!fs.existsSync(snapshotPath)) {
    fail(`current release snapshot missing for ${skill.id}@${skill.version}`);
  }
  const snapshotStat = fs.lstatSync(snapshotPath);
  if (!snapshotStat.isFile() || snapshotStat.isSymbolicLink()) {
    fail(`current release snapshot must be a regular file for ${skill.id}@${skill.version}`);
  }
  if (checkLock && fs.existsSync(packagePath) && sha256(fs.readFileSync(snapshotPath)) !== sha256(fs.readFileSync(packagePath))) {
    fail(`current release snapshot does not match package for ${skill.id}@${skill.version}`);
  }

  const lockEntry = lock.skills?.[skill.id];
  if (!lockEntry) {
    fail(`missing lock entry for core skill: ${skill.id}`);
  }
  validateLockPackagePath(skill.id, lockEntry, packagePath);
  if (lockEntry.version !== skill.version) {
    fail(`lock version mismatch for ${skill.id}: registry=${skill.version}, lock=${lockEntry.version}`);
  }
  if (checkLock) {
    const sourceHash = hashSkillSource(skill.id);
    if (lockEntry.sourceSha256 !== sourceHash.sourceSha256) {
      fail(`source hash mismatch for ${skill.id}; run npm run package:skills -- ${skill.id}`);
    }
    if (lockEntry.fileCount !== sourceHash.fileCount) {
      fail(`source file count mismatch for ${skill.id}; run npm run package:skills -- ${skill.id}`);
    }
    if (!fs.existsSync(packagePath)) {
      fail(`package missing for ${skill.id}: ${path.relative(root, packagePath)}`);
    }
    const packageSha256 = sha256(fs.readFileSync(packagePath));
    if (lockEntry.packageSha256 !== packageSha256) {
      fail(`package hash mismatch for ${skill.id}; run npm run package:skills -- ${skill.id}`);
    }
    const packageSourceHash = hashPackagedSkillSource(packagePath, skill.id);
    if (
      packageSourceHash.sourceSha256 !== lockEntry.sourceSha256 ||
      packageSourceHash.fileCount !== lockEntry.fileCount
    ) {
      fail(`package content does not match source lock for ${skill.id}`);
    }
  }
}

validateCapsuleRegistry(ids);

if ('legacyAliases' in registry) {
  fail('registry.legacyAliases is obsolete; register canonical Skill IDs only');
}

const knownSkillIds = ids;
const sourceEntries = fs.readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.name !== '.DS_Store');
for (const entry of sourceEntries) {
  const sourcePath = path.join(skillsDir, entry.name);
  const stat = fs.lstatSync(sourcePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`skills source root may contain only regular skill directories: ${entry.name}`);
  }
}
const sourceSkillIds = sourceEntries.map((entry) => entry.name).sort();
for (const sourceSkillId of sourceSkillIds) {
  if (!knownSkillIds.has(sourceSkillId)) {
    fail(`skill source directory is not registered as a core skill: ${sourceSkillId}`);
  }
  const resources = validateCompleteSkillPackage(sourceSkillId);
  const coreSkill = registry.coreSkills.find((skill) => skill.id === sourceSkillId);
  if (coreSkill) {
    for (const resourceField of ['scripts', 'references']) {
      const registered = [...coreSkill[resourceField]].sort();
      const discovered = [...resources[resourceField]].sort();
      if (JSON.stringify(registered) !== JSON.stringify(discovered)) {
        fail(
          `core skill ${sourceSkillId}.${resourceField} must list every packaged resource; ` +
          `registered=${JSON.stringify(registered)}, discovered=${JSON.stringify(discovered)}`
        );
      }
    }
  }
}

for (const skill of registry.coreSkills) {
  if ('legacyAliases' in skill) fail(`core skill ${skill.id} contains obsolete legacyAliases`);
}

if (registry.coreSkills.length > registry.policy.targetCoreSkillCount) {
  fail(
    `core skill count ${registry.coreSkills.length} exceeds target ${registry.policy.targetCoreSkillCount}`
  );
}

console.log(
  `[skills-registry] ok: ${registry.coreSkills.length} canonical core skills`
);
