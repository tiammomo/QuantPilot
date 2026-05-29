-- Promote security industry, region and concept metadata into stable top-level keys.
-- Safe to run repeatedly. Source values are kept under metadata.raw and normalized here
-- so stock-pool screens do not need to know provider-specific field names.

WITH source_values AS (
  SELECT
    symbol,
    metadata,
    NULLIF(trim(COALESCE(metadata->>'industry', metadata#>>'{raw,industry}', metadata#>>'{raw,f100}', '')), '') AS raw_industry,
    NULLIF(trim(COALESCE(metadata->>'region', metadata#>>'{raw,region}', metadata#>>'{raw,f102}', '')), '') AS raw_region,
    NULLIF(trim(COALESCE(metadata->>'concepts', metadata#>>'{raw,concepts}', metadata#>>'{raw,f103}', '')), '') AS raw_concepts,
    NULLIF(trim(COALESCE(metadata->>'sector_hint', metadata#>>'{raw,sector_hint}', '')), '') AS raw_sector_hint
  FROM quant.securities
),
normalized AS (
  SELECT
    source_values.symbol,
    CASE
      WHEN source_values.raw_industry IN ('-', '--', '无', '暂无') THEN NULL
      WHEN source_values.raw_industry IS NOT NULL THEN source_values.raw_industry
      WHEN source_values.raw_sector_hint = 'semiconductor' THEN '半导体'
      WHEN source_values.raw_sector_hint = 'gaming' THEN '游戏'
      WHEN source_values.raw_sector_hint = 'bank' THEN '银行'
      WHEN source_values.raw_sector_hint = 'gold-retail' THEN '黄金珠宝'
      WHEN source_values.raw_sector_hint = 'liquor' THEN '白酒'
      WHEN source_values.raw_sector_hint = 'home-appliance' THEN '家电'
      WHEN source_values.raw_sector_hint = 'battery' THEN '电池'
      WHEN source_values.raw_sector_hint = 'new-energy-auto' THEN '新能源汽车'
      WHEN source_values.raw_sector_hint = 'insurance' THEN '保险'
      WHEN source_values.raw_sector_hint = 'utility' THEN '公用事业'
      WHEN source_values.raw_sector_hint = 'solar' THEN '光伏'
      WHEN source_values.raw_sector_hint = 'pharma' THEN '医药'
      WHEN source_values.raw_sector_hint = 'display-panel' THEN '面板'
      WHEN source_values.raw_sector_hint = 'security-equipment' THEN '安防设备'
      WHEN source_values.raw_sector_hint = 'telecom' THEN '通信服务'
      WHEN source_values.raw_sector_hint = 'oil-gas' THEN '石油石化'
      WHEN source_values.raw_sector_hint = 'construction' THEN '建筑工程'
      WHEN source_values.raw_sector_hint = 'petrochemical' THEN '石油化工'
      WHEN source_values.raw_sector_hint = 'coal-chemical' THEN '煤化工'
      WHEN source_values.raw_sector_hint = 'chemical' THEN '化工'
      WHEN source_values.raw_sector_hint = 'soda-ash' THEN '纯碱'
      WHEN source_values.raw_sector_hint = 'fiberglass' THEN '玻璃纤维'
      WHEN source_values.raw_sector_hint = 'defense-electronics' THEN '国防军工'
    END AS industry,
    CASE
      WHEN source_values.raw_region IN ('-', '--', '无', '暂无') THEN NULL
      ELSE source_values.raw_region
    END AS region,
    ARRAY(
      SELECT concept
      FROM (
        SELECT DISTINCT ON (concept) concept, ordinality
        FROM regexp_split_to_table(COALESCE(source_values.raw_concepts, ''), '\s*[,，、;；|]\s*')
          WITH ORDINALITY AS split_value(concept, ordinality)
        WHERE concept IS NOT NULL
          AND trim(concept) NOT IN ('', '-', '--', '无', '暂无')
        ORDER BY concept, ordinality
      ) deduped
      ORDER BY ordinality
    ) AS concepts
  FROM source_values
),
sector_tags AS (
  SELECT
    normalized.symbol,
    normalized.industry,
    normalized.region,
    normalized.concepts,
    ARRAY(
      SELECT tag
      FROM (
        SELECT DISTINCT ON (tag) tag, ordinality
        FROM unnest(
          ARRAY[normalized.industry] ||
          COALESCE(normalized.concepts[1:5], ARRAY[]::TEXT[]) ||
          ARRAY[normalized.region]
        ) WITH ORDINALITY AS tag_value(tag, ordinality)
        WHERE tag IS NOT NULL
          AND trim(tag) NOT IN ('', '-', '--', '无', '暂无')
        ORDER BY tag, ordinality
      ) deduped
      ORDER BY ordinality
    ) AS sector_tags
  FROM normalized
)
UPDATE quant.securities securities
SET
  metadata =
    securities.metadata ||
    jsonb_strip_nulls(
      jsonb_build_object(
        'industry', sector_tags.industry,
        'region', sector_tags.region,
        'sector_source', 'eastmoney-clist'
      )
    ) ||
    CASE
      WHEN cardinality(sector_tags.concepts) > 0
      THEN jsonb_build_object('concepts', to_jsonb(sector_tags.concepts))
      ELSE '{}'::jsonb
    END ||
    CASE
      WHEN cardinality(sector_tags.sector_tags) > 0
      THEN jsonb_build_object('sector_tags', to_jsonb(sector_tags.sector_tags))
      ELSE '{}'::jsonb
    END,
  updated_at = now()
FROM sector_tags
WHERE securities.symbol = sector_tags.symbol
  AND (
    (securities.metadata->>'industry' IS NULL AND sector_tags.industry IS NOT NULL)
    OR (securities.metadata->>'region' IS NULL AND sector_tags.region IS NOT NULL)
    OR (securities.metadata->'concepts' IS NULL AND cardinality(sector_tags.concepts) > 0)
    OR (
      securities.metadata->'sector_tags' IS NULL
      AND cardinality(sector_tags.sector_tags) > 0
    )
  );

COMMENT ON COLUMN quant.securities.metadata IS '证券主数据补充字段；industry/region/concepts/sector_tags 为标准化板块信息，raw 保留数据源原始字段。';
