import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { getRuntimeDegradationConfig } from '@/lib/config/degradation';
import {
  deliverResearchReportNotification,
  type ResearchNotificationChannelInput,
  type ResearchNotificationReportInput,
} from './notification-adapters';

const MARKET_API_BASE_URL =
  process.env.QUANTPILOT_MARKET_API_URL ||
  process.env.QUANTPILOT_MARKET_API_BASE_URL ||
  'http://127.0.0.1:8000';

const DEFAULT_WATCHLIST_ID = 'daily-quantpilot-core';
const DEFAULT_CHANNEL_ID = 'dry-run-wxwork-research';
const DEFAULT_UNIVERSE_ID = 'a-share-sample-research-pool';

const DEFAULT_SYMBOLS = ['600519.SH', '000001.SZ', '510300.SH'];
const DEFAULT_MARKETS = ['A股', 'ETF'];

type JsonRecord = Record<string, unknown>;

export type ResearchProviderStatus = 'available' | 'partial' | 'unavailable' | 'disabled';

export interface ResearchEvidenceItem {
  source: string;
  status: ResearchProviderStatus;
  detail: string;
  capturedAt: string;
  metrics?: JsonRecord;
}

export interface ResearchWatchlistSnapshot {
  id: string;
  name: string;
  description: string | null;
  universeId: string | null;
  symbols: string[];
  markets: string[];
  status: string;
  schedule: JsonRecord;
  reportTemplate: string;
  notificationChannelIds: string[];
  updatedAt: string;
}

export interface ResearchReportRunSnapshot {
  id: string;
  watchlistId: string | null;
  status: string;
  runType: string;
  startedAt: string;
  finishedAt: string | null;
  providerMode: string;
  error: string | null;
}

export interface ResearchReportSnapshot {
  id: string;
  runId: string;
  watchlistId: string | null;
  title: string;
  summary: string;
  reportDate: string;
  score: number;
  recommendation: string;
  riskLevel: string;
  contentMarkdown: string;
  structured: JsonRecord;
  evidence: ResearchEvidenceItem[];
  source: string;
  createdAt: string;
}

export interface NotificationChannelSnapshot {
  id: string;
  name: string;
  channelType: string;
  status: string;
  target: string | null;
  isDryRun: boolean;
  updatedAt: string;
}

export interface NotificationDeliverySnapshot {
  id: string;
  runId: string | null;
  reportId: string | null;
  channelId: string | null;
  channelType: string;
  status: string;
  title: string;
  error: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface ResearchProviderMatrixItem {
  id: string;
  name: string;
  role: string;
  status: ResearchProviderStatus;
  detail: string;
}

export interface ResearchAutomationDashboard {
  generatedAt: string;
  summary: {
    watchlists: number;
    reports: number;
    activeChannels: number;
    latestScore: number | null;
  };
  watchlists: ResearchWatchlistSnapshot[];
  latestReports: ResearchReportSnapshot[];
  recentRuns: ResearchReportRunSnapshot[];
  notificationChannels: NotificationChannelSnapshot[];
  recentDeliveries: NotificationDeliverySnapshot[];
  providerMatrix: ResearchProviderMatrixItem[];
}

export interface RunDailyResearchReportOptions {
  watchlistId?: string;
  dryRun?: boolean;
  runType?: 'manual' | 'scheduled' | 'dry_run';
}

export interface SendResearchReportOptions {
  reportId?: string;
  dryRun?: boolean;
}

interface MarketProbe<T = unknown> {
  data: T | null;
  evidence: ResearchEvidenceItem;
}

interface ReportBuildResult {
  title: string;
  summary: string;
  score: number;
  recommendation: string;
  riskLevel: string;
  contentMarkdown: string;
  structured: JsonRecord;
  evidence: ResearchEvidenceItem[];
}

function nowIso() {
  return new Date().toISOString();
}

function asRecord(value: unknown): JsonRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  return {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringArray(value: Prisma.JsonValue | null | undefined): string[] {
  return asArray(value).filter((item): item is string => typeof item === 'string');
}

function jsonRecord(value: Prisma.JsonValue | null | undefined): JsonRecord {
  return asRecord(value);
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function evidenceArray(value: Prisma.JsonValue | null | undefined): ResearchEvidenceItem[] {
  return asArray(value)
    .map((item) => {
      const record = asRecord(item);
      const status = asString(record.status, 'unavailable') as ResearchProviderStatus;
      return {
        source: asString(record.source, 'unknown'),
        status: ['available', 'partial', 'unavailable', 'disabled'].includes(status) ? status : 'unavailable',
        detail: asString(record.detail),
        capturedAt: asString(record.capturedAt, nowIso()),
        metrics: asRecord(record.metrics),
      };
    });
}

function compactError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportDateValue() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function extractUniverses(payload: unknown): JsonRecord[] {
  return asArray(asRecord(payload).universes).map(asRecord);
}

function extractCandidates(payload: unknown): JsonRecord[] {
  return asArray(asRecord(payload).candidates).map(asRecord);
}

function candidateLabel(candidate: JsonRecord) {
  const symbol = asString(candidate.symbol) || asString(candidate.code, '-');
  const name = asString(candidate.name, '未命名');
  const score = asNumber(candidate.score);
  const changePercent = asNumber(candidate.change_percent);
  const scoreText = score == null ? '无评分' : `${score.toFixed(1)} 分`;
  const changeText = changePercent == null ? '涨跌未知' : `${changePercent.toFixed(2)}%`;
  return `${name} ${symbol}：${scoreText}，最新涨跌 ${changeText}`;
}

function statusPriority(status: ResearchProviderStatus) {
  if (status === 'available') return 3;
  if (status === 'partial') return 2;
  if (status === 'disabled') return 1;
  return 0;
}

function deriveRiskLevel(score: number, unavailableCount: number) {
  if (unavailableCount >= 2 || score < 65) return 'high';
  if (score < 78) return 'medium';
  return 'low';
}

function riskLevelLabel(level: string) {
  if (level === 'low') return '低';
  if (level === 'high') return '高';
  return '中';
}

function deriveRecommendation(score: number, unavailableCount: number) {
  if (unavailableCount >= 2) return '数据不足，优先补齐证据后再行动';
  if (score >= 82) return '谨慎积极，关注强势候选与仓位纪律';
  if (score >= 70) return '观察为主，等待候选信号确认';
  return '防守为主，先处理数据覆盖与风险暴露';
}

async function fetchMarketProbe<T>(pathName: string, source: string, timeoutMs = 3500): Promise<MarketProbe<T>> {
  const marketApiConfig = getRuntimeDegradationConfig().components.marketApi;
  const capturedAt = nowIso();

  if (!marketApiConfig.enabled) {
    return {
      data: null,
      evidence: {
        source,
        status: 'disabled',
        detail: 'market-data API 已按降级配置停用。',
        capturedAt,
      },
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${MARKET_API_BASE_URL}${pathName}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        data: null,
        evidence: {
          source,
          status: 'unavailable',
          detail: `market-data API ${response.status}: ${body.slice(0, 180)}`,
          capturedAt,
        },
      };
    }
    const data = await response.json() as T;
    return {
      data,
      evidence: {
        source,
        status: 'available',
        detail: '已读取本地 market-data API。',
        capturedAt,
        metrics: probeMetrics(data),
      },
    };
  } catch (error) {
    return {
      data: null,
      evidence: {
        source,
        status: 'unavailable',
        detail: compactError(error),
        capturedAt,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function probeMetrics(data: unknown): JsonRecord {
  const record = asRecord(data);
  const metrics: JsonRecord = {};
  if (Array.isArray(record.universes)) metrics.universes = record.universes.length;
  if (Array.isArray(record.candidates)) metrics.candidates = record.candidates.length;
  if (typeof record.scanned_symbols === 'number') metrics.scannedSymbols = record.scanned_symbols;
  if (typeof record.source === 'string') metrics.source = record.source;

  const analytics = asRecord(record.analytics);
  if (analytics.engine) metrics.engine = analytics.engine;
  if (analytics.status) metrics.analyticsStatus = analytics.status;

  const clickhouseStatus = asString(record.status);
  if (clickhouseStatus) metrics.status = clickhouseStatus;
  return metrics;
}

function mapWatchlist(watchlist: {
  id: string;
  name: string;
  description: string | null;
  universeId: string | null;
  symbols: Prisma.JsonValue;
  markets: Prisma.JsonValue;
  status: string;
  schedule: Prisma.JsonValue;
  reportTemplate: string;
  notificationChannelIds: Prisma.JsonValue;
  updatedAt: Date;
}): ResearchWatchlistSnapshot {
  return {
    id: watchlist.id,
    name: watchlist.name,
    description: watchlist.description,
    universeId: watchlist.universeId,
    symbols: stringArray(watchlist.symbols),
    markets: stringArray(watchlist.markets),
    status: watchlist.status,
    schedule: jsonRecord(watchlist.schedule),
    reportTemplate: watchlist.reportTemplate,
    notificationChannelIds: stringArray(watchlist.notificationChannelIds),
    updatedAt: watchlist.updatedAt.toISOString(),
  };
}

function mapRun(run: {
  id: string;
  watchlistId: string | null;
  status: string;
  runType: string;
  startedAt: Date;
  finishedAt: Date | null;
  providerMode: string;
  error: string | null;
}): ResearchReportRunSnapshot {
  return {
    id: run.id,
    watchlistId: run.watchlistId,
    status: run.status,
    runType: run.runType,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    providerMode: run.providerMode,
    error: run.error,
  };
}

function mapReport(report: {
  id: string;
  runId: string;
  watchlistId: string | null;
  title: string;
  summary: string;
  reportDate: Date;
  score: number;
  recommendation: string;
  riskLevel: string;
  contentMarkdown: string;
  structured: Prisma.JsonValue;
  evidence: Prisma.JsonValue;
  source: string;
  createdAt: Date;
}): ResearchReportSnapshot {
  return {
    id: report.id,
    runId: report.runId,
    watchlistId: report.watchlistId,
    title: report.title,
    summary: report.summary,
    reportDate: report.reportDate.toISOString(),
    score: report.score,
    recommendation: report.recommendation,
    riskLevel: report.riskLevel,
    contentMarkdown: report.contentMarkdown,
    structured: jsonRecord(report.structured),
    evidence: evidenceArray(report.evidence),
    source: report.source,
    createdAt: report.createdAt.toISOString(),
  };
}

function mapChannel(channel: {
  id: string;
  name: string;
  channelType: string;
  status: string;
  target: string | null;
  isDryRun: boolean;
  updatedAt: Date;
}): NotificationChannelSnapshot {
  return {
    id: channel.id,
    name: channel.name,
    channelType: channel.channelType,
    status: channel.status,
    target: channel.target,
    isDryRun: channel.isDryRun,
    updatedAt: channel.updatedAt.toISOString(),
  };
}

function mapDelivery(delivery: {
  id: string;
  runId: string | null;
  reportId: string | null;
  channelId: string | null;
  channelType: string;
  status: string;
  title: string;
  error: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
}): NotificationDeliverySnapshot {
  return {
    id: delivery.id,
    runId: delivery.runId,
    reportId: delivery.reportId,
    channelId: delivery.channelId,
    channelType: delivery.channelType,
    status: delivery.status,
    title: delivery.title,
    error: delivery.error,
    deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
    createdAt: delivery.createdAt.toISOString(),
  };
}

function mapNotificationReport(report: {
  id: string;
  title: string;
  summary: string;
  score: number;
  recommendation: string;
  riskLevel: string;
  contentMarkdown: string;
}): ResearchNotificationReportInput {
  return {
    id: report.id,
    title: report.title,
    summary: report.summary,
    score: report.score,
    recommendation: report.recommendation,
    riskLevel: report.riskLevel,
    contentMarkdown: report.contentMarkdown,
  };
}

function mapNotificationChannel(channel: {
  id: string;
  name: string;
  channelType: string;
  target: string | null;
  config: Prisma.JsonValue;
  isDryRun: boolean;
}): ResearchNotificationChannelInput {
  return {
    id: channel.id,
    name: channel.name,
    channelType: channel.channelType,
    target: channel.target,
    config: channel.config,
    isDryRun: channel.isDryRun,
  };
}

export async function ensureResearchAutomationSeed() {
  const watchlist = await prisma.researchWatchlist.upsert({
    where: { id: DEFAULT_WATCHLIST_ID },
    create: {
      id: DEFAULT_WATCHLIST_ID,
      name: 'QuantPilot 每日核心观察池',
      description: '围绕默认 A 股研究池和少量核心标的生成证据型日报。',
      universeId: DEFAULT_UNIVERSE_ID,
      symbols: DEFAULT_SYMBOLS,
      markets: DEFAULT_MARKETS,
      status: 'active',
      schedule: {
        timezone: 'Asia/Shanghai',
        frequency: 'daily',
        time: '08:30',
        enabled: false,
      },
      reportTemplate: 'daily_brief',
      notificationChannelIds: [DEFAULT_CHANNEL_ID],
      metadata: {
        seeded: true,
        intent: 'research_automation_p0',
        sourceProject: 'QuantPilot',
      },
    },
    update: {},
  });

  const channel = await prisma.notificationChannel.upsert({
    where: { id: DEFAULT_CHANNEL_ID },
    create: {
      id: DEFAULT_CHANNEL_ID,
      name: '企业微信投研日报 Dry-run',
      channelType: 'wxwork',
      status: 'configured',
      target: '本地模拟推送',
      config: {
        mode: 'dry_run',
        adapter: 'wxwork-webhook',
        webhookEnv: 'QUANTPILOT_WXWORK_RESEARCH_WEBHOOK',
        secretConfigured: false,
      },
      isDryRun: true,
    },
    update: {},
  });

  return { watchlist, channel };
}

async function findChannelsForWatchlist(watchlist: ResearchWatchlistSnapshot | null) {
  const ids = watchlist?.notificationChannelIds ?? [DEFAULT_CHANNEL_ID];
  const channels = await prisma.notificationChannel.findMany({
    where: {
      id: { in: ids.length > 0 ? ids : [DEFAULT_CHANNEL_ID] },
      status: { not: 'disabled' },
    },
  });

  if (channels.length > 0) return channels;

  const fallback = await prisma.notificationChannel.findUnique({ where: { id: DEFAULT_CHANNEL_ID } });
  return fallback ? [fallback] : [];
}

async function createNotificationDeliveries(params: {
  runId?: string | null;
  report: ResearchNotificationReportInput;
  channels: ResearchNotificationChannelInput[];
  dryRun: boolean;
}) {
  const deliveries = [];

  for (const channel of params.channels) {
    const result = await deliverResearchReportNotification({
      channel,
      report: params.report,
      forceDryRun: params.dryRun,
    });

    const delivery = await prisma.notificationDelivery.create({
      data: {
        runId: params.runId ?? null,
        reportId: params.report.id,
        channelId: channel.id,
        status: result.status,
        channelType: result.channelType,
        title: result.title,
        payload: result.payload,
        error: result.error,
        deliveredAt: result.deliveredAt,
      },
    });

    deliveries.push(delivery);
  }

  return deliveries;
}

function buildProviderMatrix(
  evidence: ResearchEvidenceItem[] = [],
  channels: NotificationChannelSnapshot[] = []
): ResearchProviderMatrixItem[] {
  const evidenceBySource = new Map(evidence.map((item) => [item.source, item]));
  const market = evidenceBySource.get('本地股票池');
  const screener = evidenceBySource.get('短线候选筛选');
  const clickhouse = evidenceBySource.get('ClickHouse 分析层');

  return [
    {
      id: 'local-market-data',
      name: '本地 market-data',
      role: '股票池、行情覆盖、K 线和候选筛选的事实源',
      status: market?.status ?? 'partial',
      detail: market?.detail ?? '等待下一次日报运行采样。',
    },
    {
      id: 'clickhouse',
      name: 'ClickHouse',
      role: '全市场筛选、横截面因子和批量分析加速层',
      status: clickhouse?.status ?? 'partial',
      detail: clickhouse?.detail ?? '未采样时不判断健康状态。',
    },
    {
      id: 'timescaledb',
      name: 'TimescaleDB',
      role: '本地日线事实库和回测读取口径',
      status: screener?.status ?? 'partial',
      detail: screener?.metrics?.engine === 'timescaledb'
        ? '当前筛选由 TimescaleDB 承接。'
        : '作为 ClickHouse 失败后的稳定回退路径。',
    },
    {
      id: 'news-sentiment',
      name: '新闻与舆情源',
      role: '后续接入企业新闻源、搜索 API 和社交舆情',
      status: 'disabled',
      detail: 'P0 先保留结构化证据位，不默认依赖付费 API。',
    },
    {
      id: 'notifications',
      name: '推送通道',
      role: '企业微信、飞书、钉钉、Telegram、Discord、邮件',
      status: channels.length > 0 ? 'partial' : 'disabled',
      detail: channels.length > 0
        ? `已配置 ${channels.length} 个通道，当前默认 dry-run。`
        : '尚未配置通道。',
    },
  ];
}

function buildReport(params: {
  watchlist: ResearchWatchlistSnapshot;
  universesProbe: MarketProbe;
  screenerProbe: MarketProbe;
  clickhouseProbe: MarketProbe;
}): ReportBuildResult {
  const evidence = [
    { ...params.universesProbe.evidence, source: '本地股票池' },
    { ...params.screenerProbe.evidence, source: '短线候选筛选' },
    { ...params.clickhouseProbe.evidence, source: 'ClickHouse 分析层' },
  ];

  const universes = extractUniverses(params.universesProbe.data);
  const candidates = extractCandidates(params.screenerProbe.data);
  const targetUniverse = universes.find((universe) => asString(universe.id) === params.watchlist.universeId) ?? universes[0] ?? {};
  const analytics = asRecord(asRecord(params.screenerProbe.data).analytics);
  const unavailableCount = evidence.filter((item) => statusPriority(item.status) <= 1).length;
  const readyCount = asNumber(targetUniverse.ready_count) ?? 0;
  const memberCount = asNumber(targetUniverse.member_count) ?? params.watchlist.symbols.length;
  const coverageRatio = memberCount > 0 ? readyCount / memberCount : 0;
  const candidateBoost = Math.min(12, candidates.length * 2);
  const dataPenalty = unavailableCount * 8;
  const coverageScore = Math.round(Math.min(18, coverageRatio * 18));
  const score = Math.max(45, Math.min(90, 62 + coverageScore + candidateBoost - dataPenalty));
  const riskLevel = deriveRiskLevel(score, unavailableCount);
  const recommendation = deriveRecommendation(score, unavailableCount);

  const topCandidates = candidates.slice(0, 5).map(candidateLabel);
  const evidenceLines = evidence.map((item) => `- ${item.source}: ${item.status}，${item.detail}`);
  const checklist = [
    candidates.length > 0 ? '核对前 3 个候选标的的最新 K 线、成交额和涨跌停状态。' : '先检查筛选条件和本地行情覆盖，确认为何没有候选标的。',
    coverageRatio >= 0.8 ? '股票池覆盖率可用于日报观察，继续保留补数监控。' : '优先补齐股票池日线覆盖，避免日报结论偏样本。',
    analytics.engine === 'clickhouse' ? 'ClickHouse 已参与筛选，可继续扩展横截面因子。' : '当前未确认 ClickHouse 命中，批量筛选仍需关注性能。',
    '任何买卖动作必须结合人工复核和风控仓位，不把日报作为即时交易指令。',
  ];

  const title = `${reportDateValue()} ${params.watchlist.name} 投研日报`;
  const summary = candidates.length > 0
    ? `本次生成 ${candidates.length} 个候选标的，综合评分 ${score}，建议：${recommendation}。`
    : `本次未生成候选标的，综合评分 ${score}，重点处理数据覆盖和筛选证据。`;

  const contentMarkdown = [
    `# ${title}`,
    '',
    `## 核心结论`,
    summary,
    '',
    `## 综合评分`,
    `- 评分：${score}/100`,
    `- 风险等级：${riskLevelLabel(riskLevel)}`,
    `- 建议：${recommendation}`,
    '',
    `## 观察池`,
    `- 股票池：${params.watchlist.universeId ?? '未绑定'}`,
    `- 标的：${params.watchlist.symbols.join('、') || '使用股票池成员'}`,
    `- 市场：${params.watchlist.markets.join('、') || '未设置'}`,
    '',
    `## 候选标的`,
    ...(topCandidates.length > 0 ? topCandidates.map((item) => `- ${item}`) : ['- 暂无候选标的。']),
    '',
    `## 证据来源`,
    ...evidenceLines,
    '',
    `## 操作检查清单`,
    ...checklist.map((item) => `- ${item}`),
  ].join('\n');

  return {
    title,
    summary,
    score,
    recommendation,
    riskLevel,
    contentMarkdown,
    evidence,
    structured: {
      version: 1,
      watchlistId: params.watchlist.id,
      coverage: {
        universeId: params.watchlist.universeId,
        readyCount,
        memberCount,
        coverageRatio: Number(coverageRatio.toFixed(4)),
      },
      candidates: candidates.slice(0, 10).map((candidate) => ({
        symbol: asString(candidate.symbol),
        code: asString(candidate.code),
        name: asString(candidate.name),
        score: asNumber(candidate.score),
        changePercent: asNumber(candidate.change_percent),
        tradeDate: asString(candidate.trade_date),
        signals: asArray(candidate.signals).filter((item): item is string => typeof item === 'string'),
        warnings: asArray(candidate.warnings).filter((item): item is string => typeof item === 'string'),
      })),
      analytics: {
        engine: asString(analytics.engine, 'unknown'),
        status: asString(analytics.status, 'unknown'),
        basis: asString(analytics.basis),
      },
      risks: checklist,
      nextAdapters: ['llm-synthesis', 'news-search', 'sentiment-snapshot', 'real-notification-delivery'],
    },
  };
}

export async function getResearchAutomationDashboard(): Promise<ResearchAutomationDashboard> {
  await ensureResearchAutomationSeed();

  const [watchlistCount, reportCount, channelCount, watchlists, reports, runs, channels, deliveries] = await Promise.all([
    prisma.researchWatchlist.count(),
    prisma.researchReport.count(),
    prisma.notificationChannel.count({ where: { status: { not: 'disabled' } } }),
    prisma.researchWatchlist.findMany({ orderBy: { updatedAt: 'desc' }, take: 20 }),
    prisma.researchReport.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.researchReportRun.findMany({ orderBy: { startedAt: 'desc' }, take: 20 }),
    prisma.notificationChannel.findMany({ orderBy: { updatedAt: 'desc' }, take: 10 }),
    prisma.notificationDelivery.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);

  const latestReports = reports.map(mapReport);
  const notificationChannels = channels.map(mapChannel);
  const latestEvidence = latestReports[0]?.evidence ?? [];

  return {
    generatedAt: nowIso(),
    summary: {
      watchlists: watchlistCount,
      reports: reportCount,
      activeChannels: channelCount,
      latestScore: latestReports[0]?.score ?? null,
    },
    watchlists: watchlists.map(mapWatchlist),
    latestReports,
    recentRuns: runs.map(mapRun),
    notificationChannels,
    recentDeliveries: deliveries.map(mapDelivery),
    providerMatrix: buildProviderMatrix(latestEvidence, notificationChannels),
  };
}

export async function runDailyResearchReport(
  options: RunDailyResearchReportOptions = {}
): Promise<ResearchAutomationDashboard> {
  await ensureResearchAutomationSeed();

  const watchlistRecord = await prisma.researchWatchlist.findFirst({
    where: {
      id: options.watchlistId ?? DEFAULT_WATCHLIST_ID,
      status: { not: 'disabled' },
    },
  });

  if (!watchlistRecord) {
    throw new Error(`Research watchlist not found: ${options.watchlistId ?? DEFAULT_WATCHLIST_ID}`);
  }

  const watchlist = mapWatchlist(watchlistRecord);
  const startedAt = new Date();
  const run = await prisma.researchReportRun.create({
    data: {
      watchlistId: watchlist.id,
      status: 'running',
      runType: options.runType ?? (options.dryRun === false ? 'manual' : 'dry_run'),
      startedAt,
      providerMode: 'local',
      metadata: {
        dryRun: options.dryRun ?? true,
        marketApiBaseUrl: MARKET_API_BASE_URL,
      },
    },
  });

  try {
    const universeId = watchlist.universeId ?? DEFAULT_UNIVERSE_ID;
    const [universesProbe, screenerProbe, clickhouseProbe] = await Promise.all([
      fetchMarketProbe(`/api/v1/research/universes/summary`, '本地股票池'),
      fetchMarketProbe(`/api/v1/research/screeners/a-share/short-term-candidates?universe_id=${encodeURIComponent(universeId)}&limit=8`, '短线候选筛选', 5000),
      fetchMarketProbe(`/api/v1/analytics/clickhouse/health`, 'ClickHouse 分析层'),
    ]);

    const builtReport = buildReport({ watchlist, universesProbe, screenerProbe, clickhouseProbe });
    const report = await prisma.researchReport.create({
      data: {
        runId: run.id,
        watchlistId: watchlist.id,
        title: builtReport.title,
        summary: builtReport.summary,
        reportDate: startedAt,
        marketScope: inputJson({
          universeId: watchlist.universeId,
          symbols: watchlist.symbols,
          markets: watchlist.markets,
        }),
        score: builtReport.score,
        recommendation: builtReport.recommendation,
        riskLevel: builtReport.riskLevel,
        contentMarkdown: builtReport.contentMarkdown,
        structured: inputJson(builtReport.structured),
        evidence: inputJson(builtReport.evidence),
        source: 'local-market-data',
      },
    });

    const deliveryChannels = await findChannelsForWatchlist(watchlist);
    const deliveries = await createNotificationDeliveries({
      runId: run.id,
      report: mapNotificationReport(report),
      channels: deliveryChannels.map(mapNotificationChannel),
      dryRun: options.dryRun ?? true,
    });

    await prisma.researchReportRun.update({
      where: { id: run.id },
      data: {
        status: 'completed',
        finishedAt: new Date(),
        metadata: {
          dryRun: options.dryRun ?? true,
          reportId: report.id,
          evidenceStatuses: builtReport.evidence.map((item) => ({
            source: item.source,
            status: item.status,
          })),
          deliveryStatuses: deliveries.map((delivery) => ({
            id: delivery.id,
            channelType: delivery.channelType,
            status: delivery.status,
            error: delivery.error,
          })),
        },
      },
    });
  } catch (error) {
    await prisma.researchReportRun.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        error: compactError(error),
      },
    });
    throw error;
  }

  return getResearchAutomationDashboard();
}

export async function sendResearchReport(
  options: SendResearchReportOptions = {}
): Promise<ResearchAutomationDashboard> {
  await ensureResearchAutomationSeed();

  const report = options.reportId
    ? await prisma.researchReport.findUnique({ where: { id: options.reportId } })
    : await prisma.researchReport.findFirst({ orderBy: { createdAt: 'desc' } });

  if (!report) {
    throw new Error(options.reportId ? `Research report not found: ${options.reportId}` : 'No research report available to send');
  }

  const watchlistRecord = report.watchlistId
    ? await prisma.researchWatchlist.findUnique({ where: { id: report.watchlistId } })
    : null;
  const watchlist = watchlistRecord ? mapWatchlist(watchlistRecord) : null;
  const deliveryChannels = await findChannelsForWatchlist(watchlist);

  if (deliveryChannels.length === 0) {
    throw new Error('No notification channel available');
  }

  await createNotificationDeliveries({
    runId: null,
    report: mapNotificationReport(report),
    channels: deliveryChannels.map(mapNotificationChannel),
    dryRun: options.dryRun ?? false,
  });

  return getResearchAutomationDashboard();
}
