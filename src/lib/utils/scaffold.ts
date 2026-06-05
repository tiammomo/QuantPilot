import fs from 'fs/promises';
import path from 'path';

type PackageJsonShape = {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

async function writeFileIfMissing(filePath: string, contents: string) {
  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents, 'utf8');
  }
}

async function upsertTextFile(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, 'utf8');
}

async function mergePackageJson(filePath: string, defaults: PackageJsonShape & Record<string, unknown>) {
  let packageJson = defaults;

  try {
    packageJson = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    // Missing or invalid generated package.json: rewrite with safe defaults.
  }

  packageJson.scripts = {
    ...defaults.scripts,
    ...(packageJson.scripts ?? {}),
    build: defaults.scripts.build,
    dev: defaults.scripts.dev,
  };

  packageJson.dependencies = {
    ...(packageJson.dependencies ?? {}),
    next: packageJson.dependencies?.next ?? defaults.dependencies.next,
    react: packageJson.dependencies?.react ?? defaults.dependencies.react,
    'react-dom': packageJson.dependencies?.['react-dom'] ?? defaults.dependencies['react-dom'],
  };
  delete packageJson.dependencies['next-rspack'];

  const existingDevDependencies =
    packageJson.devDependencies &&
    typeof packageJson.devDependencies === 'object' &&
    !Array.isArray(packageJson.devDependencies)
      ? packageJson.devDependencies
      : {};

  packageJson.devDependencies = {
    ...(packageJson.devDependencies ?? {}),
    typescript: existingDevDependencies.typescript ?? defaults.devDependencies.typescript,
    '@types/react': existingDevDependencies['@types/react'] ?? defaults.devDependencies['@types/react'],
    '@types/node': existingDevDependencies['@types/node'] ?? defaults.devDependencies['@types/node'],
    eslint: existingDevDependencies.eslint ?? defaults.devDependencies.eslint,
    'eslint-config-next':
      existingDevDependencies['eslint-config-next'] ?? defaults.devDependencies['eslint-config-next'],
  };
  delete packageJson.devDependencies['next-rspack'];

  await fs.writeFile(filePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
}

export function generatedBuildScriptContents(): string {
  return `#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const isWindows = process.platform === 'win32';
const workspaceRoot =
  process.env.TRAVELPILOT_WORKSPACE_ROOT || path.resolve(projectRoot, '../../..');

const buildEnv = {
  ...process.env,
  NODE_ENV: 'production',
  TRAVELPILOT_WORKSPACE_ROOT: workspaceRoot,
  NEXT_PRIVATE_BUILD_WORKER: '1',
  NEXT_TELEMETRY_DISABLED: '1',
};

delete buildEnv.NEXT_RSPACK;
delete buildEnv.TURBOPACK;

const child = spawn(
  'npx',
  ['next', 'build', ...process.argv.slice(2)],
  {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: isWindows,
    env: buildEnv,
  }
);

child.on('exit', (code, signal) => {
  if (code === 0) return;
  console.error(
    \`Next.js build failed with code \${code ?? 'null'}, signal \${signal ?? 'none'}\`
  );
  process.exit(typeof code === 'number' ? code : 1);
});

child.on('error', (error) => {
  console.error('Failed to start Next.js build');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
`;
}

function generatedDevScriptContents(): string {
  return `#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const isWindows = process.platform === 'win32';

function parsePort(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--port' || arg === '-p') && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (!Number.isNaN(parsed)) return parsed;
    }
    if (arg.startsWith('--port=')) {
      const parsed = Number.parseInt(arg.slice('--port='.length), 10);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return Number.parseInt(process.env.PORT || process.env.WEB_PORT || '4100', 10);
}

const passthrough = process.argv.slice(2).filter((arg, index, args) => {
  if (arg === '--port' || arg === '-p') return false;
  if ((args[index - 1] === '--port' || args[index - 1] === '-p')) return false;
  return !arg.startsWith('--port=');
});
const port = parsePort(process.argv.slice(2));
const url = process.env.NEXT_PUBLIC_APP_URL || \`http://localhost:\${port}\`;

process.env.PORT = String(port);
process.env.WEB_PORT = String(port);
process.env.NEXT_PUBLIC_APP_URL = url;

console.log(\`Starting Next.js preview on \${url}\`);

const hasProductionBuild = fs.existsSync(path.join(projectRoot, '.next', 'BUILD_ID'));
const commandArgs = hasProductionBuild
  ? ['next', 'start', '--port', String(port), ...passthrough]
  : ['next', 'dev', '--port', String(port), ...passthrough];

if (!hasProductionBuild && !commandArgs.includes('--turbo') && !commandArgs.includes('--turbopack')) {
  commandArgs.push('--turbo');
}

const runtimeEnv = {
  ...process.env,
  PORT: String(port),
  WEB_PORT: String(port),
  NEXT_PUBLIC_APP_URL: url,
  TRAVELPILOT_WORKSPACE_ROOT:
    process.env.TRAVELPILOT_WORKSPACE_ROOT || path.resolve(projectRoot, '../../..'),
  NEXT_TELEMETRY_DISABLED: '1',
};

delete runtimeEnv.NEXT_RSPACK;
delete runtimeEnv.TURBOPACK;

const child = spawn('npx', commandArgs, {
  cwd: projectRoot,
  stdio: 'inherit',
  shell: isWindows,
  env: runtimeEnv,
});

child.on('exit', (code) => {
  if (typeof code === 'number' && code !== 0) {
    console.error(\`Next.js preview exited with code \${code}\`);
    process.exit(code);
  }
});

child.on('error', (error) => {
  console.error('Failed to start Next.js preview');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
`;
}

function pageTemplate(projectId: string) {
  return `export default function Home() {
  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Generated workspace</p>
        <h1>Beijing Travel Agent Preview</h1>
        <p>
          This workspace is ready for travel planning UI, itinerary data, and
          local POI integrations.
        </p>
        <div className="meta">
          <span>Project</span>
          <strong>${projectId}</strong>
        </div>
      </section>
    </main>
  );
}
`;
}

function cssTemplate() {
  return `:root {
  color-scheme: light;
  --bg: #f4efe7;
  --ink: #16211b;
  --muted: #657168;
  --panel: rgba(255, 252, 244, 0.9);
  --line: rgba(22, 33, 27, 0.12);
  --accent: #c75f28;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  background:
    radial-gradient(circle at 20% 15%, rgba(199, 95, 40, 0.2), transparent 30%),
    linear-gradient(135deg, #fff8ec 0%, #e7f0df 100%);
  color: var(--ink);
  font-family: Georgia, 'Times New Roman', serif;
}

.shell {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 32px;
}

.hero {
  width: min(760px, 100%);
  padding: 40px;
  border: 1px solid var(--line);
  border-radius: 28px;
  background: var(--panel);
  box-shadow: 0 24px 70px rgba(42, 54, 45, 0.16);
}

.eyebrow {
  margin: 0 0 12px;
  color: var(--accent);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1 {
  margin: 0;
  font-size: clamp(40px, 8vw, 78px);
  line-height: 0.95;
}

p {
  color: var(--muted);
  font-size: 18px;
  line-height: 1.7;
}

.meta {
  display: inline-grid;
  gap: 4px;
  margin-top: 20px;
  padding: 12px 16px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.55);
}

.meta span {
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.meta strong {
  font-size: 14px;
}
`;
}

async function ensureNextConfig(filePath: string) {
  await writeFileIfMissing(
    filePath,
    `/** @type {import('next').NextConfig} */
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = process.env.TRAVELPILOT_WORKSPACE_ROOT
  ? path.resolve(process.env.TRAVELPILOT_WORKSPACE_ROOT)
  : path.resolve(projectRoot, '../../..');

const nextConfig = {
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  typedRoutes: true,
  outputFileTracingRoot: workspaceRoot,
  turbopack: {
    root: workspaceRoot,
  },
};

module.exports = nextConfig;
`
  );
}

export async function ensureTravelDashboardTemplate(projectPath: string) {
  await upsertTextFile(path.join(projectPath, 'app', 'page.tsx'), pageTemplate(path.basename(projectPath)));
  await upsertTextFile(path.join(projectPath, 'app', 'globals.css'), cssTemplate());
}

export async function scaffoldBasicNextApp(projectPath: string, projectId = path.basename(projectPath)) {
  await fs.mkdir(path.join(projectPath, 'app'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'scripts'), { recursive: true });

  await mergePackageJson(path.join(projectPath, 'package.json'), {
    name: projectId,
    version: '0.1.0',
    private: true,
    scripts: {
      dev: 'node scripts/run-dev.js',
      build: 'node scripts/run-build.js',
      start: 'next start',
      lint: 'next lint',
    },
    dependencies: {
      next: '^16.2.6',
      react: '^19.2.6',
      'react-dom': '^19.2.6',
    },
    devDependencies: {
      '@types/node': '^22.19.19',
      '@types/react': '^19.2.15',
      eslint: '^9.39.4',
      'eslint-config-next': '^16.2.6',
      typescript: '^6.0.3',
    },
  });

  await writeFileIfMissing(
    path.join(projectPath, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2017',
          lib: ['dom', 'dom.iterable', 'esnext'],
          allowJs: true,
          skipLibCheck: true,
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: 'react-jsx',
          incremental: true,
          plugins: [{ name: 'next' }],
          paths: { '@/*': ['./*'] },
        },
        include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
        exclude: ['node_modules'],
      },
      null,
      2
    )}\n`
  );

  await writeFileIfMissing(
    path.join(projectPath, 'app', 'layout.tsx'),
    `import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Beijing Travel Agent Preview',
  description: 'Generated travel planning workspace',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
`
  );

  await ensureTravelDashboardTemplate(projectPath);
  await ensureNextConfig(path.join(projectPath, 'next.config.js'));
  await writeFileIfMissing(path.join(projectPath, 'scripts', 'run-build.js'), generatedBuildScriptContents());
  await writeFileIfMissing(path.join(projectPath, 'scripts', 'run-dev.js'), generatedDevScriptContents());
}
