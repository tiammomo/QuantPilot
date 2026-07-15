import fs from 'fs/promises';
import path from 'path';
import {
  comparisonPageTemplate,
  stockSelectionPageTemplate,
  comparisonCss,
  stockSelectionCss,
  holdingAnalysisPageTemplate,
  holdingAnalysisCss,
} from './scaffold-dashboard-templates';
import {
  baseDashboardPageTemplate,
  baseDashboardCssTemplate,
  generatedDevScriptContents,
} from './scaffold-base-templates';
import { ensureGeneratedTsConfig } from './scaffold-config';

function shouldRefreshScaffoldFile(filePath: string, existing: string): boolean {
  const normalizedPath = filePath.replaceAll(path.sep, '/');
  const trimmed = existing.trim();

  if (normalizedPath.endsWith('/app/page.tsx')) {
    const hasQuantDataBinding =
      existing.includes('dashboard-data.json') ||
      existing.includes('data_file/final') ||
      existing.includes('/api/market/');
    const hasStandardQuantDashboard =
      existing.includes('data-source-file={DATA_FILE}') &&
      existing.includes('function getBars(') &&
      existing.includes('TrendChart') &&
      existing.includes('K 线与量价结构');
    const hasLegacySvgTitleHydrationRisk =
      hasStandardQuantDashboard &&
      (
        existing.includes('<title>{String(bar.date') ||
        existing.includes('<title>{String(bar.date ??')
      );
    const isDefaultNextPage =
      existing.includes('Get started by editing') ||
      existing.includes('src/app/page.tsx') ||
      existing.includes('app/page.tsx') ||
      existing.includes('next/font/google') ||
      existing.includes('https://vercel.com/templates');
    const hasUnstableQuantDashboard =
      hasQuantDataBinding &&
      (
        existing.includes('0 条样本') ||
        (existing.includes('最新价</span>') && !hasStandardQuantDashboard) ||
        (existing.includes('QuantPilot 看板') && !hasStandardQuantDashboard) ||
        existing.includes('SAMPLE_DATA') ||
        existing.includes('MOCK_DATA') ||
        existing.includes('STATIC_QUOTES')
      );

    return (isDefaultNextPage && !hasQuantDataBinding) || hasUnstableQuantDashboard || hasLegacySvgTitleHydrationRisk;
  }

  if (normalizedPath.endsWith('/app/globals.css')) {
    // Existing styles can be intentionally small. Validation/scaffolding must
    // not replace user-authored CSS merely because it does not use a platform
    // class name; destructive recovery is an explicit repair operation.
    return trimmed.length === 0;
  }

  if (normalizedPath.endsWith('/app/api/market/[...path]/route.ts')) {
    const targetsQuantBackend =
      existing.includes('127.0.0.1:8000/api/v1') ||
      existing.includes('QUANTPILOT_MARKET_API') ||
      existing.includes('/api/v1/');

    return !targetsQuantBackend && trimmed.length < 1_200;
  }

  if (normalizedPath.endsWith('/scripts/run-dev.js')) {
    return (
      existing.includes('--webpack') ||
      existing.includes('hasBundlerFlag') ||
      existing.includes("NEXT_RSPACK: process.env.NEXT_RSPACK || 'true'") ||
      existing.includes('const useRspack = process.env.NEXT_RSPACK ===') ||
      existing.includes('Rspack dev mode enabled') ||
      existing.includes('const devEnv =') ||
      existing.includes("commandArgs.push('--turbo')") ||
      existing.includes('delete runtimeEnv.NEXT_RSPACK') ||
      existing.includes('delete runtimeEnv.TURBOPACK') ||
      !existing.includes('QUANTPILOT_WORKSPACE_ROOT') ||
      !existing.includes("fs.existsSync(path.join(projectRoot, '.next', 'BUILD_ID'))")
    );
  }

  if (normalizedPath.endsWith('/scripts/run-build.js')) {
    return (
      existing.includes('delete buildEnv.NEXT_RSPACK') ||
      existing.includes('delete buildEnv.TURBOPACK') ||
      !existing.includes("NODE_ENV: 'production'") ||
      !existing.includes('QUANTPILOT_WORKSPACE_ROOT') ||
      !existing.includes('NEXT_PRIVATE_BUILD_WORKER') ||
      !existing.includes("['next', 'build'")
    );
  }

  if (normalizedPath.endsWith('/next-env.d.ts')) {
    return (
      existing.includes('next/navigation-types/navigation') ||
      !existing.includes('import "./.next/types/routes.d.ts";') ||
      !existing.includes('// NOTE: This file should not be edited')
    );
  }

  return false;
}

type PackageJsonShape = {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

export function generatedBuildScriptContents(): string {
  return `#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const isWindows = process.platform === 'win32';
const workspaceRoot =
  process.env.QUANTPILOT_WORKSPACE_ROOT || path.resolve(projectRoot, '../../..');

const buildEnv = {
  ...process.env,
  NODE_ENV: 'production',
  QUANTPILOT_WORKSPACE_ROOT: workspaceRoot,
  NEXT_PRIVATE_BUILD_WORKER: '1',
  NEXT_TELEMETRY_DISABLED: '1',
};

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
  if (code === 0) {
    return;
  }

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

async function mergePackageJson(filePath: string, defaults: PackageJsonShape & Record<string, unknown>) {
  let packageJson = defaults;
  let existingContents: string | null = null;

  try {
    existingContents = await fs.readFile(filePath, 'utf8');
    packageJson = JSON.parse(existingContents);
  } catch {
    // 文件缺失或 JSON 异常时，回写默认配置。
  }

  packageJson.scripts = {
    ...defaults.scripts,
    ...(packageJson.scripts ?? {}),
    build: defaults.scripts.build,
  };
  if (packageJson.scripts.build === 'next build' || packageJson.scripts.build === 'next build --webpack') {
    packageJson.scripts.build = defaults.scripts.build;
  }

  packageJson.dependencies = {
    ...(packageJson.dependencies ?? {}),
    next: packageJson.dependencies?.next ?? defaults.dependencies.next,
    react: packageJson.dependencies?.react ?? defaults.dependencies.react,
    'react-dom':
      packageJson.dependencies?.['react-dom'] ?? defaults.dependencies['react-dom'],
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
    typescript:
      existingDevDependencies.typescript ?? defaults.devDependencies.typescript,
    '@types/react':
      existingDevDependencies['@types/react'] ?? defaults.devDependencies['@types/react'],
    '@types/node':
      existingDevDependencies['@types/node'] ?? defaults.devDependencies['@types/node'],
    eslint: existingDevDependencies.eslint ?? defaults.devDependencies.eslint,
    'eslint-config-next':
      existingDevDependencies['eslint-config-next'] ?? defaults.devDependencies['eslint-config-next'],
  };
  delete packageJson.devDependencies['next-rspack'];

  const nextContents = `${JSON.stringify(packageJson, null, 2)}\n`;
  if (existingContents === nextContents) {
    return;
  }

  await fs.writeFile(filePath, nextContents, 'utf8');
}

async function ensureNextConfig(filePath: string) {
  const fallback = `/** @type {import('next').NextConfig} */
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = process.env.QUANTPILOT_WORKSPACE_ROOT
  ? path.resolve(process.env.QUANTPILOT_WORKSPACE_ROOT)
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
`;

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, fallback, 'utf8');
    return;
  }

  let nextContent = content.replace(
    /(?:const|var|let)\s+withRspack\s*=\s*require\(['"]next-rspack['"]\);\n?/g,
    ''
  );
  nextContent = nextContent.replace(
    /const\s+shouldUseRspack\s*=.*?;\n?/g,
    ''
  );
  nextContent = nextContent.replace(
    /module\.exports\s*=\s*shouldUseRspack\s*\?\s*withRspack\(nextConfig\)\s*:\s*nextConfig\s*;?/g,
    'module.exports = nextConfig;'
  );
  nextContent = nextContent.replace(
    /module\.exports\s*=\s*withRspack\(nextConfig\)\s*;?/g,
    'module.exports = nextConfig;'
  );
  if (!nextContent.includes('const projectRoot = __dirname;')) {
    nextContent = nextContent.replace(
      /\/\*\* @type \{import\('next'\)\.NextConfig\} \*\/\n/,
      "/** @type {import('next').NextConfig} */\nconst projectRoot = __dirname;\n"
    );
  }
  if (!nextContent.includes("const path = require('path');")) {
    nextContent = nextContent.replace(
      /\/\*\* @type \{import\(['"]next['"]\)\.NextConfig\} \*\/\n/,
      "/** @type {import('next').NextConfig} */\nconst path = require('path');\n\n"
    );
  }
  if (!nextContent.includes('const workspaceRoot =')) {
    nextContent = nextContent.replace(
      /const projectRoot = __dirname;\n/,
      `const projectRoot = __dirname;
const workspaceRoot = process.env.QUANTPILOT_WORKSPACE_ROOT
  ? path.resolve(process.env.QUANTPILOT_WORKSPACE_ROOT)
  : path.resolve(projectRoot, '../../..');
`
    );
  }
  nextContent = nextContent.replace(/outputFileTracingRoot:\s*projectRoot/g, 'outputFileTracingRoot: workspaceRoot');
  nextContent = nextContent.replace(/root:\s*projectRoot/g, 'root: workspaceRoot');
  if (!nextContent.includes('turbopack:')) {
    nextContent = nextContent.replace(
      /const nextConfig = \{\n/,
      `const nextConfig = {
  turbopack: {
    root: workspaceRoot,
  },
`
    );
  }
  if (!nextContent.includes('allowedDevOrigins')) {
    nextContent = nextContent.replace(
      /const nextConfig = \{\n/,
      `const nextConfig = {
  allowedDevOrigins: ['localhost', '127.0.0.1'],
`
    );
  }

  if (nextContent !== content) {
    await fs.writeFile(filePath, nextContent, 'utf8');
  }
}

async function writeFileIfMissing(filePath: string, contents: string) {
  try {
    const existing = await fs.readFile(filePath, 'utf8');
    if (!shouldRefreshScaffoldFile(filePath, existing)) {
      return;
    }
  } catch {
    // continue
  }
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, contents, 'utf8');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function ensureSharedNodeModules(projectPath: string) {
  const projectNodeModules = path.join(projectPath, 'node_modules');
  const sharedNodeModules = path.join(/*turbopackIgnore: true*/ process.cwd(), 'node_modules');

  if (path.resolve(projectNodeModules) === path.resolve(sharedNodeModules)) {
    return;
  }

  if (!(await fileExists(path.join(sharedNodeModules, 'next', 'package.json')))) {
    return;
  }

  try {
    const existing = await fs.lstat(projectNodeModules);
    if (existing.isSymbolicLink()) {
      const target = await fs.readlink(projectNodeModules);
      const resolvedTarget = path.resolve(projectPath, target);
      if (resolvedTarget === path.resolve(sharedNodeModules)) {
        return;
      }
      await fs.rm(projectNodeModules, { recursive: true, force: true });
    } else if (await directoryExists(path.join(projectNodeModules, 'next'))) {
      return;
    } else {
      return;
    }
  } catch {
    // node_modules 不存在时创建共享依赖桥接。
  }

  const relativeTarget = path.relative(projectPath, sharedNodeModules);
  await fs.symlink(relativeTarget || sharedNodeModules, projectNodeModules, 'dir');
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function upsertGeneratedCssBlock(cssPath: string, marker: string, block: string) {
  const start = `/* quantpilot-${marker}:start */`;
  const end = `/* quantpilot-${marker}:end */`;
  const raw = await fs.readFile(cssPath, 'utf8').catch(() => '');
  const normalizedBlock = `${start}\n${block.trim()}\n${end}`;
  const blockWithNewline = `${normalizedBlock}\n`;

  if (raw.includes(start) && raw.includes(end)) {
    const pattern = new RegExp(`${start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    const next = raw.replace(pattern, normalizedBlock);
    if (next !== raw) {
      await fs.writeFile(cssPath, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
    }
    return;
  }

  await fs.writeFile(cssPath, `${raw.trimEnd()}\n${blockWithNewline}`, 'utf8');
}

async function scrubLegacyTradingPlanCss(cssPath: string) {
  const raw = await fs.readFile(cssPath, 'utf8').catch(() => '');
  if (!raw) return;

  const patterns = [
    /\.trading-plan-grid\s*\{[\s\S]*?\}\n?/g,
    /\.trading-plan-panel\s*\{[\s\S]*?\}\n?/g,
    /\.trade-card\s*\{[\s\S]*?\}\n?/g,
    /\.trade-title\s*\{[\s\S]*?\}\n?/g,
    /\.trade-title\s+strong,\s*\.trade-title\s+small,\s*\.trade-title\s+em\s*\{[\s\S]*?\}\n?/g,
    /\.trade-title\s+small\s*\{[\s\S]*?\}\n?/g,
    /\.trade-title\s+em\s*\{[\s\S]*?\}\n?/g,
    /\.trade-card\s+dl\s*\{[\s\S]*?\}\n?/g,
    /\.trade-card\s+dt\s*\{[\s\S]*?\}\n?/g,
    /\.trade-card\s+dd\s*\{[\s\S]*?\}\n?/g,
    /\.trade-card\s+dl\s+div:nth-child\(2\),\s*\.trade-card\s+dl\s+div:nth-child\(4\)\s*\{[\s\S]*?\}\n?/g,
    /\.trade-rationale,\s*\.trade-abandon\s*\{[\s\S]*?\}\n?/g,
    /\.trade-abandon\s+strong\s*\{[\s\S]*?\}\n?/g,
  ];
  const next = patterns.reduce((content, pattern) => content.replace(pattern, ''), raw);
  if (next !== raw) {
    await fs.writeFile(cssPath, `${next.trimEnd()}\n`, 'utf8');
  }
}

async function ensureComparisonDashboardTemplate(projectPath: string) {
  const finalData = await readJsonRecord(path.join(projectPath, 'data_file', 'final', 'dashboard-data.json'));
  const runPlan = await readJsonRecord(path.join(projectPath, '.quantpilot', 'run_plan.json'));
  const runPlanVisualization = readRecord(runPlan?.visualization);
  const plannedTemplateId =
    typeof runPlanVisualization?.templateId === 'string'
      ? runPlanVisualization.templateId
      : typeof runPlanVisualization?.template_id === 'string'
        ? runPlanVisualization.template_id
        : null;
  const dashboardKind = typeof finalData?.dashboardKind === 'string' ? finalData.dashboardKind : null;
  const visualization = readRecord(finalData?.visualization);
  const templateId =
    typeof visualization?.template_id === 'string'
      ? visualization.template_id
      : typeof visualization?.templateId === 'string'
        ? visualization.templateId
        : null;
  const effectiveTemplateId = plannedTemplateId ?? templateId;

  const isHolding = dashboardKind === 'portfolio_rebalance' || dashboardKind === 'portfolio_risk' || effectiveTemplateId === 'holding-analysis';
  if (isHolding) {
    const assets = Array.isArray(finalData?.assets) ? finalData.assets : [];
    if (assets.length < 2) {
      return;
    }
    const pagePath = path.join(projectPath, 'app', 'page.tsx');
    const page = await fs.readFile(pagePath, 'utf8').catch(() => '');
    if (/data-template="holding-analysis"|持仓明细|仓位集中度|组合风险估算|浮动盈亏/.test(page)) {
      return;
    }
    await fs.writeFile(pagePath, holdingAnalysisPageTemplate(), 'utf8');
    const cssPath = path.join(projectPath, 'app', 'globals.css');
    const css = await fs.readFile(cssPath, 'utf8').catch(() => '');
    if (!css.includes('.holding-shell')) {
      await fs.writeFile(cssPath, `${css.trimEnd()}\n${holdingAnalysisCss()}`, 'utf8');
    }
    return;
  }

  if (effectiveTemplateId && effectiveTemplateId !== 'stock-selection' && effectiveTemplateId !== 'sector-rotation') {
    return;
  }
  const assets = Array.isArray(finalData?.assets) ? finalData.assets : [];
  if (assets.length < 2 && effectiveTemplateId !== 'stock-selection') {
    return;
  }

  const pagePath = path.join(projectPath, 'app', 'page.tsx');
  const page = await fs.readFile(pagePath, 'utf8').catch(() => '');
  const hasLegacySelectionPage =
    /TradingPlanPanel|getTradingPlanRows|tradingRows|短线交易计划|买入区间|止损|目标价|仓位上限/.test(page) ||
    /QuantPilot 选股分析|<strong>stock-selection<\/strong>|模板组件：|候选数量|候选视图|120 日收益|<dt>120 日<\/dt>/.test(page);
  const hasReadableSelectionPage =
    /data-template="stock-selection"/.test(page) &&
    /多标的指标矩阵|指标矩阵|ComparisonTable|comparison\.rows/.test(page) &&
    /收益对比主图|回撤对比主图|波动对比主图|selection-main-chart|chart-label|主图/.test(page);
  if (effectiveTemplateId === 'stock-selection' && hasReadableSelectionPage && !hasLegacySelectionPage) {
    const cssPath = path.join(projectPath, 'app', 'globals.css');
    await upsertGeneratedCssBlock(cssPath, 'comparison-dashboard', comparisonCss());
    await upsertGeneratedCssBlock(cssPath, 'stock-selection-dashboard', stockSelectionCss());
    await scrubLegacyTradingPlanCss(cssPath);
    return;
  }
  if (
    effectiveTemplateId !== 'stock-selection' &&
    /多标的相对强弱看板|指标矩阵|收益对比|回撤对比|波动率对比|流动性与可交易性/.test(page) &&
    /comparison-bars|chart-label|主图|矩阵/.test(page)
  ) {
    const cssPath = path.join(projectPath, 'app', 'globals.css');
    await upsertGeneratedCssBlock(cssPath, 'comparison-dashboard', comparisonCss());
    return;
  }

  await fs.writeFile(
    pagePath,
    effectiveTemplateId === 'stock-selection' ? stockSelectionPageTemplate() : comparisonPageTemplate(),
    'utf8'
  );

  const cssPath = path.join(projectPath, 'app', 'globals.css');
  await upsertGeneratedCssBlock(cssPath, 'comparison-dashboard', comparisonCss());
  if (effectiveTemplateId === 'stock-selection') {
    await upsertGeneratedCssBlock(cssPath, 'stock-selection-dashboard', stockSelectionCss());
    await scrubLegacyTradingPlanCss(cssPath);
  }
}

export async function ensureQuantDashboardTemplate(projectPath: string) {
  await scaffoldBasicNextApp(projectPath, path.basename(projectPath));
  await ensureComparisonDashboardTemplate(projectPath);
}

/**
 * Restore a generated dashboard to the platform-owned, validation-safe template.
 * This is intentionally separate from normal scaffolding so Agent enhancements are
 * preserved unless automatic validation proves that the generated page is broken.
 */
export async function restoreQuantDashboardTemplate(projectPath: string) {
  await scaffoldBasicNextApp(projectPath, path.basename(projectPath));
  await fs.writeFile(
    path.join(projectPath, 'app', 'page.tsx'),
    baseDashboardPageTemplate(),
    'utf8'
  );
  await fs.writeFile(
    path.join(projectPath, 'app', 'globals.css'),
    baseDashboardCssTemplate(),
    'utf8'
  );
  await ensureComparisonDashboardTemplate(projectPath);
}

export async function scaffoldBasicNextApp(
  projectPath: string,
  projectId: string
) {
  await fs.mkdir(projectPath, { recursive: true });

  const packageJson = {
    name: projectId,
    private: true,
    version: '0.1.0',
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
      typescript: '^6.0.3',
      '@types/react': '^19.2.15',
      '@types/node': '^22.19.19',
      eslint: '^9.17.0',
      'eslint-config-next': '^16.2.6',
    },
  };

  await mergePackageJson(
    path.join(projectPath, 'package.json'),
    packageJson
  );
  await ensureSharedNodeModules(projectPath);

  await ensureNextConfig(
    path.join(projectPath, 'next.config.js')
  );

  await writeFileIfMissing(
    path.join(projectPath, 'postcss.config.js'),
    `module.exports = {
  plugins: [],
};
`
  );

  await ensureGeneratedTsConfig(path.join(projectPath, 'tsconfig.json'));

  await writeFileIfMissing(
    path.join(projectPath, 'next-env.d.ts'),
    `/// <reference types="next" />
/// <reference types="next/image-types/global" />
import "./.next/types/routes.d.ts";

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
`
  );

  await writeFileIfMissing(
    path.join(projectPath, 'app/layout.tsx'),
    `import type { ReactNode } from 'react';
import './globals.css';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
`
  );

  await writeFileIfMissing(
    path.join(projectPath, 'app/api/market/[...path]/route.ts'),
    `import { NextRequest, NextResponse } from 'next/server';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const { path } = await context.params;
  const target = new URL('http://127.0.0.1:8000/api/v1/' + path.join('/'));
  const source = new URL(request.url);
  source.searchParams.forEach((value, key) => target.searchParams.set(key, value));

  const response = await fetch(target, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
    },
  });
  const body = await response.text();

  return new NextResponse(body, {
    status: response.status,
    headers: {
      'Content-Type': response.headers.get('Content-Type') ?? 'application/json',
    },
  });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
`
  );

  await writeFileIfMissing(
    path.join(projectPath, 'app/page.tsx'),
    baseDashboardPageTemplate()
  );

  await writeFileIfMissing(
    path.join(projectPath, 'app/globals.css'),
    baseDashboardCssTemplate()
  );

  await writeFileIfMissing(
    path.join(projectPath, 'scripts/run-build.js'),
    generatedBuildScriptContents()
  );

  await writeFileIfMissing(
    path.join(projectPath, 'scripts/run-dev.js'),
    generatedDevScriptContents()
  );

  await ensureComparisonDashboardTemplate(projectPath);
}
