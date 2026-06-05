from __future__ import annotations

from quantpilot_market_data.database_core import (
    DatabaseError,
    normalize_fetch_symbol,
)
from quantpilot_market_data.repositories.analytics import (
    sync_clickhouse_daily_bars,
)
from quantpilot_market_data.repositories.bars import get_local_kline
from quantpilot_market_data.repositories.coverage import (
    get_market_data_coverage_page,
    list_market_data_coverage,
)
from quantpilot_market_data.repositories.foundation import (
    list_factor_definitions,
    list_foundation_components,
    list_trading_calendar_days,
    run_data_quality_scan,
)
from quantpilot_market_data.repositories.ingestion import (
    control_ingestion_job,
    create_ingestion_job,
    finish_ingestion_job,
    get_history_ingestion_preflight,
    get_ingestion_job_control,
    list_ingestion_jobs,
    reconcile_stale_ingestion_jobs,
    update_ingestion_job_progress,
)
from quantpilot_market_data.repositories.screener import (
    screen_a_share_short_term_candidates,
)
from quantpilot_market_data.repositories.sector_flow import (
    list_sector_capital_flow,
)
from quantpilot_market_data.repositories.universes import (
    add_securities_to_universe,
    add_security_to_universe,
    clean_research_universe_tradable_members,
    get_universe_fetch_targets,
    list_research_universe_members_page,
    list_research_universe_summaries,
    list_research_universes,
)
from quantpilot_market_data.repositories.upserts import (
    upsert_kline_response,
    upsert_realtime_quote_snapshot,
)

DEFAULT_UNIVERSE_ID = "a-share-sample-research-pool"

__all__ = [
    "DatabaseError",
    "add_securities_to_universe",
    "add_security_to_universe",
    "clean_research_universe_tradable_members",
    "control_ingestion_job",
    "create_ingestion_job",
    "finish_ingestion_job",
    "get_history_ingestion_preflight",
    "get_ingestion_job_control",
    "get_local_kline",
    "get_market_data_coverage_page",
    "get_universe_fetch_targets",
    "list_factor_definitions",
    "list_foundation_components",
    "list_ingestion_jobs",
    "list_market_data_coverage",
    "list_research_universe_members_page",
    "list_research_universe_summaries",
    "list_research_universes",
    "list_sector_capital_flow",
    "list_trading_calendar_days",
    "normalize_fetch_symbol",
    "reconcile_stale_ingestion_jobs",
    "run_data_quality_scan",
    "screen_a_share_short_term_candidates",
    "sync_clickhouse_daily_bars",
    "update_ingestion_job_progress",
    "upsert_kline_response",
    "upsert_realtime_quote_snapshot",
]
