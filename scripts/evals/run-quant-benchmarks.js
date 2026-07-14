#!/usr/bin/env node

require('tsconfig-paths/register');

const fs = require('fs/promises');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const jiti = require('jiti')(path.join(process.cwd(), 'scripts/evals/run-quant-benchmarks.js'), {
  interopDefault: true,
});

const { ensureQuantDashboardTemplate, scaffoldBasicNextApp } = jiti('../../src/lib/utils/scaffold.ts');
const { writeInitialRunPlan } = jiti('../../src/lib/quant/workspace.ts');
const { buildClarificationContinuation } = jiti('../../src/lib/quant/intent.ts');
const { prefetchQuantDataForRunPlan } = jiti('../../src/lib/quant/data-prefetch.ts');
const {
  startQuantGenerationRun,
  updateQuantGenerationStep,
} = jiti('../../src/lib/quant/generation-state.ts');
const {
  buildQuantValidationRepairInstruction,
  buildQuantValidationRepairPlan,
  validateQuantProject,
} = jiti('../../src/lib/quant/validation.ts');
const { buildQuantProjectSettings } = jiti('../../src/lib/quant/capabilities.ts');
const { previewManager } = jiti('../../src/lib/services/preview.ts');
const {
  getDefaultModelForCli,
  getModelDefinitionsForCli,
  normalizeModelId,
} = jiti('../../src/lib/constants/cliModels.ts');

const prisma = new PrismaClient();
const CASES_PATH = path.resolve('benchmarks/quantpilot/cases.json');
const PROJECTS_DIR = path.resolve(process.env.PROJECTS_DIR || './data/projects');
const REPORTS_DIR = path.resolve('tmp/quantpilot-benchmark-reports');

function parseArgs(argv) {
  const selected = new Set();
  let limit = null;
  let keepProjects = false;
  let trigger = process.env.QUANTPILOT_EVAL_TRIGGER || 'cli';
  let evaluatorId = process.env.QUANTPILOT_EVAL_EVALUATOR || 'rule-strict';
  let concurrency = Number.parseInt(process.env.QUANTPILOT_EVAL_CONCURRENCY || '1', 10);

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
    if (arg === '--cli' && argv[index + 1]) {
      index += 1;
      continue;
    }
    if (arg.startsWith('--cli=')) {
      continue;
    }
    if (arg === '--model' && argv[index + 1]) {
      index += 1;
      continue;
    }
    if (arg.startsWith('--model=')) {
      continue;
    }
    if (arg === '--reasoning-effort' && argv[index + 1]) {
      index += 1;
      continue;
    }
    if (arg.startsWith('--reasoning-effort=')) {
      continue;
    }
    if (arg === '--trigger' && argv[index + 1]) {
      trigger = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--trigger=')) {
      trigger = arg.slice('--trigger='.length);
      continue;
    }
    if ((arg === '--evaluator' || arg === '--evaluator-id') && argv[index + 1]) {
      evaluatorId = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--evaluator=')) {
      evaluatorId = arg.slice('--evaluator='.length);
      continue;
    }
    if (arg.startsWith('--evaluator-id=')) {
      evaluatorId = arg.slice('--evaluator-id='.length);
      continue;
    }
    if (arg === '--concurrency' && argv[index + 1]) {
      concurrency = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg.startsWith('--concurrency=')) {
      concurrency = Number.parseInt(arg.slice('--concurrency='.length), 10);
      continue;
    }
  }

  return {
    selected,
    limit: Number.isFinite(limit) && limit > 0 ? limit : null,
    keepProjects,
    cli: 'claude',
    model: 'deepseek-v4-flash',
    reasoningEffort: '',
    trigger,
    evaluatorId: evaluatorId || 'rule-strict',
    concurrency: Number.isFinite(concurrency) && concurrency > 0 ? Math.min(16, Math.floor(concurrency)) : 1,
  };
}

async function readJson(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function fileExists(filePath) {
  return fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function readSkillLockSnapshot() {
  const lockPath = path.resolve('.claude/skills.lock.json');
  const lock = await readJson(lockPath).catch(() => null);
  if (!lock || typeof lock !== 'object' || !lock.skills || typeof lock.skills !== 'object') {
    return { schemaVersion: null, skills: {} };
  }
  const skills = Object.fromEntries(
    Object.entries(lock.skills).map(([skillId, entry]) => {
      const item = entry && typeof entry === 'object' ? entry : {};
      return [
        skillId,
        {
          version: item.version ?? null,
          hash: item.hash ?? null,
          packageHash: item.packageHash ?? null,
          sourcePath: item.sourcePath ?? null,
          packagePath: item.packagePath ?? null,
        },
      ];
    })
  );
  return {
    schemaVersion: lock.schemaVersion ?? null,
    skills,
  };
}

async function readEvents(projectPath) {
  const eventsPath = path.join(projectPath, '.quantpilot', 'events.jsonl');
  const content = await fs.readFile(eventsPath, 'utf8').catch(() => '');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { event_type: 'invalid_json', raw: line };
      }
    });
}

async function auditProjectEvents({ projectPath, testCase, expectFinalArtifacts = true }) {
  const failures = [];
  const events = await readEvents(projectPath);
  const eventTypes = new Set(events.map((event) => event.event_type));

  assertCondition(eventTypes.has('run_planned') || eventTypes.has('intent_clarification_required'), 'events.jsonl 缺少规划事件。', failures);
  if (expectFinalArtifacts) {
    assertCondition(eventTypes.has('data_prefetch_started'), 'events.jsonl 缺少 data_prefetch_started。', failures);
    assertCondition(eventTypes.has('data_prefetched'), 'events.jsonl 缺少 data_prefetched。', failures);
    assertCondition(eventTypes.has('data_quality_checked'), 'events.jsonl 缺少 data_quality_checked。', failures);
    assertCondition(eventTypes.has('validation_started'), 'events.jsonl 缺少 validation_started。', failures);
    assertCondition(eventTypes.has('validation_completed'), 'events.jsonl 缺少 validation_completed。', failures);
  }
  if (testCase.expectedImageExtraction) {
    assertCondition(eventTypes.has('image_attachment_evidence_created'), 'events.jsonl 缺少图片附件证据事件。', failures);
  }
  if (testCase.expectClarification) {
    assertCondition(eventTypes.has('intent_clarification_required'), 'events.jsonl 缺少意图澄清事件。', failures);
  }

  return {
    failures,
    total: events.length,
    eventTypes: Array.from(eventTypes),
    stages: Array.from(new Set(events.map((event) => event.stage).filter(Boolean))),
    warningCount: events.filter((event) => event.status === 'warning').length,
    errorCount: events.filter((event) => event.status === 'error').length,
  };
}

function caseCoverageTags(testCase) {
  const tags = new Set();
  tags.add(testCase.capabilityId || 'unknown_capability');
  tags.add(testCase.type || 'generated_project');
  if (testCase.expectedAssetType) tags.add(`asset:${testCase.expectedAssetType}`);
  if (testCase.expectedTemplateId) tags.add(`template:${testCase.expectedTemplateId}`);
  if (testCase.expectClarification) tags.add('intent:clarification_required');
  if (testCase.type === 'clarification_continuation') tags.add('intent:clarification_continuation');
  if (testCase.imageAttachment) tags.add('input:image_attachment');
  if (testCase.visualCheck) tags.add('visual:playwright');
  if (testCase.expectedImageExtraction) tags.add('evidence:image_extraction');
  if (testCase.type === 'runtime_registry') tags.add('runtime:deepseek_v4_flash');
  if (testCase.type === 'repair_plan') tags.add('validation:repair_plan');
  if (testCase.type === 'source_degradation_contract') tags.add('data:source_degradation');
  if (testCase.expectedFinalFields?.includes('backtest')) tags.add('analysis:backtest');
  if (testCase.expectedFinalFields?.includes('portfolio')) tags.add('analysis:portfolio');
  if (testCase.expectedFinalFields?.includes('selectionRanking')) tags.add('analysis:selection');
  if (Array.isArray(testCase.expectedSymbols) && testCase.expectedSymbols.length > 1) tags.add('data:multi_symbol');
  return Array.from(tags);
}

function buildCoverageSummary(cases, results) {
  const byCapability = {};
  const byType = {};
  const byTag = {};
  const failedTags = {};
  const caseTags = {};

  for (const testCase of cases) {
    const tags = caseCoverageTags(testCase);
    const result = results.find((item) => item.id === testCase.id);
    const passed = Boolean(result?.passed);
    const capability = testCase.capabilityId || 'unknown';
    const type = testCase.type || (testCase.expectClarification ? 'clarification_required' : 'generated_project');
    caseTags[testCase.id] = tags;

    byCapability[capability] = byCapability[capability] || { total: 0, passed: 0, failed: 0 };
    byCapability[capability].total += 1;
    byCapability[capability][passed ? 'passed' : 'failed'] += 1;

    byType[type] = byType[type] || { total: 0, passed: 0, failed: 0 };
    byType[type].total += 1;
    byType[type][passed ? 'passed' : 'failed'] += 1;

    for (const tag of tags) {
      byTag[tag] = byTag[tag] || { total: 0, passed: 0, failed: 0 };
      byTag[tag].total += 1;
      byTag[tag][passed ? 'passed' : 'failed'] += 1;
      if (!passed) {
        failedTags[tag] = failedTags[tag] || [];
        failedTags[tag].push(testCase.id);
      }
    }
  }

  return {
    byCapability,
    byType,
    byTag,
    caseTags,
    failedTags,
    requiredCoverage: {
      capabilities: [
        'fundamental_analysis',
        'technical_analysis',
        'backtest_review',
        'asset_comparison',
        'portfolio_risk',
        'stock_diagnosis',
      ],
      tags: [
        'input:image_attachment',
        'intent:clarification_required',
        'intent:clarification_continuation',
        'runtime:deepseek_v4_flash',
        'validation:repair_plan',
        'data:source_degradation',
        'visual:playwright',
      ],
    },
  };
}

async function ensureBenchmarkProject({ projectId, projectPath, testCase }) {
  await fs.rm(projectPath, { recursive: true, force: true });
  await fs.mkdir(projectPath, { recursive: true });
  await prisma.project.deleteMany({ where: { id: projectId } });

  await scaffoldBasicNextApp(projectPath, projectId);
  const selectedModel = 'deepseek-v4-flash';
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

async function writeBenchmarkImageAttachment({ projectPath, requestId, imageAttachment }) {
  const fixtureName = imageAttachment?.filename || 'portfolio-screenshot.png';
  const imageDir = path.join(projectPath, 'uploads', requestId);
  const imagePath = path.join(imageDir, fixtureName);
  await fs.mkdir(imageDir, { recursive: true });
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAUAAAADwCAIAAABxLb1rAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAG0lEQVR4nO3BAQ0AAADCoPdPbQ43oAAAAAAAAAC4Gz+0AAFjTWbGAAAAAElFTkSuQmCC';
  await fs.writeFile(imagePath, Buffer.from(pngBase64, 'base64'));
  await writeJson(path.join(projectPath, '.quantpilot', 'attachments.json'), {
    schemaVersion: 1,
    projectId: path.basename(projectPath),
    requestId,
    createdAt: new Date().toISOString(),
    attachments: [
      {
        id: 'benchmark-image-1',
        name: fixtureName,
        path: path.relative(projectPath, imagePath).replaceAll(path.sep, '/'),
        absolutePath: imagePath,
        mimeType: 'image/png',
        size: (await fs.stat(imagePath)).size,
        url: `/uploads/${requestId}/${fixtureName}`,
        publicUrl: `/uploads/${requestId}/${fixtureName}`,
      },
    ],
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

  if (testCase.expectedSymbol) {
    assertCondition(finalData.symbol === testCase.expectedSymbol, `symbol 应为 ${testCase.expectedSymbol}，实际为 ${finalData.symbol}`, failures);
  }
  if (testCase.expectedAssetType) {
    assertCondition(finalData.asset_type === testCase.expectedAssetType, `asset_type 应为 ${testCase.expectedAssetType}，实际为 ${finalData.asset_type}`, failures);
  }
  assertCondition(['ok', 'warning'].includes(quality.status), `evidence/data_quality.json 状态应为 ok/warning，实际为 ${quality.status}`, failures);
  assertCondition(Array.isArray(sources.sources) && sources.sources.length > 0, 'evidence/sources.json 应包含 sources。', failures);
  assertCondition(page.includes('data_file/final/dashboard-data.json'), 'app/page.tsx 应读取 final 数据文件。', failures);
  assertCondition(page.includes('/api/market'), 'app/page.tsx 应声明 /api/market 数据入口。', failures);
  assertCondition(page.includes('<svg'), 'app/page.tsx 应包含 SVG 图表实现。', failures);

  const templateId = testCase.expectedTemplateId || finalData.visualization?.template_id || finalData.visualization?.templateId;
  if (!templateId || ['single-stock-diagnosis', 'technical-timing', 'fundamental-research', 'backtest-review'].includes(templateId)) {
    assertCondition(page.includes('K 线与量价结构'), 'app/page.tsx 应包含 K 线与量价结构面板。', failures);
    assertCondition(page.includes('candle-up') && page.includes('candle-down'), 'app/page.tsx 应实现涨跌 K 线/OHLC 结构。', failures);
    assertCondition(page.includes('volume-chart'), 'app/page.tsx 应包含成交量副图。', failures);
    assertCondition(page.includes('SignalPanel'), 'app/page.tsx 应包含量化信号摘要面板。', failures);
  }

  assertCondition(
    page.includes('data_quality') ||
      page.includes('DataQualityPanel') ||
      page.includes('数据质量') ||
      page.includes('数据信源渠道') ||
      page.includes('数据缺口'),
    'app/page.tsx 应展示数据质量或限制信息。',
    failures
  );

  for (const expectedField of testCase.expectedFinalFields || []) {
    assertCondition(finalData[expectedField] !== undefined, `final 数据缺少字段 ${expectedField}`, failures);
  }

  if (testCase.expectedTemplateId) {
    const runPlan = await readJson(path.join(projectPath, '.quantpilot/run_plan.json'));
    const finalTemplateId = finalData.visualization?.template_id || finalData.visualization?.templateId;
    assertCondition(
      runPlan.visualization?.templateId === testCase.expectedTemplateId,
      `run_plan.visualization.templateId 应为 ${testCase.expectedTemplateId}，实际为 ${runPlan.visualization?.templateId}`,
      failures
    );
    assertCondition(
      finalTemplateId === testCase.expectedTemplateId,
      `final visualization.template_id 应为 ${testCase.expectedTemplateId}，实际为 ${finalTemplateId}`,
      failures
    );
  }

  if (Array.isArray(testCase.expectedSymbols) && testCase.expectedSymbols.length > 0) {
    const requestedSymbols = new Set([
      ...(Array.isArray(finalData.requestedSymbols) ? finalData.requestedSymbols : []),
      ...(Array.isArray(finalData.symbols) ? finalData.symbols : []),
      finalData.symbol,
    ].map(String).filter(Boolean));
    const assetSymbols = new Set((Array.isArray(finalData.assets) ? finalData.assets : []).map((asset) => String(asset?.symbol || asset?.quote?.symbol || '')).filter(Boolean));
    const comparisonSymbols = new Set((Array.isArray(finalData.comparison?.rows) ? finalData.comparison.rows : []).map((row) => String(row?.symbol || '')).filter(Boolean));
    const missingRequested = testCase.expectedSymbols.filter((symbol) => !requestedSymbols.has(symbol));
    const missingAssets = testCase.expectedSymbols.filter((symbol) => !assetSymbols.has(symbol));
    const missingComparison = testCase.expectedSymbols.filter((symbol) => !comparisonSymbols.has(symbol));

    assertCondition(missingRequested.length === 0, `requestedSymbols/symbols 缺少：${missingRequested.join('、')}`, failures);
    assertCondition(missingAssets.length === 0, `assets[] 缺少：${missingAssets.join('、')}`, failures);
    assertCondition(missingComparison.length === 0, `comparison.rows[] 缺少：${missingComparison.join('、')}`, failures);
    assertCondition(
      Array.isArray(finalData.assets) && finalData.assets.length >= testCase.expectedSymbols.length,
      `assets[] 数量应至少为 ${testCase.expectedSymbols.length}，实际为 ${finalData.assets?.length || 0}`,
      failures
    );
  }

  if (testCase.expectedFinalFields?.includes('selectionRanking')) {
    assertCondition(Array.isArray(finalData.selectionRanking?.rows) && finalData.selectionRanking.rows.length > 0, 'selectionRanking.rows 应非空。', failures);
    assertCondition(Array.isArray(finalData.financialQuality?.rows) && finalData.financialQuality.rows.length > 0, 'financialQuality.rows 应非空。', failures);
    assertCondition(
      Array.isArray(finalData.comparison?.rows) &&
        finalData.comparison.rows.every((row) => row && row.composite_score !== undefined && row.selection_view),
      'comparison.rows[] 应包含 composite_score 和 selection_view。',
      failures
    );
    assertCondition(/selectionRanking|financialQuality|stock-selection|相对强弱|财务质量|收益对比|回撤对比/i.test(page), '选股页面应包含排名、财务质量或对比图表组件。', failures);
  }

  if (testCase.expectedFinalFields?.includes('portfolio')) {
    assertCondition(finalData.portfolio && typeof finalData.portfolio === 'object', 'portfolio 应为对象。', failures);
    assertCondition(Array.isArray(finalData.holdings) && finalData.holdings.length > 0, 'holdings[] 应非空。', failures);
    assertCondition(finalData.portfolio.concentration && typeof finalData.portfolio.concentration === 'object', 'portfolio.concentration 应存在。', failures);
    assertCondition(/holding-analysis|持仓|仓位|集中度|调仓|相关性|流动性/.test(page), '持仓页面应包含持仓、仓位集中度、调仓或风险组件。', failures);
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

  for (const expectedEvidenceFile of testCase.expectedEvidenceFiles || []) {
    assertCondition(await fileExists(path.join(projectPath, expectedEvidenceFile)), `缺少 evidence 文件 ${expectedEvidenceFile}`, failures);
  }

  if (testCase.expectedImageExtraction) {
    const imageEvidence = await readJson(path.join(projectPath, 'evidence/image_extraction.json'));
    const imageSourceIds = new Set((sources.sources || []).map((source) => source.id));
    assertCondition(finalData.imageExtraction && typeof finalData.imageExtraction === 'object', 'final 数据缺少 imageExtraction。', failures);
    assertCondition(imageEvidence.status === 'metadata_ready', `image_extraction.status 应为 metadata_ready，实际为 ${imageEvidence.status}`, failures);
    assertCondition(Array.isArray(imageEvidence.images) && imageEvidence.images.length > 0, 'image_extraction.images 应非空。', failures);
    assertCondition(finalData.imageExtraction?.needs_manual_confirmation === true, 'imageExtraction.needs_manual_confirmation 应为 true。', failures);
    assertCondition(datasetIds.has('uploaded_image_attachment'), 'data_quality 缺少 uploaded_image_attachment 数据集。', failures);
    assertCondition(imageSourceIds.has('uploaded_image_attachment'), 'sources 缺少 uploaded_image_attachment 信源。', failures);
  }

  if (testCase.expectedQualityStatus) {
    assertCondition(
      quality.status === testCase.expectedQualityStatus,
      `data_quality.status 应为 ${testCase.expectedQualityStatus}，实际为 ${quality.status}`,
      failures
    );
  }

  for (const expectedProvider of testCase.expectedSourceProviders || []) {
    const providerPattern = new RegExp(expectedProvider, 'i');
    assertCondition(
      (sources.sources || []).some((source) => providerPattern.test(String(source.source ?? ''))),
      `sources 应包含信源 ${expectedProvider}`,
      failures
    );
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
      assetCount: finalData.assets?.length || 0,
      holdingCount: finalData.holdings?.length || 0,
      comparisonRows: finalData.comparison?.rows?.length || 0,
      templateId: finalData.visualization?.template_id || finalData.visualization?.templateId,
      hasImageExtraction: Boolean(finalData.imageExtraction),
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

async function runClarificationCase(testCase) {
  const startedAt = Date.now();
  const projectId = `benchmark-${testCase.id}`;
  const projectPath = path.join(PROJECTS_DIR, projectId);
  const requestId = `${projectId}-run`;
  const failures = [];

  await ensureBenchmarkProject({ projectId, projectPath, testCase });
  const plan = await writeInitialRunPlan({
    projectPath,
    instruction: testCase.question,
    requestId,
    capabilityId: testCase.capabilityId,
  });
  const prefetch = await prefetchQuantDataForRunPlan({ projectPath, plan });

  assertCondition(plan.status === 'needs_clarification', `run_plan.status 应为 needs_clarification，实际为 ${plan.status}`, failures);
  assertCondition(plan.clarification?.required === true, 'clarification.required 应为 true。', failures);
  assertCondition(prefetch.skipped === true, 'needs_clarification 时平台预取应跳过。', failures);
  for (const expectedMissing of testCase.expectedMissing || []) {
    assertCondition(
      Array.isArray(plan.clarification?.missing) && plan.clarification.missing.includes(expectedMissing),
      `clarification.missing 应包含 ${expectedMissing}。`,
      failures
    );
  }

  const finalDataExists = await fs.stat(path.join(projectPath, 'data_file/final/dashboard-data.json')).then(() => true).catch(() => false);
  assertCondition(!finalDataExists, 'needs_clarification 时不应生成 final dashboard-data.json。', failures);
  const eventAudit = await auditProjectEvents({
    projectPath,
    testCase,
    expectFinalArtifacts: false,
  });
  failures.push(...eventAudit.failures);

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
    artifacts: {
      clarification: plan.clarification,
      expectedMissing: testCase.expectedMissing || [],
    },
    eventAudit,
    validation: {
      status: 'skipped',
      checks: [
        {
          id: 'intent_clarification',
          status: failures.length === 0 ? 'passed' : 'failed',
          summary: '缺少关键信息时进入澄清流程，不取数不生成页面。',
        },
      ],
    },
  };
}

async function runClarificationContinuationCase(testCase) {
  const startedAt = Date.now();
  const projectId = `benchmark-${testCase.id}`;
  const projectPath = path.join(PROJECTS_DIR, projectId);
  const requestId = `${projectId}-run`;
  const followupRequestId = `${projectId}-followup`;
  const failures = [];

  await ensureBenchmarkProject({ projectId, projectPath, testCase });
  const firstPlan = await writeInitialRunPlan({
    projectPath,
    instruction: testCase.question,
    requestId,
    capabilityId: testCase.capabilityId,
  });
  const firstPrefetch = await prefetchQuantDataForRunPlan({ projectPath, plan: firstPlan });
  assertCondition(firstPlan.status === 'needs_clarification', `首轮应进入澄清，实际为 ${firstPlan.status}`, failures);
  assertCondition(firstPrefetch.skipped === true, '首轮澄清时不应预取数据。', failures);

  const continuation = buildClarificationContinuation({
    previousPlan: firstPlan,
    instruction: testCase.followupAnswer,
    displayInstruction: testCase.followupAnswer,
    capabilityId: testCase.capabilityId,
  });
  assertCondition(Boolean(continuation), '用户补充信息后应生成澄清承接上下文。', failures);

  let plan = firstPlan;
  let prefetch = firstPrefetch;
  let artifactInspection = null;
  let validation = null;
  if (continuation) {
    plan = await writeInitialRunPlan({
      projectPath,
      instruction: continuation.resolvedInstruction,
      requestId: followupRequestId,
      capabilityId: testCase.capabilityId,
    });
    prefetch = await prefetchQuantDataForRunPlan({ projectPath, plan });
    await ensureQuantDashboardTemplate(projectPath);
    artifactInspection = await inspectArtifacts({ projectPath, testCase, prefetch });
    validation = await validateQuantProject({
      projectId,
      projectPath,
      requestId: followupRequestId,
      cliSource: 'benchmark',
    });
    const eventAudit = await auditProjectEvents({
      projectPath,
      testCase,
      expectFinalArtifacts: true,
    });
    failures.push(
      ...(artifactInspection.failures || []),
      ...eventAudit.failures,
      ...(validation.passed ? [] : validation.checks.filter((check) => check.status === 'failed').map((check) => `${check.id}: ${check.summary}`))
    );
    artifactInspection.eventAudit = eventAudit;
  }

  await previewManager.stop(projectId);

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
    artifacts: {
      continuation,
      followup: artifactInspection,
    },
    eventAudit: artifactInspection?.eventAudit ?? null,
    validation: validation
      ? {
          status: validation.status,
          checks: validation.checks.map((check) => ({
            id: check.id,
            status: check.status,
            summary: check.summary,
          })),
        }
      : {
          status: failures.length === 0 ? 'passed' : 'failed',
          checks: [{ id: 'clarification_continuation', status: failures.length === 0 ? 'passed' : 'failed', summary: '澄清承接链路检查。' }],
        },
  };
}

function runRuntimeRegistryCase(testCase) {
  const startedAt = Date.now();
  const projectId = `benchmark-${testCase.id}`;
  const projectPath = path.join(PROJECTS_DIR, projectId);
  const failures = [];
  const deepSeekModels = getModelDefinitionsForCli('claude');

  assertCondition(deepSeekModels.length === 1, `平台应只暴露 1 个模型，实际 ${deepSeekModels.length} 个。`, failures);
  assertCondition(deepSeekModels[0]?.id === 'deepseek-v4-flash', `唯一模型应为 deepseek-v4-flash，实际 ${deepSeekModels[0]?.id}`, failures);
  assertCondition(getDefaultModelForCli('claude') === 'deepseek-v4-flash', `默认模型应为 deepseek-v4-flash，实际 ${getDefaultModelForCli('claude')}`, failures);
  assertCondition(normalizeModelId('codex', 'gpt-5.5') === 'deepseek-v4-flash', '任何旧供应商或模型输入都应收敛到 DeepSeek V4 Flash。', failures);

  return {
    id: testCase.id,
    name: testCase.name,
    question: testCase.question,
    projectId,
    projectPath,
    durationMs: Date.now() - startedAt,
    passed: failures.length === 0,
    failures,
    symbols: [],
    prefetch: { skipped: true, summary: '运行时注册表用例不创建生成项目。' },
    artifacts: {
      deepSeekModels,
      defaultModel: getDefaultModelForCli('claude'),
    },
    validation: {
      status: failures.length === 0 ? 'passed' : 'failed',
      checks: [{ id: 'runtime_registry', status: failures.length === 0 ? 'passed' : 'failed', summary: 'DeepSeek 单模型与官方直连边界检查。' }],
    },
  };
}

async function runRepairPlanCase(testCase) {
  const startedAt = Date.now();
  const projectId = `benchmark-${testCase.id}`;
  const projectPath = path.join(PROJECTS_DIR, projectId);
  const failures = [];
  const report = {
    schemaVersion: 1,
    projectId,
    reportPath: '.quantpilot/validation.json',
    status: 'failed',
    passed: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    checks: [
      { id: 'artifact_policy', name: '生成产物策略', status: 'failed', summary: '检测到外部脚本或 mock 数据。' },
      { id: 'chart_presence', name: '金融图表存在性', status: 'failed', summary: '缺少 K 线和成交量图表。' },
      { id: 'market_proxy', name: '/api/market 代理', status: 'failed', summary: '缺少同源代理。' },
    ],
  };
  const repairPlan = buildQuantValidationRepairPlan(report);
  const instruction = buildQuantValidationRepairInstruction(report, {
    originalInstruction: testCase.question,
  });

  assertCondition(repairPlan.steps.length === 3, `修复计划应包含 3 个步骤，实际 ${repairPlan.steps.length}`, failures);
  for (const checkId of ['artifact_policy', 'chart_presence', 'market_proxy']) {
    assertCondition(repairPlan.steps.some((step) => step.checkId === checkId), `修复计划缺少 ${checkId}`, failures);
  }
  assertCondition(instruction.includes('只修改当前生成项目目录内的文件'), '修复提示词应限制只修改生成项目。', failures);
  assertCondition(instruction.includes('data_file/final/dashboard-data.json'), '修复提示词应强调标准数据绑定。', failures);
  assertCondition(instruction.includes('/api/market'), '修复提示词应强调同源市场代理。', failures);

  return {
    id: testCase.id,
    name: testCase.name,
    question: testCase.question,
    projectId,
    projectPath,
    durationMs: Date.now() - startedAt,
    passed: failures.length === 0,
    failures,
    symbols: [],
    prefetch: { skipped: true, summary: '修复计划用例不创建生成项目。' },
    artifacts: { repairPlan, instructionPreview: instruction.slice(0, 1000) },
    validation: {
      status: failures.length === 0 ? 'passed' : 'failed',
      checks: [{ id: 'repair_plan', status: failures.length === 0 ? 'passed' : 'failed', summary: '自动验证失败后的结构化修复计划检查。' }],
    },
  };
}

async function runSourceDegradationCase(testCase) {
  const startedAt = Date.now();
  const projectId = `benchmark-${testCase.id}`;
  const projectPath = path.join(PROJECTS_DIR, projectId);
  const requestId = `${projectId}-run`;
  const failures = [];

  await ensureBenchmarkProject({ projectId, projectPath, testCase });
  const finalData = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    symbol: '600519',
    name: '贵州茅台',
    asset_type: 'stock',
    source: 'eastmoney',
    quote: {
      symbol: '600519',
      name: '贵州茅台',
      price: 1600,
      change_percent: 0.8,
      source: 'eastmoney',
      fetched_at: new Date().toISOString(),
    },
    kline: {
      symbol: '600519',
      source: 'tencent',
      bars: Array.from({ length: 24 }, (_, index) => ({
        date: `2026-04-${String(index + 1).padStart(2, '0')}`,
        open: 1500 + index,
        high: 1510 + index,
        low: 1490 + index,
        close: 1504 + index,
        volume: 100000 + index * 1000,
        amount: 160000000 + index * 1000000,
      })),
      data_quality: {
        status: 'warning',
        warnings: ['东方财富历史 K 线降级失败，已使用腾讯行情代理补齐。'],
      },
    },
    technicalIndicators: {
      source: 'tencent',
      summary: {
        date: '2026-04-24',
        latest_close: 1527,
        ma5: 1522,
        ma20: 1515,
        period_return_pct: 1.8,
        max_drawdown_pct: -3.2,
        volatility_20d_annualized_pct: 18.6,
      },
      data_quality: {
        status: 'warning',
        warnings: ['技术指标使用降级 K 线计算。'],
      },
    },
    financials: {
      source: 'eastmoney',
      reports: [],
      data_quality: {
        status: 'warning',
        warnings: ['财务接口暂不可用，页面必须展示缺口。'],
      },
    },
    announcements: {
      source: 'eastmoney',
      announcements: [],
      data_quality: {
        status: 'warning',
        warnings: ['公告接口暂不可用，页面必须展示缺口。'],
      },
    },
    warnings: ['已发生数据源降级：历史 K 线使用腾讯代理，财务和公告保留缺口。'],
  };
  await writeJson(path.join(projectPath, 'data_file/final/dashboard-data.json'), finalData);
  await writeJson(path.join(projectPath, '.quantpilot/run_plan.json'), {
    runId: requestId,
    status: 'planned',
    capabilityId: testCase.capabilityId,
    question: testCase.question,
    dataRequirements: ['/api/v1/quotes/realtime/600519', '/api/v1/quotes/history/600519', '/api/v1/fundamentals/financials/600519'],
  });
  await fs.appendFile(
    path.join(projectPath, '.quantpilot/events.jsonl'),
    `${JSON.stringify({
      event_type: 'run_planned',
      stage: 'planning',
      status: 'success',
      run_id: requestId,
      artifact_path: '.quantpilot/run_plan.json',
      summary: 'benchmark 已写入数据源降级测试计划。',
      created_at: new Date().toISOString(),
    })}\n${JSON.stringify({
      event_type: 'data_prefetch_started',
      stage: 'data_collection',
      status: 'pending',
      run_id: requestId,
      summary: 'benchmark 开始构造数据源降级证据。',
      created_at: new Date().toISOString(),
    })}\n${JSON.stringify({
      event_type: 'data_prefetched',
      stage: 'data_collection',
      status: 'warning',
      run_id: requestId,
      artifact_path: 'data_file/final/dashboard-data.json',
      summary: 'benchmark 已写入含备用信源的 final 数据。',
      created_at: new Date().toISOString(),
    })}\n`,
    'utf8'
  );
  await writeJson(path.join(projectPath, 'evidence/sources.json'), {
    schemaVersion: 1,
    runId: requestId,
    generated_by: 'benchmark',
    sources: [
      { id: 'quote', dataset: '实时行情', source: 'eastmoney', endpoint: '/api/v1/quotes/realtime/600519', artifact_path: 'data_file/final/dashboard-data.json', row_count: 1, status: 'ok' },
      { id: 'kline', dataset: '历史 K 线', source: 'tencent', endpoint: '/api/v1/quotes/history/600519', artifact_path: 'data_file/final/dashboard-data.json', row_count: 24, status: 'warning' },
    ],
  });
  await writeJson(path.join(projectPath, 'evidence/data_quality.json'), {
    schemaVersion: 1,
    runId: requestId,
    generated_by: 'benchmark',
    status: 'warning',
    datasets: [
      { id: 'quote', name: '实时行情', source: 'eastmoney', row_count: 1, status: 'ok', required: true, missing_fields: [], warnings: [] },
      { id: 'kline', name: '历史 K 线', source: 'tencent', row_count: 24, status: 'warning', required: true, missing_fields: [], warnings: ['东方财富降级到腾讯行情代理。'] },
      { id: 'financials', name: '财务摘要', source: 'eastmoney', row_count: 0, status: 'warning', required: false, missing_fields: ['reports'], warnings: ['财务接口暂不可用。'] },
    ],
    checks: [
      { id: 'source_degradation', dataset: 'kline', status: 'warning', row_count: 24, summary: '历史行情已降级到备用信源。' },
    ],
    warnings: ['发生数据源降级，但核心行情和 K 线仍可展示。'],
    limitations: ['降级信源的字段口径可能与主信源不同，需要在页面展示。'],
  });
  await fs.appendFile(
    path.join(projectPath, '.quantpilot/events.jsonl'),
    `${JSON.stringify({
      event_type: 'data_quality_checked',
      stage: 'data_quality',
      status: 'warning',
      run_id: requestId,
      artifact_path: 'evidence/data_quality.json',
      summary: 'benchmark 已写入 warning 级数据质量证据。',
      created_at: new Date().toISOString(),
    })}\n`,
    'utf8'
  );
  await ensureQuantDashboardTemplate(projectPath);
  const artifactInspection = await inspectArtifacts({ projectPath, testCase, prefetch: { rawFiles: [] } });
  const validation = await validateQuantProject({
    projectId,
    projectPath,
    requestId,
    cliSource: 'benchmark',
  });
  const eventAudit = await auditProjectEvents({
    projectPath,
    testCase,
    expectFinalArtifacts: true,
  });
  await previewManager.stop(projectId);
  failures.push(
    ...artifactInspection.failures,
    ...eventAudit.failures,
    ...(validation.passed ? [] : validation.checks.filter((check) => check.status === 'failed').map((check) => `${check.id}: ${check.summary}`))
  );

  return {
    id: testCase.id,
    name: testCase.name,
    question: testCase.question,
    projectId,
    projectPath,
    durationMs: Date.now() - startedAt,
    passed: failures.length === 0,
    failures,
    symbols: ['600519'],
    prefetch: { skipped: false, summary: '使用合成降级证据验证 warning 级别链路。', rawFiles: [] },
    artifacts: artifactInspection,
    eventAudit,
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

async function runVisualCheck({ projectId, testCase }) {
  if (!testCase.visualCheck) {
    return null;
  }

  const { chromium } = require('playwright');
  const preview = await previewManager.start(projectId);
  const screenshotDir = path.resolve('tmp/visual-checks');
  await fs.mkdir(screenshotDir, { recursive: true });
  const screenshotPath = path.join(
    screenshotDir,
    `benchmark-${testCase.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
  );
  const failures = [];
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const failedResources = [];
  page.on('response', (response) => {
    const type = response.request().resourceType();
    if (response.status() >= 400 && ['document', 'script', 'stylesheet', 'font', 'image'].includes(type)) {
      failedResources.push(`${response.status()} ${type} ${response.url()}`);
    }
  });

  try {
    const response = await page.goto(preview.url, { waitUntil: 'networkidle', timeout: 45000 });
    assertCondition(response?.ok(), `预览地址 ${preview.url} 未返回 2xx。`, failures);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const info = await page.evaluate(() => ({
      text: document.body.innerText,
      svgCount: document.querySelectorAll('svg').length,
      rectCount: document.querySelectorAll('rect').length,
      canvasCount: document.querySelectorAll('canvas').length,
    }));
    for (const keyword of testCase.expectedVisualKeywords || ['QuantPilot']) {
      assertCondition(info.text.includes(keyword), `截图页面缺少关键词：${keyword}`, failures);
    }
    assertCondition(info.svgCount + info.canvasCount > 0 || info.rectCount >= 12, '截图页面缺少可识别图表元素。', failures);
    failures.push(...failedResources.map((item) => `资源加载失败：${item}`));

    return {
      passed: failures.length === 0,
      failures,
      screenshotPath: path.relative(process.cwd(), screenshotPath),
      previewUrl: preview.url,
      svgCount: info.svgCount,
      rectCount: info.rectCount,
      canvasCount: info.canvasCount,
    };
  } finally {
    await browser.close();
  }
}

async function runCase(testCase) {
  if (testCase.type === 'runtime_registry') {
    return runRuntimeRegistryCase(testCase);
  }
  if (testCase.type === 'repair_plan') {
    return runRepairPlanCase(testCase);
  }
  if (testCase.type === 'clarification_continuation') {
    return runClarificationContinuationCase(testCase);
  }
  if (testCase.type === 'source_degradation_contract') {
    return runSourceDegradationCase(testCase);
  }
  if (testCase.expectClarification) {
    return runClarificationCase(testCase);
  }

  const startedAt = Date.now();
  const projectId = `benchmark-${testCase.id}`;
  const projectPath = path.join(PROJECTS_DIR, projectId);
  const requestId = `${projectId}-run`;

  await ensureBenchmarkProject({ projectId, projectPath, testCase });
  await startQuantGenerationRun({
    projectPath,
    projectId,
    requestId,
    instruction: testCase.question,
    cliPreference: 'benchmark',
    selectedModel: 'deepseek-v4-flash',
  });
  if (testCase.imageAttachment) {
    await writeBenchmarkImageAttachment({
      projectPath,
      requestId,
      imageAttachment: testCase.imageAttachment,
    });
  }

  const plan = await writeInitialRunPlan({
    projectPath,
    instruction: testCase.question,
    requestId,
    capabilityId: testCase.capabilityId,
    hasImageAttachments: Boolean(testCase.imageAttachment),
  });
  await updateQuantGenerationStep({
    projectPath,
    projectId,
    requestId,
    stepId: 'planning',
    status: plan.status === 'needs_clarification' ? 'warning' : 'success',
    summary: `benchmark 已生成 ${plan.capabilityId} 执行计划。`,
    runStatus: plan.status === 'needs_clarification' ? 'needs_clarification' : undefined,
    metadata: {
      capabilityId: plan.capabilityId,
      templateId: plan.visualization?.templateId,
      symbols: plan.symbols,
    },
  });
  const prefetch = await prefetchQuantDataForRunPlan({ projectPath, plan });
  await updateQuantGenerationStep({
    projectPath,
    projectId,
    requestId,
    stepId: 'data_prefetch',
    status: prefetch.skipped ? 'skipped' : 'success',
    summary: prefetch.summary,
    metadata: {
      skipped: prefetch.skipped,
      symbols: prefetch.symbols,
      finalDataPath: prefetch.finalDataPath,
      rawFiles: prefetch.rawFiles,
    },
  });
  await ensureQuantDashboardTemplate(projectPath);
  await updateQuantGenerationStep({
    projectPath,
    projectId,
    requestId,
    stepId: 'agent_execution',
    status: 'skipped',
    summary: 'benchmark 使用平台标准模板生成看板，跳过外部 Agent 执行。',
    metadata: {
      deterministicDashboard: true,
    },
  });
  const artifactInspection = await inspectArtifacts({ projectPath, testCase, prefetch });
  await updateQuantGenerationStep({
    projectPath,
    projectId,
    requestId,
    stepId: 'validation',
    status: 'running',
    summary: 'benchmark 开始自动验证。',
  });
  const validation = await validateQuantProject({
    projectId,
    projectPath,
    requestId,
    cliSource: 'benchmark',
  });
  await updateQuantGenerationStep({
    projectPath,
    projectId,
    requestId,
    stepId: 'validation',
    status: validation.passed ? 'success' : 'failed',
    summary: validation.passed ? 'benchmark 自动验证通过。' : 'benchmark 自动验证失败。',
    runStatus: validation.passed ? 'completed' : 'failed',
  });
  const visualCheck = await runVisualCheck({ projectId, testCase });
  const eventAudit = await auditProjectEvents({
    projectPath,
    testCase,
    expectFinalArtifacts: true,
  });

  await previewManager.stop(projectId);

  const failures = [
    ...artifactInspection.failures,
    ...(visualCheck?.failures || []),
    ...eventAudit.failures,
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
    visualCheck,
    eventAudit,
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

async function runBenchmarkCase(testCase) {
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
      eventAudit: null,
      validation: null,
    };
    await previewManager.stop(projectId).catch(() => {});
  }
  console.log(`[QuantBenchmark] ${testCase.id} ${result.passed ? 'PASS' : 'FAIL'}`);
  if (!result.passed) {
    result.failures.forEach((failure) => console.log(`  - ${failure}`));
  }
  return result;
}

async function runCasesWithConcurrency(cases, concurrency) {
  const results = new Array(cases.length);
  let nextIndex = 0;
  const workerCount = Math.min(cases.length, Math.max(1, concurrency));

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < cases.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await runBenchmarkCase(cases[currentIndex]);
    }
  }));

  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const benchmarkStartedAt = new Date().toISOString();
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
  console.log(`[QuantBenchmark] evaluator=${args.evaluatorId} concurrency=${args.concurrency} cases=${cases.length}`);
  const results = await runCasesWithConcurrency(cases, args.concurrency);

  if (!args.keepProjects) {
    for (const result of results) {
      await cleanupBenchmarkProject(result);
    }
  }

  const coverage = buildCoverageSummary(cases, results);
  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    metadata: {
      trigger: args.trigger,
      startedAt: benchmarkStartedAt,
      finishedAt: new Date().toISOString(),
      command: process.argv.slice(2),
      evaluator: {
        id: args.evaluatorId,
        concurrency: args.concurrency,
      },
      runtime: {
        cli: args.cli,
        model: args.model,
        reasoningEffort: null,
      },
      selection: {
        selectedCases: Array.from(args.selected),
        limit: args.limit,
        keepProjects: args.keepProjects,
        caseCount: cases.length,
        concurrency: args.concurrency,
      },
      skillLockSnapshot: await readSkillLockSnapshot(),
    },
    passed: results.every((result) => result.passed),
    total: results.length,
    passedCount: results.filter((result) => result.passed).length,
    failedCount: results.filter((result) => !result.passed).length,
    coverage,
    results,
  };

  const reportPath = path.join(REPORTS_DIR, `report-${Date.now()}.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\n[QuantBenchmark] report: ${path.relative(process.cwd(), reportPath)}`);
  console.log(`[QuantBenchmark] ${report.passed ? 'ALL PASSED' : 'FAILED'} (${report.passedCount}/${report.total})`);
  console.log(`[QuantBenchmark] capabilities: ${Object.keys(coverage.byCapability).join(', ')}`);
  console.log(`[QuantBenchmark] coverage tags: ${Object.keys(coverage.byTag).length}`);
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
