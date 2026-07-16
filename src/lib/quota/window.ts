import type { QuotaWindow, QuotaWindowType } from './types';

const LIFETIME_START = new Date('1970-01-01T00:00:00.000Z');
const LIFETIME_END = new Date('9999-12-31T23:59:59.999Z');

export function calculateQuotaWindow(
  windowType: QuotaWindowType,
  now: Date,
  windowSeconds: number | null = null,
): QuotaWindow {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) throw new TypeError('Quota window requires a valid date.');

  if (windowType === 'lifetime') {
    return { start: new Date(LIFETIME_START), end: new Date(LIFETIME_END) };
  }

  if (windowType === 'fixed') {
    if (!Number.isSafeInteger(windowSeconds) || (windowSeconds ?? 0) <= 0) {
      throw new TypeError('A fixed quota window requires a positive windowSeconds value.');
    }
    const durationMs = windowSeconds! * 1_000;
    const startMs = Math.floor(timestamp / durationMs) * durationMs;
    return { start: new Date(startMs), end: new Date(startMs + durationMs) };
  }

  const start = new Date(timestamp);
  if (windowType === 'minute') {
    start.setUTCSeconds(0, 0);
    return { start, end: new Date(start.getTime() + 60_000) };
  }
  if (windowType === 'hour') {
    start.setUTCMinutes(0, 0, 0);
    return { start, end: new Date(start.getTime() + 3_600_000) };
  }
  if (windowType === 'day') {
    start.setUTCHours(0, 0, 0, 0);
    return { start, end: new Date(start.getTime() + 86_400_000) };
  }

  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { start, end };
}
