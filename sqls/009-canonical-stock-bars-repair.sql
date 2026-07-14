-- Canonical end-of-day K-line read model and repeatable legacy snapshot repair.
--
-- Historical versions of the realtime ingestion path wrote unadjusted observations into
-- quant.stock_bars. Preserve those rows verbatim for audit, normalize the observations into
-- quant.realtime_quote_snapshots, remove them from the EOD hypertable, and rebuild coverage from
-- the canonical basis. Every statement is safe to run repeatedly.

CREATE SCHEMA IF NOT EXISTS quant;

CREATE TABLE IF NOT EXISTS quant.legacy_realtime_stock_bars (
  LIKE quant.stock_bars INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES
);

ALTER TABLE quant.legacy_realtime_stock_bars
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS archive_reason TEXT NOT NULL DEFAULT 'realtime_snapshot_pollution';

COMMENT ON TABLE quant.legacy_realtime_stock_bars IS
  '从 quant.stock_bars 隔离出的历史实时快照原始行；只用于审计，禁止作为正式 K 线读取。';

INSERT INTO quant.legacy_realtime_stock_bars (
  symbol, ts, timeframe, adjustment, open, high, low, close, previous_close,
  volume, amount, amplitude, change_percent, change_amount, turnover,
  trade_status, is_st, limit_up, limit_down, provider, metadata, created_at,
  archived_at, archive_reason
)
SELECT
  bars.symbol,
  bars.ts,
  bars.timeframe,
  bars.adjustment,
  bars.open,
  bars.high,
  bars.low,
  bars.close,
  bars.previous_close,
  bars.volume,
  bars.amount,
  bars.amplitude,
  bars.change_percent,
  bars.change_amount,
  bars.turnover,
  bars.trade_status,
  bars.is_st,
  bars.limit_up,
  bars.limit_down,
  bars.provider,
  bars.metadata,
  bars.created_at,
  now(),
  'realtime_snapshot_pollution'
FROM quant.stock_bars bars
WHERE COALESCE(bars.metadata->>'ingestion_mode', '') = 'realtime_snapshot'
ON CONFLICT (symbol, timeframe, adjustment, ts) DO UPDATE SET
  open = EXCLUDED.open,
  high = EXCLUDED.high,
  low = EXCLUDED.low,
  close = EXCLUDED.close,
  previous_close = EXCLUDED.previous_close,
  volume = EXCLUDED.volume,
  amount = EXCLUDED.amount,
  amplitude = EXCLUDED.amplitude,
  change_percent = EXCLUDED.change_percent,
  change_amount = EXCLUDED.change_amount,
  turnover = EXCLUDED.turnover,
  trade_status = EXCLUDED.trade_status,
  is_st = EXCLUDED.is_st,
  limit_up = EXCLUDED.limit_up,
  limit_down = EXCLUDED.limit_down,
  provider = EXCLUDED.provider,
  metadata = EXCLUDED.metadata,
  created_at = EXCLUDED.created_at,
  archived_at = now(),
  archive_reason = EXCLUDED.archive_reason;

WITH archived AS (
  SELECT
    legacy.*,
    CASE
      WHEN pg_input_is_valid(
        NULLIF(legacy.metadata #>> '{source_bar,quote_time}', ''),
        'timestamp with time zone'
      )
      THEN (legacy.metadata #>> '{source_bar,quote_time}')::TIMESTAMPTZ
      ELSE COALESCE(legacy.created_at, legacy.ts)
    END AS normalized_quote_time,
    CASE
      WHEN pg_input_is_valid(
        NULLIF(legacy.metadata #>> '{source_bar,fetched_at}', ''),
        'timestamp with time zone'
      )
      THEN (legacy.metadata #>> '{source_bar,fetched_at}')::TIMESTAMPTZ
      ELSE COALESCE(legacy.created_at, legacy.ts)
    END AS normalized_fetched_at
  FROM quant.legacy_realtime_stock_bars legacy
  WHERE COALESCE(legacy.metadata->>'ingestion_mode', '') = 'realtime_snapshot'
    AND lower(legacy.provider) = 'eastmoney'
)
INSERT INTO quant.realtime_quote_snapshots (
  symbol, quote_time, trade_date, requested_adjustment,
  open, high, low, price, previous_close, volume, amount,
  amplitude, change_percent, change_amount, turnover,
  provider, metadata, fetched_at, created_at
)
SELECT
  archived.symbol,
  archived.normalized_quote_time,
  (archived.normalized_quote_time AT TIME ZONE 'Asia/Shanghai')::DATE,
  archived.adjustment,
  archived.open,
  archived.high,
  archived.low,
  archived.close,
  archived.previous_close,
  archived.volume,
  archived.amount,
  archived.amplitude,
  archived.change_percent,
  archived.change_amount,
  archived.turnover,
  'eastmoney',
  archived.metadata || jsonb_build_object(
    'snapshot_archive',
    jsonb_build_object(
      'source_table', 'quant.stock_bars',
      'original_ts', archived.ts,
      'original_timeframe', archived.timeframe,
      'original_adjustment', archived.adjustment,
      'archived_at', archived.archived_at,
      'repair_version', '009-canonical-stock-bars-repair'
    )
  ),
  archived.normalized_fetched_at,
  archived.created_at
FROM archived
ON CONFLICT (symbol, quote_time, provider) DO UPDATE SET
  requested_adjustment = EXCLUDED.requested_adjustment,
  open = EXCLUDED.open,
  high = EXCLUDED.high,
  low = EXCLUDED.low,
  price = EXCLUDED.price,
  previous_close = EXCLUDED.previous_close,
  volume = EXCLUDED.volume,
  amount = EXCLUDED.amount,
  amplitude = EXCLUDED.amplitude,
  change_percent = EXCLUDED.change_percent,
  change_amount = EXCLUDED.change_amount,
  turnover = EXCLUDED.turnover,
  metadata = quant.realtime_quote_snapshots.metadata || EXCLUDED.metadata,
  fetched_at = GREATEST(quant.realtime_quote_snapshots.fetched_at, EXCLUDED.fetched_at);

DELETE FROM quant.stock_bars bars
WHERE COALESCE(bars.metadata->>'ingestion_mode', '') = 'realtime_snapshot'
  AND EXISTS (
    SELECT 1
    FROM quant.legacy_realtime_stock_bars archived
    WHERE archived.symbol = bars.symbol
      AND archived.timeframe = bars.timeframe
      AND archived.adjustment = bars.adjustment
      AND archived.ts = bars.ts
  );

CREATE OR REPLACE VIEW quant.canonical_stock_bars AS
SELECT bars.*
FROM quant.stock_bars bars
WHERE COALESCE(bars.metadata->>'ingestion_mode', '') <> 'realtime_snapshot';

COMMENT ON VIEW quant.canonical_stock_bars IS
  '正式 K 线唯一读取口径；永久排除未复权 realtime_snapshot 观察值。';

INSERT INTO quant.market_data_sync_state (
  symbol, timeframe, adjustment, provider, first_ts, last_ts, row_count,
  last_success_at, last_error, metadata, created_at, updated_at
)
SELECT
  bars.symbol,
  bars.timeframe,
  bars.adjustment,
  bars.provider,
  min(bars.ts),
  max(bars.ts),
  count(*)::INT,
  now(),
  NULL,
  jsonb_build_object(
    'basis', 'quant.canonical_stock_bars',
    'repair_version', '009-canonical-stock-bars-repair'
  ),
  now(),
  now()
FROM quant.canonical_stock_bars bars
GROUP BY bars.symbol, bars.timeframe, bars.adjustment, bars.provider
ON CONFLICT (symbol, timeframe, adjustment, provider) DO UPDATE SET
  first_ts = EXCLUDED.first_ts,
  last_ts = EXCLUDED.last_ts,
  row_count = EXCLUDED.row_count,
  last_error = NULL,
  metadata = quant.market_data_sync_state.metadata || EXCLUDED.metadata,
  updated_at = now();

DELETE FROM quant.market_data_sync_state sync_state
WHERE NOT EXISTS (
  SELECT 1
  FROM quant.canonical_stock_bars bars
  WHERE bars.symbol = sync_state.symbol
    AND bars.timeframe = sync_state.timeframe
    AND bars.adjustment = sync_state.adjustment
    AND bars.provider = sync_state.provider
);
