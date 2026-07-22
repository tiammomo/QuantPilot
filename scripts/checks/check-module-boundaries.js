#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const CONFIG_PATH = 'config/module-boundaries.json';
const failures = [];
const warnings = [];

function normalizePath(value) {
  return value.split(path.sep).join('/');
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function exists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(pattern) {
  const normalized = normalizePath(pattern);
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

const globCache = new Map();

function matchesGlob(relativePath, pattern) {
  const normalized = normalizePath(relativePath);
  if (!globCache.has(pattern)) {
    globCache.set(pattern, globToRegExp(pattern));
  }
  return globCache.get(pattern).test(normalized);
}

function matchesAny(relativePath, patterns) {
  return patterns.some((pattern) => matchesGlob(relativePath, pattern));
}

function walkFiles(startDir, extensions, result = []) {
  const absoluteStart = path.join(ROOT, startDir);
  if (!fs.existsSync(absoluteStart)) return result;
  for (const entry of fs.readdirSync(absoluteStart, { withFileTypes: true })) {
    const absolutePath = path.join(absoluteStart, entry.name);
    const relativePath = normalizePath(path.relative(ROOT, absolutePath));
    if (
      entry.isDirectory() &&
      !['node_modules', '.next', '.git', 'data', 'tmp', 'coverage', 'playwright-report'].includes(entry.name)
    ) {
      walkFiles(relativePath, extensions, result);
    } else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
      result.push(relativePath);
    }
  }
  return result;
}

function resolveImportPath(sourceFile, specifier) {
  if (specifier.startsWith('@/')) {
    return `src/${specifier.slice(2)}`;
  }
  if (specifier.startsWith('.')) {
    return normalizePath(path.join(path.dirname(sourceFile), specifier));
  }
  return null;
}

function importedSpecifiers(source) {
  const specifiers = new Set();
  const staticImportPattern =
    /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  const dynamicImportPattern = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const pattern of [staticImportPattern, dynamicImportPattern]) {
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

function validateConfig(config) {
  if (config.version !== 1) fail('module boundary config version must be 1');
  if (!Array.isArray(config.modules) || config.modules.length < 6) {
    fail('module boundary config should define the main platform modules');
    return;
  }
  const ids = new Set();
  for (const boundaryModule of config.modules) {
    if (!/^[a-z][a-z0-9-]*$/.test(boundaryModule.id)) {
      fail(`invalid module id: ${boundaryModule.id}`);
    }
    if (ids.has(boundaryModule.id)) fail(`duplicate module id: ${boundaryModule.id}`);
    ids.add(boundaryModule.id);
    if (!boundaryModule.name || !boundaryModule.summary || !boundaryModule.owner) {
      fail(`${boundaryModule.id} must declare name, summary and owner`);
    }
    if (!Array.isArray(boundaryModule.paths) || boundaryModule.paths.length === 0) {
      fail(`${boundaryModule.id} must declare path ownership`);
    }
    if (!Array.isArray(boundaryModule.dependsOn)) {
      fail(`${boundaryModule.id} dependsOn must be an array`);
    }
    if (
      !Array.isArray(boundaryModule.publicSurface) ||
      boundaryModule.publicSurface.length === 0
    ) {
      fail(`${boundaryModule.id} must declare a public surface`);
    }
    for (const dependency of boundaryModule.dependsOn ?? []) {
      if (!ids.has(dependency) && !config.modules.some((candidate) => candidate.id === dependency)) {
        fail(`${boundaryModule.id} depends on unknown module: ${dependency}`);
      }
    }
    if (!boundaryModule.paths.some((pattern) => exists(pattern.replace(/\/\*\*$/, '')))) {
      warn(`${boundaryModule.id} path patterns do not point at an existing root yet`);
    }
  }
}

function validateForbiddenImports(config) {
  const sourceFiles = walkFiles('src', ['.ts', '.tsx']);
  const forbiddenImports = config.rules?.forbiddenImports ?? [];
  for (const file of sourceFiles) {
    const content = read(file);
    const specs = importedSpecifiers(content);
    for (const specifier of specs) {
      const target = resolveImportPath(file, specifier);
      if (!target) continue;
      for (const rule of forbiddenImports) {
        if (matchesGlob(file, rule.from) && matchesGlob(target, rule.to)) {
          fail(`${file} imports ${specifier}; ${rule.reason}`);
        }
      }
    }
  }
}

function validateRemovedPaths(config) {
  const repositoryFiles = walkFiles('.', [
    '.ts', '.tsx', '.js', '.cjs', '.mjs', '.py', '.prisma', '.json', '.md', '.sql',
  ]);
  for (const rule of config.rules?.removedPaths ?? []) {
    const matches = repositoryFiles.filter((file) => matchesGlob(file, rule.path));
    for (const file of matches) {
      fail(`${file} restores a removed path; ${rule.reason}`);
    }
  }
}

function validateForbiddenContent(config) {
  for (const rule of config.rules?.forbiddenContent ?? []) {
    if (!exists(rule.path)) {
      fail(`forbidden content rule references missing file: ${rule.path}`);
      continue;
    }
    const expression = new RegExp(rule.pattern, rule.flags ?? 'm');
    if (expression.test(read(rule.path))) {
      fail(`${rule.path} contains removed contract content; ${rule.reason}`);
    }
  }
}

function validateLargeFiles(config) {
  for (const budget of config.rules?.largeFileBudgets ?? []) {
    if (!exists(budget.path)) {
      fail(`large file budget references missing file: ${budget.path}`);
      continue;
    }
    const lineCount = read(budget.path).split(/\r?\n/).length;
    if (lineCount > budget.maxLines) {
      fail(
        `${budget.path} has ${lineCount} lines, above max ${budget.maxLines}. ${budget.nextAction}`
      );
    } else if (lineCount > budget.targetLines) {
      warn(
        `${budget.path} has ${lineCount} lines; target is ${budget.targetLines}. ${budget.nextAction}`
      );
    }
  }
}

function validateDocs(config) {
  if (!exists('docs/module-boundaries.md')) {
    fail('docs/module-boundaries.md is required for module governance');
    return;
  }
  const docs = read('docs/module-boundaries.md');
  for (const boundaryModule of config.modules) {
    if (!docs.includes(`\`${boundaryModule.id}\``)) {
      fail(`docs/module-boundaries.md should mention module ${boundaryModule.id}`);
    }
  }
  if (!docs.includes(CONFIG_PATH)) {
    fail(`docs/module-boundaries.md should reference ${CONFIG_PATH}`);
  }
  if (!read('docs/README.md').includes('module-boundaries.md')) {
    fail('docs/README.md should link module-boundaries.md');
  }
}

const config = readJson(CONFIG_PATH);
validateConfig(config);
validateForbiddenImports(config);
validateRemovedPaths(config);
validateForbiddenContent(config);
validateLargeFiles(config);
validateDocs(config);

for (const warning of warnings) {
  console.warn(`warning: ${warning}`);
}

if (failures.length) {
  console.error('Module boundary check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `[module-boundaries] ok: ${config.modules.length} modules, ${config.rules?.forbiddenImports?.length ?? 0} forbidden import rules, ${config.rules?.removedPaths?.length ?? 0} removed path rules, ${config.rules?.forbiddenContent?.length ?? 0} current-contract rules`
);
