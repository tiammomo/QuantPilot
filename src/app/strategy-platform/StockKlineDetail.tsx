"use client";

import { type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  StrategyDividendEvent,
  StrategyLocalKlineBar,
  StrategyLocalKlineResponse,
  StrategyRealtimeQuote,
  StrategyUniverse,
  StrategyUniverseMember,
} from "@/lib/quant/strategies";
import {
  API_BASE,
  finiteNumber,
  formatDataDate,
  formatDateTime,
  formatIntradayTime,
  formatLargeValue,
  formatNumberValue,
  formatPercentValue,
  formatSignedNumberValue,
  formatSignedPercent,
  signedToneClass,
} from "./strategy-platform-helpers";

const KLINE_TIMEFRAMES = [
  { id: "realtime", label: "实时" },
  { id: "daily", label: "日线" },
  { id: "weekly", label: "周线" },
  { id: "monthly", label: "月线" },
] as const;
type KlineTimeframe = (typeof KLINE_TIMEFRAMES)[number]["id"];
const MOVING_AVERAGE_CONFIGS = [
  { period: 5, label: "MA5", color: "#2563eb", textClass: "text-blue-600" },
  { period: 10, label: "MA10", color: "#16a34a", textClass: "text-emerald-600" },
  { period: 20, label: "MA20", color: "#d97706", textClass: "text-amber-600" },
  { period: 30, label: "MA30", color: "#db2777", textClass: "text-pink-600" },
  { period: 60, label: "MA60", color: "#7c3aed", textClass: "text-violet-600" },
] as const;

function klineTimeframeLabel(value: string) {
  return KLINE_TIMEFRAMES.find((option) => option.id === value)?.label ?? value;
}

function klineFetchLimit(timeframe: KlineTimeframe) {
  if (timeframe === "realtime") return 0;
  if (timeframe === "daily") return 1260;
  if (timeframe === "weekly") return 260;
  return 120;
}

const KLINE_DETAIL_CACHE_TTL_MS = 60 * 1000;
const KLINE_DETAIL_CACHE_MAX = 96;
const REALTIME_QUOTE_REFRESH_MS = 15 * 1000;
const klineDetailCache = new Map<string, { data: StrategyLocalKlineResponse; expiresAt: number }>();
const klineDetailPromises = new Map<string, Promise<StrategyLocalKlineResponse>>();
const dividendEventsCache = new Map<string, { data: StrategyDividendEvent[]; expiresAt: number }>();
const dividendEventsPromises = new Map<string, Promise<StrategyDividendEvent[]>>();

function setBoundedCacheValue<T>(cache: Map<string, { data: T; expiresAt: number }>, key: string, data: T) {
  cache.set(key, { data, expiresAt: Date.now() + KLINE_DETAIL_CACHE_TTL_MS });
  while (cache.size > KLINE_DETAIL_CACHE_MAX) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

function getFreshCacheValue<T>(cache: Map<string, { data: T; expiresAt: number }>, key: string) {
  const cached = cache.get(key);
  if (!cached) return null;
  if (cached.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return cached.data;
}

function klineDetailCacheKey(symbol: string, timeframe: KlineTimeframe, adjustment: string) {
  return `${symbol}::${timeframe}::${adjustment}`;
}

function dividendEventsCacheKey(symbol: string) {
  return `${symbol}::dividends`;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function movingAverageSeries(bars: StrategyLocalKlineBar[], period: number) {
  let sum = 0;
  return bars.map((bar, index) => {
    sum += bar.close;
    if (index >= period) {
      sum -= bars[index - period].close;
    }
    return index >= period - 1 ? sum / period : null;
  });
}

function movingAverageAtIndex(bars: StrategyLocalKlineBar[], period: number, index: number) {
  if (index < period - 1) return null;
  const window = bars.slice(index - period + 1, index + 1);
  if (window.length < period || window.some((bar) => finiteNumber(bar.close) === null)) return null;
  return window.reduce((sum, bar) => sum + bar.close, 0) / period;
}

function returnPctForBar(bars: StrategyLocalKlineBar[], index: number) {
  const directValue = finiteNumber(bars[index]?.changePercent);
  if (directValue !== null) return directValue;
  const current = finiteNumber(bars[index]?.close);
  const previous = finiteNumber(bars[index]?.previousClose) ?? finiteNumber(bars[index - 1]?.close);
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function normalizedTradeDate(value?: string | null) {
  const formatted = formatDataDate(value);
  return formatted === "-" ? null : formatted;
}

function dateKeyToTime(dateKey?: string | null) {
  if (!dateKey) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return null;
  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

function dateKeyToWeekKey(dateKey: string) {
  const time = dateKeyToTime(dateKey);
  if (time === null) return dateKey;
  const date = new Date(time);
  const day = date.getUTCDay();
  const mondayOffset = (day + 6) % 7;
  const monday = new Date(time - mondayOffset * 24 * 60 * 60 * 1000);
  return monday.toISOString().slice(0, 10);
}

function klineAggregationKey(bar: StrategyLocalKlineBar, timeframe: KlineTimeframe) {
  const dateKey = normalizedTradeDate(bar.ts);
  if (!dateKey) return bar.ts;
  if (timeframe === "monthly") return dateKey.slice(0, 7);
  if (timeframe === "weekly") return dateKeyToWeekKey(dateKey);
  return dateKey;
}

function aggregateKlineBars(bars: StrategyLocalKlineBar[], timeframe: KlineTimeframe) {
  if (timeframe === "daily" || timeframe === "realtime") return bars;
  const grouped = new Map<string, StrategyLocalKlineBar[]>();
  for (const bar of bars) {
    const key = klineAggregationKey(bar, timeframe);
    const group = grouped.get(key) ?? [];
    group.push(bar);
    grouped.set(key, group);
  }

  return Array.from(grouped.values()).map((group) => {
    const sorted = group.slice().sort((left, right) => {
      const leftTime = new Date(left.ts).getTime();
      const rightTime = new Date(right.ts).getTime();
      return leftTime - rightTime;
    });
    const first = sorted[0];
    const last = sorted.at(-1) ?? first;
    const high = Math.max(...sorted.map((bar) => bar.high));
    const low = Math.min(...sorted.map((bar) => bar.low));
    const volume = sorted.reduce((sum, bar) => sum + bar.volume, 0);
    const amountValues = sorted.map((bar) => finiteNumber(bar.amount)).filter((value): value is number => value !== null);
    const amount = amountValues.length ? amountValues.reduce((sum, value) => sum + value, 0) : null;
    const previousClose = finiteNumber(first.previousClose);
    const changeAmount = previousClose !== null ? last.close - previousClose : null;
    const changePercent = previousClose !== null && previousClose !== 0 ? (changeAmount! / previousClose) * 100 : null;
    const amplitude = previousClose !== null && previousClose !== 0 ? ((high - low) / previousClose) * 100 : null;
    return {
      ...last,
      ts: last.ts,
      open: first.open,
      high,
      low,
      close: last.close,
      previousClose,
      volume,
      amount,
      amplitude,
      changeAmount,
      changePercent,
      turnover: null,
      limitUp: null,
      limitDown: null,
      metadata: {},
    };
  });
}

function buildKlineSummary(bars: StrategyLocalKlineBar[], rowCount = bars.length): StrategyLocalKlineResponse["summary"] {
  const latest = bars.at(-1);
  const previous = bars.at(-2);
  const previousClose = finiteNumber(previous?.close) ?? finiteNumber(latest?.previousClose);
  const totalAmountValues = bars.map((bar) => finiteNumber(bar.amount)).filter((value): value is number => value !== null);
  return {
    rowCount,
    firstTs: bars[0]?.ts ?? null,
    lastTs: latest?.ts ?? null,
    latestClose: latest?.close ?? null,
    previousClose,
    returnPct:
      latest && previousClose !== null && previousClose !== 0
        ? ((latest.close - previousClose) / previousClose) * 100
        : null,
    high: bars.length ? Math.max(...bars.map((bar) => bar.high)) : null,
    low: bars.length ? Math.min(...bars.map((bar) => bar.low)) : null,
    totalVolume: bars.reduce((sum, bar) => sum + bar.volume, 0),
    totalAmount: totalAmountValues.length ? totalAmountValues.reduce((sum, value) => sum + value, 0) : null,
  };
}

function deriveKlineResponse(
  dailyDetail: StrategyLocalKlineResponse,
  timeframe: KlineTimeframe,
  limit: number
): StrategyLocalKlineResponse {
  if (timeframe === "realtime") return dailyDetail;
  if (timeframe === "daily") {
    const bars = dailyDetail.bars.slice(-limit).map((bar) => ({ ...bar, metadata: {} }));
    const windowSummary = buildKlineSummary(bars);
    return {
      ...dailyDetail,
      timeframe,
      bars,
      summary: {
        ...dailyDetail.summary,
        high: windowSummary.high,
        low: windowSummary.low,
        totalVolume: windowSummary.totalVolume,
        totalAmount: windowSummary.totalAmount,
      },
    };
  }
  const allBars = aggregateKlineBars(dailyDetail.bars, timeframe);
  const bars = allBars.slice(-limit);
  return {
    ...dailyDetail,
    timeframe,
    bars,
    summary: buildKlineSummary(bars, allBars.length),
  };
}

function readCachedKlineDetail(symbol: string, timeframe: KlineTimeframe, adjustment: string) {
  return getFreshCacheValue(klineDetailCache, klineDetailCacheKey(symbol, timeframe, adjustment));
}

async function fetchDailyKlineDetail(symbol: string, adjustment: string): Promise<StrategyLocalKlineResponse> {
  const response = await fetch(`${API_BASE}/api/quant/strategies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "symbol-bars",
      symbol,
      timeframe: "daily",
      adjustment,
      limit: klineFetchLimit("daily"),
      includeMetadata: false,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error(payload.error ?? "读取 K 线失败");
  return deriveKlineResponse(payload.data as StrategyLocalKlineResponse, "daily", klineFetchLimit("daily"));
}

async function loadCachedKlineDetail(
  symbol: string,
  timeframe: KlineTimeframe,
  adjustment: string
): Promise<StrategyLocalKlineResponse> {
  const key = klineDetailCacheKey(symbol, timeframe, adjustment);
  const cached = getFreshCacheValue(klineDetailCache, key);
  if (cached) return cached;
  const inFlight = klineDetailPromises.get(key);
  if (inFlight) return inFlight;

  const promise: Promise<StrategyLocalKlineResponse> = (async (): Promise<StrategyLocalKlineResponse> => {
    const data: StrategyLocalKlineResponse = timeframe === "daily"
      ? await fetchDailyKlineDetail(symbol, adjustment)
      : deriveKlineResponse(
          await loadCachedKlineDetail(symbol, "daily", adjustment),
          timeframe,
          klineFetchLimit(timeframe)
        );
    setBoundedCacheValue(klineDetailCache, key, data);
    return data;
  })();

  klineDetailPromises.set(key, promise);
  try {
    return await promise;
  } finally {
    klineDetailPromises.delete(key);
  }
}

async function loadCachedDividendEvents(symbol: string) {
  const key = dividendEventsCacheKey(symbol);
  const cached = getFreshCacheValue(dividendEventsCache, key);
  if (cached) return cached;
  const inFlight = dividendEventsPromises.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const response = await fetch(`${API_BASE}/api/quant/strategies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "symbol-dividends",
        symbol,
        limit: 40,
      }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.error ?? "读取分红事件失败");
    const events = (payload.data?.events ?? []) as StrategyDividendEvent[];
    setBoundedCacheValue(dividendEventsCache, key, events);
    return events;
  })();

  dividendEventsPromises.set(key, promise);
  try {
    return await promise;
  } finally {
    dividendEventsPromises.delete(key);
  }
}

function strategyApiErrorMessage(payload: unknown, fallback: string) {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const message = typeof record.message === "string" ? record.message.trim() : "";
  const error = typeof record.error === "string" ? record.error.trim() : "";
  return message || error || fallback;
}

async function fetchRealtimeQuote(symbol: string): Promise<StrategyRealtimeQuote> {
  const response = await fetch(`${API_BASE}/api/quant/strategies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "realtime-quote",
      symbol,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error(strategyApiErrorMessage(payload, "读取实时行情失败"));
  return payload.data as StrategyRealtimeQuote;
}

async function fetchIntradayBars(symbol: string, options?: { forceRefresh?: boolean }): Promise<StrategyLocalKlineResponse> {
  const response = await fetch(`${API_BASE}/api/quant/strategies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "intraday-bars",
      symbol,
      period: "minute1",
      limit: 260,
      refresh: options?.forceRefresh === true,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error(strategyApiErrorMessage(payload, "读取分时行情失败"));
  return payload.data as StrategyLocalKlineResponse;
}

function resolveDividendMarkerIndex(
  visibleBars: StrategyLocalKlineBar[],
  eventDateKey: string,
  timeframe: KlineTimeframe
) {
  const barDateKeys = visibleBars.map((bar) => normalizedTradeDate(bar.ts));
  const exactIndex = barDateKeys.findIndex((dateKey) => dateKey === eventDateKey);
  if (exactIndex >= 0) return exactIndex;

  const eventTime = dateKeyToTime(eventDateKey);
  if (eventTime === null) return -1;

  const barTimes = barDateKeys.map(dateKeyToTime);
  const oneDay = 24 * 60 * 60 * 1000;

  if (timeframe === "daily") {
    return barTimes.findIndex((barTime) =>
      barTime !== null && barTime >= eventTime && barTime - eventTime <= oneDay * 4
    );
  }

  const maxWindow = timeframe === "weekly" ? oneDay * 10 : oneDay * 35;
  for (let index = 0; index < barTimes.length; index += 1) {
    const current = barTimes[index];
    if (current === null || current < eventTime) continue;
    const previous = index > 0 ? barTimes[index - 1] : null;
    const isInBucket = previous === null
      ? current - eventTime <= maxWindow
      : eventTime > previous && eventTime <= current;
    if (isInBucket) return index;
  }

  return -1;
}

function limitThresholdForSymbol(symbol: string, name?: string | null, exchange?: string | null) {
  const code = symbol.split(".", 1)[0];
  if ((name ?? "").toUpperCase().includes("ST")) return 5;
  if (exchange === "BJ" || code.startsWith("4") || code.startsWith("8")) return 30;
  if (code.startsWith("300") || code.startsWith("301") || code.startsWith("688")) return 20;
  return 10;
}

function limitMarkerForBar(
  bar: StrategyLocalKlineBar,
  threshold: number,
  timeframe: KlineTimeframe
): "up" | "down" | null {
  if (timeframe !== "daily") return null;
  if (bar.limitUp) return "up";
  if (bar.limitDown) return "down";
  const changePercent = finiteNumber(bar.changePercent);
  if (changePercent === null) return null;
  const tolerance = threshold >= 20 ? 0.12 : 0.06;
  if (changePercent >= threshold - tolerance) return "up";
  if (changePercent <= -threshold + tolerance) return "down";
  return null;
}

function svgPointFromPointer(event: PointerEvent<SVGSVGElement>) {
  const svg = event.currentTarget;
  const screenMatrix = svg.getScreenCTM();
  if (!screenMatrix) return null;
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(screenMatrix.inverse());
}

function KlineMiniChart({
  bars,
  dividendEvents,
  symbol,
  name,
  exchange,
  timeframe,
  selectedBarTs,
  onSelectBar,
  onResetSelection,
}: {
  bars: StrategyLocalKlineBar[];
  dividendEvents: StrategyDividendEvent[];
  symbol: string;
  name?: string | null;
  exchange?: string | null;
  timeframe: KlineTimeframe;
  selectedBarTs?: string | null;
  onSelectBar?: (bar: StrategyLocalKlineBar) => void;
  onResetSelection?: () => void;
}) {
  const cleanBars = useMemo(
    () => bars.filter((bar) =>
      [bar.open, bar.high, bar.low, bar.close, bar.volume].every(
        (value) => typeof value === "number" && Number.isFinite(value)
      )
    ),
    [bars]
  );
  const visibleCount = Math.min(90, cleanBars.length);
  const maxStartIndex = Math.max(0, cleanBars.length - visibleCount);
  const [startIndex, setStartIndex] = useState(maxStartIndex);
  const dragRef = useRef<{ x: number; startIndex: number; hasMoved: boolean } | null>(null);
  const resolvedStartIndex = clampNumber(startIndex, 0, maxStartIndex);
  const visibleBars = cleanBars.slice(resolvedStartIndex, resolvedStartIndex + visibleCount);
  const selectedVisibleIndex = visibleBars.findIndex((bar) => bar.ts === selectedBarTs);
  const averages = useMemo(
    () => MOVING_AVERAGE_CONFIGS.map((config) => ({
      ...config,
      values: movingAverageSeries(cleanBars, config.period),
    })),
    [cleanBars]
  );
  const visibleAverages = averages.map((average) => ({
    ...average,
    values: average.values.slice(resolvedStartIndex, resolvedStartIndex + visibleCount),
  }));
  const activeVisibleAverages = visibleAverages.filter((average) =>
    average.values.some((value) => finiteNumber(value) !== null)
  );
  const dividendMarkersByIndex = useMemo(() => {
    const map = new Map<number, StrategyDividendEvent[]>();
    for (const event of dividendEvents) {
      const date = normalizedTradeDate(event.exDividendDate);
      if (!date) continue;
      const index = resolveDividendMarkerIndex(visibleBars, date, timeframe);
      if (index < 0) continue;
      const events = map.get(index) ?? [];
      events.push(event);
      map.set(index, events);
    }
    return map;
  }, [dividendEvents, timeframe, visibleBars]);

  useEffect(() => {
    setStartIndex(maxStartIndex);
  }, [maxStartIndex, bars]);

  if (!visibleBars.length) {
    return (
      <div className="flex h-[340px] items-center justify-center rounded-md border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500">
        暂无可展示的 K 线样本
      </div>
    );
  }

  const width = 1320;
  const height = 360;
  const left = 66;
  const right = 24;
  const chartTop = 24;
  const chartHeight = 220;
  const volumeTop = 278;
  const volumeHeight = 42;
  const dateLabelY = height - 10;
  const chartWidth = width - left - right;
  const priceValues = [
    ...visibleBars.flatMap((bar) => [bar.high, bar.low]),
    ...visibleAverages.flatMap((average) => average.values).filter((value): value is number => value !== null),
  ];
  const highest = Math.max(...priceValues);
  const lowest = Math.min(...priceValues);
  const priceRange = Math.max(highest - lowest, 0.01);
  const maxVolume = Math.max(...visibleBars.map((bar) => bar.volume), 1);
  const step = chartWidth / visibleBars.length;
  const candleWidth = Math.max(3, Math.min(10, step * 0.55));
  const priceY = (price: number) => chartTop + ((highest - price) / priceRange) * chartHeight;
  const limitThreshold = limitThresholdForSymbol(symbol, name, exchange);
  const buildAveragePath = (values: Array<number | null>) =>
    values.reduce((path, value, index) => {
      if (value === null) return path;
      const x = left + index * step + step / 2;
      const y = priceY(value);
      return `${path}${path ? " L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
    }, "");
  const rangeLeftPct = cleanBars.length ? (resolvedStartIndex / cleanBars.length) * 100 : 0;
  const rangeWidthPct = cleanBars.length ? (visibleBars.length / cleanBars.length) * 100 : 100;
  const visibleIndexFromLocalPoint = (localPoint: { x: number; y: number } | null) => {
    if (!localPoint || !visibleBars.length) return -1;
    const localX = localPoint.x;
    const localY = localPoint.y;
    if (localX < left || localX > width - right || localY < chartTop || localY > volumeTop + volumeHeight) {
      return -1;
    }
    const rawIndex = Math.round((localX - left - step / 2) / step);
    return clampNumber(rawIndex, 0, visibleBars.length - 1);
  };
  const visibleIndexFromPointer = (event: PointerEvent<SVGSVGElement>) =>
    visibleIndexFromLocalPoint(svgPointFromPointer(event));
  const selectBarFromPointer = (event: PointerEvent<SVGSVGElement>) => {
    const index = visibleIndexFromPointer(event);
    const bar = index >= 0 ? visibleBars[index] : null;
    if (bar) {
      onSelectBar?.(bar);
    } else {
      onResetSelection?.();
    }
  };
  const moveByDelta = (localX: number) => {
    if (!dragRef.current || !maxStartIndex) return;
    const deltaBars = Math.round((localX - dragRef.current.x) / Math.max(1, step));
    setStartIndex(clampNumber(dragRef.current.startIndex - deltaBars, 0, maxStartIndex));
  };
  const handlePointerDown = (event: PointerEvent<SVGSVGElement>) => {
    const localPoint = svgPointFromPointer(event);
    const index = visibleIndexFromLocalPoint(localPoint);
    const bar = index >= 0 ? visibleBars[index] : null;
    if (bar) {
      onSelectBar?.(bar);
    } else {
      onResetSelection?.();
    }
    if (!maxStartIndex) return;
    if (!localPoint || index < 0) return;
    dragRef.current = { x: localPoint.x, startIndex: resolvedStartIndex, hasMoved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const localPoint = svgPointFromPointer(event);
    if (dragRef.current && event.buttons === 1) {
      if (!localPoint) return;
      dragRef.current.hasMoved = dragRef.current.hasMoved || Math.abs(localPoint.x - dragRef.current.x) > 3;
      moveByDelta(localPoint.x);
      return;
    }
    const index = visibleIndexFromLocalPoint(localPoint);
    const bar = index >= 0 ? visibleBars[index] : null;
    if (bar) {
      onSelectBar?.(bar);
    } else {
      onResetSelection?.();
    }
  };
  const handlePointerUp = (event: PointerEvent<SVGSVGElement>) => {
    if (dragRef.current && !dragRef.current.hasMoved) {
      selectBarFromPointer(event);
    }
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const handlePointerLeave = () => {
    if (!dragRef.current) onResetSelection?.();
  };

  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-500">
        <span>{formatDataDate(visibleBars[0]?.ts)} 至 {formatDataDate(visibleBars.at(-1)?.ts)}</span>
        <div className="flex flex-wrap items-center gap-3">
          {activeVisibleAverages.map((average) => (
            <span key={average.label} className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: average.color }} />
              {average.label}
            </span>
          ))}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className={cn("h-[360px] w-full touch-pan-y select-none", maxStartIndex ? "cursor-grab active:cursor-grabbing" : "cursor-default")}
        role="img"
        aria-label="本地 K 线图"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerLeave}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = chartTop + ratio * chartHeight;
          const price = highest - ratio * priceRange;
          return (
            <g key={ratio}>
              <line x1={left} x2={width - right} y1={y} y2={y} stroke="#e2e8f0" strokeDasharray="3 4" />
              <text x={12} y={y + 5} className="fill-slate-400 text-[14px]">
                {price.toFixed(2)}
              </text>
            </g>
          );
        })}
        <line x1={left} x2={width - right} y1={volumeTop - 10} y2={volumeTop - 10} stroke="#e2e8f0" />
        {visibleBars.map((bar, index) => {
          const x = left + index * step + step / 2;
          const isUp = bar.close >= bar.open;
          const color = isUp ? "#dc2626" : "#059669";
          const yHigh = priceY(bar.high);
          const yLow = priceY(bar.low);
          const yOpen = priceY(bar.open);
          const yClose = priceY(bar.close);
          const bodyTop = Math.min(yOpen, yClose);
          const bodyHeight = Math.max(Math.abs(yClose - yOpen), 1);
          const volumeHeightPx = (bar.volume / maxVolume) * volumeHeight;
          return (
            <g key={`${bar.ts}-${index}`}>
              <line x1={x} x2={x} y1={yHigh} y2={yLow} stroke={color} strokeWidth={1.2} />
              <rect
                x={x - candleWidth / 2}
                y={bodyTop}
                width={candleWidth}
                height={bodyHeight}
                fill={isUp ? "#fff1f2" : color}
                stroke={color}
                strokeWidth={1}
              />
              <rect
                x={x - candleWidth / 2}
                y={volumeTop + volumeHeight - volumeHeightPx}
                width={candleWidth}
                height={volumeHeightPx}
                fill={isUp ? "#fecdd3" : "#a7f3d0"}
              />
            </g>
          );
        })}
        {activeVisibleAverages.map((average) => {
          const path = buildAveragePath(average.values);
          return path ? (
            <path
              key={average.label}
              d={path}
              fill="none"
              stroke={average.color}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.4}
            />
          ) : null;
        })}
        {selectedVisibleIndex >= 0 && (
          <g pointerEvents="none">
            {(() => {
              const selectedBar = visibleBars[selectedVisibleIndex];
              const selectedX = left + selectedVisibleIndex * step + step / 2;
              return (
                <>
                  <rect
                    x={selectedX - step / 2}
                    y={chartTop}
                    width={step}
                    height={volumeTop + volumeHeight - chartTop}
                    fill="#dbeafe"
                    opacity={0.3}
                  />
                  <line
                    x1={selectedX}
                    x2={selectedX}
                    y1={chartTop}
                    y2={volumeTop + volumeHeight}
                    stroke="#2563eb"
                    strokeDasharray="4 4"
                    strokeWidth={1.2}
                  />
                  <circle
                    cx={selectedX}
                    cy={priceY(selectedBar.close)}
                    r={4.5}
                    fill="#2563eb"
                    stroke="#ffffff"
                    strokeWidth={2}
                  />
                </>
              );
            })()}
          </g>
        )}
        {visibleBars.map((bar, index) => {
          const x = left + index * step + step / 2;
          const dividendEventsForBar = dividendMarkersByIndex.get(index) ?? [];
          const limitMarker = limitMarkerForBar(bar, limitThreshold, timeframe);
          const yHigh = priceY(bar.high);
          const yLow = priceY(bar.low);
          const dividendBadgeY = Math.max(chartTop + 2, yHigh - 36);
          return (
            <g key={`${bar.ts}-${index}-markers`}>
              {dividendEventsForBar.length > 0 && (
                <g>
                  <title>
                    {dividendEventsForBar.map((event) =>
                      `除权除息日 ${formatDataDate(event.exDividendDate)}：${event.planProfile ?? "分红送配"}`
                    ).join("；")}
                  </title>
                  <line
                    x1={x}
                    x2={x}
                    y1={chartTop}
                    y2={volumeTop + volumeHeight}
                    stroke="#f59e0b"
                    strokeDasharray="4 4"
                    strokeWidth={1}
                    opacity={0.85}
                  />
                  <circle
                    cx={x}
                    cy={Math.max(chartTop + 24, yHigh)}
                    r={4.8}
                    fill="#f59e0b"
                    stroke="#fff7ed"
                    strokeWidth={2}
                  />
                  <g transform={`translate(${x - 13}, ${dividendBadgeY})`}>
                    <rect
                      width={26}
                      height={18}
                      rx={4}
                      fill="#fffbeb"
                      stroke="#f59e0b"
                      strokeWidth={1}
                    />
                    <text
                      x={13}
                      y={13}
                      textAnchor="middle"
                      className="fill-amber-700 text-[11px] font-bold"
                    >
                      除
                    </text>
                  </g>
                </g>
              )}
              {limitMarker && (
                <g transform={`translate(${x - 11}, ${limitMarker === "up" ? Math.max(chartTop + 2, yHigh - 22) : Math.min(chartTop + chartHeight - 14, yLow + 8)})`}>
                  <rect
                    width={22}
                    height={16}
                    rx={3}
                    fill={limitMarker === "up" ? "#fee2e2" : "#dcfce7"}
                    stroke={limitMarker === "up" ? "#ef4444" : "#22c55e"}
                    strokeWidth={0.8}
                  />
                  <text
                    x={11}
                    y={11.5}
                    textAnchor="middle"
                    className={cn(
                      "text-[10px] font-semibold",
                      limitMarker === "up" ? "fill-red-600" : "fill-emerald-600"
                    )}
                  >
                    <title>
                      {limitMarker === "up" ? "涨停" : "跌停"}：{formatSignedPercent(bar.changePercent)}
                    </title>
                    {limitMarker === "up" ? "涨" : "跌"}
                  </text>
                </g>
              )}
            </g>
          );
        })}
        <text x={left} y={dateLabelY} className="fill-slate-500 text-[14px]">
          {formatDataDate(visibleBars[0]?.ts)}
        </text>
        <text x={width - right} y={dateLabelY} textAnchor="end" className="fill-slate-500 text-[14px]">
          {formatDataDate(visibleBars.at(-1)?.ts)}
        </text>
      </svg>
      <div className="mt-2 h-1.5 rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-blue-500"
          style={{
            marginLeft: `${rangeLeftPct}%`,
            width: `${Math.max(4, rangeWidthPct)}%`,
          }}
        />
      </div>
    </div>
  );
}

function IntradayTimeShareChart({
  detail,
  previousClose,
}: {
  detail: StrategyLocalKlineResponse;
  previousClose?: number | null;
}) {
  const cleanBars = useMemo(
    () => detail.bars.filter((bar) =>
      [bar.open, bar.high, bar.low, bar.close, bar.volume].every(
        (value) => typeof value === "number" && Number.isFinite(value)
      )
    ),
    [detail.bars]
  );
  const points = useMemo(() => {
    let cumulativeAmount = 0;
    let cumulativeVolume = 0;
    return cleanBars.map((bar) => {
      const amount = finiteNumber(bar.amount);
      if (amount !== null) cumulativeAmount += amount;
      cumulativeVolume += bar.volume;
      const averagePrice = cumulativeAmount > 0 && cumulativeVolume > 0
        ? cumulativeAmount / (cumulativeVolume * 100)
        : bar.close;
      return { bar, averagePrice };
    });
  }, [cleanBars]);
  const [selectedIndex, setSelectedIndex] = useState(Math.max(0, points.length - 1));
  const [crosshairX, setCrosshairX] = useState<number | null>(null);
  const resolvedSelectedIndex = clampNumber(selectedIndex, 0, Math.max(0, points.length - 1));
  const selectedPoint = points[resolvedSelectedIndex] ?? points.at(-1) ?? null;
  const baseline = finiteNumber(previousClose) ?? finiteNumber(detail.summary.previousClose) ?? points[0]?.bar.open ?? null;

  useEffect(() => {
    setSelectedIndex(Math.max(0, points.length - 1));
    setCrosshairX(null);
  }, [points.length]);

  if (!points.length) {
    return (
      <div className="flex h-[320px] items-center justify-center rounded-md border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500">
        暂无可展示的分时数据
      </div>
    );
  }

  const width = 1320;
  const height = 360;
  const left = 66;
  const right = 28;
  const chartTop = 24;
  const chartHeight = 215;
  const volumeTop = 278;
  const volumeHeight = 46;
  const dateLabelY = height - 11;
  const chartWidth = width - left - right;
  const priceValues = [
    ...points.flatMap((point) => [point.bar.high, point.bar.low, point.bar.close, point.averagePrice]),
    ...(baseline !== null ? [baseline] : []),
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const highest = Math.max(...priceValues);
  const lowest = Math.min(...priceValues);
  const padding = Math.max((highest - lowest) * 0.08, highest * 0.002, 0.02);
  const priceHigh = highest + padding;
  const priceLow = lowest - padding;
  const priceRange = Math.max(priceHigh - priceLow, 0.01);
  const maxVolume = Math.max(...points.map((point) => point.bar.volume), 1);
  const step = points.length > 1 ? chartWidth / (points.length - 1) : chartWidth;
  const barWidth = Math.max(2, Math.min(7, chartWidth / points.length * 0.55));
  const priceY = (price: number) => chartTop + ((priceHigh - price) / priceRange) * chartHeight;
  const pointX = (index: number) => left + index * step;
  const buildPath = (values: number[]) =>
    values.reduce((path, value, index) => {
      const x = pointX(index);
      const y = priceY(value);
      return `${path}${path ? " L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
    }, "");
  const pricePath = buildPath(points.map((point) => point.bar.close));
  const averagePath = buildPath(points.map((point) => point.averagePrice));
  const selectedPointX = pointX(resolvedSelectedIndex);
  const selectedX = crosshairX ?? selectedPointX;
  const selectedBar = selectedPoint?.bar ?? null;
  const selectedAverage = selectedPoint?.averagePrice ?? null;
  const selectedChangePct = selectedBar && baseline
    ? ((selectedBar.close - baseline) / baseline) * 100
    : selectedBar?.changePercent ?? null;
  const selectedMetrics = selectedBar
    ? [
        { label: "时间", value: formatIntradayTime(selectedBar.ts) },
        { label: "价格", value: formatNumberValue(selectedBar.close), className: signedToneClass(selectedChangePct) },
        { label: "均价", value: formatNumberValue(selectedAverage), className: "text-amber-600" },
        { label: "涨跌", value: formatSignedPercent(selectedChangePct), className: signedToneClass(selectedChangePct) },
        { label: "成交量", value: formatLargeValue(selectedBar.volume, 0) },
        { label: "成交额", value: formatLargeValue(selectedBar.amount, 1) },
        { label: "换手", value: formatPercentValue(selectedBar.turnover) },
      ]
    : [];
  const selectFromPointer = (event: PointerEvent<SVGSVGElement>) => {
    const svg = event.currentTarget;
    const screenMatrix = svg.getScreenCTM();
    if (!screenMatrix) return;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const localPoint = point.matrixTransform(screenMatrix.inverse());
    const localX = localPoint.x;
    const nextX = clampNumber(localX, left, width - right);
    const rawIndex = Math.round((nextX - left) / step);
    setCrosshairX(nextX);
    setSelectedIndex(clampNumber(rawIndex, 0, points.length - 1));
  };

  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
          <span>{formatIntradayTime(points[0]?.bar.ts)} 至 {formatIntradayTime(points.at(-1)?.bar.ts)}</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-blue-600" />
            分时价
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-amber-500" />
            均价
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-slate-300" />
            昨收 {formatNumberValue(baseline)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selectedMetrics.map((item) => (
            <div key={item.label} className="inline-flex items-baseline gap-1 rounded bg-slate-50 px-2 py-1">
              <span className="text-xs text-slate-500">{item.label}</span>
              <span className={cn("text-sm font-semibold tabular-nums text-slate-950", item.className)}>
                {item.value}
              </span>
            </div>
          ))}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-[360px] w-full touch-pan-y select-none"
        role="img"
        aria-label="分时行情图"
        onPointerMove={selectFromPointer}
        onPointerDown={selectFromPointer}
        onPointerLeave={() => {
          setSelectedIndex(Math.max(0, points.length - 1));
          setCrosshairX(null);
        }}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = chartTop + ratio * chartHeight;
          const price = priceHigh - ratio * priceRange;
          const change = baseline ? ((price - baseline) / baseline) * 100 : null;
          return (
            <g key={ratio}>
              <line x1={left} x2={width - right} y1={y} y2={y} stroke="#e2e8f0" strokeDasharray="3 4" />
              <text x={12} y={y + 5} className="fill-slate-400 text-[13px]">
                {price.toFixed(2)}
              </text>
              <text x={width - right + 4} y={y + 5} className={cn("fill-current text-[12px]", signedToneClass(change))}>
                {formatSignedPercent(change)}
              </text>
            </g>
          );
        })}
        {baseline !== null && (
          <line
            x1={left}
            x2={width - right}
            y1={priceY(baseline)}
            y2={priceY(baseline)}
            stroke="#94a3b8"
            strokeDasharray="5 5"
            strokeWidth={1}
          />
        )}
        <line x1={left} x2={width - right} y1={volumeTop - 10} y2={volumeTop - 10} stroke="#e2e8f0" />
        {points.map((point, index) => {
          const x = pointX(index);
          const isUp = point.bar.close >= point.bar.open;
          const volumeHeightPx = (point.bar.volume / maxVolume) * volumeHeight;
          return (
            <rect
              key={`${point.bar.ts}-${index}-volume`}
              x={x - barWidth / 2}
              y={volumeTop + volumeHeight - volumeHeightPx}
              width={barWidth}
              height={Math.max(1, volumeHeightPx)}
              fill={isUp ? "#fecdd3" : "#a7f3d0"}
            />
          );
        })}
        <path
          d={pricePath}
          fill="none"
          stroke="#2563eb"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.8}
        />
        <path
          d={averagePath}
          fill="none"
          stroke="#f59e0b"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.6}
        />
        {selectedBar && (
          <g pointerEvents="none">
            <line
              x1={selectedX}
              x2={selectedX}
              y1={chartTop}
              y2={volumeTop + volumeHeight}
              stroke="#2563eb"
              strokeDasharray="4 4"
              strokeWidth={1.1}
            />
            <circle
              cx={selectedPointX}
              cy={priceY(selectedBar.close)}
              r={4.5}
              fill="#2563eb"
              stroke="#ffffff"
              strokeWidth={2}
            />
          </g>
        )}
        <text x={left} y={dateLabelY} className="fill-slate-500 text-[13px]">
          {formatIntradayTime(points[0]?.bar.ts)}
        </text>
        <text x={width / 2} y={dateLabelY} textAnchor="middle" className="fill-slate-400 text-[13px]">
          11:30 / 13:00
        </text>
        <text x={width - right} y={dateLabelY} textAnchor="end" className="fill-slate-500 text-[13px]">
          {formatIntradayTime(points.at(-1)?.bar.ts)}
        </text>
      </svg>
    </div>
  );
}

function RealtimeQuotePanel({
  quote,
  member,
  isRefreshing,
  onRefresh,
}: {
  quote: StrategyRealtimeQuote;
  member: StrategyUniverseMember;
  isRefreshing: boolean;
  onRefresh: () => void;
}) {
  const tone = signedToneClass(quote.changePercent);
  const quoteTime = quote.quoteTime ?? quote.asOf ?? quote.fetchedAt;
  const cards = [
    { label: "最新价", value: formatNumberValue(quote.price), className: tone },
    { label: "涨跌幅", value: formatSignedPercent(quote.changePercent), className: tone },
    { label: "涨跌额", value: formatSignedNumberValue(quote.changeAmount), className: tone },
    { label: "开盘", value: formatNumberValue(quote.open) },
    { label: "最高", value: formatNumberValue(quote.high), className: "text-red-600" },
    { label: "最低", value: formatNumberValue(quote.low), className: "text-emerald-600" },
    { label: "前收", value: formatNumberValue(quote.previousClose) },
    { label: "振幅", value: formatPercentValue(quote.amplitude) },
    { label: "换手", value: formatPercentValue(quote.turnover) },
    { label: "成交量", value: formatLargeValue(quote.volume, 1) },
    { label: "成交额", value: formatLargeValue(quote.amount, 1) },
    { label: "流通市值", value: formatLargeValue(quote.floatMarketCap, 1) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
        <div>
          <div className="flex flex-wrap items-baseline gap-2">
            <p className="text-base font-semibold text-slate-950">{quote.name ?? member.name ?? member.symbol}</p>
            <span className="font-mono text-sm text-slate-500">{member.symbol}</span>
            <Badge variant="outline" className="border-blue-200 bg-blue-50 text-blue-700">
              {quote.source}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            行情时间 {formatDateTime(quoteTime)} · {quote.market || member.exchange} · {quote.currency}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={isRefreshing}
          className="gap-2"
        >
          <RefreshCcw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
          刷新
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {cards.map((card) => (
          <div key={card.label} className="rounded-md border border-slate-100 bg-white px-4 py-3 shadow-sm">
            <p className="text-sm text-slate-500">{card.label}</p>
            <p className={cn("mt-1 text-xl font-semibold tabular-nums text-slate-950", card.className)}>
              {card.value}
            </p>
          </div>
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-md border border-slate-100 bg-white px-4 py-3">
          <p className="text-sm text-slate-500">总市值</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-slate-950">{formatLargeValue(quote.marketCap, 1)}</p>
        </div>
        <div className="rounded-md border border-slate-100 bg-white px-4 py-3">
          <p className="text-sm text-slate-500">数据质量</p>
          <p className="mt-1 text-lg font-semibold text-slate-950">{quote.dataQualityStatus ?? "-"}</p>
        </div>
        <div className="rounded-md border border-slate-100 bg-white px-4 py-3">
          <p className="text-sm text-slate-500">刷新状态</p>
          <p className="mt-1 text-lg font-semibold text-slate-950">
            {isRefreshing ? "刷新中" : `约 ${Math.round(REALTIME_QUOTE_REFRESH_MS / 1000)} 秒`}
          </p>
        </div>
      </div>
    </div>
  );
}

export function StockKlineDetail({
  member,
  universe,
}: {
  member: StrategyUniverseMember;
  universe: StrategyUniverse;
}) {
  const initialTimeframe = KLINE_TIMEFRAMES.some((option) => option.id === universe.defaultTimeframe)
    ? (universe.defaultTimeframe as KlineTimeframe)
    : "daily";
  const adjustment = universe.defaultAdjustment || "qfq";
  const [detailTimeframe, setDetailTimeframe] = useState<KlineTimeframe>("daily");
  const [detail, setDetail] = useState<StrategyLocalKlineResponse | null>(null);
  const [realtimeQuote, setRealtimeQuote] = useState<StrategyRealtimeQuote | null>(null);
  const [intradayDetail, setIntradayDetail] = useState<StrategyLocalKlineResponse | null>(null);
  const [selectedBarTs, setSelectedBarTs] = useState<string | null>(null);
  const [dividendEvents, setDividendEvents] = useState<StrategyDividendEvent[]>([]);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isLoadingRealtime, setIsLoadingRealtime] = useState(false);
  const [isLoadingIntraday, setIsLoadingIntraday] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [realtimeError, setRealtimeError] = useState<string | null>(null);
  const [intradayError, setIntradayError] = useState<string | null>(null);
  const detailRequestIdRef = useRef(0);
  const realtimeRequestIdRef = useRef(0);
  const intradayRequestIdRef = useRef(0);

  const loadRealtimeQuote = useCallback(async (options?: { silent?: boolean }) => {
    const requestId = realtimeRequestIdRef.current + 1;
    realtimeRequestIdRef.current = requestId;
    setRealtimeError(null);
    if (!options?.silent) {
      setIsLoadingRealtime(true);
    }
    try {
      const quote = await fetchRealtimeQuote(member.symbol);
      if (realtimeRequestIdRef.current !== requestId) return;
      setRealtimeQuote(quote);
    } catch (error) {
      if (realtimeRequestIdRef.current !== requestId) return;
      setRealtimeError(error instanceof Error ? error.message : String(error));
    } finally {
      if (realtimeRequestIdRef.current === requestId) {
        setIsLoadingRealtime(false);
      }
    }
  }, [member.symbol]);

  const loadIntradayDetail = useCallback(async (options?: { silent?: boolean; forceRefresh?: boolean }) => {
    const requestId = intradayRequestIdRef.current + 1;
    intradayRequestIdRef.current = requestId;
    setIntradayError(null);
    if (!options?.silent) {
      setIsLoadingIntraday(true);
    }
    try {
      const nextDetail = await fetchIntradayBars(member.symbol, { forceRefresh: options?.forceRefresh });
      if (intradayRequestIdRef.current !== requestId) return;
      setIntradayDetail(nextDetail);
    } catch (error) {
      if (intradayRequestIdRef.current !== requestId) return;
      setIntradayError(error instanceof Error ? error.message : String(error));
    } finally {
      if (intradayRequestIdRef.current === requestId) {
        setIsLoadingIntraday(false);
      }
    }
  }, [member.symbol]);

  const refreshRealtimeView = useCallback((options?: { silent?: boolean; forceRefresh?: boolean }) => {
    void loadRealtimeQuote(options);
    void loadIntradayDetail(options);
  }, [loadIntradayDetail, loadRealtimeQuote]);

  const loadDetail = useCallback(async (timeframe: KlineTimeframe) => {
    if (timeframe === "realtime") {
      setDetailTimeframe("realtime");
      setSelectedBarTs(null);
      setDetailError(null);
      return;
    }
    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;
    setDetailTimeframe(timeframe);
    setSelectedBarTs(null);
    setDetailError(null);

    const cached = readCachedKlineDetail(member.symbol, timeframe, adjustment);
    if (cached) {
      setDetail(cached);
      setSelectedBarTs(cached.bars.at(-1)?.ts ?? null);
      setIsLoadingDetail(false);
      return;
    }

    setDetail(null);
    setIsLoadingDetail(true);
    try {
      const nextDetail = await loadCachedKlineDetail(member.symbol, timeframe, adjustment);
      if (detailRequestIdRef.current !== requestId) return;
      setDetail(nextDetail);
      setSelectedBarTs(nextDetail.bars.at(-1)?.ts ?? null);
    } catch (error) {
      if (detailRequestIdRef.current !== requestId) return;
      setDetailError(error instanceof Error ? error.message : String(error));
    } finally {
      if (detailRequestIdRef.current === requestId) {
        setIsLoadingDetail(false);
      }
    }
  }, [adjustment, member.symbol]);

  const loadDividendEvents = useCallback(async () => {
    try {
      setDividendEvents(await loadCachedDividendEvents(member.symbol));
    } catch {
      setDividendEvents([]);
    }
  }, [member.symbol]);

  useEffect(() => {
    void loadDetail(initialTimeframe);
  }, [initialTimeframe, loadDetail]);

  useEffect(() => {
    void loadDividendEvents();
  }, [loadDividendEvents]);

  useEffect(() => {
    if (detailTimeframe !== "realtime") return;
    refreshRealtimeView({ forceRefresh: true });
    const timer = setInterval(() => {
      refreshRealtimeView({ silent: true, forceRefresh: true });
    }, REALTIME_QUOTE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [detailTimeframe, refreshRealtimeView]);

  const isRealtimeView = detailTimeframe === "realtime";
  const isInitialRealtimeLoading =
    (isLoadingRealtime && !realtimeQuote) || (isLoadingIntraday && !intradayDetail);
  const selectedBarIndex = detail
    ? detail.bars.findIndex((bar) => bar.ts === selectedBarTs)
    : -1;
  const resolvedSelectedBarIndex = detail
    ? selectedBarIndex >= 0 ? selectedBarIndex : detail.bars.length - 1
    : -1;
  const selectedBar = detail && resolvedSelectedBarIndex >= 0
    ? detail.bars[resolvedSelectedBarIndex]
    : null;
  const selectedReturnPct = detail && resolvedSelectedBarIndex >= 0
    ? returnPctForBar(detail.bars, resolvedSelectedBarIndex)
    : null;
  const selectedDateLabel = selectedBar ? formatDataDate(selectedBar.ts) : null;
  const metricCards = !isRealtimeView && detail && selectedBar
    ? [
        { label: "收盘", value: formatNumberValue(selectedBar.close) },
        {
          label: "涨跌",
          value: formatSignedPercent(selectedReturnPct),
          className: signedToneClass(selectedReturnPct),
        },
        { label: "开盘", value: formatNumberValue(selectedBar.open) },
        { label: "最高", value: formatNumberValue(selectedBar.high), className: "text-red-600" },
        { label: "最低", value: formatNumberValue(selectedBar.low), className: "text-emerald-600" },
        { label: "振幅", value: formatPercentValue(selectedBar.amplitude) },
        { label: "换手", value: formatPercentValue(selectedBar.turnover) },
        { label: "成交量", value: formatLargeValue(selectedBar.volume, 1) },
        { label: "成交额", value: formatLargeValue(selectedBar.amount, 1) },
        ...MOVING_AVERAGE_CONFIGS.map((config) => ({
          label: config.label,
          value: formatNumberValue(movingAverageAtIndex(detail.bars, config.period, resolvedSelectedBarIndex)),
          className: config.textClass,
        })),
      ]
    : [];

  return (
    <div className="border-t border-slate-100 bg-slate-50/70 p-5">
      <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2">
            <p className="shrink-0 text-sm font-semibold text-slate-950">
              K 线详情
              {!isRealtimeView && selectedDateLabel && (
                <span className="ml-2 align-middle text-xs font-medium text-slate-500">
                  {selectedDateLabel}
                </span>
              )}
            </p>
            {metricCards.length > 0 && (
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                {metricCards.map((item) => (
                  <div key={item.label} className="inline-flex items-baseline gap-1.5 rounded-md bg-slate-50 px-2.5 py-1.5">
                    <span className="text-[13px] text-slate-500">{item.label}</span>
                    <span className={cn("text-base font-semibold tabular-nums text-slate-950", item.className)}>
                      {item.value}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="inline-flex h-9 rounded-md border border-slate-200 bg-slate-50 p-1">
            {KLINE_TIMEFRAMES.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => {
                  if (option.id !== detailTimeframe) {
                    void loadDetail(option.id);
                  }
                }}
                disabled={isLoadingDetail || isLoadingRealtime || isLoadingIntraday}
                className={cn(
                  "rounded px-3 text-sm font-medium transition-colors",
                  detailTimeframe === option.id
                    ? "bg-white text-blue-700 shadow-sm"
                    : "text-slate-500 hover:text-slate-700",
                  (isLoadingDetail || isLoadingRealtime || isLoadingIntraday) && "cursor-wait opacity-70"
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {isRealtimeView && isInitialRealtimeLoading ? (
          <div className="flex h-80 items-center justify-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在读取实时行情和分时数据...
          </div>
        ) : isRealtimeView ? (
          <div className="space-y-4 p-5">
            {(realtimeError || intradayError) && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                {intradayError ?? realtimeError}
              </div>
            )}
            {intradayDetail ? (
              <IntradayTimeShareChart
                detail={intradayDetail}
                previousClose={realtimeQuote?.previousClose ?? detail?.summary.previousClose}
              />
            ) : (
              <div className="flex h-72 items-center justify-center rounded-md border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500">
                暂无分时数据
              </div>
            )}
            {realtimeQuote ? (
              <RealtimeQuotePanel
                quote={realtimeQuote}
                member={member}
                isRefreshing={isLoadingRealtime || isLoadingIntraday}
                onRefresh={() => refreshRealtimeView({ forceRefresh: true })}
              />
            ) : (
              <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
                暂无实时读数
              </div>
            )}
          </div>
        ) : isLoadingDetail ? (
          <div className="flex h-80 items-center justify-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在读取本地 TimescaleDB K 线...
          </div>
        ) : detailError ? (
          <div className="m-5 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {detailError}
          </div>
        ) : detail ? (
          <div className="p-5">
            <KlineMiniChart
              bars={detail.bars}
              dividendEvents={dividendEvents}
              symbol={member.symbol}
              name={member.name}
              exchange={member.exchange}
              timeframe={detailTimeframe}
              selectedBarTs={selectedBar?.ts ?? null}
              onSelectBar={(bar) => setSelectedBarTs(bar.ts)}
              onResetSelection={() => setSelectedBarTs(detail.bars.at(-1)?.ts ?? null)}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
