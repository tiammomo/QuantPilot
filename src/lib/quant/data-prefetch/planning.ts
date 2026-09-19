import path from 'path';
import { QuantRunPlan } from '@/lib/domains/finance/workspace';
import { asRecord } from './values';
import { readJson, writeJson } from './transport';

export function isQuantAnalysisPlan(plan: QuantRunPlan): boolean {
  return [
    'stock_diagnosis',
    'technical_analysis',
    'fundamental_analysis',
    'asset_comparison',
    'sector_rotation',
    'strategy_research',
    'backtest_review',
    'portfolio_risk',
  ].includes(plan.capabilityId);
}

export function hasExplicitTradingPlanIntent(instruction: string): boolean {
  const normalized = instruction.replace(/\s+/g, '');
  return /交易计划|买入区间|买点|卖点|入场|出场|止损|止盈|目标价|仓位|建仓|加仓|减仓|卖出|买入|(?:要|想|准备)买|推荐.*(?:买|交易)|怎么操作|如何操作|操作建议|短线.*(?:买|卖|交易|计划)|(?:1|3|5|一|三|五)个交易日.*(?:计划|操作)|持仓.*(?:调仓|减仓|加仓)/.test(normalized);
}

const SYMBOL_CODE_PATTERN = /^(?:6|0|3|5)\d{5}$/;

export function uniqueSymbols(symbols: string[]): string[] {
  return Array.from(new Set(symbols.filter((symbol) => SYMBOL_CODE_PATTERN.test(symbol))));
}

function pickSymbolCode(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return SYMBOL_CODE_PATTERN.test(trimmed) ? trimmed : null;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const candidates = [
    record.symbol,
    record.code,
    record.security_code,
    record.securityCode,
    record.ticker,
    typeof record.secid === 'string' ? record.secid.split('.').at(-1) : null,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const trimmed = candidate.trim();
    if (SYMBOL_CODE_PATTERN.test(trimmed)) {
      return trimmed;
    }
  }

  return null;
}

export function inferPlannedSymbols(plan: QuantRunPlan): string[] {
  const planned = Array.isArray(plan.symbols) ? plan.symbols : [];
  return uniqueSymbols(
    planned.map(pickSymbolCode).filter((symbol): symbol is string => Boolean(symbol)),
  ).slice(0, 8);
}

export function isBroadStockScreenerPlan(plan: QuantRunPlan): boolean {
  // A negative semantic decision is authoritative too. Legacy plans can opt in
  // through an explicit endpoint, but the execution layer never re-routes prose.
  if (plan.queryRewrite && !plan.queryRewrite.broadUniverse) return false;
  return plan.dataRequirements.some((endpoint) =>
    endpoint.includes('/api/v1/research/screeners/a-share/short-term-candidates'));
}

export function pickScreenerCandidateCode(value: unknown): string | null {
  const record = asRecord(value);
  const candidates = [
    record?.code,
    record?.symbol,
    record?.security_code,
    record?.securityCode,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const match = candidate.trim().match(/(?:^|[^\d])((?:6|0|3|5)\d{5})(?:\.(?:SH|SZ|BJ))?$/i)
      ?? candidate.trim().match(/^((?:6|0|3|5)\d{5})(?:\.(?:SH|SZ|BJ))?/i);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

export function screenerModeForQuestion(question: string): string {
  const normalized = question.replace(/\s+/g, '');
  if (/涨停|连板|接力/.test(normalized)) return 'limit_up_relay';
  if (/趋势|强弱|流动性|均线/.test(normalized)) return 'trend_liquidity';
  return 'short_term';
}

export function screenerLimitForQuestion(question: string): number {
  const normalized = question.replace(/\s+/g, '');
  const explicit = normalized.match(/(?:候选|筛选|推荐|选出)?(\d+)(?:只|个)/);
  const value = explicit?.[1] ? Number.parseInt(explicit[1], 10) : 5;
  if (!Number.isFinite(value)) return 5;
  return Math.min(Math.max(value, 3), 10);
}

function currentShanghaiYear(): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
  });
  return Number.parseInt(formatter.format(new Date()), 10) || new Date().getFullYear();
}

function normalizeMonthDayTradeDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  const paddedMonth = String(month).padStart(2, '0');
  const paddedDay = String(day).padStart(2, '0');
  return `${year}-${paddedMonth}-${paddedDay}`;
}

export function screenerTradeDateForQuestion(question: string): string | null {
  const normalized = question.replace(/\s+/g, '');
  const isoMatch = normalized.match(/((?:19|20)\d{2})[-年/]?(\d{1,2})[-月/](\d{1,2})日?/);
  if (isoMatch?.[1] && isoMatch[2] && isoMatch[3]) {
    return normalizeMonthDayTradeDate(
      Number.parseInt(isoMatch[1], 10),
      Number.parseInt(isoMatch[2], 10),
      Number.parseInt(isoMatch[3], 10)
    );
  }

  const monthDayMatch = normalized.match(/(\d{1,2})月(\d{1,2})日?/);
  if (monthDayMatch?.[1] && monthDayMatch[2]) {
    return normalizeMonthDayTradeDate(
      currentShanghaiYear(),
      Number.parseInt(monthDayMatch[1], 10),
      Number.parseInt(monthDayMatch[2], 10)
    );
  }

  return null;
}

export function inferHistoryLimit(plan: QuantRunPlan): number {
  const range = plan.queryRewrite?.timeRange;
  if (range?.value && Number.isSafeInteger(range.value) && range.value > 0) {
    const tradingDaysPerUnit = {
      trading_day: 1, day: 1, week: 5, month: 21, quarter: 63, year: 252,
    };
    if (range.unit in tradingDaysPerUnit) {
      const multiplier = tradingDaysPerUnit[range.unit as keyof typeof tradingDaysPerUnit];
      return Math.min(Math.max(range.value * multiplier, 20), 500);
    }
  }
  // Only the accepted label is a compatibility fallback. Unrelated numbers in
  // the original question must not override a rewritten or inherited range.
  const source = (range?.label ?? plan.timeRange ?? '').replace(/\s+/g, '');
  const dayMatch = source.match(/最近(\d+)(?:个)?(?:交易日|日|天)/);
  let rawDays = dayMatch?.[1] ? Number.parseInt(dayMatch[1], 10) : 120;
  if (!dayMatch) {
    if (/近?两年|最近两年|过去两年|2年|24个月/.test(source)) {
      rawDays = 500;
    } else if (/近?一年|最近一年|过去一年|1年|12个月|十二个月/.test(source)) {
      rawDays = 252;
    } else if (/近?半年|最近半年|过去半年|6个月|六个月/.test(source)) {
      rawDays = 126;
    } else if (/(?:去年|今年)?(?:上半年|下半年)/.test(source)) {
      rawDays = 126;
    } else if (/年初至今/.test(source)) {
      rawDays = 252;
    } else if (/近?三个月|最近三个月|过去三个月|3个月|一季度|一个季度/.test(source)) {
      rawDays = 63;
    }
  }
  if (!Number.isFinite(rawDays)) {
    return 120;
  }
  return Math.min(Math.max(rawDays, 20), 500);
}

export async function syncRunPlanSymbols(params: {
  projectPath: string;
  plan: QuantRunPlan;
  symbols: string[];
  source: 'run_plan' | 'screener';
  warnings: string[];
}) {
  const symbols = uniqueSymbols(params.symbols);
  if (symbols.length === 0 && params.source !== 'screener') {
    return;
  }

  const runPlanPath = path.join(params.projectPath, '.data-agent', 'finance-run-plan.json');
  const runPlan = await readJson(runPlanPath);
  if (!runPlan) {
    return;
  }

  const existingSymbols = Array.isArray(runPlan.symbols)
    ? uniqueSymbols(
        runPlan.symbols
          .map(pickSymbolCode)
          .filter((symbol): symbol is string => Boolean(symbol))
      )
    : [];
  const existingKey = existingSymbols.join(',');
  const nextKey = symbols.join(',');

  params.plan.symbols = symbols;
  if (existingKey === nextKey && asRecord(runPlan.symbolResolution)) {
    return;
  }

  await writeJson(runPlanPath, {
    ...runPlan,
    symbols,
    symbolResolution: {
      source: params.source,
      resolvedAt: new Date().toISOString(),
      warnings: params.warnings,
    },
    updatedAt: new Date().toISOString(),
  });
}
