

export type JsonRecord = Record<string, unknown>;

export interface PrefetchResult {
  skipped: boolean;
  symbol?: string;
  symbols?: string[];
  finalDataPath?: string;
  rawFiles?: string[];
  summary: string;
}

export function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

export function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function sum(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((total, value) => total + value, 0);
}

export function round(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function extractBarsFromAsset(asset: JsonRecord | null): JsonRecord[] {
  if (!asset) {
    return [];
  }
  const kline = asRecord(asset.kline) ?? asRecord(asset.history);
  const candidates = [
    kline?.bars,
    kline?.data,
    kline?.items,
    asset.bars,
    asset.klines,
    asset.candles,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    const bars = candidate.map(asRecord).filter((item): item is JsonRecord => Boolean(item));
    if (bars.length > 0) {
      return bars;
    }
  }
  return [];
}
