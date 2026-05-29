-- Promote daily context fields used by stock-pool screening and K-line annotations.
-- Safe to run repeatedly. Existing metadata values are backfilled when valid.

ALTER TABLE quant.stock_bars
  ADD COLUMN IF NOT EXISTS previous_close NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS trade_status TEXT,
  ADD COLUMN IF NOT EXISTS is_st BOOLEAN,
  ADD COLUMN IF NOT EXISTS limit_up BOOLEAN,
  ADD COLUMN IF NOT EXISTS limit_down BOOLEAN;

UPDATE quant.stock_bars
SET
  previous_close = COALESCE(
    previous_close,
    CASE
      WHEN metadata->>'previous_close' ~ '^-?[0-9]+(\.[0-9]+)?$'
      THEN (metadata->>'previous_close')::NUMERIC
    END,
    CASE
      WHEN metadata#>>'{source_bar,fields,preclose}' ~ '^-?[0-9]+(\.[0-9]+)?$'
      THEN (metadata#>>'{source_bar,fields,preclose}')::NUMERIC
    END
  ),
  trade_status = COALESCE(
    trade_status,
    NULLIF(metadata->>'trade_status', ''),
    NULLIF(metadata#>>'{source_bar,fields,tradestatus}', '')
  ),
  is_st = COALESCE(
    is_st,
    CASE
      WHEN lower(metadata->>'is_st') IN ('1', 'true', 't', 'yes', 'y') THEN TRUE
      WHEN lower(metadata->>'is_st') IN ('0', 'false', 'f', 'no', 'n') THEN FALSE
    END,
    CASE
      WHEN lower(metadata#>>'{source_bar,fields,is_st}') IN ('1', 'true', 't', 'yes', 'y')
      THEN TRUE
      WHEN lower(metadata#>>'{source_bar,fields,is_st}') IN ('0', 'false', 'f', 'no', 'n')
      THEN FALSE
    END
  ),
  limit_up = COALESCE(
    limit_up,
    CASE
      WHEN lower(metadata->>'limit_up') IN ('1', 'true', 't', 'yes', 'y') THEN TRUE
      WHEN lower(metadata->>'limit_up') IN ('0', 'false', 'f', 'no', 'n') THEN FALSE
    END
  ),
  limit_down = COALESCE(
    limit_down,
    CASE
      WHEN lower(metadata->>'limit_down') IN ('1', 'true', 't', 'yes', 'y') THEN TRUE
      WHEN lower(metadata->>'limit_down') IN ('0', 'false', 'f', 'no', 'n') THEN FALSE
    END
  )
WHERE
  (
    previous_close IS NULL
    AND (
      metadata ? 'previous_close'
      OR metadata#>>'{source_bar,fields,preclose}' IS NOT NULL
    )
  )
  OR (
    trade_status IS NULL
    AND (
      metadata ? 'trade_status'
      OR metadata#>>'{source_bar,fields,tradestatus}' IS NOT NULL
    )
  )
  OR (
    is_st IS NULL
    AND (
      metadata ? 'is_st'
      OR metadata#>>'{source_bar,fields,is_st}' IS NOT NULL
    )
  )
  OR (limit_up IS NULL AND metadata ? 'limit_up')
  OR (limit_down IS NULL AND metadata ? 'limit_down');

COMMENT ON COLUMN quant.stock_bars.previous_close IS '前收盘价；Baostock preclose / 腾讯历史行可提供。';
COMMENT ON COLUMN quant.stock_bars.trade_status IS '交易状态；Baostock tradestatus，1 通常代表正常交易。';
COMMENT ON COLUMN quant.stock_bars.is_st IS '是否 ST；Baostock isST。';
COMMENT ON COLUMN quant.stock_bars.limit_up IS '是否涨停；按 ST/主板/创业板/科创板/北交所规则由数据源涨跌幅推导。';
COMMENT ON COLUMN quant.stock_bars.limit_down IS '是否跌停；按 ST/主板/创业板/科创板/北交所规则由数据源涨跌幅推导。';

CREATE INDEX IF NOT EXISTS stock_factors_symbol_factor_ts_desc_idx
  ON quant.stock_factors (symbol, factor_key, ts DESC);
