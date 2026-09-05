import path from 'path';
import { type QuantValidationCheck } from './contracts';
import { readTextFile } from './files';
import {
  asRecord,
  extractFetchedSymbols,
  extractPlannedSymbols,
  hasExplicitTradingPlanIntent,
  inferExpectedTemplateFromTask,
  inspectDashboardDataPayload,
  isStructuredEmptyScreenerResult,
  normalizeTextForIntent,
  pickString,
  readRunPlan,
} from './inputs';

export async function checkDashboardBinding(
  projectPath: string
): Promise<Omit<QuantValidationCheck, 'id' | 'name' | 'durationMs'>> {
  const pagePath = path.join(projectPath, 'app', 'page.tsx');
  const page = await readTextFile(pagePath);
  if (!page) {
    return {
      status: 'failed',
      summary: '未找到 app/page.tsx。',
    };
  }

  const defaultPageSignals = [
    'Get started by editing',
    'Learn →',
    'Examples →',
    'Next.js →',
  ];
  if (defaultPageSignals.some((signal) => page.includes(signal))) {
    return {
      status: 'failed',
      summary: 'app/page.tsx 仍包含 Next.js 默认页内容。',
    };
  }

  const bindingSignals = [
    '/api/market',
    'dashboard-data.json',
    'data_file/final',
    'data_file\\final',
    'fetch(',
  ];
  const hasBindingSignal = bindingSignals.some((signal) => page.includes(signal));
  const hardcodedDataSignals = [
    /const\s+DASHBOARD_DATA\s*[:=]\s*\{/,
    /const\s+(?:STATIC_|MOCK_|SAMPLE_)?(?:QUOTE|QUOTES|HISTORY|KLINE|KLINES|FINANCIALS|REPORTS|ANNOUNCEMENTS|DASHBOARD_DATA)\s*[:=]\s*(?:\[|\{)/,
    /(?:bars|reports|announcements)\s*:\s*\[\s*\{[\s\S]{0,80}(?:open|close|report_date|notice_date|title)\s*:/,
  ];
  const hasStaticSmell =
    hardcodedDataSignals.some((signal) => signal.test(page)) ||
    (page.match(/(?:trade_date|report_date|notice_date|change_percent)\s*:/g)?.length ?? 0) > 30;
  const runPlan = await readRunPlan(projectPath);
  const plannedSymbols = extractPlannedSymbols(runPlan);
  const finalDataRaw = await readTextFile(path.join(projectPath, 'data_file', 'final', 'dashboard-data.json'));
  let finalData: unknown = null;
  try {
    finalData = finalDataRaw ? JSON.parse(finalDataRaw) : null;
  } catch {
    finalData = null;
  }
  const finalDataRecord = asRecord(finalData);
  const assetRows = Array.isArray(finalDataRecord?.assets) ? finalDataRecord.assets : [];
  const fetchedSymbols = extractFetchedSymbols(finalData);
  const payloadInspection = inspectDashboardDataPayload(finalData);
  const isEmptyScreenerResult = isStructuredEmptyScreenerResult(finalData);
  const isMultiSymbolTask = plannedSymbols.length > 1 || assetRows.length > 1;
  const runPlanVisualization = asRecord(runPlan?.visualization);
  const plannedTemplateId = pickString(runPlanVisualization?.templateId);
  const expectedTemplateId = inferExpectedTemplateFromTask(runPlan);
  const taskText = normalizeTextForIntent([
    runPlan?.question,
    runPlan?.task,
    runPlan?.instruction,
    runPlan?.clarification,
  ]);
  const requiredPanels = Array.isArray(runPlanVisualization?.panels)
    ? runPlanVisualization.panels.map((panel) => pickString(panel)).filter((panel): panel is string => Boolean(panel))
    : [];

  if (!hasBindingSignal) {
    return {
      status: 'failed',
      summary: '页面未检测到数据文件或同源行情 API 绑定。',
      details: 'app/page.tsx 应读取 data_file/final/dashboard-data.json，或通过 /api/market/** 获取真实数据。',
    };
  }

  if (hasStaticSmell) {
    return {
      status: 'failed',
      summary: '页面疑似直接硬编码大段行情/财务数据，未形成可复用的数据绑定。',
      details: '请让 app/page.tsx 读取 data_file/final/dashboard-data.json，或通过 /api/market/** 获取数据；不要把完整数据对象内联到页面代码。',
    };
  }

  if (!payloadInspection.hasUsableMarketData && !isEmptyScreenerResult) {
    return {
      status: 'failed',
      summary: '页面数据入口存在，但最终数据无法映射出实时行情或 K 线样本。',
      details: '请先生成可用 data_file/final/dashboard-data.json；其中至少应包含 quote.price 或 kline.bars/history.bars 等字段。',
      metadata: payloadInspection,
    };
  }

  const hasStandardBinding =
    /function\s+getBars\(|extractBarsFromDashboardData|data-source-file=\{DATA_FILE\}|data_file\/final\/dashboard-data\.json/.test(page);
  if (!hasStandardBinding) {
    return {
      status: 'failed',
      summary: '页面未使用 QuantPilot 标准看板数据绑定结构。',
      details: '请使用平台标准模板读取 dashboard-data.json，并通过统一解析层渲染最新价、K 线样本、指标、财务和公告。',
    };
  }

  const internalPresentationSignals = [
    '数据信源渠道',
    '技术证据',
    'evidence/sources.json',
    '场景模板',
    '必备组件',
  ].filter((signal) => page.includes(signal));
  if (internalPresentationSignals.length > 0) {
    return {
      status: 'failed',
      summary: '页面把后台审计或生成契约信息渲染到了用户看板。',
      details: `请移除用户可见的 ${internalPresentationSignals.join('、')} 分区；页面只保留更新时间、报告期、样本口径和质量/缺失提示，渠道端点、技术路径、模板 ID 与组件契约继续保留在后台 evidence/run plan 中。`,
      metadata: {
        internalPresentationSignals,
      },
    };
  }

  if (expectedTemplateId && plannedTemplateId !== expectedTemplateId) {
    const expectedTemplateGuidance: Record<string, string> = {
      'holding-analysis': '组合、持仓、调仓或账户类任务必须走持仓分析模板。',
      'stock-selection': '多标的比较或选股任务必须走候选对比模板。',
      'strategy-research': '策略假设与筛选研究必须走策略研究模板。',
      'technical-timing': '技术分析任务必须走技术择时模板。',
      'fundamental-research': '基本面分析任务必须走基本面研究模板。',
    };
    return {
      status: 'failed',
      summary: `执行计划模板与任务语义不一致，应使用 ${expectedTemplateId}。`,
      details: `当前 run_plan.visualization.templateId=${plannedTemplateId ?? '未设置'}。${expectedTemplateGuidance[expectedTemplateId] ?? '请按 capability 任务合同选择场景模板。'}`,
      metadata: {
        expectedTemplateId,
        plannedTemplateId,
      },
    };
  }

  const finalTemplateId = pickString(asRecord(finalDataRecord?.visualization)?.template_id ?? asRecord(finalDataRecord?.visualization)?.templateId);
  if (expectedTemplateId && finalTemplateId && finalTemplateId !== expectedTemplateId) {
    return {
      status: 'failed',
      summary: `最终数据模板与任务语义不一致，应使用 ${expectedTemplateId}。`,
      details: `当前 data_file/final/dashboard-data.json visualization.template_id=${finalTemplateId}。`,
      metadata: {
        expectedTemplateId,
        finalTemplateId,
      },
    };
  }

  const tradingPlanRows = Array.isArray(asRecord(finalDataRecord?.tradingPlan)?.rows)
    ? asRecord(finalDataRecord?.tradingPlan)?.rows as unknown[]
    : [];
  const hasPageTradingPlan = /短线交易计划|交易计划|买入区间|买点|卖点|止损|止盈|目标价|仓位上限|入场|出场/.test(page);
  if (!hasExplicitTradingPlanIntent(taskText) && (tradingPlanRows.length > 0 || hasPageTradingPlan)) {
    return {
      status: 'failed',
      summary: '页面包含未被用户明确要求的交易执行计划。',
      details: '原始需求没有要求买入区间、止损、目标价、仓位或操作建议。请移除 tradingPlan 和页面中的短线交易计划，只保留事实对比、研究结论、风险提示和数据限制。',
      metadata: {
        hasTradingPlanData: tradingPlanRows.length > 0,
        hasPageTradingPlan,
      },
    };
  }

  if (isMultiSymbolTask) {
    const dataDrivenCoverage =
      /requestedSymbols|assets|comparison/.test(page) &&
      plannedSymbols.every((symbol) => fetchedSymbols.includes(symbol));
    const missingPageSymbols = dataDrivenCoverage
      ? []
      : plannedSymbols.filter((symbol) => !page.includes(symbol));
    const hasComparisonBinding = /assets|comparison|requestedSymbols|assetCount|对比|相对强弱|多标的|收益对比|回撤对比|波动/.test(page);
    if (missingPageSymbols.length > 0 || !hasComparisonBinding) {
      return {
        status: 'failed',
        summary: '页面未完整绑定多标的对比数据。',
        details: [
          missingPageSymbols.length > 0 ? `页面未显式覆盖标的：${missingPageSymbols.join('、')}。` : null,
          !hasComparisonBinding ? '页面未检测到 assets[]、comparison 或多标的对比展示逻辑。' : null,
        ].filter(Boolean).join('\n'),
        metadata: {
          plannedSymbols,
          fetchedSymbols,
          assetCount: assetRows.length,
        },
      };
    }
  }

	  if (plannedTemplateId) {
	    const serializedPage = page.toLowerCase();
	    const serializedFinal = JSON.stringify(finalData ?? {}).toLowerCase();
	    const templateChecks: Record<string, { label: string; patterns: RegExp[] }> = {
      'holding-analysis': {
        label: '持仓分析模板',
        patterns: [/持仓|holding|portfolio|仓位|集中度/, /调仓|风险|相关性|流动性|回撤/],
      },
      'stock-selection': {
	        label: '选股分析模板',
	        patterns: [
	          /stock-selection|选股|候选|多标的|comparison|assets/,
	          /selectionranking|financialquality|排名|相对强弱|研究优先级/,
	          /收益对比|波动对比|回撤对比|财务质量|数据口径|更新时间/,
	        ],
	      },
      'strategy-research': {
        label: '策略研究模板',
        patterns: [
          /策略假设|可证伪|hypothesis|未回测/,
          /信号规则|筛选规则|候选|comparison|assets/,
          /数据限制|失效风险|风险声明|样本参数/,
        ],
      },
      'single-stock-diagnosis': {
        label: '个股诊断模板',
        patterns: [/个股|行情|最新价|quote|k\s*线|k线/, /财务|公告|质量|更新时间|报告期/],
      },
      'technical-timing': {
        label: '技术择时模板',
        patterns: [/k\s*线|k线|均线|ma20|ma60|成交量/, /触发|失效|趋势|回撤|波动/],
      },
      'fundamental-research': {
        label: '基本面研究模板',
        patterns: [/财务|基本面|营收|净利润|roe|毛利率/, /报告期|现金流|公告|估值/],
      },
      'backtest-review': {
        label: '回测复盘模板',
        patterns: [/回测|净值|策略|胜率|交易/, /参数|回撤|样本|限制/],
      },
      'sector-rotation': {
        label: '板块轮动模板',
        patterns: [/板块|行业|指数|etf|轮动|相对强弱/, /收益|回撤|流动性|排名/],
      },
    };
    const templateCheck = templateChecks[plannedTemplateId];
    const missingSignals = templateCheck?.patterns
      .filter((pattern) => !pattern.test(page) && !pattern.test(serializedPage) && !pattern.test(serializedFinal))
      .map((pattern) => pattern.source) ?? [];

	    if (templateCheck && missingSignals.length > 0) {
	      return {
	        status: 'failed',
        summary: `页面未体现 ${templateCheck.label} 的关键组件。`,
        details: [
          `run_plan.visualization.templateId=${plannedTemplateId}`,
          requiredPanels.length ? `必备组件：${requiredPanels.join('、')}` : null,
          `缺少信号：${missingSignals.join('；')}`,
        ].filter(Boolean).join('\n'),
	      };
	    }

	    if (plannedTemplateId === 'holding-analysis') {
	      const oversizedHeroSignals = [
	        /hero-band/,
	        /risk-card/,
	        /holding-analysis\s*持仓分析模板/i,
	        /持仓问题快速诊断/,
	      ];
	      if (oversizedHeroSignals.some((signal) => signal.test(page))) {
	        return {
	          status: 'failed',
	          summary: '持仓分析页面仍使用过重的顶部 hero 结构。',
          details: '持仓、调仓和截图账户类看板应直接从账户摘要、持仓矩阵或核心风险指标开始；VaR、样本口径和声明应放入连续指标带、风险分区或底部说明，不要占据首屏顶部。',
	        };
	      }
	    }

	    if (plannedTemplateId === 'stock-selection') {
	      const holdingOnlySignals = [
	        /持仓矩阵/,
	        /仓位与集中度/,
	        /调仓优先级/,
	        /portfolio[_-]?risk/i,
	        /holding-analysis/i,
	      ];
	      if (holdingOnlySignals.some((signal) => signal.test(page))) {
	        return {
	          status: 'failed',
	          summary: '页面仍残留持仓分析模板，不符合选股/多股对比任务。',
	          details: 'stock-selection 页面应展示候选覆盖、排名依据、财务质量、收益/波动/回撤对比、数据口径和更新时间；信源证据由后台文件验收。',
	        };
	      }
	    }
	  }

  return {
    status: 'passed',
    summary: '页面已检测到真实数据绑定入口。',
    metadata: {
      signals: bindingSignals.filter((signal) => page.includes(signal)),
    },
  };
}

export async function checkChartPresence(
  projectPath: string
): Promise<Omit<QuantValidationCheck, 'id' | 'name' | 'durationMs'>> {
  const pagePath = path.join(projectPath, 'app', 'page.tsx');
  const page = await readTextFile(pagePath);
  if (!page) {
    return {
      status: 'failed',
      summary: '未找到 app/page.tsx，无法检查图表。',
    };
  }

  const styleFiles = await Promise.all([
    readTextFile(path.join(projectPath, 'app', 'globals.css')),
    readTextFile(path.join(projectPath, 'styles', 'globals.css')),
    readTextFile(path.join(projectPath, 'src', 'app', 'globals.css')),
  ]);
  const visualSource = [page, ...styleFiles.filter(Boolean)].join('\n');
  const hasGraphicElement = /<svg|<canvas|<polyline|<rect|<path|Chart|chart|candlestick|ohlc|K线|K 线|折线|柱状|趋势图/i.test(page);
  const hasFinanceOrMarketLanguage = /成交量|成交额|均线|MA5|MA10|MA20|K线|K 线|营收|净利润|ROE|毛利率|回撤|波动率|quote|history|financial/i.test(page);
  const hasSemanticColoring = /red|green|up|down|gain|loss|risk-(?:high|mid|low)|dot\s+(?:red|green|amber)|candle-up|candle-down|volume-up|volume-down|bar-up|bar-down|quality-(?:ok|warning|error)|signal-(?:up|down)|#d9363e|#15945b|#dc2626|#16a34a/i.test(visualSource);
  const hasChartReadingAid = /<title>|<desc>|aria-label|chart-label|axis|grid|legend|tooltip|刻度|图例|坐标|日期/i.test(page);
  const hasMiniOnlySmell = /className="(?:sparkline|mini-kline)"|className='(?:sparkline|mini-kline)'|sparkline-empty|MiniKlineChart/i.test(page) &&
    !/chart-label|chart-price|chart-date|volume-chart|KLinePanel|MainKline|主图|成交量副图/i.test(page);
  const runPlan = await readRunPlan(projectPath);
  const plannedSymbols = extractPlannedSymbols(runPlan);
  const finalDataRaw = await readTextFile(path.join(projectPath, 'data_file', 'final', 'dashboard-data.json'));
  const hasMultiFinalData = Boolean(finalDataRaw && /"assets"\s*:|"comparison"\s*:/.test(finalDataRaw));
  const isMultiSymbolTask = plannedSymbols.length > 1 || hasMultiFinalData;
  const plannedTemplateId = pickString(asRecord(runPlan?.visualization)?.templateId);

  if (!hasGraphicElement || !hasFinanceOrMarketLanguage) {
    return {
      status: 'failed',
      summary: '未检测到有效金融图表实现。',
      details: '页面至少应包含 SVG/canvas/图表组件，并展示 K 线、成交量、均线、财务趋势或风险指标。',
    };
  }

  if (!hasSemanticColoring || !hasChartReadingAid) {
    return {
      status: 'failed',
      summary: '金融图表缺少语义染色或读图辅助。',
      details: '页面需要为涨跌、风险、质量状态提供明确颜色，并给 SVG/canvas 图表提供坐标/图例/tooltip/title 等读图辅助。',
      metadata: {
        hasSemanticColoring,
        hasChartReadingAid,
      },
    };
  }

  if (hasMiniOnlySmell) {
    return {
      status: 'failed',
      summary: '金融图表只有迷你趋势图，缺少可读主图。',
      details: '多标的页面可以保留 sparkline，但必须额外提供带坐标/日期/图例/成交量或对比尺度的主图、矩阵或表格。',
      metadata: {
        plannedSymbols,
        plannedTemplateId,
      },
    };
  }

  if (isMultiSymbolTask && !/对比|相对强弱|多标的|矩阵|收益|波动|回撤|comparison|assets/i.test(page)) {
    return {
      status: 'failed',
      summary: '多标的任务未检测到对比图表或对比指标展示。',
      details: '页面需要展示多标的指标矩阵、收益对比、波动/回撤对比或相对强弱摘要。',
      metadata: {
        plannedSymbols,
      },
    };
  }

  if (
    plannedTemplateId === 'stock-selection' &&
    !/selectionRanking|financialQuality|stock-selection|相对强弱与排名依据|财务质量|收益对比图|波动对比图|回撤对比图/.test(page)
  ) {
    return {
      status: 'failed',
      summary: '选股任务未检测到场景化选股图表组件。',
      details: '页面需要展示相对强弱/排名依据、财务质量、收益对比图、波动对比图或回撤对比图。',
      metadata: {
        plannedSymbols,
        plannedTemplateId,
      },
    };
  }

  if (plannedTemplateId === 'technical-timing') {
    const hasMa60Graphic =
      /legend-ma60|className=["'][^"']*ma60|(?:ma60|MA60)[\w]*\s*\.map\(|name\s*:\s*["']MA60/i.test(page);
    const hasExplicitRiskConclusion = /风险结论|风险等级/.test(page);
    const hasVolumeGraphic = /volume-chart|成交量副图|VolumeChart|volumeBars/.test(page);
    if (!hasMa60Graphic || !hasExplicitRiskConclusion || !hasVolumeGraphic) {
      return {
        status: 'failed',
        summary: '技术择时看板缺少完整的 MA60、成交量或风险结论。',
        details: [
          !hasMa60Graphic ? 'MA60 必须实际绘制到主图，不能只出现在文字或组件清单中。' : null,
          !hasVolumeGraphic ? '必须绘制成交量副图。' : null,
          !hasExplicitRiskConclusion ? '必须显式展示风险结论或风险等级。' : null,
        ].filter(Boolean).join('\n'),
        metadata: {
          hasMa60Graphic,
          hasVolumeGraphic,
          hasExplicitRiskConclusion,
          plannedTemplateId,
        },
      };
    }
  }

  return {
    status: 'passed',
    summary: '已检测到金融图表相关实现。',
  };
}
