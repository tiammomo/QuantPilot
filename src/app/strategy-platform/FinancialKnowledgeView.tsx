"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, BookOpen, CheckCircle2, ChevronLeft, ChevronRight, DatabaseZap, GitBranch, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

type FinancialWikiPageType = "concept" | "indicator" | "workflow" | "risk" | "source";

type FinancialWikiPage = {
  id: string;
  title: string;
  type: FinancialWikiPageType;
  domain: string;
  summary: string;
  formula?: string;
  decisionUse: string;
  sources: string[];
  links: string[];
  qualityGate: string;
  caveats: string[];
};

type FinancialWikiCollection = {
  id: string;
  name: string;
  description: string;
  pages: string[];
};

const FINANCIAL_WIKI_PAGE_TYPE_LABELS: Record<FinancialWikiPageType, string> = {
  concept: "概念",
  indicator: "指标",
  workflow: "流程",
  risk: "风控",
  source: "数据源",
};

const FINANCIAL_WIKI_PURPOSE = {
  title: "QuantPilot 金融知识库",
  statement:
    "把策略平台反复用到的行情、因子、资金流、交易规则和风控知识整理成可追溯 Wiki，供策略目录、因子目录、Agent 生成和人工复核共同引用。",
  scope: [
    "A 股股票、ETF、指数的行情与策略研究口径",
    "选股、买卖价格、参数扫描、回测和数据质量检查",
    "本地 market-data 服务可验证的数据字段与外部源限制",
  ],
  questions: [
    "这个概念依赖哪些字段，字段当前是否可用？",
    "它如何影响选股、买入、卖出或风控？",
    "它有哪些常见误用，是否需要数据源口径隔离？",
    "它和哪些策略模板、因子或基础组件互相引用？",
  ],
} as const;

const FINANCIAL_WIKI_SCHEMA_RULES = [
  "每个页面必须有 frontmatter：type、domain、status、sources、updatedBy、qualityGate。",
  "指标页面必须写明 formula、字段依赖、复权/时区/交易日口径和缺失值处理。",
  "策略相关页面必须链接到至少一个风险页面或数据质量页面。",
  "不能把外部源口径不同的字段直接混排；必须保留 provider、as_of、fetched_at。",
  "页面之间用 [[页面标题]] 交叉引用，孤立页面进入 Lint 待补链接队列。",
] as const;

const FINANCIAL_WIKI_OPERATIONS = [
  {
    id: "ingest",
    title: "Ingest 摄入",
    description: "读取 API 文档、因子定义、策略模板和外部资料，先形成结构化分析，再生成或更新 Wiki 页面。",
    checks: ["提取实体与指标", "记录来源和字段", "建议 wikilinks", "写入 log.md"],
  },
  {
    id: "query",
    title: "Query 查询",
    description: "按关键词、页面类型和图谱关联组装上下文，用编号页面回答策略问题。",
    checks: ["先搜 index.md", "再扩展相关页面", "预算内保留公式和边界", "回答引用页面编号"],
  },
  {
    id: "lint",
    title: "Lint 检查",
    description: "检查页面结构、缺失来源、断链、口径冲突和过期数据，生成待人工处理项。",
    checks: ["frontmatter 完整", "sources 可追溯", "无孤立页面", "质量门明确"],
  },
] as const;

const FINANCIAL_WIKI_PAGES: FinancialWikiPage[] = [
  {
    id: "market-data-contract",
    title: "行情数据契约",
    type: "source",
    domain: "数据源",
    summary:
      "定义行情响应必须包含 asset_type、source、as_of、fetched_at、currency、timezone、fetch 和 data_quality，避免页面只读价格而丢失来源上下文。",
    decisionUse:
      "任何策略、图表或 Agent 输出在展示行情时，都要同步展示来源、时间和质量状态；缺失字段不能静默置零。",
    sources: ["services/market-data/README.md", "/api/v1/quotes/realtime", "/api/v1/quotes/history"],
    links: ["[[回测样本完整性]]", "[[复权与交易日口径]]", "[[成交额与流动性]]"],
    qualityGate: "响应中 source、as_of、fetched_at、data_quality.status 至少四项完整。",
    caveats: ["浏览器页面优先走同源 /api/market 代理", "外部源失败时要标注 degraded", "缓存命中不代表数据已过期"],
  },
  {
    id: "adjustment-calendar",
    title: "复权与交易日口径",
    type: "concept",
    domain: "行情基础",
    summary:
      "日线、周线、月线和回测必须统一复权口径；A 股交易日以本地交易日历或已入库 K 线推断为准。",
    formula: "前复权 qfq 用于趋势与回测；不复权 none 用于盘中和原始价格检查。",
    decisionUse:
      "均线、收益率、回撤、ATR 和突破信号在复权口径不一致时会失真，策略扫描前必须固定 adjustment。",
    sources: ["quant.stock_bars", "/api/v1/foundation/trading-calendar", "/api/v1/quotes/history/{symbol}"],
    links: ["[[移动均线 MA]]", "[[ATR 真实波幅]]", "[[行情数据契约]]"],
    qualityGate: "同一策略模板只允许一个 timeframe + adjustment 组合进入回测。",
    caveats: ["分红除权会影响历史价格", "指数/ETF/股票可能适用不同默认口径", "节假日不能用自然日推断样本间隔"],
  },
  {
    id: "moving-average",
    title: "移动均线 MA",
    type: "indicator",
    domain: "趋势",
    summary:
      "MA5/10 反映短线成本，MA20/30 反映月度趋势，MA60 更接近中期趋势，是趋势过滤和持仓跟踪的基础页面。",
    formula: "MA(N) = 最近 N 个交易日收盘价之和 / N",
    decisionUse:
      "股价在 MA5 上方且 MA5 > MA10 > MA20 > MA30 > MA60，通常说明短中期成本逐级抬升，可作为趋势选股过滤。",
    sources: ["quant.stock_bars.close", "/api/v1/indicators/technical/{symbol}"],
    links: ["[[复权与交易日口径]]", "[[涨停/跌停制度]]", "[[回撤与收益风险比]]"],
    qualityGate: "至少 60 根同一复权口径 K 线可用，否则 MA60 不进入判断。",
    caveats: ["均线滞后", "震荡市容易反复假信号", "不同复权口径不可混用"],
  },
  {
    id: "dde-order-flow",
    title: "DDE 大单金额",
    type: "indicator",
    domain: "资金流",
    summary:
      "衡量大资金在某只股票上的净流入方向；不同数据源对“大单”的阈值会不同，落库时必须保留 provider 和 raw_payload。",
    formula: "大单买入金额 - 大单卖出金额",
    decisionUse:
      "连续为正通常代表资金承接更强，适合与涨停、均线多头、放量一起使用；单日转负可作为接力策略降权或退出信号。",
    sources: ["待接入 DDE provider", "quant.stock_factors.capital_flow_*"],
    links: ["[[板块资金热度代理]]", "[[成交额与流动性]]", "[[涨停/跌停制度]]"],
    qualityGate: "同一 provider、同一粒度、连续 3 个交易日以上才允许参与排序。",
    caveats: ["不要只看单日", "必须看成交额覆盖", "需要区分日终数据和盘中快照"],
  },
  {
    id: "sector-flow-proxy",
    title: "板块资金热度代理",
    type: "workflow",
    domain: "资金流",
    summary:
      "在真实 DDE/主力净流入字段接入前，用板块内成交额、换手、上涨占比、涨停数和 20 日强弱构建资金热度代理。",
    formula: "proxyNetAmount = Σ(成交额 × 涨跌方向权重)",
    decisionUse:
      "先判断资金是否在板块层面共振，再下钻龙头；避免只因为单只股票异动就误判为主线行情。",
    sources: ["/api/v1/research/screeners/a-share/short-term-candidates", "/api/v1/research/bars/{symbol}", "sector tags"],
    links: ["[[DDE 大单金额]]", "[[成交额与流动性]]", "[[涨停/跌停制度]]"],
    qualityGate: "板块样本至少 5 只且覆盖率超过 60%，否则只展示观察状态。",
    caveats: ["这是资金热度代理，不是真实 DDE", "板块标签稀疏会影响聚合", "单日热度不能替代连续性"],
  },
  {
    id: "turnover-liquidity",
    title: "成交额与流动性",
    type: "indicator",
    domain: "流动性",
    summary:
      "成交额比成交量更适合跨价格区间比较流动性，换手率反映筹码交换程度，两者共同决定策略是否可交易。",
    formula: "成交额 = 成交价格 × 成交量；换手率 = 成交量 / 流通股本 × 100%",
    decisionUse:
      "成交额不足的股票，即使命中 DDE 或均线条件，也可能无法承载实际交易规模；极端换手叠加放量阴线需降权。",
    sources: ["quant.stock_bars.amount", "quant.stock_bars.turnover", "quant.stock_bars.volume"],
    links: ["[[DDE 大单金额]]", "[[ATR 真实波幅]]", "[[回测样本完整性]]"],
    qualityGate: "20 日平均成交额和换手率至少一项可用，缺失时不参与流动性排序。",
    caveats: ["放量也可能是出货", "低成交额样本回测容易虚高", "新股和小盘股需单独阈值"],
  },
  {
    id: "limit-up-down",
    title: "涨停/跌停制度",
    type: "concept",
    domain: "交易规则",
    summary:
      "主板、创业板、科创板、北交所、ST 的涨跌幅限制不同，策略里要明确剔除、分层或单独设置阈值。",
    formula: "涨停价 ≈ 前收盘价 × (1 + 涨跌幅限制)",
    decisionUse:
      "近 4 日涨停至少 1 次说明短线情绪被激活；当日已经涨停则可能无法合理买入，应标记不可成交。",
    sources: ["quant.stock_bars.limit_up", "quant.stock_bars.limit_down", "quant.stock_bars.is_st"],
    links: ["[[移动均线 MA]]", "[[开盘强弱与回踩承接]]", "[[成交额与流动性]]"],
    qualityGate: "必须识别 ST、停牌、涨停、跌停和市场板块，避免错误计算可成交性。",
    caveats: ["涨停不等于可以买到", "一字板需要盘口数据", "涨跌幅制度随市场板块变化"],
  },
  {
    id: "gap-open-support",
    title: "开盘强弱与回踩承接",
    type: "indicator",
    domain: "买卖价格",
    summary:
      "高开代表情绪延续，回踩前收、MA5 或关键价位不破代表承接较强，是短线买点设计的重要页面。",
    formula: "开盘涨幅 = (今日开盘价 - 昨日收盘价) / 昨日收盘价 × 100%",
    decisionUse:
      "涨停次日策略里，开盘价大于昨收是强势条件；高开过多则成本失控，需要等待回踩或放弃。",
    sources: ["quant.stock_bars.open", "quant.stock_bars.previous_close", "minute1 intraday"],
    links: ["[[涨停/跌停制度]]", "[[ATR 真实波幅]]", "[[回撤与收益风险比]]"],
    qualityGate: "日线可给粗判断；真实承接必须接入分钟线或集合竞价金额。",
    caveats: ["高开过多会降低收益风险比", "日线无法判断盘中承接", "集合竞价金额很关键"],
  },
  {
    id: "atr-volatility",
    title: "ATR 真实波幅",
    type: "indicator",
    domain: "波动",
    summary:
      "ATR 衡量标的近期正常波动范围，比简单涨跌幅更适合做止损、买入区间和追高上限。",
    formula: "TR = max(高 - 低, |高 - 昨收|, |低 - 昨收|)；ATR = TR 的 N 日均值",
    decisionUse:
      "买入价、止损价、追高上限可以用 ATR 反推，例如止损距离 1.2 ATR，止盈至少 2R。",
    sources: ["quant.stock_bars.high", "quant.stock_bars.low", "quant.stock_bars.close"],
    links: ["[[回撤与收益风险比]]", "[[开盘强弱与回踩承接]]", "[[成交额与流动性]]"],
    qualityGate: "至少 14 根连续 K 线可用；低价股优先使用 ATR 百分比。",
    caveats: ["突发事件会抬高 ATR", "ATR 不能替代流动性检查", "波动扩张不必然代表趋势"],
  },
  {
    id: "risk-r-multiple",
    title: "回撤与收益风险比",
    type: "risk",
    domain: "风控",
    summary:
      "把买入、止损、止盈统一成可比较的风险单位，避免只看涨幅不看亏损，是策略输出必须附带的风险页面。",
    formula: "R = 买入价 - 止损价；收益风险比 = (目标价 - 买入价) / R",
    decisionUse:
      "买入前先算止损，至少看到 2R 空间再考虑入场；达到 2R 可先减仓，再用均线或 ATR 跟踪。",
    sources: ["strategy templates", "backtest metrics", "quant.stock_bars.close"],
    links: ["[[ATR 真实波幅]]", "[[移动均线 MA]]", "[[回测样本完整性]]"],
    qualityGate: "策略工作空间必须同时输出买入价、止损价、目标价和放弃条件。",
    caveats: ["止损不能事后移动放宽", "目标价不应凭感觉设置", "滑点会降低真实收益风险比"],
  },
  {
    id: "backtest-integrity",
    title: "回测样本完整性",
    type: "risk",
    domain: "回测",
    summary:
      "回测前检查 K 线缺口、复权口径、成交额、停牌/ST、涨跌停和字段增强状态，避免样本质量问题伪造收益。",
    decisionUse:
      "只有通过数据质量扫描的标的才进入参数扫描；缺字段策略必须保持 planned 或 needs_data 状态。",
    sources: ["/api/v1/foundation/data-quality/scan", "strategyScanRun", "strategyScanJob"],
    links: ["[[行情数据契约]]", "[[复权与交易日口径]]", "[[成交额与流动性]]"],
    qualityGate: "错误级问题为 0，警告项必须在页面中显式展示。",
    caveats: ["低流动性样本回测可能虚高", "不能用 0 替代缺失值", "参数扫描要控制过拟合"],
  },
] as const;

const FINANCIAL_WIKI_COLLECTIONS: FinancialWikiCollection[] = [
  {
    id: "foundation",
    name: "基础口径",
    description: "先确认数据契约、复权、交易日和行情质量，再谈指标。",
    pages: ["market-data-contract", "adjustment-calendar", "backtest-integrity"],
  },
  {
    id: "signals",
    name: "信号与因子",
    description: "趋势、资金流、流动性、波动和开盘强弱的计算与误用边界。",
    pages: ["moving-average", "dde-order-flow", "turnover-liquidity", "gap-open-support", "atr-volatility"],
  },
  {
    id: "strategy",
    name: "策略与风控",
    description: "把信号组合成可执行策略，并用收益风险比和样本完整性约束。",
    pages: ["sector-flow-proxy", "limit-up-down", "risk-r-multiple"],
  },
];

const FINANCIAL_WIKI_LOG = [
  { date: "2026-06-03", event: "重构金融知识模块为 Wiki 结构，补齐 purpose、schema、index、pages 与 lint 清单。" },
  { date: "2026-05-30", event: "接入因子目录与基础组件视图，知识页面开始引用本地 market-data 字段口径。" },
  { date: "2026-05-28", event: "策略平台新增股票池、策略目录、参数扫描和回测归档入口。" },
] as const;

const FINANCIAL_WIKI_ENTRY_POINTS = [
  {
    id: "strategy-context",
    title: "策略生成上下文",
    description: "把数据契约、复权口径和样本完整性作为生成前置条件。",
    pageIds: ["market-data-contract", "adjustment-calendar", "backtest-integrity"],
  },
  {
    id: "trade-price",
    title: "买卖价格判断",
    description: "用开盘强弱、ATR 和收益风险比约束追高、止损和目标价。",
    pageIds: ["gap-open-support", "atr-volatility", "risk-r-multiple"],
  },
  {
    id: "factor-research",
    title: "因子口径校验",
    description: "确认均线、资金流、成交额和流动性字段是否可用于排序。",
    pageIds: ["moving-average", "dde-order-flow", "turnover-liquidity"],
  },
  {
    id: "risk-review",
    title: "回测与风控复核",
    description: "检查涨跌停、流动性、回撤和缺失字段是否影响结果可信度。",
    pageIds: ["limit-up-down", "turnover-liquidity", "risk-r-multiple"],
  },
] as const;

function pageTypeClass(type: FinancialWikiPageType) {
  if (type === "indicator") return "border-blue-200 bg-blue-50 text-blue-700";
  if (type === "workflow") return "border-violet-200 bg-violet-50 text-violet-700";
  if (type === "risk") return "border-red-200 bg-red-50 text-red-700";
  if (type === "source") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function parseWikiLinkTitle(link: string) {
  return link.replace(/^\[\[/, "").replace(/\]\]$/, "");
}

export function FinancialKnowledgeView() {
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>("all");
  const [selectedType, setSelectedType] = useState<FinancialWikiPageType | "all">("all");
  const [selectedPageId, setSelectedPageId] = useState<string>(FINANCIAL_WIKI_PAGES[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [showProtocol, setShowProtocol] = useState(false);
  const pageById = useMemo(() => new Map(FINANCIAL_WIKI_PAGES.map((page) => [page.id, page])), []);
  const pageByTitle = useMemo(() => new Map(FINANCIAL_WIKI_PAGES.map((page) => [page.title, page])), []);
  const selectedCollection = FINANCIAL_WIKI_COLLECTIONS.find((collection) => collection.id === selectedCollectionId);
  const selectedCollectionPages = useMemo(
    () => (selectedCollection ? new Set(selectedCollection.pages) : null),
    [selectedCollection],
  );
  const filteredPages = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return FINANCIAL_WIKI_PAGES.filter((page) => {
      const collectionMatch = !selectedCollectionPages || selectedCollectionPages.has(page.id);
      const typeMatch = selectedType === "all" || page.type === selectedType;
      const text = [
        page.id,
        page.title,
        page.type,
        page.domain,
        page.summary,
        page.formula,
        page.decisionUse,
        page.qualityGate,
        ...page.sources,
        ...page.links,
        ...page.caveats,
      ].join(" ").toLowerCase();
      return collectionMatch && typeMatch && (!lower || text.includes(lower));
    });
  }, [query, selectedCollectionPages, selectedType]);

  useEffect(() => {
    if (filteredPages.length && !filteredPages.some((page) => page.id === selectedPageId)) {
      setSelectedPageId(filteredPages[0].id);
    }
  }, [filteredPages, selectedPageId]);

  const pageTypes = Object.keys(FINANCIAL_WIKI_PAGE_TYPE_LABELS) as FinancialWikiPageType[];
  const linkGraphEdges = FINANCIAL_WIKI_PAGES.reduce((sum, page) => sum + page.links.length, 0);
  const sourceCount = new Set(FINANCIAL_WIKI_PAGES.flatMap((page) => page.sources)).size;
  const selectedPage = pageById.get(selectedPageId) ?? filteredPages[0] ?? FINANCIAL_WIKI_PAGES[0];
  const relatedPages = selectedPage
    ? selectedPage.links
        .map((link) => pageByTitle.get(parseWikiLinkTitle(link)))
        .filter((page): page is FinancialWikiPage => Boolean(page))
    : [];
  const selectedPageIndex = filteredPages.findIndex((p) => p.id === selectedPage?.id);

  const navigatePage = useCallback(
    (direction: -1 | 1) => {
      const nextIdx = selectedPageIndex + direction;
      if (nextIdx >= 0 && nextIdx < filteredPages.length) {
        setSelectedPageId(filteredPages[nextIdx].id);
      }
    },
    [selectedPageIndex, filteredPages],
  );

  if (!selectedPage) {
    return <EmptyState title="知识库暂无页面" description="补充页面后会出现在这里" className="border-0" />;
  }

  return (
    <div className="space-y-4">
      {/* ── Compact Header ─────────────────────────────────────── */}
      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-4 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 ring-1 ring-blue-100">
              <BookOpen className="h-4 w-4 text-blue-500" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-slate-900">{FINANCIAL_WIKI_PURPOSE.title}</h2>
                <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-600 ring-1 ring-blue-100">
                  {FINANCIAL_WIKI_PAGES.length} 页
                </span>
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-600 ring-1 ring-emerald-100">
                  {sourceCount} 来源
                </span>
                <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-600 ring-1 ring-violet-100">
                  {linkGraphEdges} 链接
                </span>
              </div>
              <p className="mt-0.5 max-w-xl text-xs text-slate-500 line-clamp-1">{FINANCIAL_WIKI_PURPOSE.statement}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="搜索金融知识页面"
                placeholder="搜索知识页面..."
                className="h-8 border-slate-200 bg-white pl-8 text-xs"
              />
            </div>
            <button
              type="button"
              onClick={() => setShowProtocol((v) => !v)}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors",
                showProtocol
                  ? "border-blue-200 bg-blue-50 text-blue-700"
                  : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
              )}
            >
              <DatabaseZap className="h-3.5 w-3.5" />
              协议
            </button>
          </div>
        </div>

        {/* Entry Points */}
        <div className="border-t border-slate-100 px-5 py-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {FINANCIAL_WIKI_ENTRY_POINTS.map((entry) => {
              const firstPage = pageById.get(entry.pageIds[0]);
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => {
                    setSelectedCollectionId("all");
                    setSelectedType("all");
                    setQuery("");
                    if (firstPage) setSelectedPageId(firstPage.id);
                  }}
                  className="group flex items-start gap-2.5 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-left transition-all hover:border-blue-200 hover:bg-blue-50"
                >
                  <div className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400 group-hover:bg-blue-500" />
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold text-slate-800 group-hover:text-blue-700">{entry.title}</p>
                    <p className="mt-0.5 line-clamp-1 text-[11px] leading-4 text-slate-500">{entry.description}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Protocol Panel (collapsible) ──────────────────────── */}
      {showProtocol && (
        <section className="grid gap-3 lg:grid-cols-[1fr_320px]">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-slate-950">Ingest / Query / Lint 生命周期</h3>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">protocol</span>
            </div>
            <div className="mt-3 grid gap-2.5 lg:grid-cols-3">
              {FINANCIAL_WIKI_OPERATIONS.map((operation) => (
                <article key={operation.id} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                  <p className="text-xs font-bold text-slate-900">{operation.title}</p>
                  <p className="mt-1.5 text-xs leading-5 text-slate-600">{operation.description}</p>
                  <div className="mt-2 space-y-1">
                    {operation.checks.map((check) => (
                      <p key={`${operation.id}-${check}`} className="flex gap-1.5 text-[11px] leading-4 text-slate-600">
                        <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
                        <span>{check}</span>
                      </p>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-xs font-semibold text-slate-950">log.md</p>
            <div className="mt-2.5 space-y-2">
              {FINANCIAL_WIKI_LOG.map((item) => (
                <div key={`${item.date}-${item.event}`} className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2">
                  <p className="font-mono text-[11px] font-semibold text-slate-500">{item.date}</p>
                  <p className="mt-0.5 text-xs leading-5 text-slate-700">{item.event}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── Main: Left nav+list | Right detail ─────────────────── */}
      <section className="grid gap-4 xl:grid-cols-[340px_1fr]">
        {/* Left: Filters + Page List */}
        <aside className="space-y-3 xl:sticky xl:top-24 xl:self-start">
          {/* Filter Bar */}
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            {/* Collection Tabs */}
            <div className="border-b border-slate-100 px-3 py-2">
              <div className="flex flex-wrap gap-1">
                <button
                  type="button"
                  onClick={() => setSelectedCollectionId("all")}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    selectedCollectionId === "all"
                      ? "bg-slate-900 text-white"
                      : "text-slate-500 hover:bg-slate-100"
                  )}
                >
                  全部
                </button>
                {FINANCIAL_WIKI_COLLECTIONS.map((collection) => (
                  <button
                    key={collection.id}
                    type="button"
                    onClick={() => setSelectedCollectionId(collection.id)}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                      selectedCollectionId === collection.id
                        ? "bg-slate-900 text-white"
                        : "text-slate-500 hover:bg-slate-100"
                    )}
                  >
                    {collection.name}
                    <span className="ml-1 text-[10px] opacity-60">{collection.pages.length}</span>
                  </button>
                ))}
              </div>
            </div>
            {/* Type Chips */}
            <div className="flex flex-wrap gap-1 border-b border-slate-100 px-3 py-2">
              <button
                type="button"
                onClick={() => setSelectedType("all")}
                className={cn(
                  "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
                  selectedType === "all" ? "bg-blue-50 text-blue-700" : "text-slate-400 hover:bg-slate-50"
                )}
              >
                全部
              </button>
              {pageTypes.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setSelectedType(type)}
                  className={cn(
                    "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
                    selectedType === type ? pageTypeClass(type) : "text-slate-400 hover:bg-slate-50"
                  )}
                >
                  {FINANCIAL_WIKI_PAGE_TYPE_LABELS[type]}
                </button>
              ))}
            </div>
            {/* Page Count */}
            <div className="px-3 py-1.5">
              <p className="text-[11px] text-slate-400">
                {filteredPages.length} / {FINANCIAL_WIKI_PAGES.length} 页
              </p>
            </div>
          </div>

          {/* Page List */}
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="max-h-[calc(100vh-340px)] overflow-y-auto divide-y divide-slate-100">
              {filteredPages.map((page) => {
                const active = selectedPage.id === page.id;
                return (
                  <button
                    key={page.id}
                    type="button"
                    onClick={() => setSelectedPageId(page.id)}
                    className={cn(
                      "flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors",
                      active ? "bg-blue-50/80" : "hover:bg-slate-50"
                    )}
                  >
                    <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{
                      backgroundColor:
                        page.type === "indicator" ? "#3b82f6" :
                        page.type === "workflow" ? "#8b5cf6" :
                        page.type === "risk" ? "#ef4444" :
                        page.type === "source" ? "#10b981" : "#94a3b8"
                    }} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <h3 className={cn("truncate text-sm font-semibold", active ? "text-blue-700" : "text-slate-900")}>
                          {page.title}
                        </h3>
                        <span className="shrink-0 text-[10px] text-slate-400">{page.domain}</span>
                      </div>
                      <p className="mt-0.5 line-clamp-1 text-xs text-slate-500">{page.summary}</p>
                    </div>
                    <ArrowRight className={cn("mt-1 h-3 w-3 shrink-0", active ? "text-blue-500" : "text-transparent")} />
                  </button>
                );
              })}
              {!filteredPages.length && (
                <div className="px-4 py-8 text-center text-xs text-slate-400">没有匹配的页面</div>
              )}
            </div>
          </div>
        </aside>

        {/* Right: Page Detail */}
        <article className="rounded-xl border border-slate-200 bg-white shadow-sm">
          {/* Detail Header */}
          <div className="border-b border-slate-100 px-6 py-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn("rounded-md px-2 py-0.5 text-[11px] font-medium", pageTypeClass(selectedPage.type))}>
                  {FINANCIAL_WIKI_PAGE_TYPE_LABELS[selectedPage.type]}
                </span>
                <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">{selectedPage.domain}</span>
                <code className="rounded bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">{selectedPage.id}.md</code>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => navigatePage(-1)}
                  disabled={selectedPageIndex <= 0}
                  className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 disabled:opacity-30"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="min-w-[48px] text-center text-[11px] tabular-nums text-slate-400">
                  {selectedPageIndex + 1} / {filteredPages.length}
                </span>
                <button
                  type="button"
                  onClick={() => navigatePage(1)}
                  disabled={selectedPageIndex >= filteredPages.length - 1}
                  className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 disabled:opacity-30"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
            <h3 className="mt-3 text-2xl font-bold tracking-tight text-slate-950">{selectedPage.title}</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">{selectedPage.summary}</p>
          </div>

          {/* Detail Body */}
          <div className="px-6 py-5">
            <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
              {/* Main column */}
              <div className="space-y-4">
                {/* Formula */}
                {selectedPage.formula && (
                  <div className="rounded-lg border border-violet-200 bg-violet-50/60 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wider text-violet-500">公式 Formula</p>
                    <code className="mt-2 block whitespace-pre-wrap rounded-md bg-white/80 px-3 py-2.5 font-mono text-xs leading-6 text-violet-900 ring-1 ring-violet-100">
                      {selectedPage.formula}
                    </code>
                  </div>
                )}

                {/* Decision Use */}
                <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-blue-500">决策用途</p>
                  <p className="mt-2 text-sm leading-6 text-blue-950">{selectedPage.decisionUse}</p>
                </div>

                {/* Caveats */}
                <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-amber-600">注意事项</p>
                  <div className="mt-2 space-y-1.5">
                    {selectedPage.caveats.map((caveat) => (
                      <p key={`${selectedPage.id}-caveat-${caveat}`} className="flex gap-2 text-sm leading-6 text-amber-950">
                        <span className="mt-2.5 h-1 w-1 shrink-0 rounded-full bg-amber-400" />
                        <span>{caveat}</span>
                      </p>
                    ))}
                  </div>
                </div>

                {/* Wikilinks */}
                <div className="rounded-lg border border-slate-200 p-4">
                  <div className="flex items-center gap-2">
                    <GitBranch className="h-3.5 w-3.5 text-blue-500" />
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">关联页面</p>
                  </div>
                  {relatedPages.length > 0 ? (
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {relatedPages.map((page) => (
                        <button
                          key={`${selectedPage.id}-related-${page.id}`}
                          type="button"
                          onClick={() => {
                            setSelectedCollectionId("all");
                            setSelectedType("all");
                            setQuery("");
                            setSelectedPageId(page.id);
                          }}
                          className="group flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-left transition-all hover:border-blue-300 hover:bg-blue-50"
                        >
                          <div className="h-1.5 w-1.5 shrink-0 rounded-full" style={{
                            backgroundColor:
                              page.type === "indicator" ? "#3b82f6" :
                              page.type === "workflow" ? "#8b5cf6" :
                              page.type === "risk" ? "#ef4444" :
                              page.type === "source" ? "#10b981" : "#94a3b8"
                          }} />
                          <span className="text-xs font-medium text-slate-700 group-hover:text-blue-700">{page.title}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-slate-400">暂无关联页面</p>
                  )}
                </div>
              </div>

              {/* Right sidebar: metadata */}
              <div className="space-y-3">
                {/* Quality Gate */}
                <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3.5">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600">质量门</p>
                  <p className="mt-1.5 text-xs leading-5 text-emerald-950">{selectedPage.qualityGate}</p>
                </div>

                {/* Sources */}
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">数据来源</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {selectedPage.sources.map((source) => (
                      <code key={`${selectedPage.id}-source-${source}`} className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-600 ring-1 ring-slate-200">
                        {source}
                      </code>
                    ))}
                  </div>
                </div>

                {/* Agent Context */}
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Agent 上下文</p>
                  <div className="mt-2 rounded-md bg-white p-2.5 font-mono text-[10px] leading-5 text-slate-600 ring-1 ring-slate-200">
                    <p>page: {selectedPage.title}</p>
                    <p>type: {selectedPage.type}</p>
                    <p>qualityGate: {selectedPage.qualityGate}</p>
                    <p>sources: {selectedPage.sources.join(", ")}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </article>
      </section>
    </div>
  );
}
