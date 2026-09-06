"use client";

import { useMemo, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import type {
  StrategyDashboardData,
  StrategyFactorDefinition,
  StrategyFoundationComponent,
} from '@/lib/quant/strategy-types';
import { API_BASE } from "./strategy-platform-helpers";

function foundationStatusLabel(status: StrategyFoundationComponent["status"]) {
  if (status === "ready") return "已就绪";
  if (status === "missing") return "缺失";
  return "部分就绪";
}
function foundationStatusClass(status: StrategyFoundationComponent["status"]) {
  if (status === "ready") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "missing") return "border-red-200 bg-red-50 text-red-700";
  return "border-amber-200 bg-amber-50 text-amber-700";
}

function factorStatusClass(status: string) {
  if (status === "active") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "partial") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "planned") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function factorCategoryLabel(category: string) {
  const labels: Record<string, string> = {
    technical: "技术指标",
    liquidity: "流动性",
    event: "事件",
    capital_flow: "资金流",
    valuation: "估值",
    momentum: "动量",
    risk: "风险",
    quality: "质量",
    growth: "成长",
  };
  return labels[category] ?? category;
}

export function FoundationView({
  data,
  onRefresh,
}: {
  data: StrategyDashboardData;
  onRefresh: () => Promise<void>;
}) {
  const [isScanning, setIsScanning] = useState(false);
  const [scan, setScan] = useState(data.foundation.latestQualityScan ?? null);
  const [error, setError] = useState<string | null>(null);
  const factorGroups = useMemo(() => {
    const groups = new Map<string, StrategyFactorDefinition[]>();
    for (const factor of data.foundation.factors) {
      const list = groups.get(factor.category) ?? [];
      list.push(factor);
      groups.set(factor.category, list);
    }
    return Array.from(groups.entries());
  }, [data.foundation.factors]);
  const lastOpenDay = data.foundation.calendarDays.filter((item) => item.isOpen).at(-1);

  const runScan = async () => {
    setIsScanning(true);
    setError(null);
    try {
      const universeId = data.research.primaryUniverseId;
      const response = await fetch(`${API_BASE}/api/quant/strategies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "data-quality-scan",
          universeId,
          lookbackYears: data.research.ingestionPlan.lookbackYears,
          timeframe: data.research.ingestionPlan.timeframe,
          adjustment: data.research.ingestionPlan.adjustment,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error ?? "数据质量扫描失败");
      setScan(payload.data);
      await onRefresh();
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : String(scanError));
    } finally {
      setIsScanning(false);
    }
  };

  return (
    <div className="space-y-4">
      {data.foundation.error && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {data.foundation.error}
        </div>
      )}

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {data.foundation.components.map((component) => (
          <div key={component.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-950">{component.name}</p>
                <p className="mt-2 text-2xl font-bold tabular-nums text-slate-950">{component.count.toLocaleString()}</p>
              </div>
              <Badge variant="outline" className={foundationStatusClass(component.status)}>
                {foundationStatusLabel(component.status)}
              </Badge>
            </div>
            <p className="mt-3 min-h-10 text-xs leading-5 text-slate-500">{component.detail ?? "-"}</p>
          </div>
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(420px,0.9fr)]">
        <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-950">数据质量扫描</h3>
              <p className="mt-1 text-xs text-slate-500">检查缺 K、最新交易日、成交额、换手率、停牌/ST 和涨跌停字段。</p>
            </div>
            <Button size="sm" onClick={runScan} disabled={isScanning}>
              {isScanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              运行扫描
            </Button>
          </div>
          {error && <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
          {scan ? (
            <div className="space-y-4 p-4">
              <div className="grid gap-3 sm:grid-cols-5">
                {[
                  { label: "检查标的", value: scan.checkedSymbols },
                  { label: "通过", value: scan.passedSymbols },
                  { label: "警告", value: scan.warningSymbols },
                  { label: "失败", value: scan.failedSymbols },
                  { label: "问题", value: scan.issueCount },
                ].map((item) => (
                  <div key={item.label} className="rounded-md bg-slate-50 px-3 py-2">
                    <p className="text-xs text-slate-500">{item.label}</p>
                    <p className="mt-1 text-lg font-bold tabular-nums text-slate-950">{item.value.toLocaleString()}</p>
                  </div>
                ))}
              </div>
              <div className="overflow-hidden rounded-md border border-slate-200">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">标的</th>
                      <th className="px-3 py-2 font-medium">级别</th>
                      <th className="px-3 py-2 font-medium">类型</th>
                      <th className="px-3 py-2 font-medium">说明</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {scan.issues.slice(0, 12).map((issue, index) => (
                      <tr key={`${issue.symbol ?? "market"}-${issue.issueType}-${index}`}>
                        <td className="px-3 py-2 font-mono text-xs text-slate-700">
                          {issue.name ? `${issue.name} ` : ""}{issue.symbol ?? "-"}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant="outline" className={
                            issue.severity === "error"
                              ? "border-red-200 bg-red-50 text-red-700"
                              : issue.severity === "warning"
                                ? "border-amber-200 bg-amber-50 text-amber-700"
                                : "border-emerald-200 bg-emerald-50 text-emerald-700"
                          }>
                            {issue.severity}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-slate-600">{issue.issueType}</td>
                        <td className="px-3 py-2 text-slate-600">{issue.message}</td>
                      </tr>
                    ))}
                    {!scan.issues.length && (
                      <tr>
                        <td className="px-3 py-6 text-center text-slate-500" colSpan={4}>
                          当前扫描未发现关键问题
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <EmptyState title="尚未运行数据质量扫描" description="运行一次扫描后会归档到后端数据质量组件" className="border-0" />
          )}
        </div>

        <div className="space-y-4">
          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-950">交易日历</h3>
                <p className="mt-1 text-xs text-slate-500">
                  {lastOpenDay ? `最新开市日 ${lastOpenDay.tradeDate}` : "暂无独立交易日历，回退到 K 线日期推断"}
                </p>
              </div>
              <Badge variant="outline" className="bg-white text-slate-500">
                {data.foundation.calendarDays.length} 日
              </Badge>
            </div>
            <div className="mt-4 grid grid-cols-5 gap-2">
              {data.foundation.calendarDays.slice(-15).map((day) => (
                <div key={`${day.market}-${day.tradeDate}`} className={cn(
                  "rounded-md border px-2 py-2 text-center text-xs",
                  day.isOpen ? "border-emerald-100 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-400"
                )}>
                  <p className="font-mono">{day.tradeDate.slice(5)}</p>
                  <p className="mt-1">{day.source === "stock_bars-inferred" ? "推断" : day.isOpen ? "开市" : "休市"}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-950">因子定义仓库</h3>
              <p className="mt-1 text-xs text-slate-500">策略目录和首页对话优先读取这些口径说明。</p>
            </div>
            <div className="max-h-[520px] overflow-y-auto p-4">
              {factorGroups.length ? (
                <div className="space-y-4">
                  {factorGroups.map(([category, factors]) => (
                    <div key={category}>
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs font-semibold text-slate-500">{factorCategoryLabel(category)}</p>
                        <span className="text-xs tabular-nums text-slate-400">{factors.length}</span>
                      </div>
                      <div className="space-y-2">
                        {factors.map((factor) => (
                          <div key={factor.factorKey} className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2">
                            <div className="flex items-center justify-between gap-2">
                              <p className="font-semibold text-slate-900">{factor.name}</p>
                              <Badge variant="outline" className={factorStatusClass(factor.status)}>
                                {factor.status}
                              </Badge>
                            </div>
                            <p className="mt-1 text-xs leading-5 text-slate-500">{factor.description}</p>
                            {factor.formula && (
                              <code className="mt-2 block rounded bg-white px-2 py-1 font-mono text-[11px] text-slate-600">
                                {factor.formula}
                              </code>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState title="暂无因子定义" description="执行 db:init 后会登记核心因子口径" className="border-0" />
              )}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}
