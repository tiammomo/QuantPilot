CREATE SCHEMA IF NOT EXISTS quant;

-- Realtime observations are deliberately isolated from adjusted, end-of-day stock_bars.
-- They can be reconciled by a separate audited close process, but never overwrite canonical K-lines.
CREATE TABLE IF NOT EXISTS quant.realtime_quote_snapshots (
  symbol TEXT NOT NULL,
  quote_time TIMESTAMPTZ NOT NULL,
  trade_date DATE NOT NULL,
  requested_adjustment TEXT NOT NULL DEFAULT 'none',
  open NUMERIC,
  high NUMERIC,
  low NUMERIC,
  price NUMERIC,
  previous_close NUMERIC,
  volume NUMERIC,
  amount NUMERIC,
  amplitude NUMERIC,
  change_percent NUMERIC,
  change_amount NUMERIC,
  turnover NUMERIC,
  provider TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  fetched_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, quote_time, provider),
  CONSTRAINT realtime_quote_snapshots_provider_check CHECK (provider = 'eastmoney')
);

CREATE INDEX IF NOT EXISTS realtime_quote_snapshots_trade_date_idx
  ON quant.realtime_quote_snapshots (trade_date DESC, symbol);

COMMENT ON TABLE quant.realtime_quote_snapshots IS
  '未复权实时行情观察值；与正式复权日线隔离，禁止直接覆盖 quant.stock_bars。';
