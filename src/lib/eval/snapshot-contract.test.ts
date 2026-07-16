import { describe, expect, it } from 'vitest';

import {
  attestEvalDataSnapshot,
  evalSnapshotPayloadSha256,
  type EvalDataSnapshot,
} from './snapshot-contract';

function fixture() {
  const payload = { schemaVersion: 1, caseId: 'snapshot-case', symbol: '600519' };
  const snapshot: EvalDataSnapshot = {
    schemaVersion: 1,
    id: 'snapshot-case-v1',
    caseId: 'snapshot-case',
    datasetKind: 'oracle_fixture',
    fixturePath: 'snapshots/snapshot-case.json',
    payloadSha256: evalSnapshotPayloadSha256(payload),
    asOf: '2026-07-15T07:00:00.000Z',
    capturedAt: '2026-07-15T08:00:00.000Z',
    source: { provider: 'quantpilot-eval', version: '1' },
    tradingCalendarVersion: 'cn-2026.07',
    adjustment: 'qfq',
    observation: {
      minAt: '2026-01-01T00:00:00.000Z',
      maxAt: '2026-07-15T07:00:00.000Z',
      count: 120,
    },
  };
  return { payload, snapshot };
}

describe('evaluation data snapshot contract', () => {
  it('attests a replayable fixture', () => {
    const { payload, snapshot } = fixture();
    expect(attestEvalDataSnapshot(snapshot, payload, {
      expectedCaseId: 'snapshot-case',
      now: new Date('2026-07-16T00:00:00.000Z'),
    })).toEqual({ passed: true, problems: [] });
  });

  it('detects payload tampering and future-data leakage', () => {
    const { payload, snapshot } = fixture();
    const result = attestEvalDataSnapshot({
      ...snapshot,
      observation: { ...snapshot.observation, maxAt: '2026-07-16T00:00:00.000Z' },
    }, { ...payload, symbol: '000001' }, {
      now: new Date('2026-07-17T00:00:00.000Z'),
    });
    expect(result.passed).toBe(false);
    expect(result.problems).toEqual(expect.arrayContaining([
      'snapshot payloadSha256 与 fixture 内容不一致',
      'snapshot 包含 asOf 之后的数据，可能存在未来数据泄漏',
    ]));
  });
});
