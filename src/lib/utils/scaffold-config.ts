import fs from 'node:fs/promises';

const GENERATED_TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    lib: ['DOM', 'DOM.Iterable', 'ES2022'],
    allowJs: false,
    skipLibCheck: true,
    strict: true,
    forceConsistentCasingInFileNames: true,
    noEmit: true,
    esModuleInterop: true,
    module: 'ESNext',
    moduleResolution: 'Bundler',
    resolveJsonModule: true,
    isolatedModules: true,
    jsx: 'react-jsx',
    incremental: true,
    plugins: [{ name: 'next' }],
  },
  include: [
    'next-env.d.ts',
    '.next/types/**/*.ts',
    '.next/dev/types/**/*.ts',
    '**/*.mts',
    '**/*.ts',
    '**/*.tsx',
  ],
  exclude: ['node_modules'],
};

export async function ensureGeneratedTsConfig(filePath: string) {
  let config: Record<string, unknown> = structuredClone(GENERATED_TSCONFIG);
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or invalid platform-owned config is restored below.
  }

  const compilerOptions = config.compilerOptions && typeof config.compilerOptions === 'object' &&
      !Array.isArray(config.compilerOptions)
    ? config.compilerOptions as Record<string, unknown>
    : {};
  const existingPlugins = Array.isArray(compilerOptions.plugins)
    ? compilerOptions.plugins.filter((entry) => entry && typeof entry === 'object')
    : [];
  const plugins = existingPlugins.some((entry) => (entry as { name?: unknown }).name === 'next')
    ? existingPlugins
    : [...existingPlugins, { name: 'next' }];
  Object.assign(compilerOptions, {
    esModuleInterop: true,
    module: 'ESNext',
    moduleResolution: 'Bundler',
    resolveJsonModule: true,
    isolatedModules: true,
    jsx: 'react-jsx',
    plugins,
  });
  config.compilerOptions = compilerOptions;

  const includes = Array.isArray(config.include)
    ? config.include.filter((entry): entry is string => typeof entry === 'string')
    : [];
  for (const include of GENERATED_TSCONFIG.include) {
    if (!includes.includes(include)) includes.push(include);
  }
  config.include = includes;
  if (!Array.isArray(config.exclude)) config.exclude = ['node_modules'];

  const nextContents = `${JSON.stringify(config, null, 2)}\n`;
  const existingContents = await fs.readFile(filePath, 'utf8').catch(() => null);
  if (existingContents !== nextContents) {
    await fs.writeFile(filePath, nextContents, 'utf8');
  }
}
