import type { QuantEvalRuntimeOption } from './types';

export const DEFAULT_EVALUATOR_ID = 'rule-strict';
export const DEFAULT_EVAL_CONCURRENCY = 1;
export const MAX_EVAL_CONCURRENCY = 16;

export const EVAL_RUNTIME_OPTIONS: QuantEvalRuntimeOption[] = [
  {
    cli: 'claude',
    label: 'DeepSeek Agent',
    defaultModel: 'deepseek-v4-flash',
    supportsReasoningEffort: false,
    models: [
      {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        description: '通过 DeepSeek 官方 API 直连的唯一评测模型',
      },
    ],
  },
];

export const EVAL_CAPABILITY_LABELS: Record<string, string> = {
  fundamental_analysis: '基本面研究',
  technical_analysis: '技术分析',
  backtest_review: '策略回测',
  asset_comparison: '标的对比',
  portfolio_risk: '组合风控',
  stock_diagnosis: '个股诊断',
};

export const EVAL_TYPE_LABELS: Record<string, string> = {
  generated_project: '生成项目',
  clarification_required: '意图澄清',
  clarification_continuation: '澄清承接',
  runtime_registry: '运行时注册',
  repair_plan: '修复计划',
  source_degradation_contract: '信源降级',
};
