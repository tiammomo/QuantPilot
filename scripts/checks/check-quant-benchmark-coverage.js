#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const CASES_PATH = path.resolve('benchmarks/quantpilot/cases.json');

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
  if (testCase.expectClarification) tags.add('intent:clarification_required');
  if (testCase.type === 'clarification_continuation') tags.add('intent:clarification_continuation');
  if (testCase.imageAttachment) tags.add('input:image_attachment');
  if (testCase.visualCheck) tags.add('visual:playwright');
  if (testCase.expectedImageExtraction) tags.add('evidence:image_extraction');
  if (testCase.type === 'runtime_registry') tags.add('runtime:codex_gpt55');
  if (testCase.type === 'repair_plan') tags.add('validation:repair_plan');
  if (testCase.type === 'source_degradation_contract') tags.add('data:source_degradation');
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
  const requiredTags = [
    'asset:stock',
    'asset:index',
    'asset:etf',
    'template:stock-selection',
    'template:holding-analysis',
    'intent:clarification_required',
    'intent:clarification_continuation',
    'input:image_attachment',
    'evidence:image_extraction',
    'visual:playwright',
    'runtime:codex_gpt55',
    'validation:repair_plan',
    'data:source_degradation',
    'analysis:backtest',
    'analysis:portfolio',
    'analysis:selection',
    'data:multi_symbol',
  ];

  const missingCapabilities = requiredCapabilities.filter((item) => !capabilities.has(item));
  const missingTags = requiredTags.filter((item) => !tags.has(item));
  const problems = [
    ...schemaProblems,
    ...duplicateIds.map((id) => `重复用例 id：${id}`),
    ...missingCapabilities.map((item) => `缺少能力覆盖：${item}`),
    ...missingTags.map((item) => `缺少覆盖标签：${item}`),
  ];

  if (problems.length > 0) {
    fail('量化 benchmark 覆盖不足。', problems);
    return;
  }

  console.log('[benchmark-coverage] ok');
  console.log(`[benchmark-coverage] cases=${cases.length} capabilities=${capabilities.size} tags=${tags.size}`);
}

main();
