#!/usr/bin/env node

require('tsconfig-paths/register');

const fs = require('fs/promises');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const jiti = require('jiti')(path.join(process.cwd(), 'scripts/run-quant-benchmarks.js'), {
  interopDefault: true,
});

const { scaffoldBasicNextApp } = jiti('../lib/utils/scaffold.ts');
const { writeInitialRunPlan } = jiti('../lib/quant/workspace.ts');
const { prefetchQuantDataForRunPlan } = jiti('../lib/quant/data-prefetch.ts');
const { validateQuantProject } = jiti('../lib/quant/validation.ts');
const { buildQuantProjectSettings } = jiti('../lib/quant/capabilities.ts');
const { previewManager } = jiti('../lib/services/preview.ts');

const prisma = new PrismaClient();
const CASES_PATH = path.resolve('benchmarks/quantpilot/cases.json');
const PROJECTS_DIR = path.resolve(process.env.PROJECTS_DIR || './data/projects');
const REPORTS_DIR = path.resolve('tmp/quantpilot-benchmark-reports');

function parseArgs(argv) {
  const selected = new Set();
  let limit = null;
  let keepProjects = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--case' && argv[index + 1]) {
      selected.add(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--case=')) {
      selected.add(arg.slice('--case='.length));
      continue;
    }
    if (arg === '--limit' && argv[index + 1]) {
      limit = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      limit = Number.parseInt(arg.slice('--limit='.length), 10);
      continue;
    }
    if (arg === '--keep-projects') {
      keepProjects = true;
    }
  }

  return {
    selected,
    limit: Number.isFinite(limit) && limit > 0 ? limit : null,
    keepProjects,
  };
}

async function readJson(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content);
}

async function ensureBenchmarkProject({ projectId, projectPath, testCase }) {
  await fs.rm(projectPath, { recursive: true, force: true });
  await fs.mkdir(projectPath, { recursive: true });
  await prisma.project.deleteMany({ where: { id: projectId } });

  await scaffoldBasicNextApp(projectPath, projectId);
  const selectedModel = 'MiniMax-M2.7';
  await prisma.project.create({
    data: {
      id: projectId,
      name: `Benchmark ${testCase.name}`,
      description: testCase.question,
      initialPrompt: testCase.question,
      repoPath: projectPath,
      preferredCli: 'claude',
      selectedModel,
      settings: JSON.stringify({
        quant: buildQuantProjectSettings(testCase.capabilityId),
      }),
      status: 'idle',
      templateType: 'nextjs',
      lastActiveAt: new Date(),
      previewUrl: null,
      previewPort: null,
    },
  });
}

function assertCondition(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

function formatError(error) {
  return error instanceof Error ? `${error.message}\n${error.stack || ''}`.trim() : String(error);
}

async function inspectArtifacts({ projectPath, testCase, prefetch }) {
  const failures = [];
  const finalData = await readJson(path.join(projectPath, 'data_file/final/dashboard-data.json'));
  const quality = await readJson(path.join(projectPath, 'evidence/data_quality.json'));
  const sources = await readJson(path.join(projectPath, 'evidence/sources.json'));
  const page = await fs.readFile(path.join(projectPath, 'app/page.tsx'), 'utf8');

  assertCondition(finalData.symbol === testCase.expectedSymbol, `symbol 应为 ${testCase.expectedSymbol}，实际为 ${finalData.symbol}`, failures);
  assertCondition(finalData.asset_type === testCase.expectedAssetType, `asset_type 应为 ${testCase.expectedAssetType}，实际为 ${finalData.asset_type}`, failures);
  assertCondition(quality.status === 'ok', `evidence/data_quality.json 状态应为 ok，实际为 ${quality.status}`, failures);
  assertCondition(Array.isArray(sources.sources) && sources.sources.length > 0, 'evidence/sources.json 应包含 sources。', failures);
  assertCondition(page.includes('data_file/final/dashboard-data.json'), 'app/page.tsx 应读取 final 数据文件。', failures);
  assertCondition(page.includes('/api/market'), 'app/page.tsx 应声明 /api/market 数据入口。', failures);
  assertCondition(page.includes('<svg'), 'app/page.tsx 应包含 SVG 图表实现。', failures);
  assertCondition(page.includes('K 线与量价结构'), 'app/page.tsx 应包含 K 线与量价结构面板。', failures);
  assertCondition(page.includes('candle-up') && page.includes('candle-down'), 'app/page.tsx 应实现涨跌 K 线/OHLC 结构。', failures);
  assertCondition(page.includes('volume-chart'), 'app/page.tsx 应包含成交量副图。', failures);
  assertCondition(page.includes('SignalPanel'), 'app/page.tsx 应包含量化信号摘要面板。', failures);
  assertCondition(page.includes('data_quality') || page.includes('数据质量'), 'app/page.tsx 应展示数据质量或限制信息。', failures);

  for (const expectedField of testCase.expectedFinalFields || []) {
    assertCondition(finalData[expectedField] !== undefined, `final 数据缺少字段 ${expectedField}`, failures);
  }

  if (testCase.expectedFinalFields?.includes('backtest')) {
    const backtest = finalData.backtest || {};
    assertCondition(Array.isArray(backtest.equity_curve) && backtest.equity_curve.length > 0, 'backtest 应包含 equity_curve。', failures);
    assertCondition(backtest.summary && typeof backtest.summary === 'object', 'backtest 应包含 summary。', failures);
    assertCondition(page.includes('BacktestPanel'), 'app/page.tsx 应包含回测面板。', failures);
  }

  const rawFiles = new Set((prefetch.rawFiles || []).map((filePath) => path.basename(filePath)));
  for (const expectedRaw of testCase.expectedRawFiles || []) {
    assertCondition(rawFiles.has(expectedRaw), `raw 数据缺少 ${expectedRaw}`, failures);
  }

  const datasetIds = new Set((quality.datasets || []).map((dataset) => dataset.id));
  for (const expectedDataset of testCase.expectedDatasets || []) {
    assertCondition(datasetIds.has(expectedDataset), `data_quality 缺少数据集 ${expectedDataset}`, failures);
  }

  return {
    failures,
    finalData: {
      symbol: finalData.symbol,
      name: finalData.name,
      asset_type: finalData.asset_type,
      klineRows: finalData.kline?.bars?.length || 0,
      reportRows: finalData.financials?.reports?.length || 0,
      announcementRows: finalData.announcements?.announcements?.length || 0,
      backtestRows: finalData.backtest?.equity_curve?.length || 0,
      tradeRows: finalData.backtest?.trades?.length || 0,
    },
    quality: {
      status: quality.status,
      datasets: (quality.datasets || []).map((dataset) => ({
        id: dataset.id,
        status: dataset.status,
        row_count: dataset.row_count,
      })),
    },
  };
}

async function runCase(testCase) {
  const startedAt = Date.now();
  const projectId = `benchmark-${testCase.id}`;
  const projectPath = path.join(PROJECTS_DIR, projectId);
  const requestId = `${projectId}-run`;

  await ensureBenchmarkProject({ projectId, projectPath, testCase });

  const plan = await writeInitialRunPlan({
    projectPath,
    instruction: testCase.question,
    requestId,
    capabilityId: testCase.capabilityId,
  });
  const prefetch = await prefetchQuantDataForRunPlan({ projectPath, plan });
  const artifactInspection = await inspectArtifacts({ projectPath, testCase, prefetch });
  const validation = await validateQuantProject({
    projectId,
    projectPath,
    requestId,
    cliSource: 'benchmark',
  });

  await previewManager.stop(projectId);

  const failures = [
    ...artifactInspection.failures,
    ...(validation.passed ? [] : validation.checks.filter((check) => check.status === 'failed').map((check) => `${check.id}: ${check.summary}`)),
  ];

  return {
    id: testCase.id,
    name: testCase.name,
    question: testCase.question,
    projectId,
    projectPath,
    durationMs: Date.now() - startedAt,
    passed: failures.length === 0,
    failures,
    symbols: plan.symbols,
    prefetch,
    artifacts: artifactInspection,
    validation: {
      status: validation.status,
      checks: validation.checks.map((check) => ({
        id: check.id,
        status: check.status,
        summary: check.summary,
      })),
    },
  };
}

async function cleanupBenchmarkProject(result) {
  await previewManager.stop(result.projectId);
  await prisma.project.deleteMany({ where: { id: result.projectId } });
  await fs.rm(result.projectPath, { recursive: true, force: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allCases = await readJson(CASES_PATH);
  let cases = allCases;
  if (args.selected.size > 0) {
    cases = cases.filter((testCase) => args.selected.has(testCase.id));
  }
  if (args.limit !== null) {
    cases = cases.slice(0, args.limit);
  }

  if (cases.length === 0) {
    throw new Error('没有匹配的 benchmark case。');
  }

  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const results = [];
  for (const testCase of cases) {
    console.log(`\n[QuantBenchmark] ${testCase.id} - ${testCase.name}`);
    const startedAt = Date.now();
    let result;
    try {
      result = await runCase(testCase);
    } catch (error) {
      const projectId = `benchmark-${testCase.id}`;
      result = {
        id: testCase.id,
        name: testCase.name,
        question: testCase.question,
        projectId,
        projectPath: path.join(PROJECTS_DIR, projectId),
        durationMs: Date.now() - startedAt,
        passed: false,
        failures: [formatError(error)],
        symbols: [],
        prefetch: null,
        artifacts: null,
        validation: null,
      };
      await previewManager.stop(projectId).catch(() => {});
    }
    results.push(result);
    console.log(result.passed ? '  PASS' : '  FAIL');
    if (!result.passed) {
      result.failures.forEach((failure) => console.log(`  - ${failure}`));
    }
  }

  if (!args.keepProjects) {
    for (const result of results) {
      await cleanupBenchmarkProject(result);
    }
  }

  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    passed: results.every((result) => result.passed),
    total: results.length,
    passedCount: results.filter((result) => result.passed).length,
    failedCount: results.filter((result) => !result.passed).length,
    results,
  };

  const reportPath = path.join(REPORTS_DIR, `report-${Date.now()}.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\n[QuantBenchmark] report: ${path.relative(process.cwd(), reportPath)}`);
  console.log(`[QuantBenchmark] ${report.passed ? 'ALL PASSED' : 'FAILED'} (${report.passedCount}/${report.total})`);
  if (!args.keepProjects) {
    console.log('[QuantBenchmark] 临时 benchmark 项目已清理。使用 --keep-projects 可保留项目目录。');
  }

  if (!report.passed) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('[QuantBenchmark] failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
