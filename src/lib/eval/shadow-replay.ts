import { createHmac } from 'node:crypto';

export interface EvalPromptRedaction {
  text: string;
  sourcePromptHmacSha256: string;
  redactionTypes: string[];
}

const PATTERNS: Array<{ id: string; pattern: RegExp; replacement: string }> = [
  { id: 'email', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, replacement: '[EMAIL]' },
  { id: 'mobile', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/gu, replacement: '[MOBILE]' },
  { id: 'cn_id', pattern: /(?<!\d)\d{17}[\dXx](?!\d)/gu, replacement: '[CN_ID]' },
  { id: 'long_account', pattern: /(?<!\d)\d{12,19}(?!\d)/gu, replacement: '[ACCOUNT]' },
  { id: 'ipv4', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, replacement: '[IP]' },
];

const ALLOWED_CASE_FIELDS = [
  'capabilityId',
  'type',
  'expectedSymbol',
  'expectedSymbols',
  'expectedAssetType',
  'expectedTemplateId',
  'expectedVariantId',
  'expectedDatasets',
  'expectedRawFiles',
  'expectedFinalFields',
  'oracleAssertions',
  'safetyTags',
  'expectClarification',
  'visualCheck',
] as const;

type UnknownRecord = Record<string, unknown>;

export function redactEvalPrompt(value: unknown, hashKey: string): EvalPromptRedaction {
  if (hashKey.length < 16) throw new Error('生产回放 hash key 至少需要 16 个字符');
  const source = String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
  let text = source;
  const redactionTypes: string[] = [];
  for (const item of PATTERNS) {
    item.pattern.lastIndex = 0;
    if (item.pattern.test(text)) {
      redactionTypes.push(item.id);
      item.pattern.lastIndex = 0;
      text = text.replace(item.pattern, item.replacement);
    }
  }
  return {
    text,
    sourcePromptHmacSha256: createHmac('sha256', hashKey).update(source).digest('hex'),
    redactionTypes,
  };
}

export function containsDirectEvalIdentifier(value: unknown): boolean {
  const text = String(value ?? '');
  return PATTERNS.some((item) => {
    item.pattern.lastIndex = 0;
    return item.pattern.test(text);
  });
}

export function buildProductionReplayCase(value: UnknownRecord, options: { hashKey: string }) {
  const redaction = redactEvalPrompt(value.question, options.hashKey);
  if (!redaction.text) throw new Error('生产回放记录缺少 question');
  const result: UnknownRecord = {
    id: `shadow-${redaction.sourcePromptHmacSha256.slice(0, 16)}`,
    name: `脱敏生产回放 ${redaction.sourcePromptHmacSha256.slice(0, 8)}`,
    question: redaction.text,
    capabilityId: typeof value.capabilityId === 'string' && value.capabilityId
      ? value.capabilityId
      : 'unknown',
    type: typeof value.type === 'string' && value.type ? value.type : 'generated_project',
    productionSupported: false,
    privacy: {
      schemaVersion: 1,
      redacted: true,
      sourcePromptHmacSha256: redaction.sourcePromptHmacSha256,
      redactionTypes: redaction.redactionTypes,
    },
  };
  for (const field of ALLOWED_CASE_FIELDS) {
    if (value[field] !== undefined) result[field] = structuredClone(value[field]);
  }
  return result;
}

export function attestProductionReplayCase(value: unknown) {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
  const privacy = record.privacy && typeof record.privacy === 'object' && !Array.isArray(record.privacy)
    ? record.privacy as UnknownRecord
    : {};
  const problems: string[] = [];
  if (privacy.schemaVersion !== 1 || privacy.redacted !== true) {
    problems.push('生产回放 case 缺少 privacy schemaVersion/redacted 证明');
  }
  if (typeof privacy.sourcePromptHmacSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(privacy.sourcePromptHmacSha256)) {
    problems.push('生产回放 case 缺少 sourcePromptHmacSha256');
  }
  if (!Array.isArray(privacy.redactionTypes) || privacy.redactionTypes.some((item) => typeof item !== 'string')) {
    problems.push('生产回放 case redactionTypes 无效');
  }
  if (containsDirectEvalIdentifier(record.question)) {
    problems.push('生产回放 question 仍包含可识别联系方式、证件或账户信息');
  }
  for (const forbidden of ['userId', 'projectId', 'requestId', 'sessionId', 'ipAddress', 'email', 'phone']) {
    if (record[forbidden] !== undefined) problems.push(`生产回放 case 禁止持久化 ${forbidden}`);
  }
  return { passed: problems.length === 0, problems };
}
