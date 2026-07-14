/** Shared source fragments embedded into every generated quantitative dashboard page. */
export const DASHBOARD_PAGE_RUNTIME_PRELUDE = `import fs from 'fs/promises';
import path from 'path';

type JsonRecord = Record<string, unknown>;

const DATA_FILE = 'data_file/final/dashboard-data.json';
const SOURCES_FILE = 'evidence/sources.json';

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

function sourceDisplayName(source: unknown, datasetType?: unknown): string {
  const normalized = String(source ?? '').toLowerCase();
  const type = String(datasetType ?? '').toLowerCase();
  if (normalized.includes('eastmoney')) {
    if (/kline|history|历史/.test(type)) return '东方财富历史 K 线接口';
    if (/financial|fundamental|财务/.test(type)) return '东方财富财务数据接口';
    if (/announcement|event|公告/.test(type)) return '东方财富公告事件接口';
    return '东方财富实时行情接口';
  }
  if (normalized.includes('uploaded_image')) return '用户上传截图';
  if (normalized.includes('market_prefetch')) return 'QuantPilot 后端预取';
  if (normalized.includes('tencent')) return '腾讯证券行情接口';
  if (normalized.includes('sina')) return '新浪财经行情接口';
  if (normalized.includes('akshare')) return 'AKShare 免费数据接口';
  if (normalized.includes('local')) return '本地计算结果';
  return String(source ?? '未知信源');
}`;

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
