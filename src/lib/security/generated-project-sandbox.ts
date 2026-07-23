import fs from 'node:fs/promises';
import path from 'node:path';

export interface GeneratedProjectCommand {
  command: string;
  args: string[];
}

type EnvironmentInput = Readonly<Record<string, string | undefined>>;

const SAFE_ENV_KEYS = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
] as const;

const SAFE_INSTALL_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'npm_config_registry',
  'npm_config_cache',
] as const;

export function buildGeneratedProjectEnv(
  projectPath: string,
  overrides: EnvironmentInput = {},
  options: { allowInstallNetwork?: boolean } = {},
): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    CI: overrides.CI ?? '1',
    NEXT_TELEMETRY_DISABLED: '1',
    QUANTPILOT_WORKSPACE_ROOT: path.resolve(projectPath),
  };
  for (const key of SAFE_ENV_KEYS) {
    const value = overrides[key] ?? process.env[key];
    if (value) env[key] = value;
  }
  if (options.allowInstallNetwork) {
    for (const key of SAFE_INSTALL_ENV_KEYS) {
      const value = overrides[key] ?? process.env[key];
      if (value) env[key] = value;
    }
  }
  for (const key of [
    'PORT',
    'WEB_PORT',
    'NEXT_PUBLIC_APP_URL',
    'NODE_ENV',
    'NEXT_PRIVATE_BUILD_WORKER',
    'QUANTPILOT_SANDBOX_PREVIEW_SOCKET',
    'QUANTPILOT_SANDBOX_PREVIEW_PORT',
    'QUANTPILOT_SANDBOX_MARKET_SOCKET',
    'QUANTPILOT_SANDBOX_MARKET_PORT',
  ] as const) {
    const value = overrides[key];
    if (value) env[key] = value;
  }
  return env as NodeJS.ProcessEnv;
}

async function resolveSharedNodeModules(projectPath: string): Promise<string> {
  const projectModules = path.join(projectPath, 'node_modules');
  const resolved = await fs.realpath(projectModules).catch(() => null);
  if (resolved) return resolved;
  const platformModules = await fs.realpath(path.join(process.cwd(), 'node_modules')).catch(() => null);
  if (!platformModules) {
    throw new Error('Generated project sandbox cannot locate trusted node_modules.');
  }
  return platformModules;
}

async function nodeRuntimeRoot(): Promise<string> {
  const executableName = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates = [
    process.execPath,
    ...(process.env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((entry) => path.join(entry, executableName)),
  ];
  for (const candidate of candidates) {
    const resolved = await fs.realpath(candidate).catch(() => null);
    if (resolved && path.basename(resolved).toLowerCase() === executableName) {
      return path.dirname(path.dirname(resolved));
    }
  }
  throw new Error('Generated project sandbox cannot locate a trusted Node.js runtime.');
}

export async function wrapGeneratedProjectCommand(
  projectPath: string,
  command: string,
  args: readonly string[],
): Promise<GeneratedProjectCommand> {
  if (process.platform !== 'linux') {
    if (process.env.QUANTPILOT_ALLOW_UNSANDBOXED_GENERATED_CODE === '1') {
      return { command, args: [...args] };
    }
    throw new Error(
      'Generated project execution requires the Linux namespace sandbox. ' +
      'Set QUANTPILOT_ALLOW_UNSANDBOXED_GENERATED_CODE=1 only in an isolated development machine.',
    );
  }
  if (process.env.QUANTPILOT_GENERATED_SANDBOX === '0') {
    if (process.env.QUANTPILOT_ALLOW_UNSANDBOXED_GENERATED_CODE !== '1') {
      throw new Error('Refusing to disable the generated project sandbox without an explicit unsafe override.');
    }
    return { command, args: [...args] };
  }

  const workspace = await fs.realpath(path.resolve(projectPath));
  const nodeModules = await resolveSharedNodeModules(workspace);
  const runner = path.resolve(process.cwd(), 'scripts/security/run-generated-project-sandbox.sh');
  await fs.access(runner);
  return {
    command: 'unshare',
    args: [
      '--user',
      '--map-root-user',
      '--mount',
      '--net',
      '--pid',
      '--fork',
      '/bin/bash',
      runner,
      workspace,
      nodeModules,
      await nodeRuntimeRoot(),
      '--',
      command,
      ...args,
    ],
  };
}
