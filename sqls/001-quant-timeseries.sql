-- QuantPilot component bootstrap SQL.
-- Safe to run repeatedly. Docker uses this on first database creation,
-- and `npm run db:init` can apply it to an existing local database.

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE SCHEMA IF NOT EXISTS quant;

CREATE TABLE IF NOT EXISTS quant.stock_bars (
  symbol TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  timeframe TEXT NOT NULL,
  adjustment TEXT NOT NULL DEFAULT 'qfq',
  open NUMERIC(20, 8) NOT NULL,
  high NUMERIC(20, 8) NOT NULL,
  low NUMERIC(20, 8) NOT NULL,
  close NUMERIC(20, 8) NOT NULL,
  previous_close NUMERIC(20, 8),
  volume NUMERIC(24, 4) NOT NULL DEFAULT 0,
  amount NUMERIC(24, 4),
  amplitude NUMERIC(20, 8),
  change_percent NUMERIC(20, 8),
  change_amount NUMERIC(20, 8),
  turnover NUMERIC(20, 8),
  trade_status TEXT,
  is_st BOOLEAN,
  limit_up BOOLEAN,
  limit_down BOOLEAN,
  provider TEXT NOT NULL DEFAULT 'unknown',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, timeframe, adjustment, ts)
);

ALTER TABLE quant.stock_bars
  ADD COLUMN IF NOT EXISTS adjustment TEXT NOT NULL DEFAULT 'qfq',
  ADD COLUMN IF NOT EXISTS previous_close NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS amplitude NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS change_percent NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS change_amount NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS turnover NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS trade_status TEXT,
  ADD COLUMN IF NOT EXISTS is_st BOOLEAN,
  ADD COLUMN IF NOT EXISTS limit_up BOOLEAN,
  ADD COLUMN IF NOT EXISTS limit_down BOOLEAN;

DO $$
DECLARE
  has_adjustment_in_pk BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_info
    JOIN pg_class table_info
      ON table_info.oid = constraint_info.conrelid
    JOIN pg_namespace schema_info
      ON schema_info.oid = table_info.relnamespace
    JOIN unnest(constraint_info.conkey) WITH ORDINALITY column_key(attnum, ord)
      ON TRUE
    JOIN pg_attribute column_info
      ON column_info.attrelid = table_info.oid
     AND column_info.attnum = column_key.attnum
    WHERE schema_info.nspname = 'quant'
      AND table_info.relname = 'stock_bars'
      AND constraint_info.contype = 'p'
      AND column_info.attname = 'adjustment'
  ) INTO has_adjustment_in_pk;

  IF NOT has_adjustment_in_pk THEN
    IF EXISTS (
      SELECT 1
      FROM pg_constraint constraint_info
      JOIN pg_class table_info
        ON table_info.oid = constraint_info.conrelid
      JOIN pg_namespace schema_info
        ON schema_info.oid = table_info.relnamespace
      WHERE schema_info.nspname = 'quant'
        AND table_info.relname = 'stock_bars'
        AND constraint_info.conname = 'stock_bars_pkey'
    ) THEN
      ALTER TABLE quant.stock_bars DROP CONSTRAINT stock_bars_pkey;
    END IF;

    ALTER TABLE quant.stock_bars
      ADD CONSTRAINT stock_bars_pkey PRIMARY KEY (symbol, timeframe, adjustment, ts);
  END IF;
END $$;

SELECT create_hypertable('quant.stock_bars', 'ts', if_not_exists => TRUE, migrate_data => TRUE);

CREATE INDEX IF NOT EXISTS stock_bars_symbol_timeframe_adjustment_ts_desc_idx
  ON quant.stock_bars (symbol, timeframe, adjustment, ts DESC);

COMMENT ON COLUMN quant.stock_bars.amount IS '成交额；东方财富 K 线 f57。';
COMMENT ON COLUMN quant.stock_bars.previous_close IS '前收盘价；Baostock preclose / 腾讯历史行可提供。';
COMMENT ON COLUMN quant.stock_bars.amplitude IS '振幅，单位%；东方财富 K 线 f58 / AKShare 振幅。';
COMMENT ON COLUMN quant.stock_bars.change_percent IS '涨跌幅，单位%；东方财富 K 线 f59 / AKShare 涨跌幅。';
COMMENT ON COLUMN quant.stock_bars.change_amount IS '涨跌额；东方财富 K 线 f60 / AKShare 涨跌额。';
COMMENT ON COLUMN quant.stock_bars.turnover IS '换手率，单位%；东方财富 K 线 f61 / AKShare 换手率。';
COMMENT ON COLUMN quant.stock_bars.trade_status IS '交易状态；Baostock tradestatus，1 通常代表正常交易。';
COMMENT ON COLUMN quant.stock_bars.is_st IS '是否 ST；Baostock isST。';
COMMENT ON COLUMN quant.stock_bars.limit_up IS '是否涨停；按 ST/主板/创业板/科创板/北交所规则由数据源涨跌幅推导。';
COMMENT ON COLUMN quant.stock_bars.limit_down IS '是否跌停；按 ST/主板/创业板/科创板/北交所规则由数据源涨跌幅推导。';
COMMENT ON COLUMN quant.stock_bars.metadata IS
  'K 线扩展字段与数据源原始字段；东方财富 f51-f61、振幅、涨跌幅、涨跌额、换手率和 raw row 均保存在此处。';

CREATE TABLE IF NOT EXISTS quant.stock_factors (
  symbol TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  factor_key TEXT NOT NULL,
  factor_value DOUBLE PRECISION NOT NULL,
  provider TEXT NOT NULL DEFAULT 'unknown',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, factor_key, ts)
);

SELECT create_hypertable('quant.stock_factors', 'ts', if_not_exists => TRUE, migrate_data => TRUE);

CREATE INDEX IF NOT EXISTS stock_factors_factor_ts_desc_idx
  ON quant.stock_factors (factor_key, ts DESC);

CREATE INDEX IF NOT EXISTS stock_factors_symbol_factor_ts_desc_idx
  ON quant.stock_factors (symbol, factor_key, ts DESC);

CREATE TABLE IF NOT EXISTS quant.strategy_signals (
  strategy_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  signal TEXT NOT NULL,
  strength DOUBLE PRECISION,
  price NUMERIC(20, 8),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (strategy_id, symbol, ts)
);

SELECT create_hypertable('quant.strategy_signals', 'ts', if_not_exists => TRUE, migrate_data => TRUE);

CREATE INDEX IF NOT EXISTS strategy_signals_strategy_ts_desc_idx
  ON quant.strategy_signals (strategy_id, ts DESC);

CREATE TABLE IF NOT EXISTS quant.portfolio_snapshots (
  portfolio_id TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  total_value NUMERIC(24, 8) NOT NULL,
  cash NUMERIC(24, 8),
  exposure NUMERIC(24, 8),
  drawdown DOUBLE PRECISION,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (portfolio_id, ts)
);

SELECT create_hypertable('quant.portfolio_snapshots', 'ts', if_not_exists => TRUE, migrate_data => TRUE);

CREATE INDEX IF NOT EXISTS portfolio_snapshots_portfolio_ts_desc_idx
  ON quant.portfolio_snapshots (portfolio_id, ts DESC);
