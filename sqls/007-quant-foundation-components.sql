-- QuantPilot foundation components.
-- Adds shared tables for trading calendars, factor definitions, data quality scans
-- and generic platform jobs. Safe to run repeatedly.

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE SCHEMA IF NOT EXISTS quant;

CREATE TABLE IF NOT EXISTS quant.trading_calendars (
  market TEXT NOT NULL,
  trade_date DATE NOT NULL,
  is_open BOOLEAN NOT NULL DEFAULT TRUE,
  session TEXT NOT NULL DEFAULT 'regular',
  source TEXT NOT NULL DEFAULT 'local',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (market, trade_date, session)
);

CREATE INDEX IF NOT EXISTS trading_calendars_market_open_date_idx
  ON quant.trading_calendars (market, is_open, trade_date DESC);

COMMENT ON TABLE quant.trading_calendars IS
  '交易日历组件。用于补数跳过、预期样本数、回测窗口和交易日推断。';

CREATE TABLE IF NOT EXISTS quant.factor_definitions (
  factor_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'daily',
  value_type TEXT NOT NULL DEFAULT 'number',
  unit TEXT,
  description TEXT NOT NULL DEFAULT '',
  formula TEXT,
  dependencies JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  provider TEXT NOT NULL DEFAULT 'quantpilot',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS factor_definitions_category_idx
  ON quant.factor_definitions (category, status);

COMMENT ON TABLE quant.factor_definitions IS
  '因子/指标定义仓库。stock_factors 保存值，本表保存口径、依赖和解释。';

CREATE TABLE IF NOT EXISTS quant.data_quality_scans (
  id TEXT PRIMARY KEY,
  universe_id TEXT REFERENCES quant.security_universes(id) ON DELETE SET NULL,
  symbol TEXT REFERENCES quant.securities(symbol) ON DELETE SET NULL,
  scope TEXT NOT NULL DEFAULT 'universe',
  timeframe TEXT NOT NULL DEFAULT 'daily',
  adjustment TEXT NOT NULL DEFAULT 'qfq',
  status TEXT NOT NULL DEFAULT 'completed',
  severity TEXT NOT NULL DEFAULT 'ok',
  checked_symbols INT NOT NULL DEFAULT 0,
  passed_symbols INT NOT NULL DEFAULT 0,
  warning_symbols INT NOT NULL DEFAULT 0,
  failed_symbols INT NOT NULL DEFAULT 0,
  checked_rows INT NOT NULL DEFAULT 0,
  issue_count INT NOT NULL DEFAULT 0,
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS data_quality_scans_created_idx
  ON quant.data_quality_scans (created_at DESC);

CREATE INDEX IF NOT EXISTS data_quality_scans_scope_idx
  ON quant.data_quality_scans (universe_id, symbol, created_at DESC);

COMMENT ON TABLE quant.data_quality_scans IS
  '数据质量扫描结果。记录缺 K、字段缺失、重复样本、停牌/ST/涨跌停覆盖等检查摘要。';

CREATE TABLE IF NOT EXISTS quant.platform_jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  queue TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'queued',
  priority INT NOT NULL DEFAULT 100,
  progress NUMERIC(7, 4) NOT NULL DEFAULT 0,
  control TEXT NOT NULL DEFAULT 'run',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_jobs_queue_status_priority_idx
  ON quant.platform_jobs (queue, status, priority, created_at);

CREATE INDEX IF NOT EXISTS platform_jobs_type_created_idx
  ON quant.platform_jobs (job_type, created_at DESC);

COMMENT ON TABLE quant.platform_jobs IS
  '通用平台任务表。后续独立 Worker 可基于此承载补数、因子计算、质量扫描和回测任务。';

INSERT INTO quant.factor_definitions (
  factor_key, name, category, frequency, unit, description, formula, dependencies, provider, metadata
)
VALUES
  (
    'ma5',
    'MA5',
    'technical',
    'daily',
    'price',
    '最近 5 个交易日收盘价简单移动平均，用于短线趋势和价格支撑判断。',
    'avg(close, 5)',
    '["stock_bars.close"]'::jsonb,
    'quantpilot',
    '{"display_order": 10, "decision_hint": "收盘价站上 MA5 通常代表短线动能改善。"}'::jsonb
  ),
  (
    'ma10',
    'MA10',
    'technical',
    'daily',
    'price',
    '最近 10 个交易日收盘价简单移动平均，用于观察短中期趋势延续。',
    'avg(close, 10)',
    '["stock_bars.close"]'::jsonb,
    'quantpilot',
    '{"display_order": 20}'::jsonb
  ),
  (
    'ma20',
    'MA20',
    'technical',
    'daily',
    'price',
    '最近 20 个交易日收盘价简单移动平均，约等于月线趋势锚点。',
    'avg(close, 20)',
    '["stock_bars.close"]'::jsonb,
    'quantpilot',
    '{"display_order": 30, "decision_hint": "价格突破 MA20 常用于趋势转强过滤。"}'::jsonb
  ),
  (
    'ma30',
    'MA30',
    'technical',
    'daily',
    'price',
    '最近 30 个交易日收盘价简单移动平均，用于观察中期趋势平滑状态。',
    'avg(close, 30)',
    '["stock_bars.close"]'::jsonb,
    'quantpilot',
    '{"display_order": 40}'::jsonb
  ),
  (
    'ma60',
    'MA60',
    'technical',
    'daily',
    'price',
    '最近 60 个交易日收盘价简单移动平均，用于判断季度级趋势方向。',
    'avg(close, 60)',
    '["stock_bars.close"]'::jsonb,
    'quantpilot',
    '{"display_order": 50}'::jsonb
  ),
  (
    'turnover',
    '换手率',
    'liquidity',
    'daily',
    '%',
    '当日成交量相对流通股本的比例，反映筹码交换强度。',
    'provider field',
    '["stock_bars.turnover"]'::jsonb,
    'baostock/eastmoney',
    '{"display_order": 110}'::jsonb
  ),
  (
    'amount',
    '成交额',
    'liquidity',
    'daily',
    'CNY',
    '当日成交金额，用于衡量流动性和资金关注度。',
    'provider field',
    '["stock_bars.amount"]'::jsonb,
    'baostock/eastmoney',
    '{"display_order": 120}'::jsonb
  ),
  (
    'limit_up',
    '涨停标记',
    'event',
    'daily',
    'boolean',
    '结合市场板块和 ST 状态推导的涨停日标记。',
    'derived from change_percent and board rule',
    '["stock_bars.change_percent", "stock_bars.is_st"]'::jsonb,
    'quantpilot',
    '{"display_order": 210}'::jsonb
  ),
  (
    'limit_down',
    '跌停标记',
    'event',
    'daily',
    'boolean',
    '结合市场板块和 ST 状态推导的跌停日标记。',
    'derived from change_percent and board rule',
    '["stock_bars.change_percent", "stock_bars.is_st"]'::jsonb,
    'quantpilot',
    '{"display_order": 220}'::jsonb
  ),
  (
    'dde_net_amount',
    'DDE 大单净额',
    'capital_flow',
    'daily',
    'CNY',
    '大单资金净流入金额。当前作为策略所需目标因子登记，待接入真实数据源。',
    NULL,
    '[]'::jsonb,
    'planned',
    '{"display_order": 310, "data_gap": "需要接入真实 DDE/Level-2 或可授权资金流数据。"}'::jsonb
  ),
  (
    'pe_ttm',
    '市盈率 TTM',
    'valuation',
    'daily',
    'ratio',
    '滚动市盈率，用于估值过滤和风险标记。',
    'provider field',
    '["stock_factors.pe_ttm"]'::jsonb,
    'baostock',
    '{"display_order": 410}'::jsonb
  ),
  (
    'pb_mrq',
    '市净率 MRQ',
    'valuation',
    'daily',
    'ratio',
    '最近报告期市净率，用于资产类和周期类股票估值过滤。',
    'provider field',
    '["stock_factors.pb_mrq"]'::jsonb,
    'baostock',
    '{"display_order": 420}'::jsonb
  ),
  (
    'ps_ttm',
    '市销率 TTM',
    'valuation',
    'daily',
    'ratio',
    '滚动市销率，用于收入规模稳定但利润波动较大的行业估值观察。',
    'provider field',
    '["stock_factors.ps_ttm"]'::jsonb,
    'baostock',
    '{"display_order": 430}'::jsonb
  ),
  (
    'pcf_ncf_ttm',
    '市现率 TTM',
    'valuation',
    'daily',
    'ratio',
    '经营现金流口径市现率，用于观察盈利质量和现金回报风险。',
    'provider field',
    '["stock_factors.pcf_ncf_ttm"]'::jsonb,
    'baostock',
    '{"display_order": 440}'::jsonb
  ),
  (
    'ret_20d',
    '20 日相对强弱',
    'momentum',
    'daily',
    '%',
    '最近 20 个交易日区间收益，用于短线强弱排序。',
    'close / lag(close, 20) - 1',
    '["stock_bars.close"]'::jsonb,
    'quantpilot',
    '{"display_order": 510, "decision_hint": "适合和成交额、换手率、涨跌停可成交性一起用于短线候选排序。"}'::jsonb
  ),
  (
    'ret_60d',
    '60 日相对强弱',
    'momentum',
    'daily',
    '%',
    '最近 60 个交易日区间收益，用于中期趋势强弱排序。',
    'close / lag(close, 60) - 1',
    '["stock_bars.close"]'::jsonb,
    'quantpilot',
    '{"display_order": 520}'::jsonb
  ),
  (
    'ma_stack_score',
    '均线多头质量',
    'technical',
    'daily',
    'score',
    'MA5/10/20/30/60 多头排列和价格相对均线位置的综合趋势质量分。',
    'I(MA5>MA10>MA20>MA30>MA60) + normalized(close/MA20 - 1)',
    '["stock_bars.close"]'::jsonb,
    'quantpilot',
    '{"display_order": 530}'::jsonb
  ),
  (
    'amount_ratio_20d',
    '20 日成交额放大倍数',
    'liquidity',
    'daily',
    'ratio',
    '当日成交额相对过去 20 日平均成交额的倍数，用于突破和资金热度确认。',
    'amount / avg(amount, 20)',
    '["stock_bars.amount"]'::jsonb,
    'quantpilot',
    '{"display_order": 540}'::jsonb
  ),
  (
    'realized_vol_20d',
    '20 日实现波动率',
    'risk',
    'daily',
    '%',
    '20 日收益率年化波动率，用于低波动和仓位风险控制。',
    'stddev(close / lag(close, 1) - 1, 20) * sqrt(252)',
    '["stock_bars.close"]'::jsonb,
    'quantpilot',
    '{"display_order": 610}'::jsonb
  ),
  (
    'max_drawdown_60d',
    '60 日最大回撤',
    'risk',
    'daily',
    '%',
    '最近 60 个交易日从阶段高点回撤的最大幅度。',
    'min(close / rolling_max(close, 60) - 1)',
    '["stock_bars.close"]'::jsonb,
    'quantpilot',
    '{"display_order": 620}'::jsonb
  ),
  (
    'value_composite',
    '复合估值便宜度',
    'valuation',
    'daily',
    'score',
    'PE/PB/PS/PCF 行业内标准化后的复合估值得分。',
    'z(-pe_ttm) + z(-pb_mrq) + z(-ps_ttm) + z(-pcf_ncf_ttm)',
    '["stock_factors.pe_ttm", "stock_factors.pb_mrq", "stock_factors.ps_ttm", "stock_factors.pcf_ncf_ttm"]'::jsonb,
    'quantpilot',
    '{"display_order": 710, "data_gap": "需要全股票池估值覆盖和行业中性化。"}'::jsonb
  ),
  (
    'profitability_quality',
    '盈利质量',
    'quality',
    'quarterly',
    'score',
    'ROE、毛利率、净利率、资产负债率和现金流质量组成的质量因子。',
    'z(roe_ttm) + z(gross_margin) + z(net_margin) - z(debt_to_asset)',
    '[]'::jsonb,
    'planned',
    '{"display_order": 810, "data_gap": "需要财报指标表和披露日生效规则。"}'::jsonb
  ),
  (
    'growth_acceleration',
    '成长加速度',
    'growth',
    'quarterly',
    'score',
    '营收同比、利润同比和同比变化量组成的成长确认因子。',
    'z(revenue_yoy) + z(net_profit_yoy) + z(delta_net_profit_yoy)',
    '[]'::jsonb,
    'planned',
    '{"display_order": 820, "data_gap": "需要季度财报和公告披露日期。"}'::jsonb
  ),
  (
    'sector_flow_heat',
    '板块资金热度',
    'capital_flow',
    'daily',
    'score',
    '上涨占比、成交额放大、20 日强弱和方向额代理组成的板块热度因子。',
    'rising_ratio + amount_ratio_20d + strength_20d + proxy_net_amount_ratio',
    '["stock_bars.amount", "stock_bars.change_percent", "security_universe_members.sector_tags"]'::jsonb,
    'quantpilot',
    '{"display_order": 910, "data_gap": "当前为代理口径，真实主力净流入需另接资金流。"}'::jsonb
  )
ON CONFLICT (factor_key) DO UPDATE SET
  name = EXCLUDED.name,
  category = EXCLUDED.category,
  frequency = EXCLUDED.frequency,
  value_type = EXCLUDED.value_type,
  unit = EXCLUDED.unit,
  description = EXCLUDED.description,
  formula = EXCLUDED.formula,
  dependencies = EXCLUDED.dependencies,
  status = EXCLUDED.status,
  provider = EXCLUDED.provider,
  metadata = quant.factor_definitions.metadata || EXCLUDED.metadata,
  updated_at = now();

UPDATE quant.factor_definitions
SET status = 'planned',
    updated_at = now()
WHERE factor_key IN ('dde_net_amount', 'profitability_quality', 'growth_acceleration');

UPDATE quant.factor_definitions
SET status = 'partial',
    updated_at = now()
WHERE factor_key IN ('value_composite', 'sector_flow_heat');
