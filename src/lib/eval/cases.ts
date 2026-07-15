import { EVAL_CAPABILITY_LABELS, EVAL_TYPE_LABELS } from './constants';
import { CASES_PATH, EVAL_SETS_PATH } from './paths';
import type { CreateQuantEvalCaseInput, CreateQuantEvalSetInput, QuantEvalCase, QuantEvalSetDefinition } from './types';
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
  if (expectedDatasets.length) record.expectedDatasets = expectedDatasets;
  if (expectedRawFiles.length) record.expectedRawFiles = expectedRawFiles;
  if (expectedFinalFields.length) record.expectedFinalFields = expectedFinalFields;
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
