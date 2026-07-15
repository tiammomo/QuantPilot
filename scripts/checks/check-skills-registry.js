const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = process.cwd();
const registryPath = path.join(root, '.claude', 'skills.registry.json');
const skillsDir = path.join(root, '.claude', 'skills');
const changelogPath = path.join(root, '.claude', 'skills.changelog.json');
const lockPath = path.join(root, '.claude', 'skills.lock.json');
const capsuleRegistryPath = path.join(root, 'config', 'moagent-skill-capsules.json');

function fail(message) {
  console.error(`[skills-registry] ${message}`);
  process.exit(1);
}

const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const packageDir = path.join(root, registry.policy.packageDir || '.claude/skill-packages');
const checkLegacyPackages = process.argv.includes('--include-legacy');
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
  /\.claude\/skills\//i,
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

  const lockEntry = lock.skills?.[skill.id];
  if (!lockEntry) {
    fail(`missing lock entry for core skill: ${skill.id}`);
  }
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
  }
}

validateCapsuleRegistry(ids);

const aliases = registry.legacyAliases || {};
for (const [alias, target] of Object.entries(aliases)) {
  if (!ids.has(target)) {
    fail(`legacy alias ${alias} points to unknown core skill ${target}`);
  }

  const aliasSkillFile = path.join(skillsDir, alias, 'SKILL.md');
  const aliasSourceExists = fs.existsSync(aliasSkillFile);

  const packagePath = path.join(packageDir, `${alias}.tgz`);
  if (checkLegacyPackages && aliasSourceExists && fs.existsSync(packageDir) && !fs.existsSync(packagePath)) {
    fail(`legacy alias package not found: ${path.relative(root, packagePath)}`);
  }
}

for (const skill of registry.coreSkills) {
  for (const alias of skill.legacyAliases || []) {
    if (aliases[alias] !== skill.id) {
      fail(`core skill ${skill.id} legacyAliases includes ${alias}, but registry.legacyAliases does not map it back`);
    }
  }
}

if (registry.coreSkills.length > registry.policy.targetCoreSkillCount) {
  fail(
    `core skill count ${registry.coreSkills.length} exceeds target ${registry.policy.targetCoreSkillCount}`
  );
}

console.log(
  `[skills-registry] ok: ${registry.coreSkills.length} core skills, ${Object.keys(aliases).length} legacy aliases${checkLegacyPackages ? ', legacy packages checked' : ''}`
);
