import { formatPiAgentDuration, formatPiAgentTokens, type PiAgentTurnMetrics } from '@/lib/chat/turn-metrics';

export default function TurnMetricsFooter({ metrics }: { metrics: PiAgentTurnMetrics }) {
  const approximate = metrics.tokenAccounting !== 'provider';
  const context = metrics.contextSnapshot;

  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-slate-200/80 pt-2 text-[11px] leading-5 text-slate-500 tabular-nums"
      aria-label={`本轮耗时 ${formatPiAgentDuration(metrics.elapsedMs)}，累计 Token 用量${approximate ? '约' : ''} ${formatPiAgentTokens(metrics.totalTokens)}`}
    >
      <span>本轮耗时 {formatPiAgentDuration(metrics.elapsedMs)}</span>
      <span aria-hidden="true">·</span>
      <span>
        Tokens {approximate ? '约 ' : ''}
        {formatPiAgentTokens(metrics.totalTokens)}
      </span>
      <span className="text-slate-400">
        （输入 {formatPiAgentTokens(metrics.inputTokens)} · 输出 {formatPiAgentTokens(metrics.outputTokens)}）
      </span>
      {metrics.tokenAccounting === 'partial' ? <span className="text-amber-600">统计可能不完整</span> : null}
      {context ? (
        <span
          className="basis-full"
          aria-label="末次上下文预估"
          title={`${context.model} · 第 ${context.turn} 次模型调用 · ${new Date(context.observedAt).toISOString()}；配置窗口 ${formatPiAgentTokens(context.contextWindowTokens)}，保留输出 ${formatPiAgentTokens(context.reservedOutputTokens)} Token。此处为单次输入预估，不是累计用量或费用。`}
        >
          末次上下文约 {formatPiAgentTokens(context.inputTokens)} / {formatPiAgentTokens(context.inputBudgetTokens)}{' '}
          Token（输入预算{context.compacted ? '，已压缩' : ''}）
        </span>
      ) : metrics.agentRunCount > 0 ? (
        <span className="basis-full">上下文未记录</span>
      ) : null}
    </div>
  );
}
