import { EVAL_CAPABILITY_LABELS, EVAL_TYPE_LABELS } from './constants';
import type { EvalOracleAssertion } from './oracles';
import { CASES_PATH, EVAL_SETS_PATH } from './paths';
import type {
  CreateQuantEvalCaseInput,
  CreateQuantEvalSetInput,
  QuantEvalCase,
  QuantEvalCoverageLevel,
  QuantEvalSetDefinition,
} from './types';
import {
  booleanValue,
  readJson,
  readRecordArray,
  stringArray,
  stringValue,
  uniqueId,
  writeJson,
  type JsonRecord,
} from './runtime-utils';

function inferCaseType(testCase: JsonRecord): string {
  const explicitType = stringValue(testCase.type);
  if (explicitType) return explicitType;
  if (booleanValue(testCase.expectClarification)) return 'clarification_required';
  return 'generated_project';
}

function inferCoverageLevel(testCase: JsonRecord): QuantEvalCoverageLevel {
  const explicit = stringValue(testCase.coverageLevel);
  if (explicit === 'routing' || explicit === 'contract' || explicit === 'live_e2e' || explicit === 'production') {
    return explicit;
  }
  if (inferCaseType(testCase) === 'renderer_capability_contract') return 'routing';
  return 'contract';
}

function buildCaseTags(testCase: JsonRecord): string[] {
  const tags = new Set<string>();
  const capabilityId = stringValue(testCase.capabilityId);
  const type = inferCaseType(testCase);
  const assetType = stringValue(testCase.expectedAssetType);
  const templateId = stringValue(testCase.expectedTemplateId);
  const variantId = stringValue(testCase.expectedVariantId);

  if (capabilityId) tags.add(capabilityId);
  if (type) tags.add(type);
  if (assetType) tags.add(`asset:${assetType}`);
  if (templateId) tags.add(`template:${templateId}`);
  if (variantId) tags.add(`variant:${variantId}`);
  if (booleanValue(testCase.expectClarification)) tags.add('intent:clarification_required');
  if (testCase.expectClarification === false) tags.add('intent:no_false_clarification');
  if (testCase.imageAttachment) tags.add('input:image_attachment');
  if (booleanValue(testCase.visualCheck)) tags.add('visual:playwright');
  if (booleanValue(testCase.expectedImageExtraction)) tags.add('evidence:image_extraction');
  if (type === 'clarification_continuation') tags.add('intent:clarification_continuation');
  if (type === 'repair_plan') tags.add('validation:repair_plan');
  if (type === 'source_degradation_contract') tags.add('data:source_degradation');
  if (type === 'runtime_registry') tags.add('runtime:deepseek_v4_flash');
  if (type === 'renderer_capability_contract') tags.add('dashboard:renderer_capability');
  const coverageLevel = inferCoverageLevel(testCase);
  tags.add(`coverage:${coverageLevel}`);
  if (booleanValue(testCase.productionSupported)) tags.add('coverage:production');
  for (const safetyTag of stringArray(testCase.safetyTags)) tags.add(`safety:${safetyTag}`);
  for (const expectation of readRecordArray(testCase.selectionExpectations)) {
    const nestedCapabilityId = stringValue(expectation.capabilityId);
    const nestedTemplateId = stringValue(expectation.expectedTemplateId);
    const nestedVariantId = stringValue(expectation.expectedVariantId);
    if (nestedCapabilityId) tags.add(nestedCapabilityId);
    if (nestedTemplateId) tags.add(`template:${nestedTemplateId}`);
    if (nestedVariantId) tags.add(`variant:${nestedVariantId}`);
  }
  if (stringArray(testCase.expectedSymbols).length > 1) tags.add('data:multi_symbol');

  return Array.from(tags);
}

export function normalizeCase(testCase: JsonRecord): QuantEvalCase {
  const capabilityId = stringValue(testCase.capabilityId, 'unknown');
  const type = inferCaseType(testCase);
  const expectedSymbols = [
    ...new Set([
      ...stringArray(testCase.expectedSymbols),
      stringValue(testCase.expectedSymbol),
    ].filter(Boolean)),
  ];

  return {
    id: stringValue(testCase.id, 'unknown'),
    name: stringValue(testCase.name, stringValue(testCase.id, '未命名用例')),
    question: stringValue(testCase.question),
    capabilityId,
    capabilityLabel: EVAL_CAPABILITY_LABELS[capabilityId] ?? capabilityId,
    type,
    typeLabel: EVAL_TYPE_LABELS[type] ?? type,
    expectedSymbols,
    expectedAssetType: stringValue(testCase.expectedAssetType) || null,
    expectedTemplateId: stringValue(testCase.expectedTemplateId) || null,
    expectedVariantId: stringValue(testCase.expectedVariantId) || null,
    expectedDatasets: stringArray(testCase.expectedDatasets),
    expectedRawFiles: stringArray(testCase.expectedRawFiles),
    expectedFinalFields: stringArray(testCase.expectedFinalFields),
    tags: buildCaseTags(testCase),
    coverageLevel: inferCoverageLevel(testCase),
    productionSupported: booleanValue(testCase.productionSupported),
    oracleAssertions: readRecordArray(testCase.oracleAssertions) as unknown as EvalOracleAssertion[],
    safetyTags: stringArray(testCase.safetyTags),
    hasImageAttachment: Boolean(testCase.imageAttachment),
    expectClarification: booleanValue(testCase.expectClarification),
    visualCheck: booleanValue(testCase.visualCheck),
  };
}

function slugifyEvalId(value: string, prefix: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug ? `${prefix}-${slug}` : uniqueId(prefix);
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

const ORACLE_TARGETS = new Set(['finalData', 'sources', 'quality', 'page']);
const ORACLE_OPERATORS = new Set([
  'exists', 'not_exists', 'equals', 'not_equals', 'gte', 'lte', 'between',
  'contains', 'not_contains', 'matches', 'not_matches', 'length_gte', 'length_lte',
]);

function validateOracleAssertions(value: unknown): EvalOracleAssertion[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('oracleAssertions 必须是数组。');
  const ids = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`第 ${index + 1} 条 oracle 必须是对象。`);
    }
    const assertion = item as unknown as EvalOracleAssertion;
    if (!assertion.id || typeof assertion.id !== 'string' || !/^[\w:-]+$/u.test(assertion.id)) {
      throw new Error(`第 ${index + 1} 条 oracle 缺少有效 id。`);
    }
    if (ids.has(assertion.id)) throw new Error(`oracle id 重复：${assertion.id}`);
    ids.add(assertion.id);
    if (!ORACLE_TARGETS.has(assertion.target)) {
      throw new Error(`${assertion.id} 的 target 无效。`);
    }
    if (!ORACLE_OPERATORS.has(assertion.operator)) {
      throw new Error(`${assertion.id} 的 operator 无效。`);
    }
    if (assertion.path !== undefined && typeof assertion.path !== 'string') {
      throw new Error(`${assertion.id} 的 path 必须是字符串。`);
    }
    if (assertion.severity !== undefined && assertion.severity !== 'error' && assertion.severity !== 'warning') {
      throw new Error(`${assertion.id} 的 severity 必须是 error 或 warning。`);
    }
    if (assertion.operator === 'between' &&
      (typeof assertion.min !== 'number' || !Number.isFinite(assertion.min) ||
        typeof assertion.max !== 'number' || !Number.isFinite(assertion.max) ||
        assertion.min > assertion.max)) {
      throw new Error(`${assertion.id} 的 between 必须声明有效 min/max。`);
    }
    if (!['exists', 'not_exists', 'between'].includes(assertion.operator) && assertion.value === undefined) {
      throw new Error(`${assertion.id} 的 ${assertion.operator} 必须声明 value。`);
    }
    if (assertion.tolerance !== undefined &&
      (typeof assertion.tolerance !== 'number' || !Number.isFinite(assertion.tolerance) || assertion.tolerance < 0)) {
      throw new Error(`${assertion.id} 的 tolerance 必须是非负数。`);
    }
    if ((assertion.operator === 'matches' || assertion.operator === 'not_matches') &&
      (typeof assertion.value !== 'string' || assertion.value.length > 500)) {
      throw new Error(`${assertion.id} 的正则必须是长度不超过 500 的字符串。`);
    }
    if ((assertion.operator === 'matches' || assertion.operator === 'not_matches') && typeof assertion.value === 'string') {
      try {
        new RegExp(assertion.value, 'iu');
      } catch {
        throw new Error(`${assertion.id} 的正则表达式无效。`);
      }
    }
    return assertion;
  });
}

function normalizeCustomEvalSet(value: JsonRecord): QuantEvalSetDefinition {
  return {
    id: stringValue(value.id, uniqueId('custom-set')),
    name: stringValue(value.name, '未命名评测集'),
    description: stringValue(value.description),
    category: stringValue(value.category, '自定义'),
    caseIds: stringArray(value.caseIds),
    custom: true,
  };
}

async function readRawEvalCases(): Promise<JsonRecord[]> {
  const parsed = await readJson(CASES_PATH).catch(() => []);
  return readRecordArray(parsed);
}

async function readCustomEvalSetsRaw(): Promise<JsonRecord[]> {
  const parsed = await readJson(EVAL_SETS_PATH).catch(() => []);
  return readRecordArray(parsed);
}

export async function getQuantEvalCases(): Promise<QuantEvalCase[]> {
  return (await readRawEvalCases()).map(normalizeCase);
}

export async function getQuantEvalSets(): Promise<QuantEvalSetDefinition[]> {
  const cases = await getQuantEvalCases();
  const caseIds = new Set(cases.map((testCase) => testCase.id));
  return (await readCustomEvalSetsRaw())
    .map(normalizeCustomEvalSet)
    .map((evalSet) => ({
      ...evalSet,
      caseIds: evalSet.caseIds.filter((caseId) => caseIds.has(caseId)),
    }))
    .filter((evalSet) => evalSet.caseIds.length > 0);
}

export async function createQuantEvalCase(input: CreateQuantEvalCaseInput): Promise<QuantEvalCase> {
  const rawCases = await readRawEvalCases();
  const existingIds = new Set(rawCases.map((item) => stringValue(item.id)).filter(Boolean));
  const name = stringValue(input.name).trim();
  const question = stringValue(input.question).trim();
  const capabilityId = stringValue(input.capabilityId, 'asset_comparison').trim();
  const type = stringValue(input.type, 'generated_project').trim();
  const id = stringValue(input.id).trim() || slugifyEvalId(name || capabilityId, 'case');

  if (!id || !/^[\w:-]+$/u.test(id)) throw new Error('用例 ID 只能包含字母、数字、下划线、短横线和冒号。');
  if (existingIds.has(id)) throw new Error(`用例 ID 已存在：${id}`);
  if (!name) throw new Error('请填写用例名称。');
  if (!question) throw new Error('请填写用户 Query。');

  const expectedSymbols = normalizeStringList(input.expectedSymbols);
  const record: JsonRecord = {
    id,
    name,
    question,
    capabilityId,
    type,
  };

  if (expectedSymbols.length === 1) record.expectedSymbol = expectedSymbols[0];
  if (expectedSymbols.length > 1) record.expectedSymbols = expectedSymbols;
  if (input.expectedAssetType) record.expectedAssetType = input.expectedAssetType;
  if (input.expectedTemplateId) record.expectedTemplateId = input.expectedTemplateId;
  if (input.expectedVariantId) record.expectedVariantId = input.expectedVariantId;
  const expectedDatasets = normalizeStringList(input.expectedDatasets);
  const expectedRawFiles = normalizeStringList(input.expectedRawFiles);
  const expectedFinalFields = normalizeStringList(input.expectedFinalFields);
  const oracleAssertions = validateOracleAssertions(input.oracleAssertions);
  const safetyTags = normalizeStringList(input.safetyTags);
  if (input.productionSupported && oracleAssertions.length === 0) {
    throw new Error('产品支持用例必须至少提供一条事实或安全 oracle。');
  }
  if (input.productionSupported && safetyTags.length === 0) {
    throw new Error('产品支持用例必须至少提供一个安全标签。');
  }
  if (expectedDatasets.length) record.expectedDatasets = expectedDatasets;
  if (expectedRawFiles.length) record.expectedRawFiles = expectedRawFiles;
  if (expectedFinalFields.length) record.expectedFinalFields = expectedFinalFields;
  if (input.coverageLevel) record.coverageLevel = input.coverageLevel;
  if (input.productionSupported) record.productionSupported = true;
  if (oracleAssertions.length > 0) {
    record.oracleAssertions = oracleAssertions as unknown as JsonRecord[];
  }
  if (safetyTags.length) record.safetyTags = safetyTags;
  if (input.expectClarification) record.expectClarification = true;
  if (input.visualCheck) record.visualCheck = true;

  await writeJson(CASES_PATH, [...rawCases, record]);
  return normalizeCase(record);
}

export async function createQuantEvalSet(input: CreateQuantEvalSetInput): Promise<QuantEvalSetDefinition> {
  const rawSets = await readCustomEvalSetsRaw();
  const cases = await getQuantEvalCases();
  const caseIds = new Set(cases.map((testCase) => testCase.id));
  const selectedCaseIds = normalizeStringList(input.caseIds).filter((caseId) => caseIds.has(caseId));
  const reservedIds = new Set<string>(['all']);
  for (const testCase of cases) {
    reservedIds.add(`capability:${testCase.capabilityId}`);
    reservedIds.add(`type:${testCase.type}`);
  }
  if (cases.some((testCase) => testCase.visualCheck || testCase.hasImageAttachment)) reservedIds.add('special:visual');
  if (cases.some((testCase) => testCase.expectClarification || testCase.type.includes('clarification'))) reservedIds.add('special:clarification');
  const existingIds = new Set([...rawSets.map((item) => stringValue(item.id)).filter(Boolean), ...reservedIds]);
  const name = stringValue(input.name).trim();
  const id = stringValue(input.id).trim() || slugifyEvalId(name || 'eval-set', 'custom');

  if (!id || !/^[\w:-]+$/u.test(id)) throw new Error('评测集 ID 只能包含字母、数字、下划线、短横线和冒号。');
  if (existingIds.has(id)) throw new Error(`评测集 ID 已存在：${id}`);
  if (!name) throw new Error('请填写评测集名称。');
  if (!selectedCaseIds.length) throw new Error('请至少选择一个测试用例。');

  const record: JsonRecord = {
    id,
    name,
    description: stringValue(input.description),
    category: stringValue(input.category, '自定义'),
    caseIds: selectedCaseIds,
  };

  await writeJson(EVAL_SETS_PATH, [...rawSets, record]);
  return normalizeCustomEvalSet(record);
}
