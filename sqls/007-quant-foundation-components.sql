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
