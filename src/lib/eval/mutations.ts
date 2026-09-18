import { applyEvalEvaluator, isCurrentEvaluation, type EvalEvaluatorId } from './evaluators';
import { assessQuantDataResponse } from '@/lib/domains/finance/data-quality';
import { assessQuantEvidence } from '@/lib/domains/finance/evidence-quality';
import { parseAgentSemanticReview } from './agent-reviewer';
import type { ReviewEvidence } from './review-evidence';
import { evaluateOracleAssertions, type EvalOracleAssertion, type EvalOracleTarget } from './oracles';
import {
  attestEvalDataSnapshot,
  evalSnapshotPayloadSha256,
  type EvalDataSnapshot,
} from './snapshot-contract';
import { buildEvalTraceDiagnostics } from './trace-diagnostics';

export type EvalMutationCategory = 'grounding' | 'safety' | 'visual' | 'reliability' | 'snapshot';
export type EvalMutationDetector = 'oracle' | 'evaluator' | 'snapshot' | 'trace' | 'data' | 'evidence' | 'semantic' | 'report';

type UnknownRecord = Record<string, unknown>;

interface EvalMutationFixture {
  evaluatorId: EvalEvaluatorId;
  mode: 'contract' | 'e2e';
  assertions: EvalOracleAssertion[];
  targets: Record<EvalOracleTarget, unknown>;
  result: UnknownRecord;
  snapshot: EvalDataSnapshot;
  snapshotPayload: UnknownRecord;
  semantic: UnknownRecord;
  tamperScore?: boolean;
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
      finalData: { symbol: '600519', kline: {
        symbol: '600519', period: 'daily', adjustment: 'qfq', as_of: '2026-07-15',
        bars: [14, 15].map(day => ({ date: `2026-07-${day}`, low: '99', high: '102', close: '100' })),
      } },
      sources: { sources: [{ source: 'snapshot', endpoint: 'GET /api/v1/quotes/history/600519', fetched_at: '2026-07-15T08:00:00Z' }] },
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
    semantic: {
      summary: 'Evidence-backed fixture',
      dimensions: ['intentCoverage', 'businessCompleteness', 'grounding', 'riskCommunication', 'actionability']
        .map(id => ({ id, score: 90, rationale: 'Observed fixture', evidence: ['finalData#/symbol'] })),
    },
  };
}

function objectTarget(fixture: EvalMutationFixture, target: EvalOracleTarget): UnknownRecord {
  return fixture.targets[target] as UnknownRecord;
}

const MUTATIONS: EvalMutationDefinition[] = [
  ...[
    ['wrong-adjustment', (data: UnknownRecord) => { data.adjustment = 'none'; }],
    ['wrong-data-symbol', (data: UnknownRecord) => { data.symbol = '000001'; }],
    ['duplicate-bars', (data: UnknownRecord) => { const bars = data.bars as UnknownRecord[]; bars[1].date = bars[0].date; }],
    ['reversed-bars', (data: UnknownRecord) => { (data.bars as unknown[]).reverse(); }],
    ['bar-after-observed-asof', (data: UnknownRecord) => { data.as_of = '2026-07-14'; }],
    ['non-finite-price', (data: UnknownRecord) => { (data.bars as UnknownRecord[])[0].close = 'NaN'; }],
    ['invalid-ohlc', (data: UnknownRecord) => { (data.bars as UnknownRecord[])[0].close = '200'; }],
    ['source-quality-error', (data: UnknownRecord) => { data.data_quality = { status: 'error' }; }],
  ].map(([id, mutate]) => ({
    id: id as string, name: `行情一致性：${id}`, category: 'grounding' as const, expectedDetector: 'data' as const,
    mutate: (fixture: EvalMutationFixture) => (mutate as (data: UnknownRecord) => void)(objectTarget(fixture, 'finalData').kline as UnknownRecord),
  })),
  {
    id: 'empty-source-object', name: '空来源对象冒充证据', category: 'grounding', expectedDetector: 'evidence',
    mutate: fixture => { objectTarget(fixture, 'sources').sources = [{}]; },
  },
  {
    id: 'critical-quality-hidden', name: '总体成功掩盖关键数据错误', category: 'grounding', expectedDetector: 'evidence',
    mutate: fixture => { objectTarget(fixture, 'quality').datasets = [{ status: 'error', critical: true }]; },
  },
  {
    id: 'validation-failure-hidden', name: '总体成功掩盖底层验证失败', category: 'reliability', expectedDetector: 'evaluator',
    mutate: fixture => { (fixture.result.validation as UnknownRecord).checks = [{ id: 'next_build', status: 'failed' }]; },
  },
  {
    id: 'negative-runtime-errors', name: '非法错误计数伪装为无错误', category: 'reliability', expectedDetector: 'evaluator',
    mutate: fixture => { (fixture.result.eventAudit as UnknownRecord).errorCount = -1; },
  },
  {
    id: 'fabricated-review-citation', name: '语义高分引用不存在的数据', category: 'grounding', expectedDetector: 'semantic',
    mutate: fixture => { (fixture.semantic.dimensions as UnknownRecord[])[2].evidence = ['sources#/invented']; },
  },
  {
    id: 'duplicate-review-dimension', name: '重复评分维度掩盖缺项', category: 'grounding', expectedDetector: 'semantic',
    mutate: fixture => { (fixture.semantic.dimensions as UnknownRecord[])[0].id = 'grounding'; },
  },
  {
    id: 'tampered-evaluator-score', name: '报告总分与评分维度不一致', category: 'reliability', expectedDetector: 'report',
    mutate: fixture => { fixture.tamperScore = true; },
  },
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
  if (fixture.tamperScore) evaluation.score = evaluation.score === 0 ? 100 : 0;
  const data = assessQuantDataResponse({
    path: '/api/v1/quotes/history/600519', query: { adjustment: 'qfq', period: 'daily' },
    payload: objectTarget(fixture, 'finalData').kline,
  });
  const evidence = assessQuantEvidence(fixture.targets.sources, fixture.targets.quality);
  const semantic = parseAgentSemanticReview(JSON.stringify(fixture.semantic), null,
    { provider: 'openai', model: 'mutation-fixture' }, Object.fromEntries(
      ['finalData', 'sources', 'quality', 'runPlan'].map(id => [id, {
        path: `${id}.json`, sha256: `sha256:${'a'.repeat(64)}`, bytes: 100, truncated: false,
        value: { symbol: '600519' },
      }]),
    ) as ReviewEvidence);
  const snapshot = attestEvalDataSnapshot(fixture.snapshot, fixture.snapshotPayload, {
    expectedCaseId: fixture.snapshot.caseId,
    now: new Date('2026-07-16T00:00:00.000Z'),
  });
  const detectedBy: EvalMutationDetector[] = [];
  if (!oracle.passed) detectedBy.push('oracle');
  if (!evaluation.passed) detectedBy.push('evaluator');
  if (!snapshot.passed) detectedBy.push('snapshot');
  if (trace.primaryFailureStage) detectedBy.push('trace');
  if (data.status === 'failed') detectedBy.push('data');
  if (!evidence.passed) detectedBy.push('evidence');
  if (semantic.evidenceValidation?.status !== 'verified') detectedBy.push('semantic');
  if (!isCurrentEvaluation(evaluation)) detectedBy.push('report');
  return { oracle, evaluation, snapshot, trace, data, evidence, semantic, detectedBy };
}

export function runEvalMutationSuite(
  evaluatorId: EvalEvaluatorId = 'rule-strict',
  now = new Date(),
): EvalMutationReport {
  const baseline = evaluateFixture(mutationFixture(evaluatorId));
  const baselinePassed = baseline.detectedBy.length === 0;
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
      problems: [...evaluated.oracle.failures, ...evaluated.snapshot.problems,
        ...evaluated.data.issues.filter(issue => issue.severity === 'error').map(issue => `${issue.code}@${issue.path}`),
        ...evaluated.evidence.failures, ...(evaluated.semantic.evidenceValidation?.issues ?? []),
        ...evaluated.evaluation.checks.filter(check => check.status === 'failed').map(check => check.summary),
      ],
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
