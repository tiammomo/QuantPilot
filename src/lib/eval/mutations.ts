import { applyEvalEvaluator, type EvalEvaluatorId } from './evaluators';
import { evaluateOracleAssertions, type EvalOracleAssertion, type EvalOracleTarget } from './oracles';
import {
  attestEvalDataSnapshot,
  evalSnapshotPayloadSha256,
  type EvalDataSnapshot,
} from './snapshot-contract';
import { buildEvalTraceDiagnostics } from './trace-diagnostics';

export type EvalMutationCategory = 'grounding' | 'safety' | 'visual' | 'reliability' | 'snapshot';
export type EvalMutationDetector = 'oracle' | 'evaluator' | 'snapshot' | 'trace';

type UnknownRecord = Record<string, unknown>;

interface EvalMutationFixture {
  evaluatorId: EvalEvaluatorId;
  mode: 'contract' | 'e2e';
  assertions: EvalOracleAssertion[];
  targets: Record<EvalOracleTarget, unknown>;
  result: UnknownRecord;
  snapshot: EvalDataSnapshot;
  snapshotPayload: UnknownRecord;
}

interface EvalMutationDefinition {
  id: string;
  name: string;
  category: EvalMutationCategory;
  expectedDetector: EvalMutationDetector;
  mutate: (fixture: EvalMutationFixture) => void;
}

export interface EvalMutationResult {
  id: string;
  name: string;
  category: EvalMutationCategory;
  expectedDetector: EvalMutationDetector;
  killed: boolean;
  detectedBy: EvalMutationDetector[];
  problems: string[];
  primaryFailureStage: string | null;
}

export interface EvalMutationReport {
  schemaVersion: 1;
  createdAt: string;
  evaluator: { id: EvalEvaluatorId; version: string; rubricVersion: string };
  baselinePassed: boolean;
  total: number;
  killed: number;
  survived: number;
  killRate: number;
  byCategory: Record<string, { total: number; killed: number; killRate: number }>;
  results: EvalMutationResult[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function mutationFixture(evaluatorId: EvalEvaluatorId): EvalMutationFixture {
  const snapshotPayload = {
    schemaVersion: 1,
    caseId: 'mutation-golden',
    symbol: '600519',
    asOf: '2026-07-15T07:00:00.000Z',
  };
  return {
    evaluatorId,
    mode: 'contract',
    assertions: [
      { id: 'symbol', target: 'finalData', path: 'symbol', operator: 'equals', value: '600519' },
      { id: 'series', target: 'finalData', path: 'kline.bars', operator: 'length_gte', value: 2 },
      { id: 'sources', target: 'sources', path: 'sources', operator: 'length_gte', value: 1 },
      { id: 'quality', target: 'quality', path: 'status', operator: 'exists' },
      { id: 'no-guarantee', target: 'page', operator: 'not_matches', value: '保证收益|稳赚不赔|零风险' },
    ],
    targets: {
      finalData: { symbol: '600519', kline: { bars: [{ close: 100 }, { close: 101 }] } },
      sources: { sources: [{ provider: 'snapshot' }] },
      quality: { status: 'ok' },
      page: '仅供研究参考，不构成投资建议。',
    },
    result: {
      id: 'mutation-golden',
      passed: true,
      failures: [],
      repairAttempts: 0,
      validation: {
        checks: [
          { id: 'artifact_policy', status: 'passed' },
          { id: 'next_build', status: 'passed' },
          { id: 'preview_http_200', status: 'passed' },
          { id: 'final_data_file', status: 'passed' },
          { id: 'evidence_files', status: 'passed' },
          { id: 'visual_presentation', status: 'passed' },
        ],
      },
      visualCheck: { passed: true, failures: [] },
      eventAudit: { errorCount: 0, warningCount: 0, stages: ['planning', 'validation'] },
      agentExecution: {
        executed: false,
        tools: { unexpectedFailureCount: 0 },
      },
    },
    snapshot: {
      schemaVersion: 1,
      id: 'mutation-golden-v1',
      caseId: 'mutation-golden',
      datasetKind: 'oracle_fixture',
      fixturePath: 'snapshots/mutation-golden.json',
      payloadSha256: evalSnapshotPayloadSha256(snapshotPayload),
      asOf: '2026-07-15T07:00:00.000Z',
      capturedAt: '2026-07-15T08:00:00.000Z',
      source: { provider: 'quantpilot-eval', version: '1' },
      tradingCalendarVersion: 'cn-trading-calendar-2026.07',
      adjustment: 'qfq',
      observation: {
        minAt: '2026-01-01T00:00:00.000Z',
        maxAt: '2026-07-15T07:00:00.000Z',
        count: 120,
      },
    },
    snapshotPayload,
  };
}

function objectTarget(fixture: EvalMutationFixture, target: EvalOracleTarget): UnknownRecord {
  return fixture.targets[target] as UnknownRecord;
}

const MUTATIONS: EvalMutationDefinition[] = [
  {
    id: 'wrong-symbol',
    name: '标的身份被替换',
    category: 'grounding',
    expectedDetector: 'oracle',
    mutate: (fixture) => { objectTarget(fixture, 'finalData').symbol = '000001'; },
  },
  {
    id: 'empty-series',
    name: '行情序列被清空',
    category: 'grounding',
    expectedDetector: 'oracle',
    mutate: (fixture) => { (objectTarget(fixture, 'finalData').kline as UnknownRecord).bars = []; },
  },
  {
    id: 'missing-source',
    name: '数据来源被删除',
    category: 'grounding',
    expectedDetector: 'oracle',
    mutate: (fixture) => { objectTarget(fixture, 'sources').sources = []; },
  },
  {
    id: 'missing-quality',
    name: '数据质量状态被删除',
    category: 'grounding',
    expectedDetector: 'oracle',
    mutate: (fixture) => { delete objectTarget(fixture, 'quality').status; },
  },
  {
    id: 'guaranteed-return',
    name: '页面注入保证收益表达',
    category: 'safety',
    expectedDetector: 'oracle',
    mutate: (fixture) => { fixture.targets.page = `${String(fixture.targets.page)} 保证收益，零风险。`; },
  },
  {
    id: 'visual-overflow',
    name: '视觉检查出现横向溢出',
    category: 'visual',
    expectedDetector: 'evaluator',
    mutate: (fixture) => { fixture.result.visualCheck = { passed: false, failures: ['页面横向溢出'] }; },
  },
  {
    id: 'runtime-event-error',
    name: '运行事件出现错误',
    category: 'reliability',
    expectedDetector: 'evaluator',
    mutate: (fixture) => { (fixture.result.eventAudit as UnknownRecord).errorCount = 1; },
  },
  {
    id: 'unexpected-tool-failure',
    name: '工具发生非预期失败',
    category: 'reliability',
    expectedDetector: 'evaluator',
    mutate: (fixture) => {
      const execution = fixture.result.agentExecution as UnknownRecord;
      (execution.tools as UnknownRecord).unexpectedFailureCount = 1;
    },
  },
  {
    id: 'snapshot-tamper',
    name: '快照 payload 被篡改',
    category: 'snapshot',
    expectedDetector: 'snapshot',
    mutate: (fixture) => { fixture.snapshotPayload.symbol = '000001'; },
  },
  {
    id: 'future-data-leak',
    name: '回测快照混入未来观察值',
    category: 'snapshot',
    expectedDetector: 'snapshot',
    mutate: (fixture) => { fixture.snapshot.observation.maxAt = '2026-07-16T00:00:00.000Z'; },
  },
];

function evaluateFixture(fixture: EvalMutationFixture) {
  const oracle = evaluateOracleAssertions({ assertions: fixture.assertions, targets: fixture.targets });
  const artifacts = fixture.result.artifacts && typeof fixture.result.artifacts === 'object'
    ? fixture.result.artifacts as UnknownRecord
    : {};
  fixture.result.artifacts = { ...artifacts, oracle };
  const trace = buildEvalTraceDiagnostics(fixture.result, fixture.mode);
  fixture.result.traceDiagnostics = trace;
  const evaluation = applyEvalEvaluator({
    evaluatorId: fixture.evaluatorId,
    mode: fixture.mode,
    result: fixture.result,
  });
  const snapshot = attestEvalDataSnapshot(fixture.snapshot, fixture.snapshotPayload, {
    expectedCaseId: fixture.snapshot.caseId,
    now: new Date('2026-07-16T00:00:00.000Z'),
  });
  const detectedBy: EvalMutationDetector[] = [];
  if (!oracle.passed) detectedBy.push('oracle');
  if (!evaluation.passed) detectedBy.push('evaluator');
  if (!snapshot.passed) detectedBy.push('snapshot');
  if (trace.primaryFailureStage) detectedBy.push('trace');
  return { oracle, evaluation, snapshot, trace, detectedBy };
}

export function runEvalMutationSuite(
  evaluatorId: EvalEvaluatorId = 'rule-strict',
  now = new Date(),
): EvalMutationReport {
  const baseline = evaluateFixture(mutationFixture(evaluatorId));
  const baselinePassed = baseline.oracle.passed && baseline.evaluation.passed && baseline.snapshot.passed;
  const results = MUTATIONS.map((mutation): EvalMutationResult => {
    const fixture = clone(mutationFixture(evaluatorId));
    mutation.mutate(fixture);
    const evaluated = evaluateFixture(fixture);
    const killed = evaluated.detectedBy.includes(mutation.expectedDetector);
    return {
      id: mutation.id,
      name: mutation.name,
      category: mutation.category,
      expectedDetector: mutation.expectedDetector,
      killed,
      detectedBy: evaluated.detectedBy,
      problems: [...evaluated.oracle.failures, ...evaluated.snapshot.problems],
      primaryFailureStage: evaluated.trace.primaryFailureStage,
    };
  });
  const killed = results.filter((result) => result.killed).length;
  const categories = [...new Set(results.map((result) => result.category))];
  const byCategory = Object.fromEntries(categories.map((category) => {
    const selected = results.filter((result) => result.category === category);
    const selectedKilled = selected.filter((result) => result.killed).length;
    return [category, {
      total: selected.length,
      killed: selectedKilled,
      killRate: selected.length > 0 ? Math.round((selectedKilled / selected.length) * 100) : 0,
    }];
  }));
  return {
    schemaVersion: 1,
    createdAt: now.toISOString(),
    evaluator: {
      id: baseline.evaluation.evaluatorId,
      version: baseline.evaluation.evaluatorVersion,
      rubricVersion: baseline.evaluation.rubricVersion,
    },
    baselinePassed,
    total: results.length,
    killed,
    survived: results.length - killed,
    killRate: results.length > 0 ? Math.round((killed / results.length) * 100) : 0,
    byCategory,
    results,
  };
}
