-- QuantPilot component bootstrap SQL.
-- Safe to run repeatedly. Docker uses this on first database creation,
-- and `npm run db:init` can apply it to an existing local database.

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE SCHEMA IF NOT EXISTS quant;

CREATE TABLE IF NOT EXISTS quant.stock_bars (
  symbol TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  timeframe TEXT NOT NULL,
  open NUMERIC(20, 8) NOT NULL,
  high NUMERIC(20, 8) NOT NULL,
  low NUMERIC(20, 8) NOT NULL,
  close NUMERIC(20, 8) NOT NULL,
  volume NUMERIC(24, 4) NOT NULL DEFAULT 0,
  amount NUMERIC(24, 4),
  provider TEXT NOT NULL DEFAULT 'unknown',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, timeframe, ts)
);

SELECT create_hypertable('quant.stock_bars', 'ts', if_not_exists => TRUE, migrate_data => TRUE);

CREATE INDEX IF NOT EXISTS stock_bars_symbol_timeframe_ts_desc_idx
  ON quant.stock_bars (symbol, timeframe, ts DESC);

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
