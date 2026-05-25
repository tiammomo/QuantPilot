import fs from 'fs/promises';
import path from 'path';

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

    return (isDefaultNextPage && !hasQuantDataBinding) || hasUnstableQuantDashboard;
  }

  if (normalizedPath.endsWith('/app/globals.css')) {
    const hasQuantDashboardStyles =
      existing.includes('.dashboard-shell') ||
      existing.includes('.quant-dashboard') ||
      existing.includes('.chart-card');

    return !hasQuantDashboardStyles && trimmed.length < 600;
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
      /'next',\s*'dev'/.test(existing) ||
      !existing.includes("commandArgs.push('--turbo')") ||
      !existing.includes('delete runtimeEnv.NEXT_RSPACK') ||
      !existing.includes("fs.existsSync(path.join(projectRoot, '.next', 'BUILD_ID'))")
    );
  }

  return false;
}

type PackageJsonShape = {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

async function mergePackageJson(filePath: string, defaults: PackageJsonShape & Record<string, unknown>) {
  let packageJson = defaults;

  try {
    packageJson = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    // 文件缺失或 JSON 异常时，回写默认配置。
  }

  packageJson.scripts = {
    ...defaults.scripts,
    ...(packageJson.scripts ?? {}),
    build: 'next build',
  };
  if (packageJson.scripts.build === 'next build --webpack') {
    packageJson.scripts.build = 'next build';
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

  await fs.writeFile(
    filePath,
    `${JSON.stringify(packageJson, null, 2)}\n`,
    'utf8'
  );
}

async function ensureNextConfig(filePath: string) {
  const fallback = `/** @type {import('next').NextConfig} */
const projectRoot = __dirname;

const nextConfig = {
  typedRoutes: true,
  outputFileTracingRoot: projectRoot,
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
    /\n\s*turbopack:\s*\{\s*root:\s*projectRoot,?\s*\},?/m,
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

function comparisonPageTemplate() {
  return `import fs from 'fs/promises';
import path from 'path';

type JsonRecord = Record<string, unknown>;

const DATA_FILE = 'data_file/final/dashboard-data.json';

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatNumber(value: unknown, digits = 2): string {
  const number = numeric(value);
  if (number === null) return '-';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(number);
}

function formatPercent(value: unknown): string {
  const number = numeric(value);
  if (number === null) return '-';
  return (number > 0 ? '+' : '') + number.toFixed(2) + '%';
}

function formatMoney(value: unknown): string {
  const number = numeric(value);
  if (number === null) return '-';
  if (Math.abs(number) >= 100000000) return formatNumber(number / 100000000, 2) + ' 亿';
  if (Math.abs(number) >= 10000) return formatNumber(number / 10000, 2) + ' 万';
  return formatNumber(number);
}

async function readDashboardData(): Promise<JsonRecord | null> {
  try {
    const content = await fs.readFile(path.join(process.cwd(), DATA_FILE), 'utf8');
    return asRecord(JSON.parse(content));
  } catch {
    return null;
  }
}

function getAssets(data: JsonRecord | null): JsonRecord[] {
  return asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
}

function getComparisonRows(data: JsonRecord | null): JsonRecord[] {
  const comparison = asRecord(data?.comparison);
  const rows = asArray(comparison?.rows).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (rows.length > 0) return rows;
  return getAssets(data).map((asset) => {
    const quote = asRecord(asset.quote);
    const metrics = asRecord(asset.computedMetrics);
    return {
      symbol: asset.symbol ?? quote?.symbol,
      name: asset.name ?? quote?.name ?? asset.symbol,
      price: quote?.price,
      change_percent: quote?.change_percent,
      period_return: metrics?.periodReturn,
      max_drawdown: metrics?.maxDrawdown,
      volatility20d: metrics?.volatility20d,
      avg_volume_20d: metrics?.avgVolume20d,
      amount: quote?.amount,
      as_of: asset.as_of ?? quote?.quote_time ?? quote?.fetched_at,
      source: asset.source ?? quote?.source,
    };
  });
}

function getLeaders(data: JsonRecord | null): JsonRecord | null {
  return asRecord(asRecord(data?.comparison)?.leaders);
}

function tone(value: unknown): 'up' | 'down' | 'neutral' {
  const number = numeric(value);
  if (number === null || number === 0) return 'neutral';
  return number > 0 ? 'up' : 'down';
}

function BarChart({ rows, field, title, subtitle, inverse = false }: {
  rows: JsonRecord[];
  field: string;
  title: string;
  subtitle: string;
  inverse?: boolean;
}) {
  const values = rows.map((row) => numeric(row[field]) ?? 0);
  const maxAbs = Math.max(0.01, ...values.map((value) => Math.abs(value)));

  return (
    <section className="comparison-panel">
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </div>
      <svg className="comparison-bars" viewBox="0 0 100 56" preserveAspectRatio="none" role="img" aria-label={title}>
        <line x1="0" y1="44" x2="100" y2="44" className="axis" />
        {rows.map((row, index) => {
          const value = numeric(row[field]) ?? 0;
          const height = Math.max(2, (Math.abs(value) / maxAbs) * 38);
          const x = 8 + index * (84 / Math.max(rows.length, 1));
          const width = Math.min(16, 66 / Math.max(rows.length, 1));
          const y = 44 - height;
          const isPositive = inverse ? value <= 0 : value >= 0;
          return (
            <g key={String(row.symbol ?? index)} className={isPositive ? 'bar-up' : 'bar-down'}>
              <rect x={x.toFixed(2)} y={y.toFixed(2)} width={width.toFixed(2)} height={height.toFixed(2)} rx="1" />
            </g>
          );
        })}
      </svg>
      <div className="chart-value-row">
        {rows.map((row, index) => (
          <span key={String(row.symbol ?? index)}>
            {String(row.symbol ?? '-')} {formatPercent(row[field])}
          </span>
        ))}
      </div>
    </section>
  );
}

export default async function Home() {
  const data = await readDashboardData();
  const rows = getComparisonRows(data);
  const assets = getAssets(data);
  const leaders = getLeaders(data);
  const requestedSymbols = asArray(data?.requestedSymbols ?? data?.symbols).map(String);
  const bestReturn = asRecord(leaders?.best_return);
  const lowestDrawdown = asRecord(leaders?.lowest_drawdown);
  const lowestVolatility = asRecord(leaders?.lowest_volatility);

  return (
    <main className="comparison-shell" data-market-proxy="/api/market" data-source-file={DATA_FILE}>
      <section className="comparison-hero">
        <div>
          <p className="eyebrow">QuantPilot 多标的对比</p>
          <h1>多标的相对强弱看板</h1>
          <p>覆盖 {requestedSymbols.length || rows.length} 个标的：{requestedSymbols.join('、') || rows.map((row) => String(row.symbol)).join('、')}</p>
        </div>
        <div className="hero-meta">
          <span>样本：最近 60 个交易日</span>
          <span>数据：{String(data?.source ?? 'eastmoney')}</span>
          <span>文件：{DATA_FILE}</span>
        </div>
      </section>

      <section className="leader-grid">
        <article className="leader-card up">
          <span>收益领先</span>
          <strong>{String(bestReturn?.name ?? '-')}</strong>
          <em>{formatPercent(bestReturn?.value)}</em>
        </article>
        <article className="leader-card neutral">
          <span>回撤较小</span>
          <strong>{String(lowestDrawdown?.name ?? '-')}</strong>
          <em>{formatPercent(lowestDrawdown?.value)}</em>
        </article>
        <article className="leader-card neutral">
          <span>波动较低</span>
          <strong>{String(lowestVolatility?.name ?? '-')}</strong>
          <em>{formatPercent(lowestVolatility?.value)}</em>
        </article>
      </section>

      <section className="comparison-matrix">
        <div className="panel-heading">
          <div>
            <h2>指标矩阵</h2>
            <p>最新行情、区间收益、波动、回撤和成交额横向比较</p>
          </div>
          <span>{rows.length} 项</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>标的</th>
                <th>最新价</th>
                <th>涨跌幅</th>
                <th>区间收益</th>
                <th>最大回撤</th>
                <th>波动率</th>
                <th>成交额</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={String(row.symbol ?? index)}>
                  <td><strong>{String(row.name ?? row.symbol)}</strong><small>{String(row.symbol ?? '-')}</small></td>
                  <td>{formatNumber(row.price)}</td>
                  <td className={tone(row.change_percent)}>{formatPercent(row.change_percent)}</td>
                  <td className={tone(row.period_return)}>{formatPercent(row.period_return)}</td>
                  <td className="down">{formatPercent(row.max_drawdown)}</td>
                  <td>{formatPercent(row.volatility20d)}</td>
                  <td>{formatMoney(row.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="chart-grid">
        <BarChart rows={rows} field="period_return" title="收益对比" subtitle="同一窗口下的区间收益率" />
        <BarChart rows={rows} field="volatility20d" title="波动率对比" subtitle="20 日收益波动年化口径" />
        <BarChart rows={rows} field="max_drawdown" title="最大回撤对比" subtitle="从区间高点到低点的最大跌幅" inverse />
      </section>

      <section className="comparison-matrix">
        <div className="panel-heading">
          <div>
            <h2>数据来源与质量</h2>
            <p>逐只标的展示来源、时间和样本量；公开行情接口可能存在延迟。</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>标的</th>
                <th>来源</th>
                <th>行情时间</th>
                <th>K 线样本</th>
                <th>质量提示</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((asset, index) => {
                const quote = asRecord(asset.quote);
                const kline = asRecord(asset.kline);
                const quality = asRecord(quote?.data_quality) ?? asRecord(kline?.data_quality);
                return (
                  <tr key={String(asset.symbol ?? index)}>
                    <td><strong>{String(asset.name ?? quote?.name ?? asset.symbol)}</strong><small>{String(asset.symbol ?? quote?.symbol ?? '-')}</small></td>
                    <td>{String(asset.source ?? quote?.source ?? '-')}</td>
                    <td>{String(asset.as_of ?? quote?.quote_time ?? quote?.fetched_at ?? '-')}</td>
                    <td>{asArray(kline?.bars).length}</td>
                    <td>{String(quality?.status ?? 'ok')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
`;
}

function comparisonCss() {
  return `

.comparison-shell {
  min-height: 100vh;
  background: #f7f8fb;
  color: #111827;
  padding: 28px;
}

.comparison-hero {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  align-items: flex-end;
  padding: 28px;
  border: 1px solid #e5e7eb;
  background: #ffffff;
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.06);
}

.comparison-hero h1 {
  margin: 6px 0 8px;
  font-size: clamp(28px, 4vw, 48px);
  letter-spacing: 0;
}

.comparison-hero p,
.panel-heading p,
.chart-value-row,
.comparison-matrix small,
.hero-meta {
  color: #6b7280;
}

.eyebrow {
  margin: 0;
  color: #c7352f;
  font-weight: 700;
}

.hero-meta {
  display: grid;
  gap: 8px;
  text-align: right;
}

.leader-grid,
.chart-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  margin-top: 18px;
}

.leader-card,
.comparison-panel,
.comparison-matrix {
  border: 1px solid #e5e7eb;
  background: #ffffff;
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.05);
}

.leader-card {
  padding: 20px;
}

.leader-card span {
  display: block;
  color: #6b7280;
  margin-bottom: 8px;
}

.leader-card strong {
  display: block;
  font-size: 24px;
}

.leader-card em {
  display: block;
  margin-top: 8px;
  font-size: 20px;
  font-style: normal;
  font-weight: 800;
}

.comparison-matrix,
.comparison-panel {
  margin-top: 18px;
  padding: 20px;
}

.panel-heading {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 16px;
}

.panel-heading h2 {
  margin: 0 0 4px;
  font-size: 20px;
}

.table-wrap {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th,
td {
  padding: 12px;
  border-bottom: 1px solid #edf0f5;
  text-align: left;
  white-space: nowrap;
}

th {
  color: #6b7280;
  font-size: 13px;
  font-weight: 700;
}

td strong,
td small {
  display: block;
}

td small {
  margin-top: 2px;
}

.comparison-bars {
  width: 100%;
  height: 220px;
}

.axis {
  stroke: #d1d5db;
  stroke-width: 0.5;
}

.bar-up rect {
  fill: #d33b32;
}

.bar-down rect {
  fill: #16a36a;
}

.chart-value-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 13px;
}

.up {
  color: #d33b32;
}

.down {
  color: #16a36a;
}

.neutral {
  color: #374151;
}

@media (max-width: 900px) {
  .comparison-shell {
    padding: 16px;
  }

  .comparison-hero,
  .panel-heading {
    display: block;
  }

  .hero-meta {
    margin-top: 16px;
    text-align: left;
  }

  .leader-grid,
  .chart-grid {
    grid-template-columns: 1fr;
  }
}
`;
}

async function ensureComparisonDashboardTemplate(projectPath: string) {
  const finalData = await readJsonRecord(path.join(projectPath, 'data_file', 'final', 'dashboard-data.json'));
  const assets = Array.isArray(finalData?.assets) ? finalData.assets : [];
  if (assets.length < 2) {
    return;
  }

  const pagePath = path.join(projectPath, 'app', 'page.tsx');
  const page = await fs.readFile(pagePath, 'utf8').catch(() => '');
  if (/assets|comparison|多标的|相对强弱|收益对比|回撤对比|波动率对比/.test(page)) {
    return;
  }

  await fs.writeFile(pagePath, comparisonPageTemplate(), 'utf8');

  const cssPath = path.join(projectPath, 'app', 'globals.css');
  const css = await fs.readFile(cssPath, 'utf8').catch(() => '');
  if (!css.includes('.comparison-shell')) {
    await fs.writeFile(cssPath, `${css.trimEnd()}\n${comparisonCss()}`, 'utf8');
  }
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
      build: 'next build',
      start: 'next start',
      lint: 'next lint',
    },
    dependencies: {
      next: '^16.2.6',
      react: '19.0.0',
      'react-dom': '19.0.0',
    },
    devDependencies: {
      typescript: '^5.7.2',
      '@types/react': '^19.0.0',
      '@types/node': '^22.10.0',
      eslint: '^9.17.0',
      'eslint-config-next': '^16.2.6',
    },
  };

  await mergePackageJson(
    path.join(projectPath, 'package.json'),
    packageJson
  );

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

  await writeFileIfMissing(
    path.join(projectPath, 'tsconfig.json'),
    `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
`
  );

  await writeFileIfMissing(
    path.join(projectPath, 'next-env.d.ts'),
    `/// <reference types="next" />
/// <reference types="next/navigation-types/navigation" />
/// <reference types="next/image-types/global" />

// 注意：此文件由 Next.js 自动维护，通常不需要手动编辑。
// see https://nextjs.org/docs/basic-features/typescript for more information.
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
    `import fs from 'fs/promises';
import path from 'path';

type JsonRecord = Record<string, unknown>;

const DATA_FILE = 'data_file/final/dashboard-data.json';

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatNumber(value: unknown, digits = 2): string {
  const number = numeric(value);
  if (number === null) {
    return '-';
  }
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: digits,
  }).format(number);
}

function formatPercent(value: unknown): string {
  const number = numeric(value);
  if (number === null) {
    return '-';
  }
  return (number > 0 ? '+' : '') + number.toFixed(2) + '%';
}

async function readDashboardData(): Promise<JsonRecord | null> {
  try {
    const content = await fs.readFile(path.join(process.cwd(), DATA_FILE), 'utf8');
    const parsed = JSON.parse(content);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function getBars(data: JsonRecord | null): JsonRecord[] {
  const kline = asRecord(data?.kline) ?? asRecord(data?.history);
  const assets = asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (assets.length > 0) {
    const primaryAsset = assets.find((asset) => asArray(asRecord(asset.kline)?.bars).length > 0) ?? assets[0];
    return getBars(primaryAsset);
  }
  const candidates = [
    kline?.bars,
    kline?.data,
    kline?.items,
    data?.bars,
    data?.klines,
    data?.candles,
    Array.isArray(data?.history) ? data?.history : null,
  ];
  for (const candidate of candidates) {
    const bars = asArray(candidate).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
    if (bars.length > 0) {
      return bars;
    }
  }
  return [];
}

function getIndicatorSummary(data: JsonRecord | null): JsonRecord | null {
  const assets = asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (assets.length > 0) {
    return getIndicatorSummary(assets[0]);
  }
  const technical = asRecord(data?.technicalIndicators) ?? asRecord(data?.indicators) ?? asRecord(data?.technical);
  return asRecord(technical?.summary) ?? asRecord(data?.summary);
}

function getFundamentalSummary(data: JsonRecord | null): JsonRecord | null {
  const assets = asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (assets.length > 0) {
    return getFundamentalSummary(assets[0]);
  }
  const fundamental = asRecord(data?.fundamentalIndicators) ?? asRecord(data?.fundamentals) ?? asRecord(data?.financials);
  return asRecord(fundamental?.summary);
}

function getBacktest(data: JsonRecord | null): JsonRecord | null {
  const assets = asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (assets.length > 0) {
    return getBacktest(assets[0]);
  }
  return asRecord(data?.backtest);
}

function getReports(data: JsonRecord | null): JsonRecord[] {
  const assets = asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (assets.length > 0) {
    return getReports(assets[0]);
  }
  const financials = asRecord(data?.financials) ?? asRecord(data?.fundamentals);
  return asArray(financials?.reports ?? data?.reports).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
}

function getAnnouncements(data: JsonRecord | null): JsonRecord[] {
  const assets = asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (assets.length > 0) {
    return getAnnouncements(assets[0]);
  }
  const announcements = asRecord(data?.announcements) ?? asRecord(data?.events);
  return asArray(announcements?.announcements ?? announcements?.items ?? data?.announcement_events).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
}

function formatMoney(value: unknown): string {
  const number = numeric(value);
  if (number === null) {
    return '-';
  }
  if (Math.abs(number) >= 100000000) {
    return formatNumber(number / 100000000, 2) + ' 亿';
  }
  if (Math.abs(number) >= 10000) {
    return formatNumber(number / 10000, 2) + ' 万';
  }
  return formatNumber(number);
}

function formatDate(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    return '-';
  }
  return value.slice(0, 10);
}

function getComputedMetrics(data: JsonRecord | null): JsonRecord | null {
  const assets = asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (assets.length > 0) {
    return getComputedMetrics(assets[0]);
  }
  return asRecord(data?.computedMetrics);
}

function getTechnicalPoints(data: JsonRecord | null): JsonRecord[] {
  const technical = asRecord(data?.technicalIndicators);
  return asArray(technical?.points).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
}

function movingAverage(values: Array<number | null>, windowSize: number, index: number): number | null {
  if (index + 1 < windowSize) {
    return null;
  }
  const windowValues = values.slice(index + 1 - windowSize, index + 1).filter((value): value is number => value !== null);
  if (windowValues.length < windowSize) {
    return null;
  }
  return windowValues.reduce((sum, value) => sum + value, 0) / windowValues.length;
}

function scaleY(value: number, min: number, max: number): number {
  const range = Math.max(max - min, 0.000001);
  return 86 - ((value - min) / range) * 70;
}

function buildLinePath(values: Array<number | null>, min: number, max: number): string {
  const validCount = values.filter((value): value is number => value !== null).length;
  if (validCount < 2) {
    return '';
  }
  let started = false;
  return values
    .map((value, index) => {
      if (value === null) {
        return '';
      }
      const x = (index / Math.max(values.length - 1, 1)) * 100;
      const y = scaleY(value, min, max);
      const segment = (started ? 'L ' : 'M ') + x.toFixed(2) + ' ' + y.toFixed(2);
      started = true;
      return segment;
    })
    .filter(Boolean)
    .join(' ');
}

function TrendChart({ bars }: { bars: JsonRecord[] }) {
  const visibleBars = bars.slice(-60);
  const closes = visibleBars.map((bar) => numeric(bar.close));
  const highs = visibleBars.map((bar) => numeric(bar.high) ?? numeric(bar.close)).filter((value): value is number => value !== null);
  const lows = visibleBars.map((bar) => numeric(bar.low) ?? numeric(bar.close)).filter((value): value is number => value !== null);
  const volumes = visibleBars.map((bar) => numeric(bar.volume) ?? 0);
  const minPrice = lows.length ? Math.min(...lows) : 0;
  const maxPrice = highs.length ? Math.max(...highs) : 1;
  const maxVolume = Math.max(1, ...volumes);
  const ma5 = closes.map((_, index) => movingAverage(closes, 5, index));
  const ma10 = closes.map((_, index) => movingAverage(closes, 10, index));
  const ma20 = closes.map((_, index) => movingAverage(closes, 20, index));

  return (
    <div className="chart-panel">
      <div className="panel-heading">
        <div>
          <h2>K 线与量价结构</h2>
          <p>OHLC 蜡烛图、MA5/MA10/MA20、成交量和阶段走势</p>
        </div>
        <span>{bars.length} 条样本</span>
      </div>
      <div className="chart-legend">
        <span className="legend-price">K 线</span>
        <span className="legend-ma5">MA5</span>
        <span className="legend-ma10">MA10</span>
        <span className="legend-ma20">MA20</span>
      </div>
      <svg className="trend-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="K 线 OHLC 趋势图">
        <line x1="0" y1="86" x2="100" y2="86" className="axis" />
        <line x1="0" y1="16" x2="100" y2="16" className="axis muted" />
        {visibleBars.map((bar, index) => {
          const open = numeric(bar.open) ?? numeric(bar.close);
          const close = numeric(bar.close) ?? open;
          const high = numeric(bar.high) ?? Math.max(open ?? 0, close ?? 0);
          const low = numeric(bar.low) ?? Math.min(open ?? 0, close ?? 0);
          if (open === null || close === null) {
            return null;
          }
          const x = (index / Math.max(visibleBars.length - 1, 1)) * 100;
          const yHigh = scaleY(high, minPrice, maxPrice);
          const yLow = scaleY(low, minPrice, maxPrice);
          const yOpen = scaleY(open, minPrice, maxPrice);
          const yClose = scaleY(close, minPrice, maxPrice);
          const candleTop = Math.min(yOpen, yClose);
          const candleHeight = Math.max(Math.abs(yClose - yOpen), 0.8);
          const up = close >= open;
          return (
            <g
              key={String(bar.date ?? index)}
              className={up ? 'candle-up' : 'candle-down'}
            >
              <line x1={x.toFixed(2)} x2={x.toFixed(2)} y1={yHigh.toFixed(2)} y2={yLow.toFixed(2)} />
              <rect x={(x - 0.55).toFixed(2)} y={candleTop.toFixed(2)} width="1.1" height={candleHeight.toFixed(2)} />
            </g>
          );
        })}
        <path d={buildLinePath(ma5, minPrice, maxPrice)} className="ma-line ma5" />
        <path d={buildLinePath(ma10, minPrice, maxPrice)} className="ma-line ma10" />
        <path d={buildLinePath(ma20, minPrice, maxPrice)} className="ma-line ma20" />
      </svg>

      <svg className="volume-chart" viewBox="0 0 100 36" preserveAspectRatio="none" role="img" aria-label="成交量柱状图">
        <line x1="0" y1="32" x2="100" y2="32" className="axis" />
        {visibleBars.map((bar, index) => {
          const open = numeric(bar.open) ?? numeric(bar.close) ?? 0;
          const close = numeric(bar.close) ?? open;
          const volume = numeric(bar.volume) ?? 0;
          const height = Math.max(1, (volume / maxVolume) * 28);
          const x = (index / Math.max(visibleBars.length - 1, 1)) * 100;
          return (
            <rect
              key={String(bar.date ?? index)}
              x={(x - 0.55).toFixed(2)}
              y={(32 - height).toFixed(2)}
              width="1.1"
              height={height.toFixed(2)}
              className={close >= open ? 'volume-up' : 'volume-down'}
            />
          );
        })}
      </svg>
    </div>
  );
}

function buildEquityPath(points: JsonRecord[]): string {
  const values = points.map((point) => numeric(point.equity)).filter((value): value is number => value !== null);
  if (values.length < 2) {
    return '';
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 0.000001);
  return values
    .map((value, index) => {
      const x = (index / Math.max(values.length - 1, 1)) * 100;
      const y = 86 - ((value - min) / range) * 70;
      return (index === 0 ? 'M ' : 'L ') + x.toFixed(2) + ' ' + y.toFixed(2);
    })
    .join(' ');
}

function BacktestPanel({ backtest }: { backtest: JsonRecord | null }) {
  const summary = asRecord(backtest?.summary);
  const points = asArray(backtest?.equity_curve).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  const trades = asArray(backtest?.trades).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  const equityPath = buildEquityPath(points);

  if (!backtest) {
    return null;
  }

  return (
    <section className="backtest-section">
      <div className="panel-heading">
        <div>
          <h2>回测复盘</h2>
          <p>
            {String(backtest.strategy_name ?? '均线突破')} · MA{String(backtest.fast_window ?? '-')} / MA{String(backtest.slow_window ?? '-')} · 费用 {formatNumber(backtest.fee_bps)} bps
          </p>
        </div>
        <span>{points.length} 个交易日</span>
      </div>

      <div className="metric-grid backtest-metrics">
        <article><span>策略收益</span><strong>{formatPercent(summary?.total_return_pct)}</strong></article>
        <article><span>标的收益</span><strong>{formatPercent(summary?.benchmark_return_pct)}</strong></article>
        <article><span>最大回撤</span><strong>{formatPercent(summary?.max_drawdown_pct)}</strong></article>
        <article><span>胜率</span><strong>{formatPercent(summary?.win_rate_pct)}</strong></article>
      </div>

      <div className="backtest-grid">
        <div className="chart-panel embedded">
          <div className="panel-heading compact">
            <div>
              <h2>策略净值</h2>
              <p>全仓/空仓规则下的净值曲线</p>
            </div>
            <span>净值 {formatNumber(summary?.final_equity, 4)}</span>
          </div>
          <svg className="trend-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="回测净值曲线">
            <line x1="0" y1="86" x2="100" y2="86" className="axis" />
            <line x1="0" y1="16" x2="100" y2="16" className="axis muted" />
            {equityPath ? <path d={equityPath} className="equity-line" /> : null}
          </svg>
        </div>

        <article className="data-panel">
          <h2>交易明细</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>买入</th><th>卖出</th><th>收益</th><th>天数</th></tr>
              </thead>
              <tbody>
                {trades.slice(-8).reverse().map((trade, index) => (
                  <tr key={String(trade.entry_date ?? index)}>
                    <td>{String(trade.entry_date ?? '-')}</td>
                    <td>{String(trade.exit_date ?? trade.status ?? '-')}</td>
                    <td className={(numeric(trade.return_pct) ?? 0) >= 0 ? 'red' : 'green'}>{formatPercent(trade.return_pct)}</td>
                    <td>{formatNumber(trade.holding_days, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="empty-state">当前回测暂未建模滑点、停牌、分红再投资和冲击成本，结果用于策略研究参考。</p>
        </article>
      </div>
    </section>
  );
}

function FinancialPanel({
  reports,
  summary,
}: {
  reports: JsonRecord[];
  summary: JsonRecord | null;
}) {
  const recentReports = reports.slice(0, 6);
  const chartReports = recentReports.slice().reverse();
  const maxRevenue = Math.max(
    1,
    ...chartReports.map((report) => numeric(report.revenue) ?? 0)
  );

  return (
    <article className="data-panel financial-panel">
      <div className="panel-heading compact">
        <div>
          <h2>财务趋势</h2>
          <p>营收、归母净利润、ROE、毛利率和净利率</p>
        </div>
        <span>{reports.length} 期</span>
      </div>

      <div className="mini-metric-grid">
        <div><span>最新营收</span><strong>{formatMoney(summary?.latest_revenue)}</strong></div>
        <div><span>归母净利</span><strong>{formatMoney(summary?.latest_parent_net_profit)}</strong></div>
        <div><span>平均 ROE</span><strong>{formatPercent(summary?.avg_roe)}</strong></div>
        <div><span>净利率</span><strong>{formatPercent(summary?.latest_net_margin)}</strong></div>
      </div>

      {chartReports.length > 0 ? (
        <div className="financial-bars" aria-label="财务柱状趋势图">
          {chartReports.map((report, index) => {
            const revenue = numeric(report.revenue) ?? 0;
            const profit = numeric(report.parent_net_profit) ?? 0;
            const revenueHeight = Math.max(8, (revenue / maxRevenue) * 100);
            const profitHeight = Math.max(6, Math.min(100, (profit / maxRevenue) * 100));
            return (
              <div className="financial-bar-group" key={String(report.report_date ?? index)}>
                <div className="bar-stack">
                  <span className="bar revenue" style={{ height: revenueHeight + '%' }} />
                  <span className="bar profit" style={{ height: profitHeight + '%' }} />
                </div>
                <small>{formatDate(report.report_date)}</small>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="empty-state">暂无财务摘要。指数或 ETF 标的通常不提供个股财务报表。</p>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>报告期</th><th>营收</th><th>净利润</th><th>ROE</th><th>毛利率</th></tr>
          </thead>
          <tbody>
            {recentReports.map((report, index) => (
              <tr key={String(report.report_date ?? index)}>
                <td>{formatDate(report.report_date)}</td>
                <td>{formatMoney(report.revenue)}</td>
                <td>{formatMoney(report.parent_net_profit)}</td>
                <td>{formatPercent(report.weighted_roe)}</td>
                <td>{formatPercent(report.gross_margin)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function AnnouncementPanel({ announcements }: { announcements: JsonRecord[] }) {
  const recent = announcements.slice(0, 6);

  return (
    <article className="data-panel">
      <div className="panel-heading compact">
        <div>
          <h2>公告事件</h2>
          <p>近期公告标题、日期和事件线索</p>
        </div>
        <span>{announcements.length} 条</span>
      </div>
      {recent.length > 0 ? (
        <ul className="announcement-list">
          {recent.map((item, index) => (
            <li key={String(item.art_code ?? index)}>
              <span>{formatDate(item.notice_date ?? item.display_time)}</span>
              <strong>{String(item.title ?? '未命名公告')}</strong>
              <em>{asArray(item.columns).map(String).join(' / ') || '公告'}</em>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-state">暂无公告事件。指数或 ETF 标的通常不提供个股公告列表。</p>
      )}
    </article>
  );
}

function SignalPanel({
  quote,
  latestBar,
  summary,
  computedMetrics,
  data,
}: {
  quote: JsonRecord | null;
  latestBar?: JsonRecord;
  summary: JsonRecord | null;
  computedMetrics: JsonRecord | null;
  data: JsonRecord | null;
}) {
  const latestPrice = numeric(quote?.price ?? latestBar?.close);
  const ma5 = numeric(summary?.ma5 ?? computedMetrics?.ma5);
  const ma20 = numeric(summary?.ma20 ?? computedMetrics?.ma20);
  const volume = numeric(latestBar?.volume);
  const avgVolume = numeric(computedMetrics?.avgVolume20d);
  const aboveMa20 = latestPrice !== null && ma20 !== null ? latestPrice >= ma20 : null;
  const maTrend = ma5 !== null && ma20 !== null ? ma5 >= ma20 : null;
  const volumeSignal = volume !== null && avgVolume !== null ? volume / Math.max(avgVolume, 1) : null;
  const dataQuality = asRecord(data?.data_quality) ?? asRecord(asRecord(data?.kline)?.data_quality);
  const warnings = asArray(dataQuality?.warnings).map(String);

  return (
    <article className="data-panel signal-panel">
      <div className="panel-heading compact">
        <div>
          <h2>量化信号摘要</h2>
          <p>价格位置、均线结构、量能和数据质量</p>
        </div>
        <span>{String(dataQuality?.status ?? 'ok')}</span>
      </div>
      <div className="signal-list">
        <div>
          <span>价格位置</span>
          <strong className={aboveMa20 === null ? '' : aboveMa20 ? 'red' : 'green'}>
            {aboveMa20 === null ? '待确认' : aboveMa20 ? '站上 MA20' : '低于 MA20'}
          </strong>
        </div>
        <div>
          <span>均线结构</span>
          <strong className={maTrend === null ? '' : maTrend ? 'red' : 'green'}>
            {maTrend === null ? '待确认' : maTrend ? '短多排列' : '短线偏弱'}
          </strong>
        </div>
        <div>
          <span>量能状态</span>
          <strong>{volumeSignal === null ? '待确认' : volumeSignal >= 1.2 ? '放量' : volumeSignal <= 0.8 ? '缩量' : '常态'}</strong>
        </div>
      </div>
      {warnings.length > 0 ? (
        <ul className="warning-list">
          {warnings.slice(0, 3).map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      ) : (
        <p className="empty-state">未检测到阻断性数据质量警告。</p>
      )}
    </article>
  );
}

export default async function Home() {
  const data = await readDashboardData();
  const assets = asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  const primaryAsset = assets[0] ?? data;
  const quote = asRecord(primaryAsset?.quote) ?? asRecord(data?.quote);
  const bars = getBars(data);
  const summary = getIndicatorSummary(data);
  const computedMetrics = getComputedMetrics(data);
  const fundamentalSummary = getFundamentalSummary(data);
  const reports = getReports(data);
  const announcements = getAnnouncements(data);
  const backtest = getBacktest(data);
  const latestBar = bars.at(-1);
  const name = String(primaryAsset?.name ?? quote?.name ?? primaryAsset?.symbol ?? data?.name ?? 'QuantPilot');
  const symbol = String(primaryAsset?.symbol ?? quote?.symbol ?? data?.symbol ?? '-');
  const change = numeric(quote?.change_percent ?? latestBar?.change_percent);
  const isUp = (change ?? 0) >= 0;

  return (
    <main className="dashboard-shell" data-market-proxy="/api/market" data-source-file={DATA_FILE}>
      <section className="hero-band">
        <div>
          <p className="eyebrow">QuantPilot 看板</p>
          <h1>{name}</h1>
          <div className="meta-row">
            <span>{symbol}</span>
            <span>{String(data?.asset_type ?? quote?.asset_type ?? 'stock')}</span>
            <span>{String(data?.source ?? quote?.source ?? 'eastmoney')}</span>
          </div>
        </div>
        <div className={isUp ? 'quote-card up' : 'quote-card down'}>
          <span>最新价</span>
          <strong>{formatNumber(quote?.price ?? latestBar?.close)}</strong>
          <em>{formatPercent(change)}</em>
        </div>
      </section>

      <section className="metric-grid">
        <article>
          <span>区间收益</span>
          <strong>{formatPercent(summary?.period_return_pct ?? computedMetrics?.periodReturn)}</strong>
        </article>
        <article>
          <span>最大回撤</span>
          <strong>{formatPercent(summary?.max_drawdown_pct)}</strong>
        </article>
        <article>
          <span>年化波动率</span>
          <strong>{formatPercent(summary?.volatility_annualized_pct ?? computedMetrics?.volatility20d)}</strong>
        </article>
        <article>
          <span>MA20</span>
          <strong>{formatNumber(summary?.ma20 ?? computedMetrics?.ma20)}</strong>
        </article>
      </section>

      <section className="main-grid">
        <TrendChart bars={bars} />
        <SignalPanel
          quote={quote}
          latestBar={latestBar}
          summary={summary}
          computedMetrics={computedMetrics}
          data={data}
        />
      </section>

      <BacktestPanel backtest={backtest} />

      <section className="metric-grid financial-metrics">
        <article>
          <span>最新营收</span>
          <strong>{formatMoney(fundamentalSummary?.latest_revenue)}</strong>
        </article>
        <article>
          <span>归母净利润</span>
          <strong>{formatMoney(fundamentalSummary?.latest_parent_net_profit)}</strong>
        </article>
        <article>
          <span>平均毛利率</span>
          <strong>{formatPercent(fundamentalSummary?.avg_gross_margin)}</strong>
        </article>
        <article>
          <span>平均净利率</span>
          <strong>{formatPercent(fundamentalSummary?.avg_net_margin)}</strong>
        </article>
      </section>

      <section className="detail-grid">
        <article className="data-panel">
          <h2>数据来源</h2>
          <dl>
            <div><dt>时间</dt><dd>{String(data?.as_of ?? quote?.quote_time ?? quote?.fetched_at ?? '-')}</dd></div>
            <div><dt>缓存</dt><dd>{String(asRecord(quote?.fetch)?.cache_status ?? '-')}</dd></div>
            <div><dt>文件</dt><dd>{DATA_FILE}</dd></div>
          </dl>
        </article>
        <article className="data-panel">
          <h2>最近 K 线</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>日期</th><th>开盘</th><th>最高</th><th>最低</th><th>收盘</th><th>涨跌幅</th><th>成交额</th><th>成交量</th></tr>
              </thead>
              <tbody>
                {bars.slice(-10).reverse().map((bar, index) => (
                  <tr key={String(bar.date ?? index)}>
                    <td>{String(bar.date ?? '-')}</td>
                    <td>{formatNumber(bar.open)}</td>
                    <td>{formatNumber(bar.high)}</td>
                    <td>{formatNumber(bar.low)}</td>
                    <td>{formatNumber(bar.close)}</td>
                    <td className={(numeric(bar.change_percent) ?? 0) >= 0 ? 'red' : 'green'}>{formatPercent(bar.change_percent)}</td>
                    <td>{formatMoney(bar.amount)}</td>
                    <td>{formatNumber(bar.volume, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      </section>

      <section className="detail-grid wide">
        <FinancialPanel reports={reports} summary={fundamentalSummary} />
        <AnnouncementPanel announcements={announcements} />
      </section>
    </main>
  );
}
`
  );

  await writeFileIfMissing(
    path.join(projectPath, 'app/globals.css'),
    `:root {
  color-scheme: light;
  --bg: #f7f8fb;
  --ink: #182033;
  --muted: #647087;
  --line: #dfe4ec;
  --panel: #ffffff;
  --red: #d9363e;
  --green: #15945b;
  --blue: #2f6fed;
  --gold: #b88719;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
  font-family:
    Arial,
    "Microsoft YaHei",
    sans-serif;
}

button,
input,
select,
textarea {
  font: inherit;
}

.dashboard-shell {
  width: min(1180px, calc(100vw - 32px));
  margin: 0 auto;
  padding: 32px 0 48px;
}

.hero-band {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(220px, 300px);
  gap: 20px;
  align-items: stretch;
  padding: 28px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
}

.eyebrow {
  margin: 0 0 8px;
  color: var(--gold);
  font-size: 13px;
  font-weight: 700;
}

h1,
h2,
p {
  margin-top: 0;
}

h1 {
  margin-bottom: 14px;
  font-size: clamp(30px, 5vw, 56px);
  line-height: 1;
  letter-spacing: 0;
}

h2 {
  margin-bottom: 6px;
  font-size: 18px;
}

.meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.meta-row span,
.panel-heading span {
  min-height: 28px;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  font-size: 13px;
}

.quote-card {
  display: grid;
  gap: 8px;
  align-content: center;
  min-height: 150px;
  padding: 20px;
  border-radius: 8px;
  color: #fff;
}

.quote-card.up {
  background: var(--red);
}

.quote-card.down {
  background: var(--green);
}

.quote-card span {
  font-size: 14px;
  opacity: 0.82;
}

.quote-card strong {
  font-size: 42px;
  line-height: 1;
}

.quote-card em {
  font-style: normal;
  font-weight: 700;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin-top: 16px;
}

.metric-grid article,
.chart-panel,
.data-panel {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
}

.metric-grid article {
  min-height: 92px;
  padding: 18px;
}

.metric-grid span {
  display: block;
  margin-bottom: 10px;
  color: var(--muted);
  font-size: 13px;
}

.metric-grid strong {
  font-size: 26px;
}

.chart-panel {
  margin-top: 16px;
  padding: 20px;
}

.main-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(280px, 0.75fr);
  gap: 16px;
  margin-top: 16px;
}

.main-grid .chart-panel {
  margin-top: 0;
}

.backtest-section {
  margin-top: 16px;
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
}

.backtest-section .metric-grid {
  margin-top: 0;
}

.backtest-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.8fr);
  gap: 16px;
  margin-top: 16px;
}

.chart-panel.embedded {
  margin-top: 0;
}

.panel-heading {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}

.panel-heading.compact {
  align-items: flex-start;
}

.panel-heading p {
  margin-bottom: 0;
  color: var(--muted);
  font-size: 14px;
}

.trend-chart {
  width: 100%;
  height: 330px;
  overflow: visible;
}

.volume-chart {
  width: 100%;
  height: 96px;
  margin-top: 12px;
}

.chart-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 10px;
  color: var(--muted);
  font-size: 12px;
}

.chart-legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.chart-legend span::before {
  content: "";
  width: 18px;
  height: 3px;
  border-radius: 999px;
  background: currentColor;
}

.legend-price {
  color: var(--ink);
}

.legend-ma5 {
  color: var(--blue);
}

.legend-ma10 {
  color: var(--gold);
}

.legend-ma20 {
  color: #7c3aed;
}

.axis {
  stroke: var(--line);
  stroke-width: 0.6;
}

.axis.muted {
  opacity: 0.55;
}

.equity-line {
  fill: none;
  stroke: var(--gold);
  stroke-width: 2.4;
  vector-effect: non-scaling-stroke;
}

.candle-up line,
.candle-up rect {
  fill: color-mix(in srgb, var(--red) 86%, white);
  stroke: var(--red);
  stroke-width: 0.7;
  vector-effect: non-scaling-stroke;
}

.candle-down line,
.candle-down rect {
  fill: color-mix(in srgb, var(--green) 86%, white);
  stroke: var(--green);
  stroke-width: 0.7;
  vector-effect: non-scaling-stroke;
}

.ma-line {
  fill: none;
  stroke-width: 1.2;
  vector-effect: non-scaling-stroke;
}

.ma5 {
  stroke: var(--blue);
}

.ma10 {
  stroke: var(--gold);
}

.ma20 {
  stroke: #7c3aed;
}

.volume-up {
  fill: color-mix(in srgb, var(--red) 72%, white);
}

.volume-down {
  fill: color-mix(in srgb, var(--green) 72%, white);
}

.detail-grid {
  display: grid;
  grid-template-columns: minmax(260px, 0.9fr) minmax(0, 1.4fr);
  gap: 16px;
  margin-top: 16px;
}

.detail-grid.wide {
  grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.8fr);
}

.data-panel {
  padding: 20px;
}

.signal-panel {
  margin-top: 0;
}

.signal-list {
  display: grid;
  gap: 10px;
}

.signal-list div {
  display: grid;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fbfcff;
}

.signal-list span {
  color: var(--muted);
  font-size: 12px;
}

.signal-list strong {
  font-size: 18px;
}

.warning-list {
  display: grid;
  gap: 8px;
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
}

.warning-list li {
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--gold) 38%, white);
  border-radius: 8px;
  color: #805600;
  background: #fff8e5;
  font-size: 13px;
}

.mini-metric-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin: 14px 0 18px;
}

.mini-metric-grid div {
  min-height: 76px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fbfcff;
}

.mini-metric-grid span {
  display: block;
  margin-bottom: 8px;
  color: var(--muted);
  font-size: 12px;
}

.mini-metric-grid strong {
  font-size: 18px;
}

.financial-bars {
  display: grid;
  grid-template-columns: repeat(6, minmax(34px, 1fr));
  gap: 10px;
  align-items: end;
  height: 180px;
  margin: 8px 0 18px;
  padding: 12px 8px 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fbfcff;
}

.financial-bar-group {
  display: grid;
  gap: 8px;
  align-items: end;
  min-width: 0;
  height: 100%;
}

.bar-stack {
  position: relative;
  display: flex;
  align-items: end;
  justify-content: center;
  gap: 3px;
  height: 130px;
}

.bar {
  width: 10px;
  min-height: 4px;
  border-radius: 999px 999px 2px 2px;
}

.bar.revenue {
  background: var(--blue);
}

.bar.profit {
  background: var(--gold);
}

.financial-bar-group small {
  overflow: hidden;
  color: var(--muted);
  font-size: 11px;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.announcement-list {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.announcement-list li {
  display: grid;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fbfcff;
}

.announcement-list span,
.announcement-list em {
  color: var(--muted);
  font-size: 12px;
  font-style: normal;
}

.announcement-list strong {
  line-height: 1.45;
}

.empty-state {
  margin: 10px 0 0;
  padding: 14px;
  border: 1px dashed var(--line);
  border-radius: 8px;
  color: var(--muted);
  background: #fbfcff;
}

dl {
  display: grid;
  gap: 12px;
  margin: 0;
}

dl div {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 12px;
}

dt {
  color: var(--muted);
}

dd {
  margin: 0;
  word-break: break-word;
}

.table-wrap {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

th,
td {
  padding: 10px 8px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  white-space: nowrap;
}

th {
  color: var(--muted);
  font-weight: 600;
}

.red {
  color: var(--red);
}

.green {
  color: var(--green);
}

@media (max-width: 800px) {
  .dashboard-shell {
    width: min(100vw - 20px, 720px);
    padding-top: 16px;
  }

  .hero-band,
  .main-grid,
  .detail-grid,
  .detail-grid.wide,
  .backtest-grid {
    grid-template-columns: 1fr;
  }

  .metric-grid,
  .mini-metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .trend-chart {
    height: 240px;
  }
}

@media (max-width: 520px) {
  .metric-grid {
    grid-template-columns: 1fr;
  }

  .mini-metric-grid {
    grid-template-columns: 1fr;
  }

  .hero-band,
  .chart-panel,
  .data-panel {
    padding: 16px;
  }
}
`
  );

  await writeFileIfMissing(
    path.join(projectPath, 'scripts/run-dev.js'),
    `#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const isWindows = process.platform === 'win32';

function parseCliArgs(argv) {
  const passthrough = [];
  let preferredPort;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--port' || arg === '-p') {
      const value = argv[i + 1];
      if (value && !value.startsWith('-')) {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isNaN(parsed)) {
          preferredPort = parsed;
        }
        i += 1;
        continue;
      }
    } else if (arg.startsWith('--port=')) {
      const value = arg.slice('--port='.length);
      const parsed = Number.parseInt(value, 10);
      if (!Number.isNaN(parsed)) {
        preferredPort = parsed;
      }
      continue;
    } else if (arg.startsWith('-p=')) {
      const value = arg.slice('-p='.length);
      const parsed = Number.parseInt(value, 10);
      if (!Number.isNaN(parsed)) {
        preferredPort = parsed;
      }
      continue;
    }

    passthrough.push(arg);
  }

  return { preferredPort, passthrough };
}

function resolvePort(preferredPort) {
  const candidates = [
    preferredPort,
    process.env.PORT,
    process.env.WEB_PORT,
    process.env.PREVIEW_PORT_START,
    3100,
  ];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) {
      continue;
    }

    const numeric =
      typeof candidate === 'number'
        ? candidate
        : Number.parseInt(String(candidate), 10);

    if (!Number.isNaN(numeric) && numeric > 0 && numeric <= 65535) {
      return numeric;
    }
  }

  return 3100;
}

(async () => {
  const argv = process.argv.slice(2);
  const { preferredPort, passthrough } = parseCliArgs(argv);
  const port = resolvePort(preferredPort);
  const url =
    process.env.NEXT_PUBLIC_APP_URL || \`http://localhost:\${port}\`;

  process.env.PORT = String(port);
  process.env.WEB_PORT = String(port);
  process.env.NEXT_PUBLIC_APP_URL = url;

  console.log(\`🚀 Starting Next.js dev server on \${url}\`);

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
    NEXT_TELEMETRY_DISABLED: '1',
  };
  delete runtimeEnv.NEXT_RSPACK;
  delete runtimeEnv.TURBOPACK;

  const child = spawn(
    'npx',
    commandArgs,
    {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: isWindows,
      env: runtimeEnv,
    }
  );

  child.on('exit', (code) => {
    if (typeof code === 'number' && code !== 0) {
      console.error(\`❌ Next.js dev server exited with code \${code}\`);
      process.exit(code);
    }
  });

  child.on('error', (error) => {
    console.error('❌ Failed to start Next.js dev server');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
})();
`
  );

  await ensureComparisonDashboardTemplate(projectPath);
}
