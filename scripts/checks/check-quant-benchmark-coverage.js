#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { loadQuantE2eSuite } = require('./quant-e2e-suite');

const CASES_PATH = path.resolve('benchmarks/quantpilot/cases.json');
const CASE_COVERAGE_LEVELS = new Set(['routing', 'contract']);
const ORACLE_TARGETS = new Set(['finalData', 'sources', 'quality', 'page']);
const ORACLE_OPERATORS = new Set([
  'exists', 'not_exists', 'equals', 'not_equals', 'gte', 'lte', 'between',
  'contains', 'not_contains', 'matches', 'not_matches', 'length_gte', 'length_lte',
]);

function fail(message, details = []) {
  console.error(`[benchmark-coverage] failed: ${message}`);
  for (const detail of details) {
    console.error(`- ${detail}`);
  }
  process.exitCode = 1;
}

function caseTags(testCase) {
  const tags = new Set();
  tags.add(testCase.capabilityId || 'unknown_capability');
  tags.add(testCase.type || (testCase.expectClarification ? 'clarification_required' : 'generated_project'));
  if (testCase.expectedAssetType) tags.add(`asset:${testCase.expectedAssetType}`);
  if (testCase.expectedTemplateId) tags.add(`template:${testCase.expectedTemplateId}`);
  if (testCase.expectedVariantId) tags.add(`variant:${testCase.expectedVariantId}`);
  if (testCase.expectClarification) tags.add('intent:clarification_required');
  if (testCase.expectClarification === false) tags.add('intent:no_false_clarification');
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
  return tags;
}

function main() {
  const cases = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
  const ids = new Set();
  const duplicateIds = [];
  const capabilities = new Set();
  const routingCapabilities = new Set();
  const productionCapabilities = new Set();
  const tags = new Set();
  const schemaProblems = [];

  for (const testCase of cases) {
    if (!testCase.id || !testCase.name || !testCase.question || !testCase.capabilityId) {
      schemaProblems.push(`${testCase.id || '<missing-id>'} 缺少 id/name/question/capabilityId。`);
    }
    if (ids.has(testCase.id)) {
      duplicateIds.push(testCase.id);
    }
    ids.add(testCase.id);
    capabilities.add(testCase.capabilityId);
    if (testCase.productionSupported === true) productionCapabilities.add(testCase.capabilityId);
    if (testCase.productionSupported !== undefined && typeof testCase.productionSupported !== 'boolean') {
      schemaProblems.push(`${testCase.id} 的 productionSupported 必须是 boolean。`);
    }
    if (testCase.coverageLevel !== undefined && !CASE_COVERAGE_LEVELS.has(testCase.coverageLevel)) {
      schemaProblems.push(`${testCase.id} 的 coverageLevel 无效：${testCase.coverageLevel}`);
    }
    if (testCase.type === 'renderer_capability_contract' && testCase.productionSupported === true) {
      schemaProblems.push(`${testCase.id} 是 routing-only renderer contract，不能声明 productionSupported。`);
    }
    if (testCase.type === 'renderer_capability_contract') {
      routingCapabilities.add(testCase.capabilityId);
    }
    for (const expectation of testCase.selectionExpectations || []) {
      if (expectation.capabilityId) routingCapabilities.add(expectation.capabilityId);
    }
    const oracleIds = new Set();
    for (const assertion of testCase.oracleAssertions || []) {
      if (!assertion.id || !assertion.target || !assertion.operator) {
        schemaProblems.push(`${testCase.id} 的 oracleAssertions 必须包含 id/target/operator。`);
      }
      if (!ORACLE_TARGETS.has(assertion.target)) {
        schemaProblems.push(`${testCase.id}/${assertion.id} 的 oracle target 无效：${assertion.target}`);
      }
      if (!ORACLE_OPERATORS.has(assertion.operator)) {
        schemaProblems.push(`${testCase.id}/${assertion.id} 的 oracle operator 无效：${assertion.operator}`);
      }
      if (assertion.severity !== undefined && !['error', 'warning'].includes(assertion.severity)) {
        schemaProblems.push(`${testCase.id}/${assertion.id} 的 severity 必须是 error 或 warning。`);
      }
      if (assertion.path !== undefined && typeof assertion.path !== 'string') {
        schemaProblems.push(`${testCase.id}/${assertion.id} 的 path 必须是字符串。`);
      }
      if (assertion.operator === 'between' &&
        (!Number.isFinite(assertion.min) || !Number.isFinite(assertion.max) || assertion.min > assertion.max)) {
        schemaProblems.push(`${testCase.id}/${assertion.id} 的 between 必须声明有效 min/max。`);
      }
      if (!['exists', 'not_exists', 'between'].includes(assertion.operator) &&
        assertion.value === undefined) {
        schemaProblems.push(`${testCase.id}/${assertion.id} 的 ${assertion.operator} 必须声明 value。`);
      }
      if (oracleIds.has(assertion.id)) {
        schemaProblems.push(`${testCase.id} 包含重复 oracle id：${assertion.id}`);
      }
      oracleIds.add(assertion.id);
    }
    if (testCase.safetyTags !== undefined &&
      (!Array.isArray(testCase.safetyTags) || testCase.safetyTags.some((tag) => typeof tag !== 'string' || !tag.trim()))) {
      schemaProblems.push(`${testCase.id} 的 safetyTags 必须是非空字符串数组。`);
    }
    if (testCase.productionSupported === true &&
      (!Array.isArray(testCase.oracleAssertions) || testCase.oracleAssertions.length === 0)) {
      schemaProblems.push(`${testCase.id} 声明 productionSupported 时必须提供 oracleAssertions。`);
    }
    if (testCase.productionSupported === true &&
      (!Array.isArray(testCase.safetyTags) || testCase.safetyTags.length === 0)) {
      schemaProblems.push(`${testCase.id} 声明 productionSupported 时必须提供 safetyTags。`);
    }
    for (const tag of caseTags(testCase)) {
      tags.add(tag);
    }
  }

  const requiredCapabilities = [
    'fundamental_analysis',
    'technical_analysis',
    'backtest_review',
    'asset_comparison',
    'portfolio_risk',
    'stock_diagnosis',
  ];
  const requiredRoutingCapabilities = ['sector_rotation', 'strategy_research'];
  const requiredProductionCapabilities = [...requiredCapabilities];
  const requiredTags = [
    'asset:stock',
    'asset:index',
    'asset:etf',
    'template:stock-selection',
    'template:holding-analysis',
    'intent:clarification_required',
    'intent:clarification_continuation',
    'intent:no_false_clarification',
    'input:image_attachment',
    'evidence:image_extraction',
    'visual:playwright',
    'runtime:deepseek_v4_flash',
    'validation:repair_plan',
    'data:source_degradation',
    'analysis:backtest',
    'analysis:portfolio',
    'analysis:selection',
    'data:multi_symbol',
    'dashboard:renderer_capability',
    'lane:deterministic_standard',
    'lane:model_custom',
    'visual:no-card-workbench',
    'variant:sector-capital-flow-board',
    'variant:strategy-signal-lab',
  ];

  const missingCapabilities = requiredCapabilities.filter((item) => !capabilities.has(item));
  const missingRoutingCapabilities = requiredRoutingCapabilities.filter((item) => !routingCapabilities.has(item));
  const missingProductionCapabilities = requiredProductionCapabilities.filter((item) => !productionCapabilities.has(item));
  const missingTags = requiredTags.filter((item) => !tags.has(item));
  const problems = [
    ...schemaProblems,
    ...duplicateIds.map((id) => `重复用例 id：${id}`),
    ...missingCapabilities.map((item) => `缺少能力覆盖：${item}`),
    ...missingRoutingCapabilities.map((item) => `缺少路由覆盖：${item}`),
    ...missingProductionCapabilities.map((item) => `缺少明确产品支持声明：${item}`),
    ...missingTags.map((item) => `缺少覆盖标签：${item}`),
  ];

  if (problems.length > 0) {
    fail('量化 benchmark 覆盖不足。', problems);
    return;
  }

  try {
    const e2eSuite = loadQuantE2eSuite({
      root: process.cwd(),
      cases,
      requireReleaseCoverage: true,
    });
    const liveCapabilities = new Set(
      e2eSuite.caseIds.map((id) => e2eSuite.caseById.get(id)?.capabilityId).filter(Boolean),
    );
    const requiredLiveCapabilities = [
      'fundamental_analysis',
      'technical_analysis',
      'portfolio_risk',
      'stock_diagnosis',
    ];
    const missingLiveCapabilities = requiredLiveCapabilities.filter((item) => !liveCapabilities.has(item));
    if (missingLiveCapabilities.length > 0) {
      fail('真实 E2E 能力覆盖不足。', missingLiveCapabilities.map((item) => `缺少 live E2E：${item}`));
      return;
    }
    console.log(
      `[benchmark-coverage] e2e=${e2eSuite.id} live-model=${e2eSuite.caseIds.length} ` +
      `live-capabilities=${liveCapabilities.size} product-controls=${e2eSuite.productControlCaseIds.length} ` +
      `runtime-tests=${e2eSuite.runtimeTestFiles.length}`,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  console.log('[benchmark-coverage] ok');
  console.log(
    `[benchmark-coverage] cases=${cases.length} contract-capabilities=${capabilities.size} ` +
      `routing-only-capabilities=${routingCapabilities.size} production-capabilities=${productionCapabilities.size} ` +
      `tags=${tags.size}`,
  );
}

main();
