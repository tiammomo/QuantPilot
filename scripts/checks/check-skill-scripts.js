const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = process.cwd();
const skillsDir = path.join(root, '.claude', 'skills');
const pycacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quantpilot-skill-pyc-'));

function fail(message, result) {
  console.error(`[skill-scripts] ${message}`);
  if (result?.stdout) process.stderr.write(result.stdout);
  if (result?.stderr) process.stderr.write(result.stderr);
  fs.rmSync(pycacheDir, { recursive: true, force: true });
  process.exit(1);
}

function scriptResources(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) return scriptResources(absolutePath);
    if (entry.isFile() && /\.(?:py|js|mjs|sh)$/.test(entry.name)) return [absolutePath];
    return [];
  }).sort();
}

const scripts = fs.readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => scriptResources(path.join(skillsDir, entry.name, 'scripts')));

if (scripts.length === 0) fail('no deterministic skill scripts found');

const env = { ...process.env, PYTHONPYCACHEPREFIX: pycacheDir };
const pythonScripts = scripts.filter((script) => script.endsWith('.py'));
if (pythonScripts.length > 0) {
  const compile = spawnSync('python', ['-m', 'py_compile', ...pythonScripts], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  if (compile.status !== 0) fail('Python syntax validation failed', compile);
}

for (const script of scripts) {
  const relativePath = path.relative(root, script);
  const stat = fs.statSync(script);
  if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) {
    fail(`${relativePath} must be executable`);
  }
  const firstLine = fs.readFileSync(script, 'utf8').split(/\r?\n/, 1)[0];
  if (script.endsWith('.py') && firstLine !== '#!/usr/bin/env python3') {
    fail(`${relativePath} must start with #!/usr/bin/env python3`);
  }
  if ((script.endsWith('.js') || script.endsWith('.mjs')) && firstLine !== '#!/usr/bin/env node') {
    fail(`${relativePath} must start with #!/usr/bin/env node`);
  }
  if (script.endsWith('.sh') && firstLine !== '#!/usr/bin/env bash') {
    fail(`${relativePath} must start with #!/usr/bin/env bash`);
  }

  const syntax = script.endsWith('.py')
    ? null
    : script.endsWith('.sh')
      ? spawnSync('bash', ['-n', script], { cwd: root, env, encoding: 'utf8' })
      : spawnSync('node', ['--check', script], { cwd: root, env, encoding: 'utf8' });
  if (syntax && syntax.status !== 0) {
    fail(`${relativePath} syntax validation failed`, syntax);
  }

  const command = script.endsWith('.py') ? 'python' : script.endsWith('.sh') ? 'bash' : 'node';
  const help = spawnSync(command, [script, '--help'], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (help.status !== 0 || !/usage:/i.test(help.stdout)) {
    fail(`${relativePath} must support --help`, help);
  }
}

fs.rmSync(pycacheDir, { recursive: true, force: true });
console.log(`[skill-scripts] ok: ${scripts.length} executable scripts passed syntax and --help checks`);
