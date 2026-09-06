import { getRuntimeDegradationConfig } from '@/lib/config/degradation';

export const MARKET_API_BASE_URL =
  process.env.QUANTPILOT_MARKET_API_URL || process.env.QUANTPILOT_MARKET_API_BASE_URL || 'http://127.0.0.1:8000';

function getMarketApiConfig() {
  return getRuntimeDegradationConfig().components.marketApi;
}

export function assertMarketApiEnabled() {
  if (!getMarketApiConfig().enabled) {
    throw new Error('market API 已按降级配置停用');
  }
}

export async function fetchBacktest(params: {
  symbol: string;
  parameters: Record<string, string | number>;
  strategyId: string;
  limit?: number;
}): Promise<Record<string, unknown>> {
  assertMarketApiEnabled();
  const query = new URLSearchParams({
    fee_bps: String(params.parameters.fee_bps ?? 5),
    period: 'daily',
    adjustment: 'qfq',
    limit: String(params.limit ?? 1260),
  });
  for (const [key, value] of Object.entries(params.parameters)) {
    query.set(key, String(value));
  }
  const responseData = await fetchMarketApiJson<Record<string, unknown>>(
    `/api/v1/backtests/strategies/${encodeURIComponent(params.strategyId)}/${encodeURIComponent(params.symbol)}?${query.toString()}`,
    { init: { cache: 'no-store' }, errorBodyLimit: 180 }
  );

  return responseData;
}

export async function fetchMarketApiJson<T>(
  pathName: string,
  options: { timeoutMs?: number; init?: RequestInit; errorBodyLimit?: number } = {}
): Promise<T> {
  assertMarketApiEnabled();
  const controller = options.timeoutMs ? new AbortController() : null;
  const timeout = controller && options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
  try {
    const response = await fetch(`${MARKET_API_BASE_URL}${pathName}`, {
      cache: 'no-store',
      ...options.init,
      signal: controller?.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`market API ${response.status}: ${body.slice(0, options.errorBodyLimit ?? 180)}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`market API timeout after ${options.timeoutMs}ms: ${pathName}`);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function marketAdminHeaders(): Record<string, string> {
  const token = process.env.QUANTPILOT_MARKET_ADMIN_TOKEN?.trim();
  return token ? { 'X-QuantPilot-Admin-Token': token } : {};
}
