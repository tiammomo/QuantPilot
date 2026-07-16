import { createHash } from 'node:crypto';

export type EvalSnapshotDatasetKind = 'market_response' | 'oracle_fixture';
export type EvalSnapshotAdjustment = 'none' | 'qfq' | 'hfq' | 'mixed';

export interface EvalDataSnapshot {
  schemaVersion: 1;
  id: string;
  caseId: string;
  datasetKind: EvalSnapshotDatasetKind;
  fixturePath: string;
  payloadSha256: string;
  asOf: string;
  capturedAt: string;
  source: {
    provider: string;
    version: string;
  };
  tradingCalendarVersion: string;
  adjustment: EvalSnapshotAdjustment;
  observation: {
    minAt: string;
    maxAt: string;
    count: number;
  };
}

type UnknownRecord = Record<string, unknown>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as UnknownRecord)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function evalSnapshotPayloadSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function parsedTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function attestEvalDataSnapshot(
  snapshot: EvalDataSnapshot,
  payload: unknown,
  options: { expectedCaseId?: string; now?: Date } = {},
) {
  const problems: string[] = [];
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as UnknownRecord
    : {};
  if (snapshot.schemaVersion !== 1) problems.push('snapshot schemaVersion 必须为 1');
  if (!snapshot.id || !/^[\w:.-]+$/u.test(snapshot.id)) problems.push('snapshot id 无效');
  if (!snapshot.caseId) problems.push('snapshot 缺少 caseId');
  if (options.expectedCaseId && snapshot.caseId !== options.expectedCaseId) {
    problems.push(`snapshot caseId 应为 ${options.expectedCaseId}`);
  }
  if (typeof record.caseId === 'string' && record.caseId !== snapshot.caseId) {
    problems.push('fixture caseId 与 snapshot caseId 不一致');
  }
  if (!['market_response', 'oracle_fixture'].includes(snapshot.datasetKind)) {
    problems.push('snapshot datasetKind 无效');
  }
  if (!snapshot.fixturePath || snapshot.fixturePath.startsWith('/') || snapshot.fixturePath.includes('..')) {
    problems.push('snapshot fixturePath 必须是仓库内安全相对路径');
  }
  if (!/^[a-f0-9]{64}$/u.test(snapshot.payloadSha256)) {
    problems.push('snapshot payloadSha256 无效');
  } else if (evalSnapshotPayloadSha256(payload) !== snapshot.payloadSha256) {
    problems.push('snapshot payloadSha256 与 fixture 内容不一致');
  }
  if (!snapshot.source?.provider || !snapshot.source?.version) {
    problems.push('snapshot 缺少 source provider/version');
  }
  if (!snapshot.tradingCalendarVersion) problems.push('snapshot 缺少交易日历版本');
  if (!['none', 'qfq', 'hfq', 'mixed'].includes(snapshot.adjustment)) {
    problems.push('snapshot adjustment 无效');
  }

  const asOf = parsedTime(snapshot.asOf);
  const capturedAt = parsedTime(snapshot.capturedAt);
  const minAt = parsedTime(snapshot.observation?.minAt);
  const maxAt = parsedTime(snapshot.observation?.maxAt);
  if (asOf === null || capturedAt === null || minAt === null || maxAt === null) {
    problems.push('snapshot 时间字段必须是有效 ISO 时间');
  } else {
    if (minAt > maxAt) problems.push('snapshot observation.minAt 晚于 maxAt');
    if (maxAt > asOf) problems.push('snapshot 包含 asOf 之后的数据，可能存在未来数据泄漏');
    if (asOf > capturedAt) problems.push('snapshot asOf 晚于 capturedAt');
    const now = (options.now ?? new Date()).getTime();
    if (capturedAt > now + 5 * 60_000) problems.push('snapshot capturedAt 位于允许时钟偏差之外的未来');
  }
  if (!Number.isSafeInteger(snapshot.observation?.count) || snapshot.observation.count < 1) {
    problems.push('snapshot observation.count 必须是正整数');
  }
  return { passed: problems.length === 0, problems };
}
