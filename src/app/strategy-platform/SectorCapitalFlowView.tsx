"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  StrategyDashboardData,
  StrategySectorCapitalFlowDetail,
  StrategySectorCapitalFlowItem,
  StrategySectorCapitalFlowMarketSummary,
} from '@/lib/quant/strategy-types';
import {
  API_BASE,
  finiteNumber,
  formatLargeValue,
  formatNumberValue,
  formatPercentValue,
  formatSignedPercent,
  signedToneClass,
} from "./strategy-platform-helpers";

function sectorSignalLabel(signal: StrategySectorCapitalFlowItem["signal"]) {
  if (signal === "warming") return "资金升温";
  if (signal === "cooling") return "资金转冷";
  if (signal === "neutral") return "观察";
  return "样本不足";
}
function sectorSignalClass(signal: StrategySectorCapitalFlowItem["signal"]) {
  if (signal === "warming") return "border-red-200 bg-red-50 text-red-700";
  if (signal === "cooling") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (signal === "neutral") return "border-blue-200 bg-blue-50 text-blue-700";
  return "border-slate-200 bg-slate-50 text-slate-500";
}

function SectorTrendBars({ detail }: { detail: StrategySectorCapitalFlowDetail }) {
  const maxAmount = Math.max(
    ...detail.trend.map((point) => Math.abs(finiteNumber(point.proxyNetAmount) ?? 0)),
    1
  );
  const visibleTrend = detail.trend.slice(-20);
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-950">{detail.sector} 近段资金热度</p>
          <p className="mt-1 text-xs text-slate-500">方向额代理、上涨占比、涨停数按交易日聚合。</p>
        </div>
        <Badge variant="outline" className={sectorSignalClass(detail.item.signal)}>
          {sectorSignalLabel(detail.item.signal)}
        </Badge>
      </div>
      <div className="mt-4 flex h-44 items-end gap-1 overflow-x-auto border-b border-slate-100 pb-2">
        {visibleTrend.map((point) => {
          const net = finiteNumber(point.proxyNetAmount) ?? 0;
          const height = Math.max(6, Math.min(100, Math.abs(net) / maxAmount * 100));
          return (
            <div key={point.tradeDate} className="flex min-w-8 flex-1 flex-col items-center justify-end gap-1">
              <div
                className={cn("w-full rounded-t", net >= 0 ? "bg-red-400" : "bg-emerald-400")}
                style={{ height: `${height}%` }}
                title={`${point.tradeDate} 方向额 ${formatLargeValue(point.proxyNetAmount, 1)} / 上涨 ${formatPercentValue(point.risingRatio)}`}
              />
              <span className="text-[10px] tabular-nums text-slate-400">{point.tradeDate.slice(5)}</span>
            </div>
          );
        })}
        {!visibleTrend.length && (
          <div className="flex h-full flex-1 items-center justify-center text-sm text-slate-500">
            暂无趋势明细
          </div>
        )}
      </div>
    </div>
  );
}

export function SectorCapitalFlowView({ data }: { data: StrategyDashboardData }) {
  const primaryUniverse =
    data.research.universes.find((universe) => universe.id === data.research.primaryUniverseId) ??
    data.research.universes.find((universe) => universe.stockCount > 0) ??
    data.research.universes[0] ??
    null;
  const [selectedUniverseId, setSelectedUniverseId] = useState(primaryUniverse?.id ?? data.research.primaryUniverseId);
  const [items, setItems] = useState<StrategySectorCapitalFlowItem[]>([]);
  const [marketSummary, setMarketSummary] = useState<StrategySectorCapitalFlowMarketSummary | null>(null);
  const [selectedSector, setSelectedSector] = useState<string | null>(null);
  const [sectorDetail, setSectorDetail] = useState<StrategySectorCapitalFlowDetail | null>(null);
  const [proxyNote, setProxyNote] = useState("");
  const [cacheStatus, setCacheStatus] = useState("bypass");
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const selectedUniverse =
    data.research.universes.find((universe) => universe.id === selectedUniverseId) ??
    primaryUniverse;

  const loadSectorFlow = useCallback(async () => {
    if (!selectedUniverse) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/quant/strategies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sector-capital-flow",
          universeId: selectedUniverse.id,
          limit: 50,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error ?? "读取板块资金失败");
      }
      setItems((payload.data?.items ?? []) as StrategySectorCapitalFlowItem[]);
      setMarketSummary((payload.data?.marketSummary ?? null) as StrategySectorCapitalFlowMarketSummary | null);
      setProxyNote(String(payload.data?.proxyNote ?? ""));
      setCacheStatus(String(payload.data?.cacheStatus ?? "bypass"));
    } catch (loadError) {
      setItems([]);
      setMarketSummary(null);
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setIsLoading(false);
    }
  }, [selectedUniverse]);

  const loadSectorDetail = useCallback(async (sector: string) => {
    if (!selectedUniverse) return;
    setSelectedSector(sector);
    setIsLoadingDetail(true);
    setDetailError(null);
    try {
      const response = await fetch(`${API_BASE}/api/quant/strategies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sector-capital-flow",
          universeId: selectedUniverse.id,
          limit: 50,
          sector,
          detailDays: 20,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error ?? "读取板块详情失败");
      }
      setSectorDetail((payload.data?.detail ?? null) as StrategySectorCapitalFlowDetail | null);
    } catch (loadError) {
      setSectorDetail(null);
      setDetailError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setIsLoadingDetail(false);
    }
  }, [selectedUniverse]);

  useEffect(() => {
    setSelectedSector(null);
    setSectorDetail(null);
    void loadSectorFlow();
  }, [loadSectorFlow]);

  const leadingItems = items.slice(0, 6);
  const warmingCount = marketSummary?.warmingCount ?? items.filter((item) => item.signal === "warming").length;
  const totalProxyAmount = marketSummary?.proxyNetAmount ?? items.reduce((sum, item) => sum + (finiteNumber(item.proxyNetAmount) ?? 0), 0);

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-950">板块资金与主力动向</h2>
              <Badge variant="outline" className="bg-white text-slate-500">
                {items.length ? `${items.length} 个板块标签` : "等待数据"}
              </Badge>
              <Badge variant="outline" className="bg-white text-slate-500">
                缓存 {cacheStatus === "redis-hit" ? "Redis" : cacheStatus === "hit" ? "命中" : cacheStatus === "miss" ? "已刷新" : "直读"}
              </Badge>
              {isLoading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
            </div>
            <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-600">
              用本地 TimescaleDB 中的板块标签、成交额、换手、上涨占比和 20 日强弱，先构建板块资金热度代理；真实 DDE/主力净流入字段接入后再替换为资金流口径。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {data.research.universes.filter((universe) => universe.stockCount > 0).map((universe) => (
              <button
                key={universe.id}
                type="button"
                onClick={() => setSelectedUniverseId(universe.id)}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                  selectedUniverse?.id === universe.id
                    ? "border-blue-200 bg-blue-50 text-blue-700"
                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                )}
              >
                {universe.name}
              </button>
            ))}
            <Button variant="outline" size="sm" onClick={() => void loadSectorFlow()} disabled={isLoading}>
              <RefreshCcw className={cn("h-4 w-4", isLoading && "animate-spin")} />
              刷新
            </Button>
          </div>
        </div>

        {error && (
          <div className="border-b border-amber-100 bg-amber-50 px-5 py-3 text-sm text-amber-700">
            {error}
          </div>
        )}

        <div className="grid gap-3 border-b border-slate-100 px-5 py-4 md:grid-cols-4">
          <div className="rounded-md bg-slate-50 px-4 py-3">
            <p className="text-xs text-slate-500">升温板块</p>
            <p className="mt-1 text-xl font-bold tabular-nums text-slate-950">{warmingCount}</p>
          </div>
          <div className="rounded-md bg-slate-50 px-4 py-3">
            <p className="text-xs text-slate-500">全市场方向额代理</p>
            <p className={cn("mt-1 text-xl font-bold tabular-nums", signedToneClass(totalProxyAmount))}>
              {formatLargeValue(totalProxyAmount, 1)}
            </p>
          </div>
          <div className="rounded-md bg-slate-50 px-4 py-3">
            <p className="text-xs text-slate-500">全市场上涨占比</p>
            <p className={cn("mt-1 text-xl font-bold tabular-nums", signedToneClass((marketSummary?.risingRatio ?? 50) - 50))}>
              {formatPercentValue(marketSummary?.risingRatio)}
            </p>
          </div>
          <div className="rounded-md bg-slate-50 px-4 py-3">
            <p className="text-xs text-slate-500">全市场量能比</p>
            <p className="mt-1 text-xl font-bold tabular-nums text-slate-950">
              {finiteNumber(marketSummary?.amountRatio20d) === null ? "-" : `${formatNumberValue(marketSummary?.amountRatio20d, 2)}x`}
            </p>
          </div>
        </div>

        {marketSummary?.analysis?.length ? (
          <div className="grid gap-3 border-b border-slate-100 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-semibold text-slate-950">全市场资金流量分析</p>
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                {marketSummary.analysis.map((line, index) => (
                  <p key={`${line}-${index}`} className="rounded-md bg-white px-3 py-2 text-sm leading-6 text-slate-600">
                    {line}
                  </p>
                ))}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <p className="text-sm font-semibold text-slate-950">强弱方向</p>
              <div className="mt-3 grid gap-3 text-sm">
                <div>
                  <span className="text-xs text-slate-400">强势板块</span>
                  <p className="mt-1 text-slate-700">{marketSummary.strongestSectors.join("、") || "-"}</p>
                </div>
                <div>
                  <span className="text-xs text-slate-400">弱势板块</span>
                  <p className="mt-1 text-slate-700">{marketSummary.weakestSectors.join("、") || "-"}</p>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="grid gap-4 px-5 py-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="overflow-x-auto rounded-md border border-slate-200">
            <table className="w-full min-w-[1120px] text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">板块</th>
                  <th className="px-3 py-3 font-medium">信号</th>
                  <th className="px-3 py-3 font-medium">方向成交额代理</th>
                  <th className="px-3 py-3 font-medium">最新成交额</th>
                  <th className="px-3 py-3 font-medium">量能比</th>
                  <th className="px-3 py-3 font-medium">上涨占比</th>
                  <th className="px-3 py-3 font-medium">20日强弱</th>
                  <th className="px-3 py-3 font-medium">换手</th>
                  <th className="px-3 py-3 font-medium">样本</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((item) => (
                  <tr
                    key={item.sector}
                    onClick={() => void loadSectorDetail(item.sector)}
                    className={cn(
                      "cursor-pointer align-top transition-colors hover:bg-slate-50",
                      selectedSector === item.sector && "bg-blue-50/70"
                    )}
                  >
                    <td className="px-4 py-3">
                      <p className="font-semibold text-slate-950">{item.sector}</p>
                      <p className="mt-1 text-xs text-slate-400">
                        {item.coveredCount}/{item.memberCount} 已覆盖 · 涨停 {item.limitUpCount} · 跌停 {item.limitDownCount}
                      </p>
                    </td>
                    <td className="px-3 py-3">
                      <Badge variant="outline" className={sectorSignalClass(item.signal)}>
                        {sectorSignalLabel(item.signal)}
                      </Badge>
                    </td>
                    <td className="px-3 py-3">
                      <p className={cn("font-semibold tabular-nums", signedToneClass(item.proxyNetAmount))}>
                        {formatLargeValue(item.proxyNetAmount, 1)}
                      </p>
                      <p className="mt-1 text-xs text-slate-400">
                        净额占比 {formatPercentValue(item.netAmountRatio)}
                      </p>
                    </td>
                    <td className="px-3 py-3 font-semibold tabular-nums text-slate-900">
                      {formatLargeValue(item.latestAmount, 1)}
                    </td>
                    <td className="px-3 py-3 font-semibold tabular-nums text-slate-900">
                      {finiteNumber(item.amountRatio20d) === null ? "-" : `${formatNumberValue(item.amountRatio20d, 2)}x`}
                    </td>
                    <td className="px-3 py-3">
                      <p className="font-semibold tabular-nums text-slate-900">{formatPercentValue(item.risingRatio)}</p>
                      <p className="mt-1 text-xs text-slate-400">{item.risingCount} 涨 / {item.fallingCount} 跌</p>
                    </td>
                    <td className={cn("px-3 py-3 font-semibold tabular-nums", signedToneClass(item.strength20dPct))}>
                      {formatSignedPercent(item.strength20dPct)}
                    </td>
                    <td className="px-3 py-3 font-semibold tabular-nums text-slate-900">
                      {formatPercentValue(item.avgTurnover20d)}
                    </td>
                    <td className="px-3 py-3">
                      <p className="line-clamp-2 max-w-[220px] text-xs leading-5 text-slate-500">
                        {item.topSymbols.join("、") || "-"}
                      </p>
                    </td>
                  </tr>
                ))}
                {!items.length && (
                  <tr>
                    <td colSpan={9} className="px-5 py-12 text-center text-sm text-slate-500">
                      {isLoading ? "正在读取板块资金代理..." : "暂无板块资金数据"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <aside className="space-y-3">
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <p className="text-sm font-semibold text-slate-950">如何探查主力资金</p>
              <div className="mt-3 space-y-3 text-sm leading-6 text-slate-600">
                <p><span className="font-semibold text-slate-900">先看板块：</span>板块内多数股票上涨、成交额放大且 20 日强弱转正，说明资金不是孤立拉一只票。</p>
                <p><span className="font-semibold text-slate-900">再看龙头：</span>涨停数、成交额排名和强弱排名同步靠前，才更像主动资金聚集。</p>
                <p><span className="font-semibold text-slate-900">最后看连续性：</span>DDE/主力净流入至少观察 3 日，单日大额流入可能是对倒或出货。</p>
              </div>
            </div>
            <div className="rounded-lg border border-amber-100 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-900">当前口径说明</p>
              <p className="mt-2 text-sm leading-6 text-amber-800">
                {proxyNote || "当前为成交额、换手、上涨占比和20日强弱聚合出的资金热度代理，不是 DDE/主力净流入真实字段。"}
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <p className="text-sm font-semibold text-slate-950">后续真实字段</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {["主力净流入", "超大单净额", "大单净额", "DDE 大单金额", "DDE 大单净量", "3/5日资金连续性"].map((item) => (
                  <Badge key={item} variant="outline" className="border-blue-100 bg-blue-50 text-blue-700">
                    {item}
                  </Badge>
                ))}
              </div>
            </div>
          </aside>
        </div>

        {(selectedSector || isLoadingDetail || detailError) && (
          <div className="border-t border-slate-100 px-5 py-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">板块详情</p>
                <p className="mt-1 text-sm text-slate-500">
                  {selectedSector ? `当前查看：${selectedSector}` : "点击任一板块查看资金热度趋势和龙头贡献。"}
                </p>
              </div>
              {isLoadingDetail && (
                <span className="inline-flex items-center gap-2 text-sm text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在读取板块详情
                </span>
              )}
            </div>
            {detailError && (
              <div className="mb-4 rounded-md border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                {detailError}
              </div>
            )}
            {sectorDetail && (
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
                <SectorTrendBars detail={sectorDetail} />
                <div className="space-y-4">
                  <div className="rounded-lg border border-slate-200 bg-white p-4">
                    <p className="text-sm font-semibold text-slate-950">详情解读</p>
                    <div className="mt-3 space-y-2">
                      {sectorDetail.analysis.map((line, index) => (
                        <p key={`${line}-${index}`} className="text-sm leading-6 text-slate-600">{line}</p>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-white p-4">
                    <p className="text-sm font-semibold text-slate-950">成交额贡献靠前</p>
                    <div className="mt-3 space-y-2">
                      {sectorDetail.topMembers.slice(0, 8).map((member) => (
                        <div key={member.symbol} className="flex items-center justify-between gap-3 rounded-md bg-slate-50 px-3 py-2 text-sm">
                          <div className="min-w-0">
                            <p className="truncate font-medium text-slate-900">{member.name ?? member.symbol}</p>
                            <p className="font-mono text-xs text-slate-400">{member.symbol}</p>
                          </div>
                          <div className="text-right">
                            <p className={cn("font-semibold tabular-nums", signedToneClass(member.latestChangePercent))}>
                              {formatSignedPercent(member.latestChangePercent)}
                            </p>
                            <p className="text-xs tabular-nums text-slate-500">{formatLargeValue(member.latestAmount, 1)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {leadingItems.length > 0 && (
          <div className="border-t border-slate-100 px-5 py-4">
            <p className="text-sm font-semibold text-slate-900">当前最值得关注的板块</p>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              {leadingItems.map((item) => (
                <div key={item.sector} className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-slate-950">{item.sector}</p>
                    <Badge variant="outline" className={sectorSignalClass(item.signal)}>
                      {sectorSignalLabel(item.signal)}
                    </Badge>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <span className="text-slate-400">方向额</span>
                      <p className={cn("font-semibold tabular-nums", signedToneClass(item.proxyNetAmount))}>
                        {formatLargeValue(item.proxyNetAmount, 1)}
                      </p>
                    </div>
                    <div>
                      <span className="text-slate-400">强弱</span>
                      <p className={cn("font-semibold tabular-nums", signedToneClass(item.strength20dPct))}>
                        {formatSignedPercent(item.strength20dPct)}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
