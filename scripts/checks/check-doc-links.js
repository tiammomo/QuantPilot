#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const failures = [];
const scannedFiles = [];
let checkedLinks = 0;

const INCLUDED_ROOT_FILES = ['README.md'];
const INCLUDED_DIRECTORIES = ['docs', 'services/market-data', 'sqls'];
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.venv',
  'build',
  'coverage',
  'data',
  'dist',
  'node_modules',
  'out',
  'playwright-report',
  'tmp',
]);

function normalizePath(value) {
  return value.split(path.sep).join('/');
}

function collectMarkdownFiles(relativePath, result = []) {
  const absolutePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(absolutePath)) return result;
  const stats = fs.statSync(absolutePath);
  if (stats.isFile()) {
    if (absolutePath.endsWith('.md')) result.push(normalizePath(relativePath));
    return result;
  }

  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    collectMarkdownFiles(path.join(relativePath, entry.name), result);
  }
  return result;
}

function withoutFencedCode(source) {
  return source.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, '');
}

function linkTargets(source) {
  const targets = [];
  const content = withoutFencedCode(source);
  const inlinePattern = /!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\)/g;
  const referencePattern = /^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm;

  for (const pattern of [inlinePattern, referencePattern]) {
    for (const match of content.matchAll(pattern)) {
      targets.push(match[1]);
    }
  }
  return targets;
}

function isExternalTarget(target) {
  return (
    /^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(target) ||
    /^(?:mailto|tel|data|javascript|app):/i.test(target) ||
    target.startsWith('#') ||
    target.includes('{{') ||
    target.includes('${')
  );
}

function resolveLocalTarget(sourceFile, rawTarget) {
  const unwrapped = rawTarget.startsWith('<') && rawTarget.endsWith('>')
    ? rawTarget.slice(1, -1)
    : rawTarget;
  const withoutFragment = unwrapped.split('#', 1)[0].split('?', 1)[0];
  if (!withoutFragment) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    failures.push(`${sourceFile}: invalid URL encoding in ${rawTarget}`);
    return null;
  }

  if (path.isAbsolute(decoded)) {
    return path.join(ROOT, decoded.replace(/^[/\\]+/, ''));
  }
  return path.resolve(ROOT, path.dirname(sourceFile), decoded);
}

function validateLink(sourceFile, target) {
  if (isExternalTarget(target)) return;
  const resolved = resolveLocalTarget(sourceFile, target);
  if (!resolved) return;
  checkedLinks += 1;

  const relative = path.relative(ROOT, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    failures.push(`${sourceFile}: link escapes the repository: ${target}`);
    return;
  }
  if (!fs.existsSync(resolved)) {
    failures.push(`${sourceFile}: missing local target: ${target}`);
  }
}

for (const rootFile of INCLUDED_ROOT_FILES) {
  collectMarkdownFiles(rootFile, scannedFiles);
}
for (const directory of INCLUDED_DIRECTORIES) {
  collectMarkdownFiles(directory, scannedFiles);
}

for (const sourceFile of [...new Set(scannedFiles)].sort()) {
  const source = fs.readFileSync(path.join(ROOT, sourceFile), 'utf8');
  for (const target of linkTargets(source)) {
    validateLink(sourceFile, target);
  }
}

if (failures.length > 0) {
  console.error('[docs] local link check failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`[docs] ok: ${new Set(scannedFiles).size} Markdown files, ${checkedLinks} local links`);
