import {
  formatMoAgentDuration,
  formatMoAgentTokens,
  type MoAgentTurnMetrics,
} from '@/lib/chat/turn-metrics';

export default function TurnMetricsFooter({ metrics }: { metrics: MoAgentTurnMetrics }) {
  const approximate = metrics.tokenAccounting !== 'provider';

  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-slate-200/80 pt-2 text-[11px] leading-5 text-slate-500 tabular-nums"
      aria-label={`本轮耗时 ${formatMoAgentDuration(metrics.elapsedMs)}，Token 用量 ${formatMoAgentTokens(metrics.totalTokens)}`}
    >
      <span>本轮耗时 {formatMoAgentDuration(metrics.elapsedMs)}</span>
      <span aria-hidden="true">·</span>
      <span>
        Tokens {approximate ? '约 ' : ''}{formatMoAgentTokens(metrics.totalTokens)}
      </span>
      <span className="text-slate-400">
        （输入 {formatMoAgentTokens(metrics.inputTokens)} · 输出 {formatMoAgentTokens(metrics.outputTokens)}）
      </span>
      {metrics.tokenAccounting === 'partial' ? (
        <span className="text-amber-600">统计可能不完整</span>
      ) : null}
    </div>
  );
}
