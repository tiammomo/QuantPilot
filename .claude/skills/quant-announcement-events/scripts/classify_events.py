#!/usr/bin/env python3
"""Deduplicate and classify announcement metadata without inferring sentiment."""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any


JsonRecord = dict[str, Any]

TAXONOMY: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("earnings", ("业绩预告", "业绩快报", "年度报告", "半年度报告", "季度报告", "年报", "季报")),
    ("dividend", ("利润分配", "分红", "派息", "现金红利", "送转")),
    ("repurchase", ("回购",)),
    ("holding_change", ("增持", "减持", "解禁", "持股变动")),
    ("restructuring", ("重大资产", "重组", "并购", "收购", "资产出售")),
    ("litigation_regulatory", ("诉讼", "仲裁", "处罚", "立案", "问询", "监管", "警示函")),
    ("suspension", ("停牌", "复牌")),
    ("financing", ("定向增发", "定增", "配股", "可转债", "担保", "质押", "融资")),
    ("governance", ("董事", "监事", "高管", "股东大会", "章程", "人事变动")),
)


def as_record(value: Any) -> JsonRecord | None:
    return value if isinstance(value, dict) else None


def extract_rows(value: Any) -> tuple[list[JsonRecord], JsonRecord]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)], {}
    root = as_record(value)
    if root is None:
        raise ValueError("输入 JSON 根必须是对象或公告数组。")
    nested = as_record(root.get("announcements"))
    for candidate in (
        nested.get("announcements") if nested else None,
        nested.get("data") if nested else None,
        root.get("announcements"),
        root.get("events"),
        root.get("data"),
        root.get("items"),
    ):
        if isinstance(candidate, list):
            return [item for item in candidate if isinstance(item, dict)], root
    raise ValueError("输入中没有可识别的 announcements/events/data 数组。")


def first_value(record: JsonRecord, *keys: str) -> Any:
    for key in keys:
        if key in record and record[key] not in (None, ""):
            return record[key]
    return None


def normalize_text(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    return re.sub(r"\s+", " ", text).strip()


def classify(title: str) -> list[str]:
    labels = [label for label, keywords in TAXONOMY if any(keyword in title for keyword in keywords)]
    return labels or ["other"]


def normalize_event(row: JsonRecord, index: int, root: JsonRecord) -> tuple[JsonRecord | None, list[str]]:
    title = normalize_text(first_value(row, "title", "notice_title", "announcement_title"))
    if not title:
        return None, [f"第 {index + 1} 条公告缺少 title，已排除。"]
    notice_date_value = first_value(row, "notice_date", "display_time", "publish_time", "date")
    notice_date = normalize_text(notice_date_value) or None
    url = normalize_text(first_value(row, "url", "announcement_url", "link")) or None
    pdf_url = normalize_text(first_value(row, "pdf_url", "pdf", "attachment_url")) or None
    announcement_id = normalize_text(first_value(row, "id", "announcement_id", "notice_id")) or None
    body = normalize_text(first_value(row, "body", "content", "full_text"))
    warnings: list[str] = []
    if notice_date is None:
        warnings.append(f"公告“{title}”缺少披露时间。")
    if url is None and pdf_url is None:
        warnings.append(f"公告“{title}”没有可下钻链接。")
    return {
        "announcement_id": announcement_id,
        "title": title,
        "notice_date": notice_date,
        "display_time": normalize_text(row.get("display_time")) or None,
        "taxonomy": classify(title),
        "evidence_level": "full_text" if body else "title_metadata",
        "needs_full_text": not bool(body),
        "url": url,
        "pdf_url": pdf_url,
        "source": row.get("source") or root.get("source"),
        "causal_claim_permitted": False,
    }, warnings


def dedupe_key(event: JsonRecord) -> str:
    if event.get("announcement_id"):
        return f"id:{event['announcement_id']}"
    if event.get("url"):
        return f"url:{str(event['url']).rstrip('/').lower()}"
    if event.get("pdf_url"):
        return f"pdf:{str(event['pdf_url']).rstrip('/').lower()}"
    return f"title-date:{event.get('notice_date') or ''}:{normalize_text(event.get('title')).lower()}"


def build_events(value: Any) -> JsonRecord:
    rows, root = extract_rows(value)
    if not rows:
        raise ValueError("公告数组为空。")
    warnings: list[str] = []
    normalized: list[JsonRecord] = []
    for index, row in enumerate(rows):
        event, event_warnings = normalize_event(row, index, root)
        warnings.extend(event_warnings)
        if event:
            normalized.append(event)
    if not normalized:
        raise ValueError("没有包含 title 的有效公告。")

    normalized.sort(
        key=lambda event: (
            str(event.get("notice_date") or ""),
            str(event.get("announcement_id") or ""),
            str(event.get("title") or ""),
        ),
        reverse=True,
    )
    events: list[JsonRecord] = []
    seen: set[str] = set()
    for event in normalized:
        key = dedupe_key(event)
        if key in seen:
            warnings.append(f"发现重复公告并去重：{event['title']}")
            continue
        seen.add(key)
        events.append(event)

    taxonomy_counts: dict[str, int] = {}
    for event in events:
        for label in event["taxonomy"]:
            taxonomy_counts[label] = taxonomy_counts.get(label, 0) + 1
    return {
        "schema_version": 1,
        "symbol": root.get("symbol"),
        "events": events,
        "taxonomy_counts": dict(sorted(taxonomy_counts.items())),
        "source": root.get("source"),
        "fetched_at": root.get("fetched_at") or root.get("as_of"),
        "data_quality": {
            "status": "warning" if warnings else "ok",
            "input_rows": len(rows),
            "output_rows": len(events),
            "warnings": warnings,
        },
        "interpretation_guardrail": "taxonomy is not sentiment or proof of price causality",
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


def main() -> int:
    parser = argparse.ArgumentParser(description="去重并分类 QuantPilot A 股公告元数据。")
    parser.add_argument("input", nargs="?", default="-", help="JSON 文件；传 - 或省略时读取 stdin。")
    parser.add_argument("-o", "--output", help="可选输出文件；默认输出到 stdout。")
    args = parser.parse_args()
    try:
        emit(build_events(read_json(args.input)), args.output)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        print(f"classify_events: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
