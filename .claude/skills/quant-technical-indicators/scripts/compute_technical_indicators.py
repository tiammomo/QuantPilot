#!/usr/bin/env python3
"""Compute deterministic technical indicators from local QuantPilot bars."""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from pathlib import Path
from typing import Any


JsonRecord = dict[str, Any]
DEFAULT_ANNUALIZATION = {"daily": 252, "weekly": 52, "monthly": 12}


def as_record(value: Any) -> JsonRecord | None:
    return value if isinstance(value, dict) else None


def numeric(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(value) else None
    if isinstance(value, str) and value.strip():
        try:
            parsed = float(value.strip().replace(",", ""))
        except ValueError:
            return None
        return parsed if math.isfinite(parsed) else None
    return None


def extract_bars(value: Any) -> tuple[list[JsonRecord], JsonRecord]:
    if isinstance(value, list):
        return [bar for bar in value if isinstance(bar, dict)], {}
    root = as_record(value)
    if root is None:
        raise ValueError("输入 JSON 根必须是对象或 bar 数组。")
    assets = root.get("assets")
    if isinstance(assets, list):
        records = [asset for asset in assets if isinstance(asset, dict)]
        if len(records) != 1:
            raise ValueError("技术指标脚本一次只接受一个资产；多资产请分别运行。")
        root = records[0]
    kline = as_record(root.get("kline")) or {}
    history = as_record(root.get("history")) or {}
    for candidate in (
        root.get("bars"),
        kline.get("bars"),
        kline.get("data"),
        history.get("bars"),
        history.get("data"),
        root.get("data"),
    ):
        if isinstance(candidate, list):
            return [bar for bar in candidate if isinstance(bar, dict)], root
    raise ValueError("输入中没有可识别的 bars/data 数组。")


def normalize_bars(rows: list[JsonRecord]) -> tuple[list[JsonRecord], list[str]]:
    warnings: list[str] = []
    bars: list[JsonRecord] = []
    for index, row in enumerate(rows):
        raw_date = row.get("date") or row.get("trade_date") or row.get("time") or row.get("timestamp")
        date = str(raw_date).strip() if raw_date not in (None, "") else ""
        close = numeric(row.get("close"))
        if not date:
            warnings.append(f"第 {index + 1} 根 bar 缺少时间键，已排除。")
            continue
        if close is None or close <= 0:
            warnings.append(f"{date} 的 close 不是有限正数，已排除。")
            continue
        volume = numeric(row.get("volume"))
        if volume is not None and volume < 0:
            warnings.append(f"{date} 的 volume 为负，已置 null。")
            volume = None
        bars.append({"date": date, "close": close, "volume": volume})
    if not bars:
        raise ValueError("没有包含时间键和有限正 close 的有效 bars。")
    bars.sort(key=lambda bar: str(bar["date"]))
    dates = [str(bar["date"]) for bar in bars]
    duplicates = sorted({date for date in dates if dates.count(date) > 1})
    if duplicates:
        raise ValueError(f"存在重复时间键：{', '.join(duplicates[:5])}")
    return bars, warnings


def parse_windows(raw: str) -> list[int]:
    try:
        windows = sorted({int(item.strip()) for item in raw.split(",") if item.strip()})
    except ValueError as error:
        raise argparse.ArgumentTypeError("--windows 必须是逗号分隔的正整数。") from error
    if not windows or any(window <= 0 or window > 10_000 for window in windows):
        raise argparse.ArgumentTypeError("--windows 必须包含 1..10000 的整数。")
    return windows


def mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def rounded(value: float | None, digits: int = 6) -> float | None:
    return round(value, digits) if value is not None and math.isfinite(value) else None


def annualized_volatility(closes: list[float], annualization: int, max_returns: int | None = None) -> float | None:
    returns = [math.log(current / previous) for previous, current in zip(closes, closes[1:], strict=False)]
    if max_returns is not None:
        returns = returns[-max_returns:]
    if len(returns) < 2:
        return None
    return statistics.stdev(returns) * math.sqrt(annualization) * 100


def compute(value: Any, windows: list[int], period_arg: str | None, adjustment_arg: str | None, annualization_arg: int | None) -> JsonRecord:
    rows, root = extract_bars(value)
    bars, warnings = normalize_bars(rows)
    kline = as_record(root.get("kline")) or {}
    period = period_arg or str(kline.get("period") or root.get("period") or "daily")
    adjustment = adjustment_arg or str(kline.get("adjustment") or root.get("adjustment") or "unknown")
    annualization = annualization_arg or DEFAULT_ANNUALIZATION.get(period)
    if annualization is None:
        raise ValueError(f"period={period} 没有默认年化因子；请显式传 --annualization。")
    if adjustment not in {"none", "qfq", "hfq"}:
        warnings.append(f"adjustment={adjustment} 不在 none/qfq/hfq 中；未猜测复权口径。")

    closes: list[float] = []
    volumes: list[float | None] = []
    points: list[JsonRecord] = []
    peak = 0.0
    for bar in bars:
        close = float(bar["close"])
        previous = closes[-1] if closes else None
        closes.append(close)
        volumes.append(numeric(bar.get("volume")))
        peak = max(peak, close)
        point: JsonRecord = {
            "date": bar["date"],
            "close": rounded(close),
            "volume": rounded(numeric(bar.get("volume")), 2),
            "return_pct": rounded((close / previous - 1) * 100 if previous else None),
            "drawdown_pct": rounded((close / peak - 1) * 100),
        }
        for window in windows:
            point[f"ma{window}"] = rounded(mean(closes[-window:])) if len(closes) >= window else None
        points.append(point)

    latest = closes[-1]
    period_return = (latest / closes[0] - 1) * 100 if len(closes) >= 2 else None
    max_drawdown = min(float(point["drawdown_pct"]) for point in points)
    valid_volume20 = [volume for volume in volumes[-20:] if volume is not None and volume >= 0]
    avg_volume20 = mean(valid_volume20) if len(valid_volume20) == 20 else None
    if len(closes) < max(windows):
        warnings.append(f"有效 bars 少于最大 MA 窗口 {max(windows)}；不足窗口的 MA 为 null。")
    if len(closes) < 3:
        warnings.append("有效收益少于 2 个，年化波动率为 null。")
    if avg_volume20 is None:
        warnings.append("不足 20 个有效 volume，avg_volume20 为 null。")

    quote = as_record(root.get("quote")) or {}
    latest_mas = {f"ma{window}": points[-1][f"ma{window}"] for window in windows}
    return {
        "schema_version": 1,
        "symbol": root.get("symbol") or quote.get("symbol"),
        "period": period,
        "adjustment": adjustment,
        "annualization": annualization,
        "windows": windows,
        "points": points,
        "summary": {
            "date": points[-1]["date"],
            "sample_size": len(points),
            "latest_close": rounded(latest),
            "period_return_pct": rounded(period_return),
            "max_drawdown_pct": rounded(max_drawdown),
            "volatility_annualized_pct": rounded(annualized_volatility(closes, annualization)),
            "volatility_20d_annualized_pct": rounded(annualized_volatility(closes, annualization, 20)),
            "avg_volume20": rounded(avg_volume20, 2),
            **latest_mas,
        },
        "source": root.get("source") or kline.get("source"),
        "fetched_at": root.get("fetched_at") or kline.get("fetched_at") or root.get("as_of"),
        "data_quality": {
            "status": "warning" if warnings else "ok",
            "input_rows": len(rows),
            "output_rows": len(points),
            "warnings": warnings,
        },
    }


def read_json(source: str) -> Any:
    text = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
    return json.loads(text)


def emit(value: JsonRecord, output_path: str | None) -> None:
    payload = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    if output_path:
        output = Path(output_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(payload, encoding="utf-8")
    else:
        sys.stdout.write(payload)


def positive_integer(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("必须是正整数。")
    return parsed


def main() -> int:
    parser = argparse.ArgumentParser(description="从 QuantPilot 本地 bars 计算标准技术指标。")
    parser.add_argument("input", nargs="?", default="-", help="JSON 文件；传 - 或省略时读取 stdin。")
    parser.add_argument("--period", help="覆盖输入 period，例如 daily/weekly/monthly。")
    parser.add_argument("--adjustment", choices=("none", "qfq", "hfq"), help="覆盖输入复权口径。")
    parser.add_argument("--annualization", type=positive_integer, help="年化因子；日线默认 252。")
    parser.add_argument("--windows", type=parse_windows, default=parse_windows("5,10,20,60"), help="MA 窗口，逗号分隔。")
    parser.add_argument("-o", "--output", help="可选输出文件；默认输出到 stdout。")
    args = parser.parse_args()
    try:
        emit(compute(read_json(args.input), args.windows, args.period, args.adjustment, args.annualization), args.output)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        print(f"compute_technical_indicators: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
