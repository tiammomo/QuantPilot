import type { QuantEvalRuntimeOption } from './types';

export const DEFAULT_EVALUATOR_ID = 'rule-strict';
export const DEFAULT_EVAL_CONCURRENCY = 1;
export const MAX_EVAL_CONCURRENCY = 16;

export const EVAL_RUNTIME_OPTIONS: QuantEvalRuntimeOption[] = [
  {
    cli: 'claude',
    label: 'Claude Code',
    defaultModel: 'mimo-v2.5-pro',
    supportsReasoningEffort: false,
    models: [
      {
        id: 'mimo-v2.5-pro',
        name: 'Mimo V2.5 Pro',
        description: '通过 Anthropic 兼容协议接入 Claude Code 的 Mimo 模型',
      },
      {
        id: 'MiniMax-M2.7',
        name: 'MiniMax M2.7',
        description: '保留的 MiniMax 兼容模型选项',
      },
    ],
  },
  {
    cli: 'codex',
    label: 'Codex CLI',
    defaultModel: 'gpt-5.5',
    supportsReasoningEffort: true,
    models: [
      {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        description: '通过 OpenAI 兼容协议接入 Codex CLI 的第三方 GPT 模型',
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
