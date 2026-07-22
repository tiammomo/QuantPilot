#!/usr/bin/env node

require('tsconfig-paths/register');

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const jiti = require('jiti')(path.join(process.cwd(), 'scripts/checks/check-quant-research-guardrails.js'), {
  interopDefault: true,
});

const {
  hasExplicitTradingPlanIntent,
  inferHistoryLimit,
} = jiti('../../src/lib/quant/data-prefetch.ts');
const { ensureQuantDashboardTemplate } = jiti('../../src/lib/utils/scaffold.ts');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function researchPlan(question) {
  return {
    schemaVersion: 1,
    capabilityId: 'asset_comparison',
    question,
    symbols: ['600519', '000858'],
    dataRequirements: [
      'GET /api/v1/symbols/resolve',
      'GET /api/v1/quotes/realtime/{symbol}',
      'GET /api/v1/quotes/history/{symbol}',
      'GET /api/v1/fundamentals/financials/{symbol}',
      'GET /api/v1/indicators/fundamental/{symbol}',
    ],
    visualization: {
      templateId: 'stock-selection',
      variantId: 'selection-ranking-matrix',
      panels: ['标的覆盖摘要', '多标的指标矩阵', '收益对比主图', '回撤/波动主图', '排序依据', '数据口径'],
    },
  };
}

function finalData() {
  const assets = [
    {
      symbol: '600519',
      name: '贵州茅台',
      quote: { symbol: '600519', name: '贵州茅台', price: 1268, change_percent: -1.09, amount: 4273000000 },
      kline: { bars: [{ date: '2025-05-21', close: 1529 }, { date: '2026-06-04', close: 1268 }] },
      computedMetrics: { periodReturn: -17.09, maxDrawdown: -18.46, volatility20d: 19.73 },
      technicalIndicators: {
        summary: {
          symbol: '600519',
          name: '贵州茅台',
          period_return_pct: -17.09,
          return_120d_pct: -10.2,
          max_drawdown_pct: -18.46,
          volatility_20d_annualized_pct: 19.73,
          ma20: 1315.13,
        },
      },
      financialQuality: { symbol: '600519', name: '贵州茅台', quality_score: 90, quality_label: '盈利质量较强' },
    },
    {
      symbol: '000858',
      name: '五粮液',
      quote: { symbol: '000858', name: '五粮液', price: 81.1, change_percent: -1.52, amount: 1669000000 },
      kline: { bars: [{ date: '2025-05-21', close: 123.5 }, { date: '2026-06-04', close: 81.1 }] },
      computedMetrics: { periodReturn: -34.34, maxDrawdown: -36.32, volatility20d: 20.46 },
      technicalIndicators: {
        summary: {
          symbol: '000858',
          name: '五粮液',
          period_return_pct: -34.34,
          return_120d_pct: -28.85,
          max_drawdown_pct: -36.32,
          volatility_20d_annualized_pct: 20.46,
          ma20: 85.65,
        },
      },
      financialQuality: { symbol: '000858', name: '五粮液', quality_score: 92, quality_label: '盈利质量较强' },
    },
  ];

  return {
    dashboardKind: 'asset_comparison',
    requestedSymbols: ['600519', '000858'],
    assets,
    comparison: {
      rows: [
        {
          symbol: '600519',
          name: '贵州茅台',
          price: 1268,
          change_percent: -1.09,
          period_return: -17.09,
          return_120d_pct: -10.2,
          max_drawdown: -18.46,
          volatility20d: 19.73,
          amount: 4273000000,
          composite_score: 90,
          selection_view: '优先研究',
        },
        {
          symbol: '000858',
          name: '五粮液',
          price: 81.1,
          change_percent: -1.52,
          period_return: -34.34,
          return_120d_pct: -28.85,
          max_drawdown: -36.32,
          volatility20d: 20.46,
          amount: 1669000000,
          composite_score: 60,
          selection_view: '观察研究',
        },
      ],
      leaders: {
        best_return: { symbol: '600519', name: '贵州茅台', value: -17.09 },
        lowest_drawdown: { symbol: '600519', name: '贵州茅台', value: -18.46 },
        lowest_volatility: { symbol: '600519', name: '贵州茅台', value: 19.73 },
      },
    },
    selectionRanking: {
      rows: [
        { symbol: '600519', name: '贵州茅台', rank: 1, score: 90, view: '优先研究', reason: '收益和回撤领先' },
        { symbol: '000858', name: '五粮液', rank: 2, score: 60, view: '观察研究', reason: '区间表现偏弱' },
      ],
    },
    financialQuality: {
      rows: assets.map((asset) => asset.financialQuality),
    },
    visualization: {
      template_id: 'stock-selection',
      name: '多标的对比模板',
      required_components: ['标的覆盖摘要', '多标的指标矩阵', '收益对比主图', '回撤/波动主图', '排序依据', '数据口径'],
    },
    conclusion: {
      summary: ['排序仅用于横向研究，不构成交易指令。'],
    },
  };
}

async function createLegacySelectionPage(projectPath) {
  await writeFile(
    path.join(projectPath, 'app/page.tsx'),
    `export default function Home() {
  const tradingRows = [];
  return (
    <main data-template="stock-selection">
      <p>QuantPilot 选股分析</p>
      <strong>stock-selection</strong>
      <section>
        <h2>多标的指标矩阵</h2>
        <table><tbody><tr><td>comparison.rows</td><td>120 日收益</td></tr></tbody></table>
      </section>
      <section><h2>收益对比主图</h2><svg className="chart-label" /></section>
      <section><h2>短线交易计划</h2><p>买入区间、止损、目标价、仓位上限</p></section>
      <TradingPlanPanel rows={tradingRows} />
    </main>
  );
}
function TradingPlanPanel() { return null; }
`
  );
  await writeFile(
    path.join(projectPath, 'app/globals.css'),
    `.dashboard-shell { min-height: 100vh; }
.trading-plan-grid { display: grid; }
.trade-card { padding: 12px; }
`
  );
}

async function main() {
  const researchQuestion = '请生成近一年贵州茅台和五粮液对比研究看板，展示累计收益、估值、风险和结论，不要营销风格。';

  assert(!hasExplicitTradingPlanIntent(researchQuestion), 'research prompt should not imply trading plan intent');
  assert(hasExplicitTradingPlanIntent('贵州茅台接下来怎么操作？给我买入区间、止损和目标价。'), 'trading prompt should imply trading plan intent');
  assert(inferHistoryLimit(researchPlan(researchQuestion)) === 252, '近一年 should map to 252 trading days');
  assert(inferHistoryLimit(researchPlan('最近半年沪深300走势如何？')) === 126, '半年 should map to 126 trading days');
  assert(inferHistoryLimit(researchPlan('最近80个交易日沪深300走势如何？')) === 80, 'explicit trading days should win');

  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-research-guardrails-'));

  try {
    await writeJson(path.join(projectPath, '.data-agent/finance-run-plan.json'), researchPlan(researchQuestion));
    await writeJson(path.join(projectPath, 'data_file/final/dashboard-data.json'), finalData());
    await createLegacySelectionPage(projectPath);

    await ensureQuantDashboardTemplate(projectPath);

    const page = await fs.readFile(path.join(projectPath, 'app/page.tsx'), 'utf8');
    const css = await fs.readFile(path.join(projectPath, 'app/globals.css'), 'utf8');

    assert(/QuantPilot 多标的对比/.test(page), 'generated page should use research comparison wording');
    assert(/区间收益/.test(page), 'generated page should use period return wording');
    assert(/不构成交易指令/.test(page), 'generated page should keep research disclaimer');
    assert(!/TradingPlanPanel|getTradingPlanRows|tradingRows|短线交易计划|买入区间|止损|目标价|仓位上限/.test(page), 'generated page should not contain trading plan UI');
    assert(!/QuantPilot 选股分析|<strong>stock-selection<\/strong>|模板组件：|候选数量|候选视图|120 日收益|<dt>120 日<\/dt>/.test(page), 'generated page should not expose legacy selection wording');
    assert(!/\.trading-plan-grid|\.trade-card|\.trade-title|\.trade-rationale|\.trade-abandon/.test(css), 'generated CSS should not contain trading plan styles');

    console.log('[quant-research-guardrails] ok');
  } finally {
    await fs.rm(projectPath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[quant-research-guardrails] failed');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
