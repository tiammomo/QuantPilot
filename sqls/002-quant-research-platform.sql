-- QuantPilot strategy research platform bootstrap SQL.
-- This file is intentionally idempotent so first-use setup can run it repeatedly.

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE SCHEMA IF NOT EXISTS quant;

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

CREATE INDEX IF NOT EXISTS stock_bars_symbol_timeframe_adjustment_ts_desc_idx
  ON quant.stock_bars (symbol, timeframe, adjustment, ts DESC);

CREATE INDEX IF NOT EXISTS stock_factors_symbol_factor_ts_desc_idx
  ON quant.stock_factors (symbol, factor_key, ts DESC);

CREATE TABLE IF NOT EXISTS quant.securities (
  symbol TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT,
  exchange TEXT NOT NULL DEFAULT 'UNKNOWN',
  asset_type TEXT NOT NULL DEFAULT 'stock',
  currency TEXT NOT NULL DEFAULT 'CNY',
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  secid TEXT,
  provider TEXT NOT NULL DEFAULT 'eastmoney',
  listed_at DATE,
  status TEXT NOT NULL DEFAULT 'active',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS securities_provider_secid_idx
  ON quant.securities (provider, secid)
  WHERE secid IS NOT NULL;

CREATE TABLE IF NOT EXISTS quant.security_universes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'manual',
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quant.security_universe_members (
  universe_id TEXT NOT NULL REFERENCES quant.security_universes(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL REFERENCES quant.securities(symbol) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  weight NUMERIC(12, 8),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (universe_id, symbol)
);

CREATE INDEX IF NOT EXISTS security_universe_members_symbol_idx
  ON quant.security_universe_members (symbol);

CREATE TABLE IF NOT EXISTS quant.market_data_ingestion_jobs (
  id TEXT PRIMARY KEY,
  universe_id TEXT REFERENCES quant.security_universes(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'eastmoney',
  timeframe TEXT NOT NULL DEFAULT 'daily',
  adjustment TEXT NOT NULL DEFAULT 'qfq',
  requested_start DATE,
  requested_end DATE,
  status TEXT NOT NULL DEFAULT 'queued',
  total_symbols INT NOT NULL DEFAULT 0,
  completed_symbols INT NOT NULL DEFAULT 0,
  failed_symbols INT NOT NULL DEFAULT 0,
  rows_received INT NOT NULL DEFAULT 0,
  rows_upserted INT NOT NULL DEFAULT 0,
  error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS market_data_ingestion_jobs_created_idx
  ON quant.market_data_ingestion_jobs (created_at DESC);

CREATE TABLE IF NOT EXISTS quant.market_data_sync_state (
  symbol TEXT NOT NULL REFERENCES quant.securities(symbol) ON DELETE CASCADE,
  timeframe TEXT NOT NULL DEFAULT 'daily',
  adjustment TEXT NOT NULL DEFAULT 'qfq',
  provider TEXT NOT NULL DEFAULT 'eastmoney',
  first_ts TIMESTAMPTZ,
  last_ts TIMESTAMPTZ,
  row_count INT NOT NULL DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, timeframe, adjustment, provider)
);

CREATE INDEX IF NOT EXISTS market_data_sync_state_last_ts_idx
  ON quant.market_data_sync_state (last_ts DESC);

CREATE TABLE IF NOT EXISTS quant.backtest_runs (
  id TEXT PRIMARY KEY,
  universe_id TEXT REFERENCES quant.security_universes(id) ON DELETE SET NULL,
  strategy_id TEXT NOT NULL,
  strategy_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  timeframe TEXT NOT NULL DEFAULT 'daily',
  adjustment TEXT NOT NULL DEFAULT 'qfq',
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS backtest_runs_created_idx
  ON quant.backtest_runs (created_at DESC);

CREATE TABLE IF NOT EXISTS quant.backtest_orders (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES quant.backtest_runs(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  side TEXT NOT NULL,
  quantity NUMERIC(24, 8) NOT NULL,
  price NUMERIC(20, 8) NOT NULL,
  amount NUMERIC(24, 8) NOT NULL,
  fee NUMERIC(20, 8) NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS backtest_orders_run_ts_idx
  ON quant.backtest_orders (run_id, ts);

CREATE OR REPLACE VIEW quant.market_data_coverage AS
SELECT
  bars.symbol,
  bars.timeframe,
  bars.adjustment,
  bars.provider,
  min(bars.ts) AS first_ts,
  max(bars.ts) AS last_ts,
  count(*)::INT AS row_count
FROM quant.stock_bars bars
GROUP BY bars.symbol, bars.timeframe, bars.adjustment, bars.provider;

DROP TABLE IF EXISTS quant_seed_securities;
CREATE TEMP TABLE quant_seed_securities (
  seed_order INT PRIMARY KEY,
  symbol TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  exchange TEXT NOT NULL,
  secid TEXT NOT NULL,
  sector_hint TEXT NOT NULL
);

INSERT INTO quant_seed_securities (seed_order, symbol, code, name, exchange, secid, sector_hint)
VALUES
  (1, '002156.SZ', '002156', '通富微电', 'SZ', '0.002156', 'semiconductor'),
  (2, '002555.SZ', '002555', '三七互娱', 'SZ', '0.002555', 'gaming'),
  (3, '002624.SZ', '002624', '完美世界', 'SZ', '0.002624', 'gaming'),
  (4, '601398.SH', '601398', '工商银行', 'SH', '1.601398', 'bank'),
  (5, '600916.SH', '600916', '中国黄金', 'SH', '1.600916', 'gold-retail'),
  (6, '600519.SH', '600519', '贵州茅台', 'SH', '1.600519', 'liquor'),
  (7, '000858.SZ', '000858', '五粮液', 'SZ', '0.000858', 'liquor'),
  (8, '000333.SZ', '000333', '美的集团', 'SZ', '0.000333', 'home-appliance'),
  (9, '000651.SZ', '000651', '格力电器', 'SZ', '0.000651', 'home-appliance'),
  (10, '300750.SZ', '300750', '宁德时代', 'SZ', '0.300750', 'battery'),
  (11, '002594.SZ', '002594', '比亚迪', 'SZ', '0.002594', 'new-energy-auto'),
  (12, '601318.SH', '601318', '中国平安', 'SH', '1.601318', 'insurance'),
  (13, '600036.SH', '600036', '招商银行', 'SH', '1.600036', 'bank'),
  (14, '601166.SH', '601166', '兴业银行', 'SH', '1.601166', 'bank'),
  (15, '601288.SH', '601288', '农业银行', 'SH', '1.601288', 'bank'),
  (16, '600900.SH', '600900', '长江电力', 'SH', '1.600900', 'utility'),
  (17, '601012.SH', '601012', '隆基绿能', 'SH', '1.601012', 'solar'),
  (18, '600276.SH', '600276', '恒瑞医药', 'SH', '1.600276', 'pharma'),
  (19, '000725.SZ', '000725', '京东方A', 'SZ', '0.000725', 'display-panel'),
  (20, '002415.SZ', '002415', '海康威视', 'SZ', '0.002415', 'security-equipment'),
  (21, '600050.SH', '600050', '中国联通', 'SH', '1.600050', 'telecom'),
  (22, '601857.SH', '601857', '中国石油', 'SH', '1.601857', 'oil-gas'),
  (23, '600028.SH', '600028', '中国石化', 'SH', '1.600028', 'oil-gas'),
  (24, '601668.SH', '601668', '中国建筑', 'SH', '1.601668', 'construction'),
  (25, '601888.SH', '601888', '中国中免', 'SH', '1.601888', 'travel-retail'),
  (26, '600030.SH', '600030', '中信证券', 'SH', '1.600030', 'brokerage'),
  (27, '300059.SZ', '300059', '东方财富', 'SZ', '0.300059', 'fintech-brokerage'),
  (28, '603259.SH', '603259', '药明康德', 'SH', '1.603259', 'cro'),
  (29, '688981.SH', '688981', '中芯国际', 'SH', '1.688981', 'semiconductor-foundry'),
  (30, '002230.SZ', '002230', '科大讯飞', 'SZ', '0.002230', 'ai'),
  (31, '603986.SH', '603986', '兆易创新', 'SH', '1.603986', 'semiconductor-memory'),
  (32, '603501.SH', '603501', '韦尔股份', 'SH', '1.603501', 'semiconductor-cis'),
  (33, '002371.SZ', '002371', '北方华创', 'SZ', '0.002371', 'semiconductor-equipment'),
  (34, '688012.SH', '688012', '中微公司', 'SH', '1.688012', 'semiconductor-equipment'),
  (35, '600584.SH', '600584', '长电科技', 'SH', '1.600584', 'semiconductor-packaging'),
  (36, '688008.SH', '688008', '澜起科技', 'SH', '1.688008', 'semiconductor-memory-interface'),
  (37, '688126.SH', '688126', '沪硅产业', 'SH', '1.688126', 'semiconductor-wafer'),
  (38, '688099.SH', '688099', '晶晨股份', 'SH', '1.688099', 'semiconductor-soc'),
  (39, '300223.SZ', '300223', '北京君正', 'SZ', '0.300223', 'semiconductor-memory'),
  (40, '603290.SH', '603290', '斯达半导', 'SH', '1.603290', 'power-semiconductor'),
  (41, '300661.SZ', '300661', '圣邦股份', 'SZ', '0.300661', 'analog-chip'),
  (42, '300782.SZ', '300782', '卓胜微', 'SZ', '0.300782', 'rf-chip'),
  (43, '002049.SZ', '002049', '紫光国微', 'SZ', '0.002049', 'security-chip'),
  (44, '600745.SH', '600745', '闻泰科技', 'SH', '1.600745', 'semiconductor-idm'),
  (45, '605358.SH', '605358', '立昂微', 'SH', '1.605358', 'semiconductor-wafer'),
  (46, '688396.SH', '688396', '华润微', 'SH', '1.688396', 'power-semiconductor'),
  (47, '688041.SH', '688041', '海光信息', 'SH', '1.688041', 'cpu'),
  (48, '688256.SH', '688256', '寒武纪', 'SH', '1.688256', 'ai-chip'),
  (49, '688111.SH', '688111', '金山办公', 'SH', '1.688111', 'software-office'),
  (50, '688036.SH', '688036', '传音控股', 'SH', '1.688036', 'consumer-electronics'),
  (51, '688521.SH', '688521', '芯原股份', 'SH', '1.688521', 'chip-design-service'),
  (52, '002475.SZ', '002475', '立讯精密', 'SZ', '0.002475', 'electronics-manufacturing'),
  (53, '601138.SH', '601138', '工业富联', 'SH', '1.601138', 'ai-server-manufacturing'),
  (54, '300308.SZ', '300308', '中际旭创', 'SZ', '0.300308', 'optical-module'),
  (55, '300502.SZ', '300502', '新易盛', 'SZ', '0.300502', 'optical-module'),
  (56, '300394.SZ', '300394', '天孚通信', 'SZ', '0.300394', 'optical-device'),
  (57, '000977.SZ', '000977', '浪潮信息', 'SZ', '0.000977', 'server'),
  (58, '603019.SH', '603019', '中科曙光', 'SH', '1.603019', 'server-hpc'),
  (59, '000938.SZ', '000938', '紫光股份', 'SZ', '0.000938', 'networking-cloud'),
  (60, '002463.SZ', '002463', '沪电股份', 'SZ', '0.002463', 'pcb'),
  (61, '300033.SZ', '300033', '同花顺', 'SZ', '0.300033', 'fintech-software'),
  (62, '600570.SH', '600570', '恒生电子', 'SH', '1.600570', 'financial-software'),
  (63, '600588.SH', '600588', '用友网络', 'SH', '1.600588', 'enterprise-software'),
  (64, '002410.SZ', '002410', '广联达', 'SZ', '0.002410', 'construction-software'),
  (65, '002236.SZ', '002236', '大华股份', 'SZ', '0.002236', 'security-equipment'),
  (66, '002241.SZ', '002241', '歌尔股份', 'SZ', '0.002241', 'consumer-electronics'),
  (67, '300124.SZ', '300124', '汇川技术', 'SZ', '0.300124', 'industrial-automation'),
  (68, '688777.SH', '688777', '中控技术', 'SH', '1.688777', 'industrial-software'),
  (69, '300496.SZ', '300496', '中科创达', 'SZ', '0.300496', 'intelligent-os'),
  (70, '002920.SZ', '002920', '德赛西威', 'SZ', '0.002920', 'smart-car-electronics'),
  (71, '000063.SZ', '000063', '中兴通讯', 'SZ', '0.000063', 'telecom-equipment'),
  (72, '600941.SH', '600941', '中国移动', 'SH', '1.600941', 'telecom-operator'),
  (73, '300604.SZ', '300604', '长川科技', 'SZ', '0.300604', 'semiconductor-equipment'),
  (74, '688037.SH', '688037', '芯源微', 'SH', '1.688037', 'semiconductor-equipment'),
  (75, '688072.SH', '688072', '拓荆科技', 'SH', '1.688072', 'semiconductor-equipment'),
  (76, '688082.SH', '688082', '盛美上海', 'SH', '1.688082', 'semiconductor-equipment'),
  (77, '688120.SH', '688120', '华海清科', 'SH', '1.688120', 'semiconductor-equipment'),
  (78, '688200.SH', '688200', '华峰测控', 'SH', '1.688200', 'semiconductor-test'),
  (79, '688019.SH', '688019', '安集科技', 'SH', '1.688019', 'semiconductor-material'),
  (80, '688234.SH', '688234', '天岳先进', 'SH', '1.688234', 'semiconductor-material'),
  (81, '300666.SZ', '300666', '江丰电子', 'SZ', '0.300666', 'semiconductor-material'),
  (82, '002409.SZ', '002409', '雅克科技', 'SZ', '0.002409', 'semiconductor-material'),
  (83, '688536.SH', '688536', '思瑞浦', 'SH', '1.688536', 'analog-chip'),
  (84, '688052.SH', '688052', '纳芯微', 'SH', '1.688052', 'analog-chip'),
  (85, '688798.SH', '688798', '艾为电子', 'SH', '1.688798', 'analog-chip'),
  (86, '688608.SH', '688608', '恒玄科技', 'SH', '1.688608', 'aiot-chip'),
  (87, '688385.SH', '688385', '复旦微电', 'SH', '1.688385', 'fpga-security-chip'),
  (88, '688107.SH', '688107', '安路科技', 'SH', '1.688107', 'fpga'),
  (89, '688153.SH', '688153', '唯捷创芯', 'SH', '1.688153', 'rf-chip'),
  (90, '688213.SH', '688213', '思特威', 'SH', '1.688213', 'cis-chip'),
  (91, '688220.SH', '688220', '翱捷科技', 'SH', '1.688220', 'wireless-chip'),
  (92, '301269.SZ', '301269', '华大九天', 'SZ', '0.301269', 'eda'),
  (93, '688262.SH', '688262', '国芯科技', 'SH', '1.688262', 'chip-design'),
  (94, '688047.SH', '688047', '龙芯中科', 'SH', '1.688047', 'cpu'),
  (95, '688502.SH', '688502', '茂莱光学', 'SH', '1.688502', 'precision-optics'),
  (96, '688498.SH', '688498', '源杰科技', 'SH', '1.688498', 'optical-chip'),
  (97, '300567.SZ', '300567', '精测电子', 'SZ', '0.300567', 'display-semiconductor-equipment'),
  (98, '002916.SZ', '002916', '深南电路', 'SZ', '0.002916', 'pcb'),
  (99, '002938.SZ', '002938', '鹏鼎控股', 'SZ', '0.002938', 'pcb'),
  (100, '002384.SZ', '002384', '东山精密', 'SZ', '0.002384', 'pcb-electronics'),
  (101, '300476.SZ', '300476', '胜宏科技', 'SZ', '0.300476', 'pcb'),
  (102, '603228.SH', '603228', '景旺电子', 'SH', '1.603228', 'pcb'),
  (103, '603160.SH', '603160', '汇顶科技', 'SH', '1.603160', 'touch-chip'),
  (104, '002138.SZ', '002138', '顺络电子', 'SZ', '0.002138', 'passive-components'),
  (105, '600183.SH', '600183', '生益科技', 'SH', '1.600183', 'copper-clad-laminate'),
  (106, '300408.SZ', '300408', '三环集团', 'SZ', '0.300408', 'electronic-ceramics'),
  (107, '002402.SZ', '002402', '和而泰', 'SZ', '0.002402', 'controller'),
  (108, '002139.SZ', '002139', '拓邦股份', 'SZ', '0.002139', 'controller'),
  (109, '002050.SZ', '002050', '三花智控', 'SZ', '0.002050', 'auto-thermal-robotics'),
  (110, '002747.SZ', '002747', '埃斯顿', 'SZ', '0.002747', 'robotics'),
  (111, '300024.SZ', '300024', '机器人', 'SZ', '0.300024', 'robotics'),
  (112, '688017.SH', '688017', '绿的谐波', 'SH', '1.688017', 'robotics-reducer'),
  (113, '301029.SZ', '301029', '怡合达', 'SZ', '0.301029', 'automation-parts'),
  (114, '688188.SH', '688188', '柏楚电子', 'SH', '1.688188', 'laser-software'),
  (115, '300316.SZ', '300316', '晶盛机电', 'SZ', '0.300316', 'crystal-growth-equipment'),
  (116, '002008.SZ', '002008', '大族激光', 'SZ', '0.002008', 'laser-equipment'),
  (117, '300450.SZ', '300450', '先导智能', 'SZ', '0.300450', 'battery-equipment'),
  (118, '688187.SH', '688187', '时代电气', 'SH', '1.688187', 'power-electronics'),
  (119, '688169.SH', '688169', '石头科技', 'SH', '1.688169', 'home-robot'),
  (120, '000066.SZ', '000066', '中国长城', 'SZ', '0.000066', 'cybersecurity-hardware'),
  (121, '002439.SZ', '002439', '启明星辰', 'SZ', '0.002439', 'cybersecurity'),
  (122, '300454.SZ', '300454', '深信服', 'SZ', '0.300454', 'cybersecurity-cloud'),
  (123, '300017.SZ', '300017', '网宿科技', 'SZ', '0.300017', 'cloud-cdn'),
  (124, '002405.SZ', '002405', '四维图新', 'SZ', '0.002405', 'smart-car-map'),
  (125, '002212.SZ', '002212', '天融信', 'SZ', '0.002212', 'cybersecurity'),
  (126, '688568.SH', '688568', '中科星图', 'SH', '1.688568', 'satellite-data'),
  (127, '688088.SH', '688088', '虹软科技', 'SH', '1.688088', 'ai-vision'),
  (128, '300229.SZ', '300229', '拓尔思', 'SZ', '0.300229', 'ai-software'),
  (129, '300418.SZ', '300418', '昆仑万维', 'SZ', '0.300418', 'ai-internet'),
  (130, '300413.SZ', '300413', '芒果超媒', 'SZ', '0.300413', 'media-platform'),
  (131, '603000.SH', '603000', '人民网', 'SH', '1.603000', 'media-data'),
  (132, '601360.SH', '601360', '三六零', 'SH', '1.601360', 'security-ai'),
  (133, '002602.SZ', '002602', '世纪华通', 'SZ', '0.002602', 'gaming'),
  (134, '300315.SZ', '300315', '掌趣科技', 'SZ', '0.300315', 'gaming'),
  (135, '000001.SZ', '000001', '平安银行', 'SZ', '0.000001', 'bank'),
  (136, '600000.SH', '600000', '浦发银行', 'SH', '1.600000', 'bank'),
  (137, '601939.SH', '601939', '建设银行', 'SH', '1.601939', 'bank'),
  (138, '601988.SH', '601988', '中国银行', 'SH', '1.601988', 'bank'),
  (139, '601328.SH', '601328', '交通银行', 'SH', '1.601328', 'bank'),
  (140, '601658.SH', '601658', '邮储银行', 'SH', '1.601658', 'bank'),
  (141, '600999.SH', '600999', '招商证券', 'SH', '1.600999', 'brokerage'),
  (142, '601211.SH', '601211', '国泰君安', 'SH', '1.601211', 'brokerage'),
  (143, '601688.SH', '601688', '华泰证券', 'SH', '1.601688', 'brokerage'),
  (144, '000776.SZ', '000776', '广发证券', 'SZ', '0.000776', 'brokerage'),
  (145, '601601.SH', '601601', '中国太保', 'SH', '1.601601', 'insurance'),
  (146, '601336.SH', '601336', '新华保险', 'SH', '1.601336', 'insurance'),
  (147, '000568.SZ', '000568', '泸州老窖', 'SZ', '0.000568', 'liquor'),
  (148, '600809.SH', '600809', '山西汾酒', 'SH', '1.600809', 'liquor'),
  (149, '603369.SH', '603369', '今世缘', 'SH', '1.603369', 'liquor'),
  (150, '600887.SH', '600887', '伊利股份', 'SH', '1.600887', 'dairy'),
  (151, '000002.SZ', '000002', '万科A', 'SZ', '0.000002', 'real-estate'),
  (152, '001979.SZ', '001979', '招商蛇口', 'SZ', '0.001979', 'real-estate'),
  (153, '600048.SH', '600048', '保利发展', 'SH', '1.600048', 'real-estate'),
  (154, '000069.SZ', '000069', '华侨城A', 'SZ', '0.000069', 'tourism-real-estate'),
  (155, '002271.SZ', '002271', '东方雨虹', 'SZ', '0.002271', 'building-material'),
  (156, '000786.SZ', '000786', '北新建材', 'SZ', '0.000786', 'building-material'),
  (157, '600585.SH', '600585', '海螺水泥', 'SH', '1.600585', 'cement'),
  (158, '000401.SZ', '000401', '冀东水泥', 'SZ', '0.000401', 'cement'),
  (159, '600031.SH', '600031', '三一重工', 'SH', '1.600031', 'construction-machinery'),
  (160, '000425.SZ', '000425', '徐工机械', 'SZ', '0.000425', 'construction-machinery'),
  (161, '000157.SZ', '000157', '中联重科', 'SZ', '0.000157', 'construction-machinery'),
  (162, '601100.SH', '601100', '恒立液压', 'SH', '1.601100', 'hydraulic-parts'),
  (163, '600406.SH', '600406', '国电南瑞', 'SH', '1.600406', 'grid-automation'),
  (164, '000400.SZ', '000400', '许继电气', 'SZ', '0.000400', 'grid-equipment'),
  (165, '600089.SH', '600089', '特变电工', 'SH', '1.600089', 'power-equipment'),
  (166, '601877.SH', '601877', '正泰电器', 'SH', '1.601877', 'low-voltage-electrical'),
  (167, '300274.SZ', '300274', '阳光电源', 'SZ', '0.300274', 'inverter-storage'),
  (168, '300014.SZ', '300014', '亿纬锂能', 'SZ', '0.300014', 'battery'),
  (169, '002812.SZ', '002812', '恩捷股份', 'SZ', '0.002812', 'battery-separator'),
  (170, '002460.SZ', '002460', '赣锋锂业', 'SZ', '0.002460', 'lithium'),
  (171, '002466.SZ', '002466', '天齐锂业', 'SZ', '0.002466', 'lithium'),
  (172, '603799.SH', '603799', '华友钴业', 'SH', '1.603799', 'cobalt-lithium'),
  (173, '300073.SZ', '300073', '当升科技', 'SZ', '0.300073', 'cathode-material'),
  (174, '300769.SZ', '300769', '德方纳米', 'SZ', '0.300769', 'cathode-material'),
  (175, '002709.SZ', '002709', '天赐材料', 'SZ', '0.002709', 'electrolyte'),
  (176, '300037.SZ', '300037', '新宙邦', 'SZ', '0.300037', 'electrolyte'),
  (177, '002129.SZ', '002129', 'TCL中环', 'SZ', '0.002129', 'solar-wafer'),
  (178, '688599.SH', '688599', '天合光能', 'SH', '1.688599', 'solar'),
  (179, '601865.SH', '601865', '福莱特', 'SH', '1.601865', 'solar-glass'),
  (180, '600438.SH', '600438', '通威股份', 'SH', '1.600438', 'solar-silicon'),
  (181, '603806.SH', '603806', '福斯特', 'SH', '1.603806', 'solar-film'),
  (182, '002459.SZ', '002459', '晶澳科技', 'SZ', '0.002459', 'solar-module'),
  (183, '300118.SZ', '300118', '东方日升', 'SZ', '0.300118', 'solar-module'),
  (184, '688223.SH', '688223', '晶科能源', 'SH', '1.688223', 'solar-module'),
  (185, '600905.SH', '600905', '三峡能源', 'SH', '1.600905', 'green-power'),
  (186, '001289.SZ', '001289', '龙源电力', 'SZ', '0.001289', 'wind-power'),
  (187, '600011.SH', '600011', '华能国际', 'SH', '1.600011', 'thermal-power'),
  (188, '600027.SH', '600027', '华电国际', 'SH', '1.600027', 'thermal-power'),
  (189, '600795.SH', '600795', '国电电力', 'SH', '1.600795', 'utility-power'),
  (190, '600886.SH', '600886', '国投电力', 'SH', '1.600886', 'utility-power'),
  (191, '600025.SH', '600025', '华能水电', 'SH', '1.600025', 'hydropower'),
  (192, '600803.SH', '600803', '新奥股份', 'SH', '1.600803', 'gas'),
  (193, '601225.SH', '601225', '陕西煤业', 'SH', '1.601225', 'coal'),
  (194, '601088.SH', '601088', '中国神华', 'SH', '1.601088', 'coal'),
  (195, '600188.SH', '600188', '兖矿能源', 'SH', '1.600188', 'coal'),
  (196, '601898.SH', '601898', '中煤能源', 'SH', '1.601898', 'coal'),
  (197, '000983.SZ', '000983', '山西焦煤', 'SZ', '0.000983', 'coal'),
  (198, '600111.SH', '600111', '北方稀土', 'SH', '1.600111', 'rare-earth'),
  (199, '600362.SH', '600362', '江西铜业', 'SH', '1.600362', 'copper'),
  (200, '601899.SH', '601899', '紫金矿业', 'SH', '1.601899', 'copper-gold'),
  (201, '603993.SH', '603993', '洛阳钼业', 'SH', '1.603993', 'molybdenum-cobalt'),
  (202, '000807.SZ', '000807', '云铝股份', 'SZ', '0.000807', 'aluminum'),
  (203, '601600.SH', '601600', '中国铝业', 'SH', '1.601600', 'aluminum'),
  (204, '000630.SZ', '000630', '铜陵有色', 'SZ', '0.000630', 'copper'),
  (205, '600547.SH', '600547', '山东黄金', 'SH', '1.600547', 'gold'),
  (206, '002532.SZ', '002532', '天山铝业', 'SZ', '0.002532', 'aluminum'),
  (207, '600489.SH', '600489', '中金黄金', 'SH', '1.600489', 'gold'),
  (208, '000338.SZ', '000338', '潍柴动力', 'SZ', '0.000338', 'engine'),
  (209, '601766.SH', '601766', '中国中车', 'SH', '1.601766', 'rail-equipment'),
  (210, '600104.SH', '600104', '上汽集团', 'SH', '1.600104', 'auto'),
  (211, '601633.SH', '601633', '长城汽车', 'SH', '1.601633', 'auto'),
  (212, '600660.SH', '600660', '福耀玻璃', 'SH', '1.600660', 'auto-glass'),
  (213, '002472.SZ', '002472', '双环传动', 'SZ', '0.002472', 'auto-parts'),
  (214, '601689.SH', '601689', '拓普集团', 'SH', '1.601689', 'auto-parts'),
  (215, '600741.SH', '600741', '华域汽车', 'SH', '1.600741', 'auto-parts'),
  (216, '002126.SZ', '002126', '银轮股份', 'SZ', '0.002126', 'auto-thermal'),
  (217, '300001.SZ', '300001', '特锐德', 'SZ', '0.300001', 'charging-grid'),
  (218, '600845.SH', '600845', '宝信软件', 'SH', '1.600845', 'industrial-software'),
  (219, '000997.SZ', '000997', '新大陆', 'SZ', '0.000997', 'payment-iot'),
  (220, '000034.SZ', '000034', '神州数码', 'SZ', '0.000034', 'it-distribution'),
  (221, '600536.SH', '600536', '中国软件', 'SH', '1.600536', 'basic-software'),
  (222, '600271.SH', '600271', '航天信息', 'SH', '1.600271', 'tax-it'),
  (223, '002268.SZ', '002268', '电科网安', 'SZ', '0.002268', 'cybersecurity'),
  (224, '300253.SZ', '300253', '卫宁健康', 'SZ', '0.300253', 'healthcare-it'),
  (225, '300682.SZ', '300682', '朗新集团', 'SZ', '0.300682', 'utility-software'),
  (226, '300451.SZ', '300451', '创业慧康', 'SZ', '0.300451', 'healthcare-it'),
  (227, '300212.SZ', '300212', '易华录', 'SZ', '0.300212', 'data-center'),
  (228, '600131.SH', '600131', '国网信通', 'SH', '1.600131', 'power-it'),
  (229, '300760.SZ', '300760', '迈瑞医疗', 'SZ', '0.300760', 'medical-device'),
  (230, '300015.SZ', '300015', '爱尔眼科', 'SZ', '0.300015', 'healthcare-service'),
  (231, '600436.SH', '600436', '片仔癀', 'SH', '1.600436', 'tcm'),
  (232, '000538.SZ', '000538', '云南白药', 'SZ', '0.000538', 'tcm'),
  (233, '000661.SZ', '000661', '长春高新', 'SZ', '0.000661', 'biotech'),
  (234, '300122.SZ', '300122', '智飞生物', 'SZ', '0.300122', 'vaccine'),
  (235, '600196.SH', '600196', '复星医药', 'SH', '1.600196', 'pharma'),
  (236, '600161.SH', '600161', '天坛生物', 'SH', '1.600161', 'vaccine-blood-products'),
  (237, '300347.SZ', '300347', '泰格医药', 'SZ', '0.300347', 'cro'),
  (238, '300759.SZ', '300759', '康龙化成', 'SZ', '0.300759', 'cro'),
  (239, '688271.SH', '688271', '联影医疗', 'SH', '1.688271', 'medical-device'),
  (240, '603392.SH', '603392', '万泰生物', 'SH', '1.603392', 'vaccine-diagnostics'),
  (241, '300601.SZ', '300601', '康泰生物', 'SZ', '0.300601', 'vaccine'),
  (242, '002007.SZ', '002007', '华兰生物', 'SZ', '0.002007', 'blood-products'),
  (243, '600763.SH', '600763', '通策医疗', 'SH', '1.600763', 'dental-service'),
  (244, '688235.SH', '688235', '百济神州-U', 'SH', '1.688235', 'biotech'),
  (245, '688180.SH', '688180', '君实生物-U', 'SH', '1.688180', 'biotech'),
  (246, '000895.SZ', '000895', '双汇发展', 'SZ', '0.000895', 'meat-processing'),
  (247, '600690.SH', '600690', '海尔智家', 'SH', '1.600690', 'home-appliance'),
  (248, '603288.SH', '603288', '海天味业', 'SH', '1.603288', 'condiment'),
  (249, '600872.SH', '600872', '中炬高新', 'SH', '1.600872', 'condiment'),
  (250, '600298.SH', '600298', '安琪酵母', 'SH', '1.600298', 'food-ingredient'),
  (251, '600309.SH', '600309', '万华化学', 'SH', '1.600309', 'chemical-material'),
  (252, '002304.SZ', '002304', '洋河股份', 'SZ', '0.002304', 'liquor'),
  (253, '603899.SH', '603899', '晨光股份', 'SH', '1.603899', 'stationery'),
  (254, '603816.SH', '603816', '顾家家居', 'SH', '1.603816', 'furniture'),
  (255, '603833.SH', '603833', '欧派家居', 'SH', '1.603833', 'furniture'),
  (256, '002507.SZ', '002507', '涪陵榨菜', 'SZ', '0.002507', 'food'),
  (257, '002714.SZ', '002714', '牧原股份', 'SZ', '0.002714', 'pig-farming'),
  (258, '000876.SZ', '000876', '新希望', 'SZ', '0.000876', 'agriculture'),
  (259, '002311.SZ', '002311', '海大集团', 'SZ', '0.002311', 'feed'),
  (260, '600600.SH', '600600', '青岛啤酒', 'SH', '1.600600', 'beer'),
  (261, '000729.SZ', '000729', '燕京啤酒', 'SZ', '0.000729', 'beer'),
  (262, '000596.SZ', '000596', '古井贡酒', 'SZ', '0.000596', 'liquor'),
  (263, '000799.SZ', '000799', '酒鬼酒', 'SZ', '0.000799', 'liquor'),
  (264, '601111.SH', '601111', '中国国航', 'SH', '1.601111', 'airline'),
  (265, '600029.SH', '600029', '南方航空', 'SH', '1.600029', 'airline'),
  (266, '600115.SH', '600115', '中国东航', 'SH', '1.600115', 'airline'),
  (267, '601919.SH', '601919', '中远海控', 'SH', '1.601919', 'shipping'),
  (268, '601872.SH', '601872', '招商轮船', 'SH', '1.601872', 'shipping'),
  (269, '600026.SH', '600026', '中远海能', 'SH', '1.600026', 'shipping'),
  (270, '600018.SH', '600018', '上港集团', 'SH', '1.600018', 'port'),
  (271, '601018.SH', '601018', '宁波港', 'SH', '1.601018', 'port'),
  (272, '600009.SH', '600009', '上海机场', 'SH', '1.600009', 'airport'),
  (273, '600004.SH', '600004', '白云机场', 'SH', '1.600004', 'airport'),
  (274, '002352.SZ', '002352', '顺丰控股', 'SZ', '0.002352', 'logistics'),
  (275, '601816.SH', '601816', '京沪高铁', 'SH', '1.601816', 'railway'),
  (276, '601006.SH', '601006', '大秦铁路', 'SH', '1.601006', 'railway'),
  (277, '600760.SH', '600760', '中航沈飞', 'SH', '1.600760', 'defense-aviation'),
  (278, '000768.SZ', '000768', '中航西飞', 'SZ', '0.000768', 'defense-aviation'),
  (279, '600893.SH', '600893', '航发动力', 'SH', '1.600893', 'aero-engine'),
  (280, '600118.SH', '600118', '中国卫星', 'SH', '1.600118', 'satellite'),
  (281, '601989.SH', '601989', '中国重工', 'SH', '1.601989', 'shipbuilding'),
  (282, '600150.SH', '600150', '中国船舶', 'SH', '1.600150', 'shipbuilding'),
  (283, '601698.SH', '601698', '中国卫通', 'SH', '1.601698', 'satellite-communication'),
  (284, '300114.SZ', '300114', '中航电测', 'SZ', '0.300114', 'defense-electronics'),
  (285, '002179.SZ', '002179', '中航光电', 'SZ', '0.002179', 'connector'),
  (286, '600372.SH', '600372', '中航机载', 'SH', '1.600372', 'avionics'),
  (287, '000738.SZ', '000738', '航发控制', 'SZ', '0.000738', 'aero-engine-control'),
  (288, '600482.SH', '600482', '中国动力', 'SH', '1.600482', 'marine-power'),
  (289, '600019.SH', '600019', '宝钢股份', 'SH', '1.600019', 'steel'),
  (290, '000708.SZ', '000708', '中信特钢', 'SZ', '0.000708', 'special-steel'),
  (291, '000932.SZ', '000932', '华菱钢铁', 'SZ', '0.000932', 'steel'),
  (292, '600010.SH', '600010', '包钢股份', 'SH', '1.600010', 'steel-rare-earth'),
  (293, '600346.SH', '600346', '恒力石化', 'SH', '1.600346', 'petrochemical'),
  (294, '002493.SZ', '002493', '荣盛石化', 'SZ', '0.002493', 'petrochemical'),
  (295, '000301.SZ', '000301', '东方盛虹', 'SZ', '0.000301', 'petrochemical'),
  (296, '600989.SH', '600989', '宝丰能源', 'SH', '1.600989', 'coal-chemical'),
  (297, '002648.SZ', '002648', '卫星化学', 'SZ', '0.002648', 'chemical'),
  (298, '600426.SH', '600426', '华鲁恒升', 'SH', '1.600426', 'chemical'),
  (299, '000683.SZ', '000683', '远兴能源', 'SZ', '0.000683', 'soda-ash'),
  (300, '600176.SH', '600176', '中国巨石', 'SH', '1.600176', 'fiberglass');

INSERT INTO quant.securities (symbol, code, name, exchange, asset_type, secid, provider, metadata)
SELECT
  symbol,
  code,
  name,
  exchange,
  'stock',
  secid,
  'eastmoney',
  jsonb_build_object('sector_hint', sector_hint, 'seed_order', seed_order)
FROM quant_seed_securities
ON CONFLICT (symbol) DO UPDATE SET
  code = EXCLUDED.code,
  name = EXCLUDED.name,
  exchange = EXCLUDED.exchange,
  asset_type = EXCLUDED.asset_type,
  secid = EXCLUDED.secid,
  provider = EXCLUDED.provider,
  metadata = quant.securities.metadata || EXCLUDED.metadata,
  updated_at = now();

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
  symbol,
  'member',
  round((1::NUMERIC / count(*) OVER ()), 8),
  jsonb_build_object('order', seed_order)
FROM quant_seed_securities
ORDER BY seed_order
ON CONFLICT (universe_id, symbol) DO UPDATE SET
  role = EXCLUDED.role,
  weight = EXCLUDED.weight,
  metadata = quant.security_universe_members.metadata || EXCLUDED.metadata;

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
