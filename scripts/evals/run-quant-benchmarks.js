#!/usr/bin/env node

require('tsconfig-paths/register');

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');
const { PrismaClient } = require('@prisma/client');
const { NextRequest } = require('next/server');
const jiti = require('jiti')(path.join(process.cwd(), 'scripts/evals/run-quant-benchmarks.js'), {
  interopDefault: true,
});

const { ensureQuantDashboardTemplate, scaffoldBasicNextApp } = jiti('../../src/lib/utils/scaffold.ts');
const { writeInitialRunPlan } = jiti('../../src/lib/domains/finance/workspace.ts');
const { rewriteQuantQuery } = jiti('../../src/lib/domains/finance/query-rewrite.ts');
const {
  serializeQuantVisualizationTemplate,
} = jiti('../../src/lib/domains/finance/visualization-templates.ts');
const {
  __dashboardSpecTesting,
} = jiti('../../src/lib/domains/finance/agent-tools/dashboard-spec.ts');
const { buildClarificationContinuation } = jiti('../../src/lib/domains/finance/intent.ts');
const { prefetchQuantDataForRunPlan } = jiti('../../src/lib/quant/data-prefetch.ts');
const {
  startQuantGenerationRun,
  updateQuantGenerationStep,
} = jiti('../../src/lib/quant/generation-state.ts');
const {
  buildQuantValidationRepairInstruction,
  buildQuantValidationRepairPlan,
  readQuantValidationReport,
  validateQuantProject,
} = jiti('../../src/lib/quant/validation.ts');
const { previewManager } = jiti('../../src/lib/services/preview.ts');
const { createProject } = jiti('../../src/lib/services/project.ts');
const {
  getDefaultModelForCli,
  getModelDefinitionsForCli,
  normalizeModelId,
} = jiti('../../src/lib/constants/models.ts');
const { applyChanges, initializeNextJsProject } = jiti('../../src/lib/services/cli/moagent.ts');
const {
  failBenchmarkGenerationRun,
  runBenchmarkRepairLoop,
} = jiti('../../src/lib/eval/benchmark-repair.ts');
const {
  DEFAULT_MOAGENT_E2E_QUALITY_THRESHOLDS,
  evaluateMoAgentE2eQuality,
  isE2eAgentExecutionAttested,
  summarizeE2eAgentExecution,
  summarizeMoAgentE2eQuality,
} = jiti('../../src/lib/eval/e2e-attestation.ts');
const {
  MOAGENT_BUILD_IDENTITY,
  MOAGENT_FRAMEWORK_VERSION,
} = jiti('../../src/lib/agent/framework-identity.ts');
const {
  attestEvalReport,
  EVAL_REPORT_SCHEMA_VERSION,
} = jiti('../../src/lib/eval/report-attestation.ts');
const {
  attestProductControlEvidence,
  loadQuantE2eSuite,
} = require('../checks/quant-e2e-suite');
const {
  applyEvalEvaluator,
  getEvalEvaluatorDefinition,
} = jiti('../../src/lib/eval/evaluators.ts');
const { reviewAgentWorkspace } = jiti('../../src/lib/eval/agent-reviewer.ts');
const { evaluateOracleAssertions } = jiti('../../src/lib/eval/oracles.ts');
const { buildEvalQualitySummary } = jiti('../../src/lib/eval/scoring.ts');
const { buildEvalTraceDiagnostics } = jiti('../../src/lib/eval/trace-diagnostics.ts');
const { evalSnapshotPayloadSha256 } = jiti('../../src/lib/eval/snapshot-contract.ts');
const { normalizedPromptHash } = jiti('../../src/lib/eval/dataset-contract.ts');

// Keep CLI evaluation consistent with the web launcher while preserving
// explicitly provided CI environment variables. Local overrides load first.
dotenv.config({ path: path.resolve('.env.local') });
dotenv.config({ path: path.resolve('.env') });

const prisma = new PrismaClient();
const CASES_PATH = path.resolve('benchmarks/quantpilot/cases.json');
const E2E_SUITE_PATH = path.resolve('benchmarks/quantpilot/e2e-suite.json');
const DATASET_REGISTRY_PATH = path.resolve('benchmarks/quantpilot/datasets.json');
const SNAPSHOT_MANIFEST_PATH = path.resolve('benchmarks/quantpilot/snapshot-manifest.json');
const QUERY_REWRITE_FIXTURES_PATH = path.resolve('benchmarks/quantpilot/query-rewrite-fixtures.json');
const PROJECTS_DIR = path.resolve(process.env.PROJECTS_DIR || './data/projects');
const REPORTS_DIR = path.resolve('tmp/quantpilot-benchmark-reports');
const DEFAULT_MODEL = getDefaultModelForCli('moagent');
const QUERY_REWRITE_FIXTURES = require(QUERY_REWRITE_FIXTURES_PATH);

function githubWorkflowCommandValue(value) {
  return String(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

function emitGithubError(title, message) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  console.error(
    `::error title=${githubWorkflowCommandValue(title)}::` +
    githubWorkflowCommandValue(String(message).slice(0, 6_000)),
  );
}

async function replayContractQueryRewrite({ testCase, instruction, phase = 'primary', projectId }) {
  const fixture = QUERY_REWRITE_FIXTURES?.cases?.[testCase.id]?.[phase];
  if (!fixture) {
    throw new Error(`contract query rewrite fixture 缺失：${testCase.id}/${phase}`);
  }
  return rewriteQuantQuery(instruction, {
    requestedCapabilityId: testCase.capabilityId,
    projectId,
    semanticRewriter: async () => ({
      ok: true,
      data: fixture,
      provider: QUERY_REWRITE_FIXTURES.provider,
      model: QUERY_REWRITE_FIXTURES.model,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
  });
}

function modelRuntime(model) {
  const definition = getModelDefinitionsForCli('moagent')
    .find((candidate) => candidate.id === model);
  if (!definition) throw new Error(`未注册的 MoAgent 模型：${model || '(empty)'}`);
  return { model: definition.id, provider: definition.provider };
}

function parseArgs(argv) {
  const selected = new Set();
  let limit = null;
  let keepProjects = false;
  let trigger = process.env.QUANTPILOT_EVAL_TRIGGER || 'cli';
  let evaluatorId = process.env.QUANTPILOT_EVAL_EVALUATOR || 'rule-strict';
  let concurrency = Number.parseInt(process.env.QUANTPILOT_EVAL_CONCURRENCY || '1', 10);
  let repeat = Number.parseInt(process.env.QUANTPILOT_EVAL_REPEAT || '1', 10);
  let mode = process.env.QUANTPILOT_EVAL_MODE || 'contract';
  let datasetVisibility = process.env.QUANTPILOT_EVAL_DATASET_VISIBILITY || 'public';
  let casesFile = process.env.QUANTPILOT_EVAL_CASES_PATH || null;
  let cli = 'moagent';
  let model = process.env.QUANTPILOT_EVAL_MODEL || DEFAULT_MODEL;

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
    if (arg === '--e2e') {
      mode = 'e2e';
      continue;
    }
    if (arg === '--contract') {
      mode = 'contract';
      continue;
    }
    if (arg === '--mode' && argv[index + 1]) {
      mode = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      mode = arg.slice('--mode='.length);
      continue;
    }
    if (arg === '--dataset-visibility' && argv[index + 1]) {
      datasetVisibility = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--dataset-visibility=')) {
      datasetVisibility = arg.slice('--dataset-visibility='.length);
      continue;
    }
    if (arg === '--cases-file' && argv[index + 1]) {
      casesFile = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--cases-file=')) {
      casesFile = arg.slice('--cases-file='.length);
      continue;
    }
    if (arg === '--cli' && argv[index + 1]) {
      cli = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--cli=')) {
      cli = arg.slice('--cli='.length);
      continue;
    }
    if (arg === '--model' && argv[index + 1]) {
      model = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--model=')) {
      model = arg.slice('--model='.length);
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
    if (arg === '--repeat' && argv[index + 1]) {
      repeat = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg.startsWith('--repeat=')) {
      repeat = Number.parseInt(arg.slice('--repeat='.length), 10);
      continue;
    }
  }

  if (!['contract', 'e2e'].includes(mode)) {
    throw new Error(`不支持的 benchmark mode：${mode}。请使用 contract 或 e2e。`);
  }
  if (!['public', 'hidden', 'production_replay'].includes(datasetVisibility)) {
    throw new Error(`不支持的 dataset visibility：${datasetVisibility}`);
  }
  if (datasetVisibility !== 'public') {
    casesFile = casesFile || (datasetVisibility === 'hidden'
      ? process.env.QUANTPILOT_HIDDEN_EVAL_CASES_PATH
      : process.env.QUANTPILOT_PRODUCTION_REPLAY_CASES_PATH) || null;
    if (!casesFile) {
      throw new Error(`${datasetVisibility} 评测必须通过环境变量或 --cases-file 注入外部数据集`);
    }
    if (mode !== 'e2e') throw new Error(`${datasetVisibility} 评测必须使用真实 e2e 模式`);
  } else if (casesFile) {
    throw new Error('public 评测固定使用仓库 cases.json，不能通过 --cases-file 替换');
  }
  if (datasetVisibility !== 'public' && casesFile) {
    const resolvedCasesFile = path.resolve(casesFile);
    const relativeCasesFile = path.relative(process.cwd(), resolvedCasesFile);
    if (relativeCasesFile && !relativeCasesFile.startsWith('..') && !path.isAbsolute(relativeCasesFile)) {
      const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', relativeCasesFile], {
        cwd: process.cwd(),
        stdio: 'ignore',
      });
      if (tracked.status === 0) throw new Error(`${datasetVisibility} 数据集被 Git 跟踪，拒绝执行以防测试集泄漏`);
    }
  }
  if (cli !== 'moagent') {
    throw new Error(`benchmark 只接受 --cli=moagent，收到：${cli || '(empty)'}`);
  }
  const requestedModel = model.trim().toLowerCase();
  const modelDefinition = getModelDefinitionsForCli('moagent').find((definition) =>
    definition.id.toLowerCase() === requestedModel ||
    definition.aliases.some((alias) => alias.toLowerCase() === requestedModel));
  if (!modelDefinition) throw new Error(`benchmark 收到未注册的 MoAgent 模型：${model || '(empty)'}`);
  model = modelDefinition.id;
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 5) {
    throw new Error(`--repeat 必须是 1 到 5 的整数，收到：${repeat}`);
  }
  const evaluator = getEvalEvaluatorDefinition(evaluatorId || 'rule-strict');
  if (!evaluator.supportedModes.includes(mode)) {
    throw new Error(`${evaluator.id} 不支持 ${mode} 模式。`);
  }

  return {
    selected,
    limit: Number.isFinite(limit) && limit > 0 ? limit : null,
    keepProjects,
    cli,
    model,
    reasoningEffort: '',
    trigger,
    evaluatorId: evaluatorId || 'rule-strict',
    repeat,
    concurrency: Number.isFinite(concurrency) && concurrency > 0 ? Math.min(16, Math.floor(concurrency)) : 1,
    mode,
    datasetVisibility,
    casesFile: casesFile ? path.resolve(casesFile) : CASES_PATH,
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
  const lockPath = path.resolve('.moagent/skills.lock.json');
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
          sourceSha256: item.sourceSha256 ?? item.hash ?? null,
          packageSha256: item.packageSha256 ?? item.packageHash ?? null,
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

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function reportCommand(argv, datasetVisibility) {
  if (datasetVisibility === 'public') return argv;
  const redacted = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cases-file') {
      redacted.push(arg, '[external-dataset]');
      index += 1;
    } else if (arg.startsWith('--cases-file=')) {
      redacted.push('--cases-file=[external-dataset]');
    } else {
      redacted.push(arg);
    }
  }
  return redacted;
}

async function readEvents(projectPath) {
  const eventsPath = path.join(projectPath, '.data-agent', 'events.jsonl');
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
  if (testCase.expectedVariantId) tags.add(`variant:${testCase.expectedVariantId}`);
  if (testCase.expectClarification) tags.add('intent:clarification_required');
  if (testCase.type === 'clarification_continuation') tags.add('intent:clarification_continuation');
  if (testCase.imageAttachment) tags.add('input:image_attachment');
  if (testCase.visualCheck) tags.add('visual:playwright');
  if (testCase.expectedImageExtraction) tags.add('evidence:image_extraction');
  if (testCase.expectedExecutionLane) tags.add(`lane:${testCase.expectedExecutionLane}`);
  if (testCase.expectedNoCardSurface) tags.add('visual:no-card-workbench');
  if (testCase.type === 'runtime_registry') tags.add('runtime:deepseek_v4_flash');
  if (testCase.type === 'repair_plan') tags.add('validation:repair_plan');
  if (testCase.type === 'source_degradation_contract') tags.add('data:source_degradation');
  if (testCase.type === 'renderer_capability_contract') tags.add('dashboard:renderer_capability');
  const coverageLevel = testCase.coverageLevel ||
    (testCase.type === 'renderer_capability_contract' ? 'routing' : 'contract');
  tags.add(`coverage:${coverageLevel}`);
  if (testCase.productionSupported) tags.add('coverage:production');
  for (const safetyTag of testCase.safetyTags || []) tags.add(`safety:${safetyTag}`);
  for (const expectation of testCase.selectionExpectations || []) {
    if (expectation.capabilityId) tags.add(expectation.capabilityId);
    if (expectation.expectedTemplateId) tags.add(`template:${expectation.expectedTemplateId}`);
    if (expectation.expectedVariantId) tags.add(`variant:${expectation.expectedVariantId}`);
  }
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
  const caseLevels = {};
  const byLevel = {
    routing: {},
    contract: {},
    live_e2e: {},
    production: {},
  };

  const addLevel = (level, capability, passed) => {
    byLevel[level][capability] = byLevel[level][capability] || { total: 0, passed: 0, failed: 0 };
    byLevel[level][capability].total += 1;
    byLevel[level][capability][passed ? 'passed' : 'failed'] += 1;
  };

  for (const testCase of cases) {
    const tags = caseCoverageTags(testCase);
    const result = results.find((item) => item.id === testCase.id);
    const passed = Boolean(result?.passed);
    const capability = testCase.capabilityId || 'unknown';
    const type = testCase.type || (testCase.expectClarification ? 'clarification_required' : 'generated_project');
    caseTags[testCase.id] = tags;
    const levels = new Set();
    const configuredLevel = testCase.coverageLevel ||
      (type === 'renderer_capability_contract' ? 'routing' : 'contract');
    levels.add(configuredLevel);
    if (type === 'renderer_capability_contract' || (testCase.selectionExpectations || []).length > 0) {
      levels.add('routing');
    }
    if (result?.executionMode === 'e2e') levels.add('live_e2e');
    if (testCase.productionSupported) levels.add('production');
    caseLevels[testCase.id] = Array.from(levels);
    for (const level of levels) addLevel(level, capability, passed);
    if (levels.has('routing')) {
      for (const expectation of testCase.selectionExpectations || []) {
        if (expectation.capabilityId && expectation.capabilityId !== capability) {
          addLevel('routing', expectation.capabilityId, passed);
        }
      }
    }

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
    byLevel,
    caseLevels,
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
      levels: {
        routing: ['sector_rotation', 'strategy_research'],
        contract: [
          'fundamental_analysis',
          'technical_analysis',
          'backtest_review',
          'asset_comparison',
          'portfolio_risk',
          'stock_diagnosis',
        ],
        live_e2e: [
          'fundamental_analysis',
          'technical_analysis',
          'portfolio_risk',
          'stock_diagnosis',
        ],
      },
    },
  };
}

async function ensureBenchmarkProject({ projectId, projectPath, testCase, selectedModel = DEFAULT_MODEL }) {
  await fs.rm(projectPath, { recursive: true, force: true });
  await prisma.project.deleteMany({ where: { id: projectId } });

  await createProject({
    project_id: projectId,
    name: `Benchmark ${testCase.name}`,
    description: testCase.question,
    initialPrompt: testCase.question,
    preferredCli: 'moagent',
    selectedModel,
    quantCapabilityId: testCase.capabilityId,
    quantCapabilitySource: 'manual',
  });
  await scaffoldBasicNextApp(projectPath, projectId);
}

async function writeBenchmarkImageAttachment({ projectPath, requestId, imageAttachment }) {
  const fixtureName = imageAttachment?.filename || 'portfolio-screenshot.png';
  const imageDir = path.join(projectPath, 'uploads', requestId);
  const imagePath = path.join(imageDir, fixtureName);
  await fs.mkdir(imageDir, { recursive: true });
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAUAAAADwCAIAAABxLb1rAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAG0lEQVR4nO3BAQ0AAADCoPdPbQ43oAAAAAAAAAC4Gz+0AAFjTWbGAAAAAElFTkSuQmCC';
  await fs.writeFile(imagePath, Buffer.from(pngBase64, 'base64'));
  await writeJson(path.join(projectPath, '.data-agent', 'attachments.json'), {
    schemaVersion: 1,
    projectId: path.basename(projectPath),
    requestId,
    createdAt: new Date().toISOString(),
    attachments: [
      {
        id: 'benchmark-image-1',
        name: fixtureName,
        path: path.relative(projectPath, imagePath).replaceAll(path.sep, '/'),
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

function formatValidationFailure(check) {
  return `${check.id}: ${check.summary}${check.details ? `\n${check.details}` : ''}`;
}

async function readInspectionArtifact({ projectPath, relativePath, format, failures, missingArtifacts, invalidArtifacts }) {
  const absolutePath = path.join(projectPath, relativePath);
  let content;
  try {
    content = await fs.readFile(absolutePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      missingArtifacts.push(relativePath);
      failures.push(`缺少必需产物：${relativePath}`);
    } else {
      invalidArtifacts.push(relativePath);
      failures.push(`无法读取产物 ${relativePath}：${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }

  if (!content.trim()) {
    invalidArtifacts.push(relativePath);
    failures.push(`产物为空：${relativePath}`);
    return null;
  }
  if (format === 'text') {
    return content;
  }

  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('根节点必须是 JSON 对象');
    }
    return parsed;
  } catch (error) {
    invalidArtifacts.push(relativePath);
    failures.push(`产物 JSON 无效 ${relativePath}：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function inspectArtifacts({ projectPath, testCase, prefetch }) {
  const failures = [];
  const missingArtifacts = [];
  const invalidArtifacts = [];
  const readArtifact = (relativePath, format = 'json') => readInspectionArtifact({
    projectPath,
    relativePath,
    format,
    failures,
    missingArtifacts,
    invalidArtifacts,
  });
  const [finalData, quality, sources, page, runPlan] = await Promise.all([
    readArtifact('data_file/final/dashboard-data.json'),
    readArtifact('evidence/data_quality.json'),
    readArtifact('evidence/sources.json'),
    readArtifact('app/page.tsx', 'text'),
    readArtifact('.data-agent/finance-run-plan.json'),
  ]);

  if (!finalData || !quality || !sources || !page || !runPlan) {
    return {
      status: 'failed',
      failures,
      missingArtifacts,
      invalidArtifacts,
      finalData: null,
      quality: null,
      oracle: {
        passed: false,
        warning: false,
        checks: [],
        failures: ['关键产物缺失，无法执行事实 oracle。'],
        warnings: [],
      },
    };
  }

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
      page.includes('更新时间') ||
      page.includes('数据缺口'),
    'app/page.tsx 应展示数据质量或限制信息。',
    failures
  );

  for (const expectedField of testCase.expectedFinalFields || []) {
    assertCondition(finalData[expectedField] !== undefined, `final 数据缺少字段 ${expectedField}`, failures);
  }

  if (testCase.expectedTemplateId) {
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

  if (testCase.expectedVariantId) {
    const finalVariantId = finalData.visualization?.variant_id || finalData.visualization?.variantId;
    assertCondition(
      runPlan.visualization?.variantId === testCase.expectedVariantId,
      `run_plan.visualization.variantId 应为 ${testCase.expectedVariantId}，实际为 ${runPlan.visualization?.variantId}`,
      failures
    );
    assertCondition(
      finalVariantId === testCase.expectedVariantId,
      `final visualization.variant_id 应为 ${testCase.expectedVariantId}，实际为 ${finalVariantId}`,
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
    const screenerCandidates = Array.isArray(finalData.screener?.candidates) ? finalData.screener.candidates : null;
    const isStructuredEmptyResult =
      finalData.status === 'no_candidates' &&
      Number(finalData.screener?.total_candidates) === 0 &&
      screenerCandidates &&
      screenerCandidates.length === 0 &&
      Array.isArray(finalData.assets) &&
      finalData.assets.length === 0;
    if (isStructuredEmptyResult) {
      assertCondition(Array.isArray(finalData.selectionRanking?.rows), '空候选结果仍应包含 selectionRanking.rows 数组。', failures);
      assertCondition(Array.isArray(finalData.financialQuality?.rows), '空候选结果仍应包含 financialQuality.rows 数组。', failures);
      assertCondition(Array.isArray(finalData.comparison?.rows), '空候选结果仍应包含 comparison.rows 数组。', failures);
      assertCondition(finalData.tradingPlan?.status === 'unavailable', '空候选结果的 tradingPlan.status 应为 unavailable。', failures);
      assertCondition(Array.isArray(finalData.warnings) && finalData.warnings.length > 0, '空候选结果应包含可读的 warnings。', failures);
      assertCondition(/noCandidates|没有满足安全条件的候选|结构化空结果/.test(page), '空候选页面应明确展示无安全候选状态。', failures);
    } else {
      assertCondition(Array.isArray(finalData.selectionRanking?.rows) && finalData.selectionRanking.rows.length > 0, 'selectionRanking.rows 应非空。', failures);
      assertCondition(Array.isArray(finalData.financialQuality?.rows) && finalData.financialQuality.rows.length > 0, 'financialQuality.rows 应非空。', failures);
      assertCondition(
        Array.isArray(finalData.comparison?.rows) &&
          finalData.comparison.rows.every((row) => row && row.composite_score !== undefined && row.selection_view),
        'comparison.rows[] 应包含 composite_score 和 selection_view。',
        failures
      );
    }
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
    const imageEvidence = await readArtifact('evidence/image_extraction.json');
    const imageSourceIds = new Set((sources.sources || []).map((source) => source.id));
    assertCondition(finalData.imageExtraction && typeof finalData.imageExtraction === 'object', 'final 数据缺少 imageExtraction。', failures);
    assertCondition(imageEvidence?.status === 'metadata_ready', `image_extraction.status 应为 metadata_ready，实际为 ${imageEvidence?.status}`, failures);
    assertCondition(Array.isArray(imageEvidence?.images) && imageEvidence.images.length > 0, 'image_extraction.images 应非空。', failures);
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

  if (testCase.expectedNoCardSurface) {
    const visualReport = await readArtifact('.data-agent/visual-validation.json');
    const viewports = Array.isArray(visualReport?.viewports) ? visualReport.viewports : [];
    assertCondition(viewports.length >= 2, '无卡片定制必须保留桌面端和移动端视觉证据。', failures);
    for (const viewport of viewports) {
      const metrics = viewport?.metrics || {};
      assertCondition(
        metrics.hasFinancialWorkbenchMarker === true,
        `${viewport?.id || 'unknown'} 无卡片定制缺少 financial-workbench 标记。`,
        failures,
      );
      assertCondition(
        metrics.cardGridClusterCount === 0,
        `${viewport?.id || 'unknown'} 仍存在独立圆角卡片网格。`,
        failures,
      );
      assertCondition(
        Number(metrics.firstViewportCardLikeSurfaceCount || 0) < 4 &&
          Number(metrics.cardLikeSurfaceCount || 0) < 8,
        `${viewport?.id || 'unknown'} 独立卡片式容器仍然偏多。`,
        failures,
      );
    }
  }

  const oracle = evaluateOracleAssertions({
    assertions: testCase.oracleAssertions || [],
    targets: { finalData, sources, quality, page },
  });
  failures.push(...oracle.failures);

  return {
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
    missingArtifacts,
    invalidArtifacts,
    oracle,
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
    capabilitySource: 'benchmark',
    queryRewrite: await replayContractQueryRewrite({
      testCase,
      instruction: testCase.question,
      projectId,
    }),
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
  await startQuantGenerationRun({
    projectPath,
    projectId,
    requestId,
    instruction: testCase.question,
    cliPreference: 'benchmark',
    selectedModel: DEFAULT_MODEL,
  });
  const firstPlan = await writeInitialRunPlan({
    projectPath,
    instruction: testCase.question,
    requestId,
    capabilityId: testCase.capabilityId,
    capabilitySource: 'benchmark',
    queryRewrite: await replayContractQueryRewrite({
      testCase,
      instruction: testCase.question,
      projectId,
    }),
  });
  await updateQuantGenerationStep({
    projectPath,
    projectId,
    requestId,
    stepId: 'planning',
    status: firstPlan.status === 'needs_clarification' ? 'warning' : 'success',
    summary: `benchmark 首轮已生成 ${firstPlan.capabilityId} 执行计划。`,
    runStatus: firstPlan.status === 'needs_clarification' ? 'needs_clarification' : undefined,
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
    await startQuantGenerationRun({
      projectPath,
      projectId,
      requestId: followupRequestId,
      instruction: continuation.resolvedInstruction,
      cliPreference: 'benchmark',
      selectedModel: DEFAULT_MODEL,
    });
    plan = await writeInitialRunPlan({
      projectPath,
      instruction: continuation.resolvedInstruction,
      requestId: followupRequestId,
      capabilityId: testCase.capabilityId,
      capabilitySource: 'benchmark',
      queryRewrite: await replayContractQueryRewrite({
        testCase,
        instruction: continuation.resolvedInstruction,
        phase: 'followup',
        projectId,
      }),
    });
    await updateQuantGenerationStep({
      projectPath,
      projectId,
      requestId: followupRequestId,
      stepId: 'planning',
      status: plan.status === 'needs_clarification' ? 'warning' : 'success',
      summary: 'benchmark 已承接用户补充并更新执行计划。',
      runStatus: plan.status === 'needs_clarification' ? 'needs_clarification' : undefined,
      metadata: {
        previousRunId: continuation.previousRunId,
        symbols: plan.symbols,
      },
    });
    prefetch = await prefetchQuantDataForRunPlan({ projectPath, plan });
    await updateQuantGenerationStep({
      projectPath,
      projectId,
      requestId: followupRequestId,
      stepId: 'data_prefetch',
      status: prefetch.skipped ? 'skipped' : 'success',
      summary: prefetch.summary,
      metadata: {
        skipped: prefetch.skipped,
        symbols: prefetch.symbols,
      },
    });
    await ensureQuantDashboardTemplate(projectPath);
    await updateQuantGenerationStep({
      projectPath,
      projectId,
      requestId: followupRequestId,
      stepId: 'agent_execution',
      status: 'skipped',
      summary: '契约 benchmark 使用平台标准模板，不声明为模型生成结果。',
      metadata: {
        deterministicDashboard: true,
        modelExecuted: false,
      },
    });
    artifactInspection = await inspectArtifacts({ projectPath, testCase, prefetch });
    await updateQuantGenerationStep({
      projectPath,
      projectId,
      requestId: followupRequestId,
      stepId: 'validation',
      status: 'running',
      summary: 'benchmark 开始自动验证。',
    });
    validation = await validateQuantProject({
      projectId,
      projectPath,
      requestId: followupRequestId,
      cliSource: 'benchmark',
    });
    await updateQuantGenerationStep({
      projectPath,
      projectId,
      requestId: followupRequestId,
      stepId: 'validation',
      status: validation.passed ? 'success' : 'failed',
      summary: validation.passed ? 'benchmark 自动验证通过。' : 'benchmark 自动验证失败。',
      runStatus: validation.passed ? 'completed' : 'failed',
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
  const registeredModels = getModelDefinitionsForCli('moagent');

  assertCondition(registeredModels.length === 3, `平台应暴露 3 个受控模型，实际 ${registeredModels.length} 个。`, failures);
  assertCondition(registeredModels[0]?.id === DEFAULT_MODEL, `首个模型应为 ${DEFAULT_MODEL}，实际 ${registeredModels[0]?.id}`, failures);
  assertCondition(registeredModels[1]?.id === 'deepseek:deepseek-v4-flash', `第二个模型应为 ModelPort DeepSeek，实际 ${registeredModels[1]?.id}`, failures);
  assertCondition(registeredModels[2]?.id === 'deepseek-v4-flash', `第三个模型应为可选官方直连，实际 ${registeredModels[2]?.id}`, failures);
  assertCondition(getDefaultModelForCli('moagent') === DEFAULT_MODEL, `默认模型应为 ${DEFAULT_MODEL}，实际 ${getDefaultModelForCli('moagent')}`, failures);
  assertCondition(normalizeModelId('moagent', 'local_qwen:qwen3.5-9b-q5km') === 'local_qwen:qwen3.5-9b-q5km', '已注册的本地 Qwen 输入应被保留。', failures);
  assertCondition(normalizeModelId('codex', 'gpt-5.5') === DEFAULT_MODEL, '任何未注册供应商或模型输入都应安全回退到本地 Qwen。', failures);

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
      registeredModels,
      defaultModel: getDefaultModelForCli('moagent'),
    },
    validation: {
      status: failures.length === 0 ? 'passed' : 'failed',
      checks: [{ id: 'runtime_registry', status: failures.length === 0 ? 'passed' : 'failed', summary: '本地 Qwen、ModelPort DeepSeek 与官方直连接入边界检查。' }],
    },
  };
}

function runRendererCapabilityContractCase(testCase) {
  const startedAt = Date.now();
  const projectId = `benchmark-${testCase.id}`;
  const projectPath = path.join(PROJECTS_DIR, projectId);
  const failures = [];
  const actualMatrix = __dashboardSpecTesting.capabilityMatrix.map((capability) => ({
    templateId: capability.templateId,
    variantId: capability.variantId,
    supported: capability.supported,
  }));
  const expectedMatrix = Array.isArray(testCase.variantExpectations)
    ? testCase.variantExpectations
    : [];

  assertCondition(
    expectedMatrix.length > 0,
    'renderer capability contract 必须声明非空 variantExpectations。',
    failures,
  );
  assertCondition(
    JSON.stringify(actualMatrix) === JSON.stringify(expectedMatrix),
    `DashboardSpec renderer capability matrix 漂移：expected=${JSON.stringify(expectedMatrix)} actual=${JSON.stringify(actualMatrix)}`,
    failures,
  );

  const selections = [];
  for (const expectation of testCase.selectionExpectations || []) {
    const selected = serializeQuantVisualizationTemplate(expectation.capabilityId, {
      instruction: expectation.question,
      symbolCount: expectation.symbolCount,
      dataSignals: expectation.dataSignals,
    });
    const projection = {
      capabilityId: expectation.capabilityId,
      templateId: selected.templateId,
      variantId: selected.variantId,
    };
    selections.push(projection);
    assertCondition(
      selected.templateId === expectation.expectedTemplateId,
      `${expectation.capabilityId} template 应为 ${expectation.expectedTemplateId}，实际为 ${selected.templateId}`,
      failures,
    );
    assertCondition(
      selected.variantId === expectation.expectedVariantId,
      `${expectation.capabilityId} variant 应为 ${expectation.expectedVariantId}，实际为 ${selected.variantId}`,
      failures,
    );
  }

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
    prefetch: { skipped: true, summary: 'Renderer capability contract 不创建生成项目。' },
    artifacts: { capabilityMatrix: actualMatrix, selections },
    validation: {
      status: failures.length === 0 ? 'passed' : 'failed',
      checks: [{
        id: 'renderer_capability_contract',
        status: failures.length === 0 ? 'passed' : 'failed',
        summary: 'DashboardSpec 变体覆盖、支持状态与选择路由检查。',
      }],
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
    reportPath: '.data-agent/validation.json',
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
  assertCondition(
    instruction.includes('唯一可写范围：app/page.tsx、app/globals.css 和 app/api/market/[...path]/route.ts') &&
      !instruction.includes('唯一可写范围：app/**、data_file/final/**') &&
      !instruction.includes('唯一可写范围：app/**、evidence/**'),
    '纯 UI/代理失败的修复提示词应把 Agent 写权限精确限制在失败项对应的 app 文件。',
    failures,
  );
  assertCondition(
    instruction.includes('整个 `.data-agent/**`') && instruction.includes('结构修复和重新生成由平台负责'),
    '修复提示词应明确 .data-agent 全部由平台维护。',
    failures,
  );
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
  await startQuantGenerationRun({
    projectPath,
    projectId,
    requestId,
    instruction: testCase.question,
    cliPreference: 'benchmark',
    selectedModel: DEFAULT_MODEL,
  });
  const plan = await writeInitialRunPlan({
    projectPath,
    instruction: '贵州茅台 600519 最近行情走势如何？',
    requestId,
    capabilityId: testCase.capabilityId,
    capabilitySource: 'benchmark',
    queryRewrite: await replayContractQueryRewrite({
      testCase,
      instruction: '贵州茅台 600519 最近行情走势如何？',
      projectId,
    }),
  });
  assertCondition(plan.status === 'planned', `降级证据 fixture 应生成 planned 计划，实际为 ${plan.status}`, failures);
  await updateQuantGenerationStep({
    projectPath,
    projectId,
    requestId,
    stepId: 'planning',
    status: 'success',
    summary: 'benchmark 已通过生产 writer 写入数据源降级测试计划。',
  });
  const finalData = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    symbol: '600519',
    name: '贵州茅台',
    asset_type: 'stock',
    source: 'eastmoney',
    as_of: new Date().toISOString(),
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
    visualization: {
      template_id: plan.visualization.templateId,
      name: plan.visualization.name,
      scenario: plan.visualization.scenario,
      variant_id: plan.visualization.variantId,
      layout: plan.visualization.layout,
      density: plan.visualization.density,
      required_components: plan.visualization.panels,
      rendered_components: plan.visualization.panels,
      missing_components: [],
    },
    warnings: ['已发生数据源降级：历史 K 线使用腾讯代理，财务和公告保留缺口。'],
  };
  await writeJson(path.join(projectPath, 'data_file/final/dashboard-data.json'), finalData);
  await fs.appendFile(
    path.join(projectPath, '.data-agent/events.jsonl'),
    `${JSON.stringify({
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
      {
        id: 'quote',
        dataset: '实时行情',
        source: 'eastmoney',
        endpoint: '/api/v1/quotes/realtime/600519',
        artifact_path: 'data_file/final/dashboard-data.json',
        row_count: 1,
        fetched_at: finalData.quote.fetched_at,
        as_of: finalData.quote.fetched_at,
        status: 'ok',
      },
      {
        id: 'kline',
        dataset: '历史 K 线',
        source: 'tencent',
        endpoint: '/api/v1/quotes/history/600519',
        artifact_path: 'data_file/final/dashboard-data.json',
        row_count: 24,
        fetched_at: finalData.generatedAt,
        as_of: '2026-04-24',
        status: 'warning',
      },
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
    path.join(projectPath, '.data-agent/events.jsonl'),
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
  await updateQuantGenerationStep({
    projectPath,
    projectId,
    requestId,
    stepId: 'data_prefetch',
    status: 'warning',
    summary: 'benchmark 已写入含备用信源和缺口说明的降级证据。',
  });
  await ensureQuantDashboardTemplate(projectPath);
  const artifactInspection = await inspectArtifacts({ projectPath, testCase, prefetch: { rawFiles: [] } });
  await updateQuantGenerationStep({
    projectPath,
    projectId,
    requestId,
    stepId: 'validation',
    status: 'running',
    summary: 'benchmark 开始验证数据源降级链路。',
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
    summary: validation.passed ? '数据源降级链路验证通过。' : '数据源降级链路验证失败。',
    runStatus: validation.passed ? 'completed' : 'failed',
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
  const screenshotDir = path.resolve('tmp/quantpilot-benchmark-screenshots');
  await fs.mkdir(screenshotDir, { recursive: true });
  const failures = [];
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const screenshots = [];
  let accessibilityIssueCount = 0;
  let preview = null;
  let browser = null;
  const viewports = [
    { id: 'desktop', width: 1440, height: 1000 },
    { id: 'mobile', width: 390, height: 844 },
  ];

  try {
    preview = await previewManager.start(projectId);
    browser = await chromium.launch({ headless: true });
    for (const viewport of viewports) {
      const page = await browser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
      });
      const failedResources = [];
      const runtimeErrors = [];
      page.on('response', (response) => {
        const type = response.request().resourceType();
        if (response.status() >= 400 && ['document', 'script', 'stylesheet', 'font', 'image'].includes(type)) {
          failedResources.push(`${response.status()} ${type} ${response.url()}`);
        }
      });
      page.on('pageerror', (error) => runtimeErrors.push(error.message));
      try {
        const response = await page.goto(preview.url, { waitUntil: 'networkidle', timeout: 45000 });
        assertCondition(response?.ok(), `${viewport.id} 预览地址 ${preview.url} 未返回 2xx。`, failures);
        const screenshotPath = path.join(
          screenshotDir,
          `benchmark-${testCase.id}-${viewport.id}-${timestamp}.png`,
        );
        await page.screenshot({ path: screenshotPath, fullPage: true });
        screenshots.push({
          viewport: viewport.id,
          path: path.relative(process.cwd(), screenshotPath),
          width: viewport.width,
          height: viewport.height,
        });
        const info = await page.evaluate(() => {
          const accessibleName = (element) => {
            const labelledBy = element.getAttribute('aria-labelledby');
            const labelledText = labelledBy
              ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() || '').join(' ').trim()
              : '';
            return element.getAttribute('aria-label') ||
              labelledText ||
              element.getAttribute('title') ||
              element.textContent?.trim() ||
              element.querySelector('img[alt]')?.getAttribute('alt') ||
              element.querySelector('svg title')?.textContent?.trim() || '';
          };
          const controlsWithoutName = Array.from(document.querySelectorAll('button,a[href],[role="button"]'))
            .filter((element) => !accessibleName(element)).length;
          const inputsWithoutName = Array.from(document.querySelectorAll('input,select,textarea'))
            .filter((element) => {
              const id = element.getAttribute('id');
              return !element.getAttribute('aria-label') &&
                !element.getAttribute('aria-labelledby') &&
                !(id && document.querySelector(`label[for="${CSS.escape(id)}"]`));
            }).length;
          const imagesWithoutAlt = Array.from(document.querySelectorAll('img'))
            .filter((element) => !element.hasAttribute('alt')).length;
          return {
            text: document.body.innerText,
            svgCount: document.querySelectorAll('svg').length,
            rectCount: document.querySelectorAll('rect').length,
            canvasCount: document.querySelectorAll('canvas').length,
            headingCount: document.querySelectorAll('h1').length,
            horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
            accessibilityIssueCount: controlsWithoutName + inputsWithoutName + imagesWithoutAlt,
          };
        });
        for (const keyword of testCase.expectedVisualKeywords || ['QuantPilot']) {
          assertCondition(info.text.includes(keyword), `${viewport.id} 页面缺少关键词：${keyword}`, failures);
        }
        assertCondition(info.svgCount + info.canvasCount > 0 || info.rectCount >= 12, `${viewport.id} 页面缺少可识别图表元素。`, failures);
        assertCondition(!info.horizontalOverflow, `${viewport.id} 页面存在水平溢出。`, failures);
        assertCondition(info.headingCount <= 1, `${viewport.id} 页面存在 ${info.headingCount} 个 h1，应最多保留一个主标题。`, failures);
        assertCondition(info.accessibilityIssueCount === 0, `${viewport.id} 页面存在 ${info.accessibilityIssueCount} 个无可访问名称的控件或图片。`, failures);
        accessibilityIssueCount += info.accessibilityIssueCount;
        failures.push(...failedResources.map((item) => `${viewport.id} 资源加载失败：${item}`));
        failures.push(...runtimeErrors.map((item) => `${viewport.id} 页面运行时错误：${item}`));
      } finally {
        await page.close();
      }
    }

    return {
      passed: failures.length === 0,
      failures,
      screenshotPath: screenshots[0]?.path || null,
      screenshots,
      accessibilityIssueCount,
      previewUrl: preview?.url || null,
    };
  } catch (error) {
    failures.push(`视觉检查无法执行：${formatError(error)}`);
    return {
      passed: false,
      failures,
      screenshotPath: screenshots[0]?.path || null,
      screenshots,
      accessibilityIssueCount,
      previewUrl: preview?.url || null,
    };
  } finally {
    if (browser) await browser.close();
  }
}

let chatActRoute = null;

function loadChatActRoute() {
  chatActRoute ??= jiti('../../src/app/api/chat/[project_id]/act/route.ts');
  return chatActRoute;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readGenerationPrefetch(projectPath) {
  const generation = await readJson(
    path.join(projectPath, '.data-agent/generation-state.json'),
  ).catch(() => null);
  const step = Array.isArray(generation?.steps)
    ? generation.steps.find((item) => item?.id === 'data_prefetch')
    : null;
  return {
    skipped: step?.status === 'skipped',
    summary: typeof step?.summary === 'string' ? step.summary : '',
    rawFiles: Array.isArray(step?.metadata?.rawFiles) ? step.metadata.rawFiles : [],
    finalDataPath: typeof step?.metadata?.finalDataPath === 'string'
      ? step.metadata.finalDataPath
      : null,
  };
}

async function waitForAcceptedMission({ projectPath, projectId, requestId }) {
  const timeoutMs = Number.parseInt(
    process.env.QUANTPILOT_E2E_MISSION_TIMEOUT_MS || '1200000',
    10,
  );
  const deadline = Date.now() + (Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : 1_200_000);
  while (Date.now() < deadline) {
    const mission = await prisma.agentMission.findUnique({
      where: { requestId },
      include: { acceptedReceipt: true },
    });
    if (mission && ['failed', 'cancelled'].includes(mission.status)) {
      throw new Error(
        `MoAgent Mission ${mission.id} ended as ${mission.status}: ` +
        `${mission.errorCode || 'UNKNOWN'} ${mission.errorMessage || ''}`.trim(),
      );
    }
    if (mission?.status === 'completed' && mission.acceptedReceipt) {
      const generation = await readJson(
        path.join(projectPath, '.data-agent/generation-state.json'),
      ).catch(() => null);
      const request = await prisma.userRequest.findUnique({
        where: { id: requestId },
        select: { projectId: true, status: true },
      });
      if (
        generation?.status === 'completed' &&
        request?.projectId === projectId &&
        request.status === 'completed'
      ) {
        return mission;
      }
    }
    await delay(1_000);
  }
  throw new Error(`等待 MoAgent Mission acceptance 超时：${requestId}`);
}

function aggregateNumber(records, field) {
  return records.reduce((sum, record) => sum + Number(record[field] || 0), 0);
}

function toolExecutionSummary(executions) {
  const statusCount = (status) =>
    executions.filter((execution) => execution.status === status).length;
  const failed = statusCount('failed');
  const uncertain = statusCount('uncertain');
  return {
    total: executions.length,
    succeeded: statusCount('succeeded'),
    failed,
    uncertain,
    unexpectedFailureCount: failed + uncertain,
    workspaceWriteSucceeded: executions.filter((execution) =>
      execution.status === 'succeeded' && execution.effect === 'workspace_write').length,
    submitResultSucceeded: executions.filter((execution) =>
      execution.status === 'succeeded' && execution.toolName === 'submit_result').length,
    succeededToolNames: Array.from(new Set(executions
      .filter((execution) => execution.status === 'succeeded')
      .map((execution) => execution.toolName)))
      .sort(),
  };
}

function expectedExecutionLaneFailures(testCase, execution, expectedRuntime) {
  if (!testCase.expectedExecutionLane) return [];
  const rootRun = execution?.runs?.find((run) => run.requestId === execution.requestId);
  const rootToolNames = rootRun?.tools?.succeededToolNames || [];
  if (testCase.expectedExecutionLane === 'deterministic_standard') {
    return execution?.provider === 'moagent-trusted-renderer' &&
      execution?.model === 'moagent-deterministic-renderer-v1' &&
      execution?.turns === 2 &&
      execution?.usage?.totalTokens === 0 &&
      execution?.usage?.inputTokens === 0 &&
      execution?.usage?.outputTokens === 0 &&
      execution?.usage?.cachedInputTokens === 0 &&
      execution?.usage?.cacheMissInputTokens === 0 &&
      execution?.usage?.reasoningTokens === 0 &&
      rootRun?.turns === 2 &&
      rootRun?.tools?.unexpectedFailureCount === 0 &&
      rootToolNames.includes('apply_dashboard_spec') &&
      rootToolNames.includes('submit_result')
      ? []
      : ['期望 deterministic_standard 零模型 Token 路径，但实际运行身份不匹配。'];
  }
  if (testCase.expectedExecutionLane === 'model_custom') {
    return execution?.provider === expectedRuntime.provider &&
      execution?.model === expectedRuntime.model &&
      Number.isSafeInteger(rootRun?.turns) &&
      rootRun.turns > 0 &&
      rootRun.turns <= 3 &&
      Number.isSafeInteger(rootRun?.usage?.inputTokens) &&
      rootRun.usage.inputTokens >= 0 &&
      rootRun.usage.inputTokens <= 24_000 &&
      Number.isSafeInteger(rootRun?.usage?.cacheMissInputTokens) &&
      rootRun.usage.cacheMissInputTokens >= 0 &&
      rootRun.usage.cacheMissInputTokens <= 24_000 &&
      rootRun?.tools?.unexpectedFailureCount === 0 &&
      rootToolNames.includes('semantic_edit') &&
      !rootToolNames.includes('quant_api_get') &&
      !rootToolNames.includes('apply_dashboard_spec')
      ? []
      : ['期望 model_custom DeepSeek 路径，但实际运行身份不匹配。'];
  }
  return [`未知 expectedExecutionLane：${testCase.expectedExecutionLane}`];
}

function candidateSource(receipt) {
  const payload = receipt?.payload;
  return payload && typeof payload === 'object' && !Array.isArray(payload) &&
    typeof payload.source === 'string'
    ? payload.source
    : null;
}

async function collectLiveAgentExecution({ projectId, requestId, mission }) {
  const [runs, candidateReceipt] = await Promise.all([
    prisma.agentRun.findMany({
      // Root and validation-repair requests are the only physical executions
      // admitted to this Mission lineage. Do not use a process-clock lower bound
      // against database timestamps and do not aggregate unrelated project runs.
      where: {
        projectId,
        OR: [
          { requestId },
          { requestId: { startsWith: `${requestId}-validation-repair` } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: {
        toolExecutions: {
          select: {
            status: true,
            errorCode: true,
            effect: true,
            toolName: true,
          },
        },
      },
    }),
    prisma.agentEvidenceReceipt.findFirst({
      where: {
        missionId: mission.id,
        candidateVersion: mission.candidateVersion,
        receiptType: 'candidate',
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  const unique = (field) => Array.from(new Set(runs.map((run) => run[field])));
  const only = (field) => {
    const values = unique(field);
    return values.length === 1 ? values[0] : null;
  };
  const toolExecutions = runs.flatMap((run) => run.toolExecutions);
  const errorCodes = {};
  for (const execution of toolExecutions) {
    if (!execution.errorCode) continue;
    errorCodes[execution.errorCode] = (errorCodes[execution.errorCode] || 0) + 1;
  }
  const runEvidence = runs.map((run) => ({
    id: run.id,
    runInstanceId: run.runInstanceId,
    requestId: run.requestId,
    status: run.status,
    provider: run.provider,
    model: run.model,
    frameworkVersion: run.frameworkVersion,
    buildRevision: run.buildRevision,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.finishedAt?.toISOString() ?? null,
    turns: run.turnCount,
    usage: {
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      totalTokens: run.totalTokens,
      cachedInputTokens: run.cachedInputTokens,
      cacheMissInputTokens: run.cacheMissInputTokens,
      reasoningTokens: run.reasoningTokens,
    },
    tools: toolExecutionSummary(run.toolExecutions),
  }));
  const startedAt = runs.map((run) => run.startedAt)
    .filter(Boolean)
    .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
  const completedAt = runs.map((run) => run.finishedAt)
    .filter(Boolean)
    .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;

  const aggregateTools = toolExecutionSummary(toolExecutions);
  const acceptedCandidateSource =
    candidateReceipt?.sourceRunId === mission.acceptedReceipt?.sourceRunId &&
    candidateReceipt?.sourceRequestId === mission.acceptedReceipt?.sourceRequestId
      ? candidateSource(candidateReceipt)
      : null;
  return {
    executed: runs.length > 0,
    cli: 'moagent',
    provider: only('provider'),
    model: only('model'),
    requestId,
    runIds: runs.map((run) => run.id),
    runs: runEvidence,
    missionId: mission.id,
    generationId: mission.generationId,
    missionStatus: mission.status,
    candidateVersion: mission.candidateVersion,
    acceptedReceiptId: mission.acceptedReceiptId,
    acceptedReceiptHash: mission.acceptedReceipt?.receiptHash ?? null,
    acceptedReceiptType: mission.acceptedReceipt?.receiptType ?? null,
    acceptedReceiptVerdict: mission.acceptedReceipt?.verdict ?? null,
    acceptedSourceRunId: mission.acceptedReceipt?.sourceRunId ?? null,
    acceptedSourceRequestId: mission.acceptedReceipt?.sourceRequestId ?? null,
    acceptedCandidateSource,
    frameworkVersion: only('frameworkVersion'),
    buildRevision: only('buildRevision'),
    gitRevision: MOAGENT_BUILD_IDENTITY.gitRevision,
    startedAt: startedAt?.toISOString() ?? null,
    completedAt: completedAt?.toISOString() ?? null,
    turns: aggregateNumber(runs, 'turnCount'),
    usage: {
      inputTokens: aggregateNumber(runs, 'inputTokens'),
      outputTokens: aggregateNumber(runs, 'outputTokens'),
      totalTokens: aggregateNumber(runs, 'totalTokens'),
      cachedInputTokens: aggregateNumber(runs, 'cachedInputTokens'),
      cacheMissInputTokens: aggregateNumber(runs, 'cacheMissInputTokens'),
      reasoningTokens: aggregateNumber(runs, 'reasoningTokens'),
    },
    tools: {
      ...aggregateTools,
      errorCodes,
    },
  };
}

async function runLiveProductE2eCase(testCase, options) {
  const startedAt = Date.now();
  const projectId = `benchmark-${testCase.id}`;
  const projectPath = path.join(PROJECTS_DIR, projectId);
  const requestId = `${projectId}-run`;
  const expectedRuntime = modelRuntime(options.model);
  await ensureBenchmarkProject({
    projectId,
    projectPath,
    testCase,
    selectedModel: expectedRuntime.model,
  });

  const { POST } = loadChatActRoute();
  const response = await POST(new NextRequest(
    `http://127.0.0.1/api/chat/${encodeURIComponent(projectId)}/act`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        instruction: testCase.question,
        displayInstruction: testCase.question,
        requestId,
        selectedModel: options.model,
        quantCapabilityId: testCase.capabilityId,
        quantCapabilitySource: 'manual',
        isInitialPrompt: true,
      }),
    },
  ), { params: Promise.resolve({ project_id: projectId }) });
  const actResult = await response.json();
  if (!response.ok || actResult?.success !== true || !actResult?.missionId) {
    throw new Error(
      `正式 /act 链路启动失败（HTTP ${response.status}）：${JSON.stringify(actResult)}`,
    );
  }

  const mission = await waitForAcceptedMission({ projectPath, projectId, requestId });
  const [plan, prefetch, validation] = await Promise.all([
    readQuantRunPlan(projectPath),
    readGenerationPrefetch(projectPath),
    readQuantValidationReport(projectPath),
  ]);
  if (!plan || !validation) {
    throw new Error('Mission completed without its run plan or authoritative validation report.');
  }
  const agentExecution = await collectLiveAgentExecution({
    projectId,
    requestId,
    mission,
  });
  const artifactInspection = await inspectArtifacts({ projectPath, testCase, prefetch });
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
    ...expectedExecutionLaneFailures(testCase, agentExecution, expectedRuntime),
    ...(validation.passed
      ? []
      : validation.checks
        .filter((check) => check.status === 'failed')
        .map(formatValidationFailure)),
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
    repairAttempts: Number(mission.candidateVersion || 1) - 1,
    platformRepairCount: 0,
    requestId,
    agentExecuted: agentExecution.executed,
    agentExecution,
    missionAcceptance: {
      missionId: mission.id,
      generationId: mission.generationId,
      status: mission.status,
      candidateVersion: mission.candidateVersion,
      acceptedReceiptId: mission.acceptedReceiptId,
      acceptedReceiptHash: mission.acceptedReceipt.receiptHash,
      acceptedReceiptType: mission.acceptedReceipt.receiptType,
      acceptedReceiptVerdict: mission.acceptedReceipt.verdict,
      acceptedSourceRunId: mission.acceptedReceipt.sourceRunId,
      acceptedSourceRequestId: mission.acceptedReceipt.sourceRequestId,
      acceptedCandidateSource: agentExecution.acceptedCandidateSource,
    },
    validation: {
      status: validation.status,
      checks: validation.checks.map((check) => ({
        id: check.id,
        status: check.status,
        summary: check.summary,
        details: check.details ?? null,
        metadata: check.metadata ?? null,
      })),
    },
    executionMode: 'e2e',
  };
}

async function runCase(testCase, options) {
  if (options.mode === 'e2e' || options.mode === 'product-control') {
    return runLiveProductE2eCase(testCase, options);
  }
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
  if (testCase.type === 'renderer_capability_contract') {
    return runRendererCapabilityContractCase(testCase);
  }
  if (testCase.expectClarification) {
    return runClarificationCase(testCase);
  }

  const startedAt = Date.now();
  const projectId = `benchmark-${testCase.id}`;
  const projectPath = path.join(PROJECTS_DIR, projectId);
  const requestId = `${projectId}-run`;
  const agentExecution = {
    executed: false,
    provider: options.mode === 'e2e' ? modelRuntime(options.model).provider : null,
    model: options.mode === 'e2e' ? DEFAULT_MODEL : null,
    requestId,
    startedAt: null,
    completedAt: null,
  };

  await ensureBenchmarkProject({ projectId, projectPath, testCase });
  await startQuantGenerationRun({
    projectPath,
    projectId,
    requestId,
    instruction: testCase.question,
    cliPreference: 'benchmark',
    selectedModel: DEFAULT_MODEL,
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
    capabilitySource: 'benchmark',
    hasImageAttachments: Boolean(testCase.imageAttachment),
    queryRewrite: await replayContractQueryRewrite({
      testCase,
      instruction: testCase.question,
      projectId,
    }),
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
  if (options.mode === 'e2e') {
    await updateQuantGenerationStep({
      projectPath,
      projectId,
      requestId,
      stepId: 'agent_execution',
      status: 'running',
      summary: '真实 E2E benchmark 正在调用本地 Qwen 生成看板。',
      metadata: {
        deterministicDashboard: false,
        model: DEFAULT_MODEL,
      },
    });
    agentExecution.startedAt = new Date().toISOString();
    await initializeNextJsProject(
      projectId,
      projectPath,
      testCase.question,
      DEFAULT_MODEL,
      requestId,
    );
    agentExecution.executed = true;
    agentExecution.completedAt = new Date().toISOString();
    await updateQuantGenerationStep({
      projectPath,
      projectId,
      requestId,
      stepId: 'agent_execution',
      status: 'success',
      summary: '本地 Qwen 真实生成执行完成。',
      metadata: {
        deterministicDashboard: false,
        model: DEFAULT_MODEL,
      },
    });
  } else {
    await ensureQuantDashboardTemplate(projectPath);
    await updateQuantGenerationStep({
      projectPath,
      projectId,
      requestId,
      stepId: 'agent_execution',
      status: 'skipped',
      summary: '契约 benchmark 使用平台标准模板，不声明为模型生成结果。',
      metadata: {
        deterministicDashboard: true,
        modelExecuted: false,
      },
    });
  }
  await updateQuantGenerationStep({
    projectPath,
    projectId,
    requestId,
    stepId: 'validation',
    status: 'running',
    summary: 'benchmark 开始自动验证。',
  });
  let validation = await validateQuantProject({
    projectId,
    projectPath,
    requestId,
    cliSource: 'benchmark',
  });
  let repairAttempts = 0;
  let platformRepairCount = 0;

  if (options.mode === 'e2e' && !validation.passed) {
    const repairResult = await runBenchmarkRepairLoop({
      projectPath,
      projectId,
      parentRequestId: requestId,
      originalInstruction: testCase.question,
      initialValidation: validation,
      applyRepair: async ({ instruction, repairRequestId }) => {
        await applyChanges(
          projectId,
          projectPath,
          instruction,
          DEFAULT_MODEL,
          repairRequestId,
        );
      },
      validate: (parentRequestId) => validateQuantProject({
        projectId,
        projectPath,
        requestId: parentRequestId,
        cliSource: 'benchmark',
      }),
    });
    validation = repairResult.validation;
    repairAttempts = repairResult.repairAttempts;
    platformRepairCount = repairResult.platformRepairCount;
  }

  const artifactInspection = await inspectArtifacts({ projectPath, testCase, prefetch });
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
    ...(validation.passed ? [] : validation.checks.filter((check) => check.status === 'failed').map(formatValidationFailure)),
  ];
  const benchmarkPassed = failures.length === 0;
  await updateQuantGenerationStep({
    projectPath,
    projectId,
    requestId,
    stepId: repairAttempts > 0 ? 'final_validation' : 'validation',
    status: benchmarkPassed ? 'success' : 'failed',
    summary: benchmarkPassed
      ? repairAttempts > 0
        ? `benchmark 经 ${repairAttempts} 次自动修复后完整验收通过。`
        : 'benchmark 完整验收通过。'
      : `benchmark 完整验收失败，共 ${failures.length} 项问题。`,
    runStatus: benchmarkPassed ? 'completed' : 'failed',
  });

  return {
    id: testCase.id,
    name: testCase.name,
    question: testCase.question,
    projectId,
    projectPath,
    durationMs: Date.now() - startedAt,
    passed: benchmarkPassed,
    failures,
    symbols: plan.symbols,
    prefetch,
    artifacts: artifactInspection,
    visualCheck,
    eventAudit,
    repairAttempts,
    platformRepairCount,
    requestId,
    agentExecuted: agentExecution.executed,
    agentExecution,
    validation: {
      status: validation.status,
      checks: validation.checks.map((check) => ({
        id: check.id,
        status: check.status,
        summary: check.summary,
        details: check.details ?? null,
        metadata: check.metadata ?? null,
      })),
    },
    executionMode: options.mode,
  };
}

async function cleanupBenchmarkProject(result) {
  const targets = Array.isArray(result?.stability?.attempts)
    ? result.stability.attempts
      .map((attempt) => ({ projectId: attempt.projectId, projectPath: attempt.projectPath }))
      .filter((attempt) => attempt.projectId && attempt.projectPath)
    : [{ projectId: result.projectId, projectPath: result.projectPath }];
  for (const target of targets) {
    await previewManager.stop(target.projectId);
    await prisma.project.deleteMany({ where: { id: target.projectId } });
    await fs.rm(target.projectPath, { recursive: true, force: true });
  }
}

async function applySelectedEvaluator(testCase, result, options) {
  const evaluator = getEvalEvaluatorDefinition(options.evaluatorId);
  const evaluationMode = options.mode === 'product-control' ? 'e2e' : options.mode;
  result.traceDiagnostics = buildEvalTraceDiagnostics(result, evaluationMode);
  let semanticReview = null;
  let reviewError = null;
  if (evaluator.requiresSemanticReview && result.passed === true && result.projectPath) {
    try {
      semanticReview = await reviewAgentWorkspace({
        projectPath: result.projectPath,
        question: testCase.question,
        testCase,
        deterministicResult: {
          passed: result.passed,
          failures: result.failures,
          validation: result.validation,
          artifacts: result.artifacts,
          eventAudit: result.eventAudit,
          visualCheck: result.visualCheck,
          traceDiagnostics: result.traceDiagnostics,
        },
        model: options.model,
      });
    } catch (error) {
      reviewError = `语义审阅失败：${formatError(error)}`;
    }
  }
  const firstPassPassed = result.passed === true && Number(result.repairAttempts || 0) === 0;
  const evaluation = applyEvalEvaluator({
    evaluatorId: evaluator.id,
    mode: evaluationMode,
    result,
    semanticReview,
  });
  const evaluatorFailures = evaluation.checks
    .filter((check) => check.status === 'failed')
    .map((check) => `${check.id}: ${check.summary}`);
  result.firstPassPassed = firstPassPassed && evaluation.passed;
  result.finalPassed = evaluation.passed;
  result.evaluation = evaluation;
  result.score = evaluation.score;
  result.passed = evaluation.passed;
  result.failures = Array.from(new Set([
    ...(result.failures || []),
    ...(reviewError ? [reviewError] : []),
    ...evaluatorFailures,
  ]));
  return result;
}

async function runBenchmarkCase(testCase, options) {
  console.log(`\n[QuantBenchmark:${options.mode}] ${testCase.id} - ${testCase.name}`);
  const startedAt = Date.now();
  let result;
  try {
    result = await runCase(testCase, options);
  } catch (error) {
    const expectedRuntime = modelRuntime(options.model);
    const projectId = `benchmark-${testCase.id}`;
    const projectPath = path.join(PROJECTS_DIR, projectId);
    const parentRequestId = `${projectId}-run`;
    const failedState = await failBenchmarkGenerationRun({
      projectPath,
      projectId,
      parentRequestId,
      error,
    }).catch(() => null);
    result = {
      id: testCase.id,
      name: testCase.name,
      question: testCase.question,
      projectId,
      projectPath,
      durationMs: Date.now() - startedAt,
      passed: false,
      failures: [formatError(error)],
      symbols: [],
      prefetch: null,
      artifacts: null,
      eventAudit: null,
      validation: null,
      executionMode: options.mode,
      requestId: parentRequestId,
      repairAttempts: failedState?.repairAttemptCount ?? 0,
      platformRepairCount: 0,
      agentExecuted: false,
      agentExecution: {
        executed: false,
        provider: options.mode === 'e2e' ? expectedRuntime.provider : null,
        model: options.mode === 'e2e' ? expectedRuntime.model : null,
        requestId: parentRequestId,
        startedAt: null,
        completedAt: null,
      },
    };
    await previewManager.stop(projectId).catch(() => {});
  }
  result.executionMode = options.mode;
  result.agentExecuted = result.agentExecution?.executed === true;
  const expectedRuntime = modelRuntime(options.model);
  if (options.mode === 'e2e' && !isE2eAgentExecutionAttested(result, expectedRuntime)) {
    result.passed = false;
    result.failures = Array.from(new Set([
      ...(result.failures || []),
      '该 E2E case 未实际执行 MoAgent，不能作为真实生成通过证据。',
    ]));
  }
  result = await applySelectedEvaluator(testCase, result, options);
  console.log(`[QuantBenchmark] ${testCase.id} ${result.passed ? 'PASS' : 'FAIL'}`);
  if (!result.passed) {
    result.failures.forEach((failure) => console.log(`  - ${failure}`));
    emitGithubError(
      `Quant contract failed: ${testCase.id}`,
      result.failures.join('\n'),
    );
  }
  return result;
}

async function runBenchmarkCaseWithRepeats(testCase, options) {
  const attempts = [];
  for (let attempt = 1; attempt <= options.repeat; attempt += 1) {
    const physicalCase = attempt === 1
      ? testCase
      : { ...testCase, id: `${testCase.id}--attempt-${attempt}` };
    const result = await runBenchmarkCase(physicalCase, options);
    attempts.push({ attempt, result });
  }
  const primary = attempts[0].result;
  const passedAttempts = attempts.filter((item) => item.result.passed).length;
  primary.id = testCase.id;
  primary.name = testCase.name;
  primary.question = testCase.question;
  primary.durationMs = attempts.reduce((total, item) => total + Number(item.result.durationMs || 0), 0);
  primary.stability = {
    passed: passedAttempts === attempts.length,
    repeatCount: attempts.length,
    passedAttempts,
    passRate: Math.round((passedAttempts / attempts.length) * 100),
    flaky: passedAttempts > 0 && passedAttempts < attempts.length,
    attempts: attempts.map(({ attempt, result }) => ({
      attempt,
      passed: result.passed,
      firstPassPassed: result.firstPassPassed,
      score: result.score,
      durationMs: result.durationMs,
      repairAttempts: Number(result.repairAttempts || 0),
      projectId: result.projectId || null,
      projectPath: result.projectPath || null,
      requestId: result.requestId || null,
      failures: result.failures || [],
      agentAttested: options.mode === 'e2e'
        ? isE2eAgentExecutionAttested(result, modelRuntime(options.model))
        : null,
      evidence: options.mode === 'e2e' ? { ...result } : undefined,
    })),
  };
  return primary;
}

async function runCasesWithConcurrency(cases, concurrency, options) {
  const results = new Array(cases.length);
  let nextIndex = 0;
  const workerCount = Math.min(cases.length, Math.max(1, concurrency));

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < cases.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await runBenchmarkCaseWithRepeats(cases[currentIndex], options);
    }
  }));

  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const benchmarkStartedAt = new Date().toISOString();
  const allCases = await readJson(args.casesFile);
  if (!Array.isArray(allCases)) throw new Error('评测数据集必须是 case 数组');
  const datasetRegistry = await readJson(DATASET_REGISTRY_PATH);
  const snapshotManifest = await readJson(SNAPSHOT_MANIFEST_PATH);
  const allCaseIds = new Set(allCases.map((testCase) => testCase.id));
  const unknownSelectedIds = Array.from(args.selected).filter((id) => !allCaseIds.has(id));
  if (unknownSelectedIds.length > 0) {
    throw new Error(`包含未知 benchmark case：${unknownSelectedIds.join(', ')}`);
  }
  const e2eSuite = args.mode === 'e2e' && args.datasetVisibility === 'public'
    ? loadQuantE2eSuite({
        root: process.cwd(),
        suitePath: E2E_SUITE_PATH,
        cases: allCases,
        requireReleaseCoverage: true,
      })
    : null;
  const formalSuiteRun = Boolean(
    e2eSuite && args.selected.size === 0 && args.limit === null,
  );
  let cases = allCases;
  if (args.selected.size > 0) {
    cases = cases.filter((testCase) => args.selected.has(testCase.id));
  } else if (e2eSuite) {
    const suiteIds = new Set(e2eSuite.caseIds);
    cases = cases.filter((testCase) => suiteIds.has(testCase.id));
  }
  if (args.limit !== null) {
    cases = cases.slice(0, args.limit);
  }

  if (cases.length === 0) {
    throw new Error('没有匹配的 benchmark case。');
  }

  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const evaluatorDefinition = getEvalEvaluatorDefinition(args.evaluatorId);
  console.log(`[QuantBenchmark] mode=${args.mode} evaluator=${args.evaluatorId}@${evaluatorDefinition.version} concurrency=${args.concurrency} repeat=${args.repeat} cases=${cases.length}`);
  const productControlsStartedAt = formalSuiteRun ? new Date().toISOString() : null;
  const productControlCases = formalSuiteRun
    ? e2eSuite.productControlCaseIds.map((id) => e2eSuite.caseById.get(id))
    : [];
  const productControlResults = productControlCases.length > 0
    ? await runCasesWithConcurrency(
        productControlCases,
        1,
        { ...args, mode: 'product-control', repeat: 1 },
      )
    : [];
  const productControlsFinishedAt = formalSuiteRun ? new Date().toISOString() : null;
  const results = await runCasesWithConcurrency(cases, args.concurrency, args);

  const coverage = buildCoverageSummary(cases, results);
  const qualitySummary = buildEvalQualitySummary(results, args.repeat);
  const selectedCaseIds = new Set(cases.map((testCase) => testCase.id));
  const selectedDataSnapshots = (snapshotManifest.snapshots || [])
    .filter((snapshot) => selectedCaseIds.has(snapshot.caseId))
    .map((snapshot) => ({
      caseId: snapshot.caseId,
      id: snapshot.id,
      asOf: snapshot.asOf,
      payloadSha256: snapshot.payloadSha256,
    }));
  const reportResults = args.datasetVisibility === 'public'
    ? results
    : results.map((result) => {
        const redacted = structuredClone(result);
        const testCase = cases.find((item) => item.id === result.id);
        const questionEvidence = `[redacted:${normalizedPromptHash(testCase?.question || result.question || '')}]`;
        redacted.question = questionEvidence;
        for (const attempt of redacted.stability?.attempts || []) {
          if (attempt.evidence && typeof attempt.evidence === 'object') {
            attempt.evidence.question = questionEvidence;
          }
        }
        return redacted;
      });
  const expectedRuntime = modelRuntime(args.model);
  const agentExecutionSummary = summarizeE2eAgentExecution(results, expectedRuntime);
  const e2eQuality = args.mode === 'e2e'
    ? evaluateMoAgentE2eQuality(results, DEFAULT_MOAGENT_E2E_QUALITY_THRESHOLDS)
    : null;
  const benchmarkFinishedAt = new Date().toISOString();
  const reportCreatedAt = new Date().toISOString();
  let releaseControls = null;
  if (formalSuiteRun) {
    releaseControls = {
      schemaVersion: 1,
      suiteId: e2eSuite.id,
      suiteSchemaVersion: e2eSuite.schemaVersion,
      frameworkVersion: MOAGENT_FRAMEWORK_VERSION,
      buildRevision: MOAGENT_BUILD_IDENTITY.buildRevision,
      gitRevision: MOAGENT_BUILD_IDENTITY.gitRevision,
      startedAt: productControlsStartedAt,
      finishedAt: productControlsFinishedAt,
      caseIds: e2eSuite.productControlCaseIds,
      runtimeTestFiles: e2eSuite.runtimeTestFiles,
      passed: productControlResults.every((result) => result.passed),
      results: productControlResults,
    };
    const productControlAttestation = attestProductControlEvidence(releaseControls, {
      suite: e2eSuite,
      frameworkVersion: MOAGENT_FRAMEWORK_VERSION,
      buildRevision: MOAGENT_BUILD_IDENTITY.buildRevision,
      gitRevision: MOAGENT_BUILD_IDENTITY.gitRevision,
    });
    releaseControls.attestation = {
      schemaVersion: 1,
      verifiedAt: reportCreatedAt,
      ...productControlAttestation,
    };
  }
  const report = {
    schemaVersion: EVAL_REPORT_SCHEMA_VERSION,
    createdAt: reportCreatedAt,
    metadata: {
      trigger: args.trigger,
      startedAt: benchmarkStartedAt,
      finishedAt: benchmarkFinishedAt,
      command: reportCommand(process.argv.slice(2), args.datasetVisibility),
      evaluator: {
        id: args.evaluatorId,
        version: evaluatorDefinition.version,
        rubricVersion: evaluatorDefinition.rubricVersion,
        concurrency: args.concurrency,
      },
      runtime: {
        cli: args.cli,
        provider: args.mode === 'e2e' ? expectedRuntime.provider : null,
        model: args.mode === 'e2e' ? args.model : null,
        configuredModel: args.model,
        agentExecuted: args.mode === 'e2e' && agentExecutionSummary.agentExecuted,
        executedCaseCount: agentExecutionSummary.executedCaseCount,
        unattestedCaseIds: args.mode === 'e2e' ? agentExecutionSummary.unattestedCaseIds : [],
        frameworkVersion: MOAGENT_FRAMEWORK_VERSION,
        buildRevision: MOAGENT_BUILD_IDENTITY.buildRevision,
        reasoningEffort: null,
      },
      suite: {
        mode: args.mode,
        label: args.mode === 'e2e' ? `${args.model} 真实生成 E2E` : '确定性产物契约',
        executionClass: args.mode === 'e2e'
          ? 'live_mission_e2e'
          : 'deterministic_contract',
        ...(e2eSuite
          ? {
              id: e2eSuite.id,
              schemaVersion: e2eSuite.schemaVersion,
              productControlCaseIds: e2eSuite.productControlCaseIds,
              scenarios: e2eSuite.scenarios,
            }
          : {}),
      },
      dataset: {
        schemaVersion: 1,
        visibility: args.datasetVisibility,
        promptsRedacted: args.datasetVisibility !== 'public',
        sourceIdentitySha256: sha256(
          args.datasetVisibility === 'public' ? 'benchmarks/quantpilot/cases.json' : args.datasetVisibility,
        ),
      },
      provenance: {
        gitCommit: MOAGENT_BUILD_IDENTITY.gitRevision,
        gitRevision: MOAGENT_BUILD_IDENTITY.gitRevision,
        buildRevision: MOAGENT_BUILD_IDENTITY.buildRevision,
        frameworkVersion: MOAGENT_FRAMEWORK_VERSION,
        casesSha256: sha256(JSON.stringify(cases)),
        promptsSha256: sha256(cases.map((testCase) => testCase.question || '').join('\n')),
        datasetRegistrySha256: evalSnapshotPayloadSha256(datasetRegistry),
        snapshotManifestSha256: evalSnapshotPayloadSha256(snapshotManifest),
      },
      dataSnapshots: {
        schemaVersion: 1,
        manifestId: snapshotManifest.id,
        manifestVersion: snapshotManifest.version,
        selected: selectedDataSnapshots,
      },
      e2eQuality,
      selection: {
        selectedCases: Array.from(args.selected),
        limit: args.limit,
        keepProjects: args.keepProjects,
        caseCount: cases.length,
        concurrency: args.concurrency,
        repeat: args.repeat,
      },
      retention: {
        databaseEvidenceRetained: args.mode === 'e2e',
        workspaceRetained: args.mode === 'e2e' || args.keepProjects,
      },
      ...(releaseControls ? { releaseControls } : {}),
      skillLockSnapshot: await readSkillLockSnapshot(),
    },
    passed: results.every((result) => result.passed) &&
      qualitySummary.stability.passRate === 100 &&
      (e2eQuality?.passed ?? true),
    total: reportResults.length,
    passedCount: reportResults.filter((result) => result.passed).length,
    failedCount: reportResults.filter((result) => !result.passed).length,
    coverage,
    qualitySummary,
    e2eQuality,
    results: reportResults,
  };

  const inProcessAttestation = attestEvalReport(report, {
    mode: args.mode,
    expectedCaseIds: cases.map((testCase) => testCase.id),
    expectedCasesSha256: report.metadata.provenance.casesSha256,
    expectedPromptsSha256: report.metadata.provenance.promptsSha256,
    expectedDatasetRegistrySha256: report.metadata.provenance.datasetRegistrySha256,
    expectedSnapshotManifestSha256: report.metadata.provenance.snapshotManifestSha256,
    expectedDataSnapshots: selectedDataSnapshots,
    expectedDatasetVisibility: args.datasetVisibility,
    expectedRuntimeProvider: expectedRuntime.provider,
    expectedRuntimeModel: expectedRuntime.model,
    expectedResultQuestions: Object.fromEntries(cases.map((testCase) => [
      testCase.id,
      args.datasetVisibility === 'public'
        ? testCase.question
        : `[redacted:${normalizedPromptHash(testCase.question || '')}]`,
    ])),
    frameworkVersion: MOAGENT_FRAMEWORK_VERSION,
    buildRevision: MOAGENT_BUILD_IDENTITY.buildRevision,
    gitRevision: MOAGENT_BUILD_IDENTITY.gitRevision,
    qualityThresholds: DEFAULT_MOAGENT_E2E_QUALITY_THRESHOLDS,
    now: new Date(reportCreatedAt),
  });
  report.attestation = {
    schemaVersion: 1,
    verifiedAt: reportCreatedAt,
    passed: inProcessAttestation.passed,
    problems: inProcessAttestation.problems,
  };
  if (!inProcessAttestation.passed) report.passed = false;
  report.releasePassed = formalSuiteRun
    ? report.passed && releaseControls?.attestation?.passed === true
    : null;

  const reportPath = path.join(REPORTS_DIR, `report-${Date.now()}.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  // E2E evidence remains queryable for the subsequent CI gate. A later run's
  // deterministic project bootstrap deletes its own prior lineage. Contract
  // fixtures do not carry durable AgentRun/Mission evidence and may be removed.
  if (args.mode === 'contract' && !args.keepProjects) {
    for (const result of results) {
      await cleanupBenchmarkProject(result);
    }
  }
  console.log(`\n[QuantBenchmark] report: ${path.relative(process.cwd(), reportPath)}`);
  console.log(`[QuantBenchmark] ${args.mode} ${report.passed ? 'ALL PASSED' : 'FAILED'} (${report.passedCount}/${report.total})`);
  console.log(`[QuantBenchmark] capabilities: ${Object.keys(coverage.byCapability).join(', ')}`);
  console.log(`[QuantBenchmark] coverage tags: ${Object.keys(coverage.byTag).length}`);
  console.log(
    `[QuantBenchmark] quality first/final=${qualitySummary.firstPassRate}%/` +
    `${qualitySummary.finalPassRate}% repair=${qualitySummary.repairRate}% ` +
    `stability=${qualitySummary.stability.passRate}% score=${qualitySummary.averageScore}`,
  );
  if (e2eQuality) {
    const quality = summarizeMoAgentE2eQuality(results);
    console.log(
      `[QuantBenchmark] MoAgent quality turns(avg/max)=` +
      `${quality.turns.average}/${quality.turns.max.value} ` +
      `cacheMiss(avg/max)=${quality.cacheMissInputTokens.average}/` +
      `${quality.cacheMissInputTokens.max.value} ` +
      `unexpectedToolFailures=${quality.tools.unexpectedFailureCount}`,
    );
    for (const problem of e2eQuality.problems) {
      console.log(`[QuantBenchmark] quality gate: ${problem}`);
    }
  }
  if (args.mode === 'e2e') {
    console.log('[QuantBenchmark] E2E AgentRun/Mission evidence retained for the external gate.');
    if (formalSuiteRun) {
      console.log(
        `[QuantBenchmark] product controls ` +
        `${releaseControls.attestation.passed ? 'PASS' : 'FAIL'} ` +
        `(${productControlResults.filter((result) => result.passed).length}/${productControlResults.length})`,
      );
      for (const problem of releaseControls.attestation.problems) {
        console.log(`[QuantBenchmark] product control attestation: ${problem}`);
      }
    }
  } else if (!args.keepProjects) {
    console.log('[QuantBenchmark] 临时 benchmark 项目已清理。使用 --keep-projects 可保留项目目录。');
  }
  for (const problem of inProcessAttestation.problems) {
    console.log(`[QuantBenchmark] evidence attestation: ${problem}`);
    emitGithubError('Quant evidence attestation failed', problem);
  }

  if (!report.passed || (formalSuiteRun && report.releasePassed !== true)) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('[QuantBenchmark] failed:', error);
    emitGithubError('Quant benchmark runner failed', formatError(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
