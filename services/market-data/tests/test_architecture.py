from pathlib import Path
from runpy import run_path

import pytest

CHECK = run_path(
    str(Path(__file__).resolve().parents[3] / "scripts/checks/check-backend-layers.py")
)


@pytest.mark.parametrize(
    ("file", "source"),
    [
        ("services/ingestion/history.py", "from ...routers import ingestion"),
        ("repositories/bars.py", "from quantpilot_market_data.services import quotes"),
        ("providers/remote.py", "import quantpilot_market_data.repositories.bars"),
        ("contracts/quotes.py", "from quantpilot_market_data import services"),
        ("services/new.py", "from fastapi import HTTPException"),
        ("services/new.py", 'importlib.import_module("quantpilot_market_data.api")'),
        ("api.py", '@app.post("/write")\nasync def write(): pass'),
    ],
)
def test_rejects_upward_dependencies_and_http_business_logic(file: str, source: str) -> None:
    assert CHECK["check_source"](file, source)


def test_ignores_examples_and_allows_downward_service_dependencies() -> None:
    source = """
# from fastapi import HTTPException
example = "import quantpilot_market_data.api"
from ...repositories.ingestion import create_ingestion_job
from ...providers.baostock import BaoStockClient
"""
    assert CHECK["check_source"]("services/ingestion/history.py", source) == []
