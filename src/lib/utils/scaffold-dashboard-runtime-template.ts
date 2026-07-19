/** Shared source fragments embedded into every generated quantitative dashboard page. */
export const DASHBOARD_PAGE_RUNTIME_PRELUDE = `import fs from 'fs/promises';
import path from 'path';

type JsonRecord = Record<string, unknown>;

const DATA_FILE = 'data_file/final/dashboard-data.json';

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatNumber(value: unknown, digits = 2): string {
  const number = numeric(value);
  if (number === null) return '-';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(number);
}

function formatPercent(value: unknown): string {
  const number = numeric(value);
  if (number === null) return '-';
  return (number > 0 ? '+' : '') + number.toFixed(2) + '%';
}

function formatMoney(value: unknown): string {
  const number = numeric(value);
  if (number === null) return '-';
  if (Math.abs(number) >= 100000000) return formatNumber(number / 100000000, 2) + ' 亿';
  if (Math.abs(number) >= 10000) return formatNumber(number / 10000, 2) + ' 万';
  return formatNumber(number);
}

`;

export const DASHBOARD_DATA_READER = `async function readDashboardData(): Promise<JsonRecord | null> {
  try {
    const content = await fs.readFile(
      path.join(/*turbopackIgnore: true*/ process.cwd(), DATA_FILE),
      'utf8'
    );
    return asRecord(JSON.parse(content));
  } catch {
    return null;
  }
}`;
