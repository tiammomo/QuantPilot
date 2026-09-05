import fs from 'fs/promises';
import path from 'path';
import { type JsonRecord, asRecord } from './values';

const MARKET_API_BASE_URL = process.env.QUANTPILOT_MARKET_API_URL ?? 'http://127.0.0.1:8000';

const FETCH_TIMEOUT_MS = Number.parseInt(process.env.QUANTPILOT_MARKET_PREFETCH_TIMEOUT_MS ?? '', 10) || 12_000;

export const SCREENER_FETCH_TIMEOUT_MS =
  Number.parseInt(process.env.QUANTPILOT_SCREENER_PREFETCH_TIMEOUT_MS ?? '', 10) || Math.max(FETCH_TIMEOUT_MS, 45_000);

export async function fetchJson(
  endpoint: string,
  init: RequestInit = {},
  options: { timeoutMs?: number } = {}
): Promise<JsonRecord> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${MARKET_API_BASE_URL}${endpoint}`, {
      ...init,
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${endpoint} 返回 HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    const parsed = JSON.parse(text);
    const record = asRecord(parsed);
    if (!record) {
      throw new Error(`${endpoint} 未返回 JSON 对象。`);
    }
    return record;
  } finally {
    clearTimeout(timeout);
  }
}

export async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readJson(filePath: string): Promise<JsonRecord | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return asRecord(JSON.parse(content));
  } catch {
    return null;
  }
}
