-- Observed financial vintages. A late capture never backdates knowledge.
CREATE SCHEMA IF NOT EXISTS quant;

CREATE TABLE IF NOT EXISTS quant.financial_report_versions (
    revision_id UUID PRIMARY KEY,
    symbol TEXT NOT NULL,
    provider TEXT NOT NULL,
    report_date DATE NOT NULL,
    notice_at TIMESTAMPTZ,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    available_at TIMESTAMPTZ,
    content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
    payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    CHECK ((notice_at IS NULL AND available_at IS NULL) OR
           (notice_at IS NOT NULL AND available_at IS NOT NULL AND
            available_at >= notice_at AND available_at >= observed_at))
);

CREATE INDEX IF NOT EXISTS financial_report_versions_as_of_idx
    ON quant.financial_report_versions
       (symbol, provider, report_date DESC, observed_at DESC, revision_id DESC);

CREATE OR REPLACE FUNCTION quant.reject_financial_report_version_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Financial report versions are immutable; append a new observation';
END;
$$;

CREATE OR REPLACE TRIGGER financial_report_versions_immutable_rows
    BEFORE UPDATE OR DELETE ON quant.financial_report_versions
    FOR EACH ROW EXECUTE FUNCTION quant.reject_financial_report_version_mutation();

CREATE OR REPLACE TRIGGER financial_report_versions_immutable_table
    BEFORE TRUNCATE ON quant.financial_report_versions
    FOR EACH STATEMENT EXECUTE FUNCTION quant.reject_financial_report_version_mutation();
