import {
  EVAL_SCORE_DIMENSION_IDS,
  resultScore,
  weightedDimensionScore,
  type EvalScoreDimension,
  type EvalScoreDimensionId,
} from './scoring';

export type EvalEvaluatorId = 'rule-strict' | 'agent-review' | 'visual-contract';

export interface EvalEvaluatorDefinition {
  id: EvalEvaluatorId;
  version: string;
  rubricVersion: string;
  name: string;
  description: string;
  supportedModes: Array<'contract' | 'e2e'>;
  requiresSemanticReview: boolean;
  dimensionWeights: Record<EvalScoreDimensionId, number>;
}

export interface EvalSemanticReviewDimension {
  id: 'intentCoverage' | 'businessCompleteness' | 'grounding' | 'riskCommunication' | 'actionability';
  score: number;
  rationale: string;
  evidence: string[];
}

export interface EvalSemanticReview {
  schemaVersion: 1;
  reviewer: {
    provider: string;
    model: string;
    promptVersion: string;
    independentFromGenerator: boolean;
  };
  verdict: 'passed' | 'warning' | 'failed';
  score: number;
  summary: string;
  dimensions: EvalSemanticReviewDimension[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
}

export interface EvalStrategyCheck {
  id: string;
  name: string;
  status: 'passed' | 'warning' | 'failed';
  summary: string;
}

export interface AppliedEvaluation {
  evaluatorId: EvalEvaluatorId;
  evaluatorVersion: string;
  rubricVersion: string;
  hardGatePassed: boolean;
  passed: boolean;
  score: number;
  checks: EvalStrategyCheck[];
  dimensions: EvalScoreDimension[];
  semanticReview: EvalSemanticReview | null;
}

type UnknownRecord = Record<string, unknown>;

const record = (value: unknown): UnknownRecord =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};

const number = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const statusScore = (statuses: string[]): number => {
  if (statuses.includes('failed')) return 0;
  if (statuses.includes('warning') || statuses.includes('unknown')) return 70;
  return statuses.length > 0 ? 100 : 85;
};

const statusFromScore = (score: number): EvalScoreDimension['status'] =>
  score >= 85 ? 'passed' : score >= 65 ? 'warning' : 'failed';

const DEFAULT_WEIGHTS: Record<EvalScoreDimensionId, number> = {
  contract: 25,
  grounding: 20,
  task: 20,
  visual: 15,
  reliability: 10,
  efficiency: 5,
  safety: 5,
};

export const EVAL_EVALUATOR_DEFINITIONS: EvalEvaluatorDefinition[] = [
  {
    id: 'rule-strict',
    version: '2.1.0',
    rubricVersion: 'quantpilot-rule-rubric-v3',
    name: '强规则评测器',
    description: '确定性检查产物、数据证据、运行链路、事实 oracle 与安全约束。',
    supportedModes: ['contract', 'e2e'],
    requiresSemanticReview: false,
    dimensionWeights: DEFAULT_WEIGHTS,
  },
  {
    id: 'agent-review',
    version: '2.1.0',
    rubricVersion: 'quantpilot-agent-review-v2',
    name: 'Agent 评测器',
    description: '在确定性硬门之后执行版本化语义审阅，评价意图、业务完整性、依据、风险与行动建议。',
    supportedModes: ['e2e'],
    requiresSemanticReview: true,
    dimensionWeights: {
      contract: 15,
      grounding: 25,
      task: 25,
      visual: 10,
      reliability: 10,
      efficiency: 5,
      safety: 10,
    },
  },
  {
    id: 'visual-contract',
    version: '2.1.0',
    rubricVersion: 'quantpilot-visual-rubric-v3',
    name: '视觉契约评测器',
    description: '强化多视口、可访问性、资源加载、布局和金融图表表达检查。',
    supportedModes: ['contract', 'e2e'],
    requiresSemanticReview: false,
    dimensionWeights: {
      contract: 15,
      grounding: 10,
      task: 15,
      visual: 40,
      reliability: 10,
      efficiency: 5,
      safety: 5,
    },
  },
];

export function getEvalEvaluatorDefinition(value: string): EvalEvaluatorDefinition {
  const definition = EVAL_EVALUATOR_DEFINITIONS.find((item) => item.id === value);
  if (!definition) throw new Error(`未知评测器：${value}`);
  return definition;
}

function checkStatuses(result: UnknownRecord, ids: string[]): string[] {
  const validation = record(result.validation);
  const checks = Array.isArray(validation.checks) ? validation.checks.map(record) : [];
  return checks
    .filter((check) => ids.includes(String(check.id ?? '')))
    .map((check) => String(check.status ?? 'unknown'));
}

function dimension(
  definition: EvalEvaluatorDefinition,
  id: EvalScoreDimensionId,
  score: number,
  summary: string,
): EvalScoreDimension {
  const bounded = Math.min(100, Math.max(0, Math.round(score)));
  return {
    id,
    label: {
      contract: '产物契约',
      grounding: '事实与证据',
      task: '任务完成度',
      visual: '视觉交付',
      reliability: '运行可靠性',
      efficiency: '执行效率',
      safety: '安全与边界',
    }[id],
    score: bounded,
    weight: definition.dimensionWeights[id],
    status: statusFromScore(bounded),
    summary,
  };
}

export function applyEvalEvaluator(input: {
  evaluatorId: string;
  mode: 'contract' | 'e2e';
  result: unknown;
  semanticReview?: EvalSemanticReview | null;
}): AppliedEvaluation {
  const definition = getEvalEvaluatorDefinition(input.evaluatorId);
  if (!definition.supportedModes.includes(input.mode)) {
    throw new Error(`${definition.id} 不支持 ${input.mode} 模式`);
  }
  const result = record(input.result);
  const failures = Array.isArray(result.failures) ? result.failures.map(String) : [];
  const artifacts = record(result.artifacts);
  const oracle = record(artifacts.oracle);
  const eventAudit = record(result.eventAudit);
  const visualCheck = record(result.visualCheck);
  const agentExecution = record(result.agentExecution);
  const usage = record(agentExecution.usage);
  const tools = record(agentExecution.tools);
  const repairAttempts = number(result.repairAttempts);
  const hardGatePassed = result.passed === true &&
    oracle.passed !== false &&
    (result.visualCheck == null || visualCheck.passed === true) &&
    number(eventAudit.errorCount) === 0 &&
    number(tools.unexpectedFailureCount) === 0;

  const contractScore = statusScore(checkStatuses(result, [
    'artifact_policy',
    'next_build',
    'preview_http_200',
    'artifact_contracts',
    'dashboard_data_binding',
    'chart_presence',
  ]));
  const groundingStatuses = checkStatuses(result, [
    'final_data_file',
    'evidence_files',
    'market_proxy',
  ]);
  if (oracle.passed === false) groundingStatuses.push('failed');
  if (oracle.warning === true) groundingStatuses.push('warning');
  let groundingScore = statusScore(groundingStatuses);
  let taskScore = hardGatePassed ? 100 : Math.max(0, 70 - failures.length * 15);
  const visualStatuses = checkStatuses(result, ['visual_presentation']);
  if (result.visualCheck != null) visualStatuses.push(visualCheck.passed === true ? 'passed' : 'failed');
  const visualScore = statusScore(visualStatuses);
  const reliabilityScore = Math.max(
    0,
    100 - repairAttempts * 18 - number(eventAudit.errorCount) * 35 - number(eventAudit.warningCount) * 4,
  );
  const turns = number(agentExecution.turns);
  const cacheMissTokens = number(usage.cacheMissInputTokens);
  const toolFailures = number(tools.unexpectedFailureCount);
  const efficiencyScore = input.mode === 'e2e'
    ? Math.max(0, 100 - Math.max(0, turns - 6) * 6 - Math.floor(cacheMissTokens / 28_000) * 8 - toolFailures * 30)
    : 100;
  let safetyScore = statusScore(checkStatuses(result, ['artifact_policy']));
  const oracleChecks = Array.isArray(oracle.checks) ? oracle.checks.map(record) : [];
  const safetyOracleChecks = oracleChecks.filter((check) =>
    check.target === 'page' &&
    (check.operator === 'not_matches' || check.operator === 'not_contains'));
  if (safetyOracleChecks.some((check) => check.passed !== true && check.severity !== 'warning')) {
    safetyScore = 0;
  } else if (safetyOracleChecks.some((check) => check.passed !== true)) {
    safetyScore = Math.min(safetyScore, 70);
  }
  const semanticReview = input.semanticReview ?? null;
  const checks: EvalStrategyCheck[] = [];

  if (definition.id === 'agent-review') {
    if (!semanticReview) {
      checks.push({
        id: 'semantic_review',
        name: '语义审阅',
        status: 'failed',
        summary: 'Agent 评测器没有生成可验真的语义审阅结果。',
      });
      taskScore = 0;
      groundingScore = 0;
    } else {
      checks.push({
        id: 'semantic_review',
        name: '语义审阅',
        status: semanticReview.verdict,
        summary: semanticReview.summary,
      });
      checks.push({
        id: 'reviewer_independence',
        name: 'Reviewer 独立性',
        status: semanticReview.reviewer.independentFromGenerator ? 'passed' : 'warning',
        summary: semanticReview.reviewer.independentFromGenerator
          ? '语义 reviewer 与生成模型来源独立。'
          : '语义 reviewer 与生成模型不独立，只能作为软证据。',
      });
      const byId = new Map(semanticReview.dimensions.map((item) => [item.id, item.score]));
      taskScore = Math.round(((byId.get('intentCoverage') ?? 0) +
        (byId.get('businessCompleteness') ?? 0) +
        (byId.get('actionability') ?? 0)) / 3);
      groundingScore = byId.get('grounding') ?? 0;
      safetyScore = Math.round((safetyScore + (byId.get('riskCommunication') ?? 0)) / 2);
    }
  } else if (definition.id === 'visual-contract') {
    checks.push({
      id: 'visual_contract',
      name: '视觉契约',
      status: visualScore >= 85 ? 'passed' : visualScore >= 65 ? 'warning' : 'failed',
      summary: visualScore >= 85
        ? '多视口视觉与可访问性契约通过。'
        : '视觉契约存在布局、资源或可访问性问题。',
    });
  } else {
    checks.push({
      id: 'strict_contract',
      name: '强规则复核',
      status: hardGatePassed ? 'passed' : 'failed',
      summary: hardGatePassed ? '确定性硬门全部通过。' : `确定性硬门发现 ${failures.length} 项失败。`,
    });
  }

  const dimensions = [
    dimension(definition, 'contract', contractScore, '构建、Schema、绑定和产物策略。'),
    dimension(definition, 'grounding', groundingScore, '数据文件、来源、质量与事实 oracle。'),
    dimension(definition, 'task', taskScore, '用户意图、业务内容和交付完整性。'),
    dimension(definition, 'visual', visualScore, '多视口布局、图表、资源和可访问性。'),
    dimension(definition, 'reliability', reliabilityScore, `修复 ${repairAttempts} 次，事件错误 ${number(eventAudit.errorCount)} 个。`),
    dimension(definition, 'efficiency', efficiencyScore, input.mode === 'e2e' ? `turns=${turns}，cache-miss=${cacheMissTokens}。` : '确定性链路不计算模型成本。'),
    dimension(definition, 'safety', safetyScore, '产物执行策略、禁止性断言与风险边界。'),
  ];
  const score = weightedDimensionScore(dimensions);
  const strategyPassed = checks.every((check) => check.status !== 'failed');

  return {
    evaluatorId: definition.id,
    evaluatorVersion: definition.version,
    rubricVersion: definition.rubricVersion,
    hardGatePassed,
    passed: hardGatePassed && strategyPassed,
    score,
    checks,
    dimensions,
    semanticReview,
  };
}

export function isCurrentEvaluation(value: unknown): boolean {
  const evaluation = record(value);
  if (!EVAL_EVALUATOR_DEFINITIONS.some((item) =>
    item.id === evaluation.evaluatorId && item.version === evaluation.evaluatorVersion)) {
    return false;
  }
  if (!EVAL_SCORE_DIMENSION_IDS.every((id) =>
    Array.isArray(evaluation.dimensions) && evaluation.dimensions.some((item) => record(item).id === id))) {
    return false;
  }
  return resultScore({ evaluation }) === evaluation.score &&
    typeof evaluation.hardGatePassed === 'boolean' &&
    typeof evaluation.passed === 'boolean';
}
