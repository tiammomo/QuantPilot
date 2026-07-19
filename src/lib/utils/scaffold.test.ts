import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { restoreQuantDashboardTemplate, scaffoldBasicNextApp } from './scaffold';
import {
  comparisonCss,
  comparisonPageTemplate,
  holdingAnalysisCss,
  holdingAnalysisPageTemplate,
  stockSelectionCss,
  stockSelectionPageTemplate,
} from './scaffold-dashboard-templates';

const temporaryProjects: string[] = [];

async function createProject() {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-scaffold-'));
  temporaryProjects.push(projectPath);
  await fs.mkdir(path.join(projectPath, '.quantpilot'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'data_file', 'final'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'app'), { recursive: true });
  return projectPath;
}

afterEach(async () => {
  await Promise.all(
    temporaryProjects.splice(0).map((projectPath) =>
      fs.rm(projectPath, { recursive: true, force: true })
    )
  );
});

describe('restoreQuantDashboardTemplate', () => {
  it('keeps platform scenario templates as continuous workbenches without hero or duplicate card grids', () => {
    const templates = [
      {
        name: 'comparison',
        page: comparisonPageTemplate(),
        css: comparisonCss(),
        required: ['comparison-header', 'comparison-metrics', '指标矩阵', 'chart-grid'],
        forbidden: ['comparison-hero', 'leader-card', 'leader-grid'],
      },
      {
        name: 'stock-selection',
        page: stockSelectionPageTemplate(),
        css: stockSelectionCss(),
        required: ['selection-header', 'selection-metrics', '多标的指标矩阵', 'core-chart-panel'],
        forbidden: ['selection-hero', 'summary-grid', 'asset-grid', 'asset-card', 'AssetCards', 'function Sparkline('],
      },
      {
        name: 'holding-analysis',
        page: holdingAnalysisPageTemplate(),
        css: holdingAnalysisCss(),
        required: ['holding-header', 'portfolio-metrics', 'risk-strip', '持仓明细', 'portfolio-chart-panel'],
        forbidden: ['holding-hero', 'hero-summary', 'holding-grid', 'holding-card', 'HoldingCards', 'function Sparkline(', 'risk-grid'],
      },
    ];

    for (const template of templates) {
      expect(template.page, template.name).toContain('data-visual-language="financial-workbench"');
      for (const signal of template.required) {
        expect(template.page, `${template.name}: ${signal}`).toContain(signal);
      }
      for (const legacyStructure of template.forbidden) {
        expect(template.page, `${template.name} page: ${legacyStructure}`).not.toContain(legacyStructure);
        expect(template.css, `${template.name} css: ${legacyStructure}`).not.toContain(legacyStructure);
      }
      for (const hiddenEvidenceDetail of ['数据信源渠道', '技术证据', '行情源：', 'evidence/sources.json', '场景模板', '必备组件']) {
        expect(template.page, `${template.name}: ${hiddenEvidenceDetail}`).not.toContain(hiddenEvidenceDetail);
      }
    }
  });

  it('contains long ETF names and wide comparison content on mobile workbenches', () => {
    for (const [name, css] of [
      ['comparison', comparisonCss()],
      ['stock-selection', stockSelectionCss()],
    ] as const) {
      expect(css, name).toContain('max-width: 100%');
      expect(css, name).toContain('min-width: 0');
      expect(css, name).toContain('overflow-wrap: anywhere');
      expect(css, name).toContain('white-space: normal');
      expect(css, name).not.toContain('width: 100vw');
    }
  });

  it('replaces an invalid Agent page with the platform technical dashboard', async () => {
    const projectPath = await createProject();
    await Promise.all([
      fs.writeFile(
        path.join(projectPath, '.quantpilot', 'run_plan.json'),
        JSON.stringify({
          status: 'planned',
          capabilityId: 'technical_analysis',
          symbols: ['600519'],
          visualization: { templateId: 'technical-timing' },
        })
      ),
      fs.writeFile(
        path.join(projectPath, 'data_file', 'final', 'dashboard-data.json'),
        JSON.stringify({
          symbol: '600519',
          name: '贵州茅台',
          visualization: { template_id: 'technical-timing' },
        })
      ),
      fs.writeFile(
        path.join(projectPath, 'app', 'page.tsx'),
        'export default function Page(){ return <main>TradingPlanPanel 买入区间 止损 目标价</main> }\n'
      ),
      fs.writeFile(path.join(projectPath, 'app', 'globals.css'), 'body{}\n'),
    ]);

    await restoreQuantDashboardTemplate(projectPath);

    const [page, css] = await Promise.all([
      fs.readFile(path.join(projectPath, 'app', 'page.tsx'), 'utf8'),
      fs.readFile(path.join(projectPath, 'app', 'globals.css'), 'utf8'),
    ]);
    expect(page).toContain('data-source-file={DATA_FILE}');
    expect(page).toContain('function getBars(');
    expect(page).toContain('K 线与量价结构');
    expect(page).toContain('className="ma-line ma60"');
    expect(page).toContain('风险结论');
    expect(page).toContain('data-visual-language="financial-workbench"');
    expect(page).not.toContain('TradingPlanPanel');
    expect(page).not.toContain('买入区间');
    expect(css).toContain('.dashboard-shell');
    expect(css).toContain('FINANCIAL WORKBENCH CANVAS');
    expect(css).toContain('.dashboard-shell[data-visual-language="financial-workbench"] .chart-panel');
    expect(css).toContain('border-radius: 0');
  });

  it('scaffolds a continuous financial workbench instead of a card-grid default', async () => {
    const projectPath = await createProject();

    await scaffoldBasicNextApp(projectPath, 'continuous-workbench-project');

    const [page, css, nextConfig, buildScript, devScript] = await Promise.all([
      fs.readFile(path.join(projectPath, 'app', 'page.tsx'), 'utf8'),
      fs.readFile(path.join(projectPath, 'app', 'globals.css'), 'utf8'),
      fs.readFile(path.join(projectPath, 'next.config.js'), 'utf8'),
      fs.readFile(path.join(projectPath, 'scripts', 'run-build.js'), 'utf8'),
      fs.readFile(path.join(projectPath, 'scripts', 'run-dev.js'), 'utf8'),
    ]);
    expect(page).toContain('data-visual-language="financial-workbench"');
    expect(page).not.toContain('数据信源渠道');
    expect(page).not.toContain('技术证据');
    expect(page).not.toContain('行情源：');
    expect(page).not.toContain('evidence/sources.json');
    expect(page).not.toContain('场景模板');
    expect(page).not.toContain('必备组件');
    expect(page).toContain('className="metric-strip metrics-7"');
    expect(page).toContain('className="metric-strip metrics-4"');
    expect(css).toContain('FINANCIAL WORKBENCH CANVAS');
    expect(css).toContain('border-inline: 1px solid var(--line)');
    expect(css).toContain('border-bottom: 1px solid var(--line)');
    expect(css).toContain('.metric-strip.metrics-7');
    expect(css).toContain('grid-template-columns: repeat(7, minmax(0, 1fr))');
    expect(css).toContain('grid-template-columns: repeat(12, minmax(0, 1fr))');
    expect(css).toContain('.metric-strip.metrics-7 .metric-cell:nth-last-child(-n + 3)');
    expect(css).toContain('font-variant-numeric: tabular-nums lining-nums');
    expect(css).toContain('white-space: nowrap');
    expect(css).not.toContain('grid-template-columns: repeat(6, minmax(0, 1fr))');
    expect(css).not.toContain('linear-gradient(180deg, #eef4ff');
    expect(nextConfig).toContain('outputFileTracingRoot: projectRoot');
    expect(nextConfig).toContain('root: projectRoot');
    expect(nextConfig).not.toContain('outputFileTracingRoot: workspaceRoot');
    expect(nextConfig).not.toContain('root: workspaceRoot');
    expect(buildScript).toContain("defaultBundlerArgs = hasBundlerFlag ? [] : ['--webpack']");
    expect(devScript).toContain("defaultBundlerArgs = hasBundlerFlag ? [] : ['--webpack']");
  });

  it('keeps an existing page and stylesheet during non-destructive scaffolding', async () => {
    const projectPath = await createProject();
    const page = 'export default function Page(){ return <main>custom dashboard</main> }\n';
    const css = '.custom-dashboard { color: rebeccapurple; }\n';
    await Promise.all([
      fs.writeFile(path.join(projectPath, 'app', 'page.tsx'), page),
      fs.writeFile(path.join(projectPath, 'app', 'globals.css'), css),
    ]);

    await scaffoldBasicNextApp(projectPath, 'non-destructive-project');

    await expect(fs.readFile(path.join(projectPath, 'app', 'page.tsx'), 'utf8')).resolves.toBe(page);
    await expect(fs.readFile(path.join(projectPath, 'app', 'globals.css'), 'utf8')).resolves.toBe(css);
  });

  it('does not rewrite an unchanged package.json during repeated scaffolding', async () => {
    const projectPath = await createProject();
    const packageJsonPath = path.join(projectPath, 'package.json');

    await scaffoldBasicNextApp(projectPath, 'idempotent-project');
    const contents = await fs.readFile(packageJsonPath, 'utf8');
    const sentinel = new Date('2026-01-01T00:00:00.000Z');
    await fs.utimes(packageJsonPath, sentinel, sentinel);
    const before = await fs.stat(packageJsonPath);

    await scaffoldBasicNextApp(projectPath, 'idempotent-project');

    const after = await fs.stat(packageJsonPath);
    await expect(fs.readFile(packageJsonPath, 'utf8')).resolves.toBe(contents);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('normalizes the platform TypeScript config before read-only sandbox execution', async () => {
    const projectPath = await createProject();
    const tsconfigPath = path.join(projectPath, 'tsconfig.json');
    await fs.writeFile(tsconfigPath, JSON.stringify({
      compilerOptions: { jsx: 'preserve', strict: true },
      include: ['next-env.d.ts', '**/*.tsx'],
    }));

    await scaffoldBasicNextApp(projectPath, 'sandbox-ready-project');

    const config = JSON.parse(await fs.readFile(tsconfigPath, 'utf8'));
    const nextEnv = await fs.readFile(path.join(projectPath, 'next-env.d.ts'), 'utf8');
    expect(config.compilerOptions).toMatchObject({
      jsx: 'react-jsx',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      plugins: [{ name: 'next' }],
      strict: true,
    });
    expect(config.include).toEqual(expect.arrayContaining([
      '.next/types/**/*.ts',
      '.next/dev/types/**/*.ts',
      '**/*.mts',
    ]));
    expect(nextEnv).toContain('import "./.next/types/routes.d.ts";');
    expect(nextEnv).not.toContain('next/navigation-types/navigation');
  });
});
