-- Promote high-value K-line enrichment fields to first-class columns.
-- Safe to run repeatedly. Existing metadata values are backfilled when valid.

ALTER TABLE quant.stock_bars
  ADD COLUMN IF NOT EXISTS amplitude NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS change_percent NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS change_amount NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS turnover NUMERIC(20, 8);

UPDATE quant.stock_bars
SET
  amplitude = COALESCE(
    amplitude,
    CASE
      WHEN metadata->>'amplitude' ~ '^-?[0-9]+(\.[0-9]+)?$'
      THEN (metadata->>'amplitude')::NUMERIC
    END
  ),
  change_percent = COALESCE(
    change_percent,
    CASE
      WHEN metadata->>'change_percent' ~ '^-?[0-9]+(\.[0-9]+)?$'
      THEN (metadata->>'change_percent')::NUMERIC
    END
  ),
  change_amount = COALESCE(
    change_amount,
    CASE
      WHEN metadata->>'change_amount' ~ '^-?[0-9]+(\.[0-9]+)?$'
      THEN (metadata->>'change_amount')::NUMERIC
    END
  ),
  turnover = COALESCE(
    turnover,
    CASE
      WHEN metadata->>'turnover' ~ '^-?[0-9]+(\.[0-9]+)?$'
      THEN (metadata->>'turnover')::NUMERIC
    END
  )
WHERE
  amplitude IS NULL
  OR change_percent IS NULL
  OR change_amount IS NULL
  OR turnover IS NULL;

COMMENT ON COLUMN quant.stock_bars.amplitude IS '振幅，单位%；东方财富 K 线 f58 / AKShare 振幅。';
COMMENT ON COLUMN quant.stock_bars.change_percent IS '涨跌幅，单位%；东方财富 K 线 f59 / AKShare 涨跌幅。';
COMMENT ON COLUMN quant.stock_bars.change_amount IS '涨跌额；东方财富 K 线 f60 / AKShare 涨跌额。';
COMMENT ON COLUMN quant.stock_bars.turnover IS '换手率，单位%；东方财富 K 线 f61 / AKShare 换手率。';
