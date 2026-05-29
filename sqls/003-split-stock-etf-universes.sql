-- Split the strategy platform universe into stock-only and ETF/index pools.
-- Safe to run repeatedly. Historical K-line rows are not deleted.

CREATE SCHEMA IF NOT EXISTS quant;

INSERT INTO quant.security_universes (id, name, description, status, source, tags, metadata)
VALUES (
  'a-share-sample-research-pool',
  'A 股股票池',
  '用于策略平台打通本地行情覆盖、数据质量检查和回测链路的 A 股股票池；ETF 和指数已拆分到独立池。',
  'active',
  'seed',
  '["A股","股票","东方财富","策略回测"]'::jsonb,
  '{"default_timeframe":"daily","default_adjustment":"qfq","provider":"eastmoney","display_order":1,"universe_type":"stock","suggested_limit":1260}'::jsonb
),
(
  'etf-index-pool',
  'ETF/指数池',
  '用于指数代理、ETF 轮动和跨资产对比的独立池；不再混入 A 股股票池。',
  'active',
  'seed',
  '["ETF","指数","东方财富","轮动"]'::jsonb,
  '{"default_timeframe":"daily","default_adjustment":"qfq","provider":"eastmoney","display_order":2,"universe_type":"etf-index","suggested_limit":1260}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  status = EXCLUDED.status,
  source = EXCLUDED.source,
  tags = EXCLUDED.tags,
  metadata = quant.security_universes.metadata || EXCLUDED.metadata,
  updated_at = now();

INSERT INTO quant.security_universe_members (universe_id, symbol, role, weight, metadata)
SELECT
  'a-share-sample-research-pool',
  securities.symbol,
  'member',
  NULL,
  jsonb_build_object(
    'order',
    row_number() OVER (ORDER BY securities.exchange, securities.code),
    'added_source',
    'stock-pool-split'
  )
FROM quant.securities securities
WHERE securities.asset_type = 'stock'
ON CONFLICT (universe_id, symbol) DO UPDATE SET
  role = EXCLUDED.role,
  metadata = CASE
    WHEN quant.security_universe_members.metadata ? 'order'
    THEN quant.security_universe_members.metadata || (EXCLUDED.metadata - 'order')
    ELSE quant.security_universe_members.metadata || EXCLUDED.metadata
  END;

INSERT INTO quant.security_universe_members (universe_id, symbol, role, weight, metadata)
SELECT
  'etf-index-pool',
  securities.symbol,
  'member',
  NULL,
  jsonb_build_object(
    'order',
    row_number() OVER (ORDER BY securities.exchange, securities.code),
    'added_source',
    'etf-index-pool-split'
  )
FROM quant.securities securities
WHERE securities.asset_type IN ('etf', 'index', 'fund')
ON CONFLICT (universe_id, symbol) DO UPDATE SET
  role = EXCLUDED.role,
  metadata = CASE
    WHEN quant.security_universe_members.metadata ? 'order'
    THEN quant.security_universe_members.metadata || (EXCLUDED.metadata - 'order')
    ELSE quant.security_universe_members.metadata || EXCLUDED.metadata
  END;

DELETE FROM quant.security_universe_members members
USING quant.securities securities
WHERE members.universe_id = 'a-share-sample-research-pool'
  AND members.symbol = securities.symbol
  AND securities.asset_type <> 'stock';
