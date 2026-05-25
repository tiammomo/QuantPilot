#!/usr/bin/env python3
"""QuantPilot intent clarification helper.

The script is intentionally lightweight and deterministic. It only classifies
whether a question lacks execution-critical slots; it does not fetch data or
write project files.
"""

from __future__ import annotations

import argparse
import json
import re
from typing import Any


SYMBOL_CODE_PATTERN = re.compile(r"\b(?:6|0|3|5)\d{5}\b")
KNOWN_SYMBOL_KEYWORDS = [
    ("贵州茅台", "600519"),
    ("茅台", "600519"),
    ("宁德时代", "300750"),
    ("平安银行", "000001"),
    ("招商银行", "600036"),
    ("通富微电", "002156"),
    ("沪深300", "000300"),
    ("沪深 300", "000300"),
    ("创业板指", "399006"),
    ("创业板指数", "399006"),
    ("中证500", "000905"),
    ("中证 500", "000905"),
    ("科创50", "000688"),
    ("科创 50", "000688"),
    ("沪深300ETF", "510300"),
    ("沪深300 ETF", "510300"),
    ("300ETF", "510300"),
]
FINANCIAL_KEYWORDS = re.compile(
    r"股票|个股|A股|港股|美股|证券|标的|行情|走势|K\s*线|技术指标|财务|基本面|公告|指数|ETF|基金|量化|回测|策略|风控|风险|仓位|涨跌|价格|大盘|板块|行业|买入|卖出|持有|推荐|估值",
    re.I,
)
GOAL_KEYWORDS = re.compile(
    r"行情|走势|K\s*线|技术|财务|基本面|公告|回测|策略|风险|估值|对比|比较|诊断|看板|可视化|价格|成交量|指标|收益|回撤|波动|分析|怎么样|如何|怎么",
    re.I,
)
BROAD_MARKET_TARGET = re.compile(r"大盘|全市场|A股|港股|美股|沪深|创业板|科创|中证|指数|ETF|基金|行业|板块|市场", re.I)
COMPARISON = re.compile(r"对比|比较|相比|相对|哪个|哪只|谁更|强弱|VS|vs|versus", re.I)
RECOMMENDATION = re.compile(r"推荐|买什么|买入|卖出|持有|能不能买|能买吗|值得买吗|可以买|要不要", re.I)
INVESTMENT_CONSTRAINT = re.compile(
    r"短线|中线|长线|日内|波段|价值|成长|稳健|激进|保守|风险|回撤|仓位|周期|一周|一个月|三个月|半年|一年|预算|资金|偏好|低风险|高风险|A股|港股|美股|ETF|指数",
    re.I,
)

GENERIC_WORDS = {
    "一个",
    "一下",
    "这个",
    "那个",
    "某个",
    "股票",
    "个股",
    "标的",
    "证券",
    "公司",
    "资产",
    "行业",
    "板块",
    "市场",
    "项目",
    "推荐",
    "买入",
    "卖出",
    "补充",
    "哪个",
    "哪只",
    "谁更",
    "更好",
    "更强",
    "更弱",
    "对比",
    "比较",
    "分析",
    "查询",
    "查看",
    "看看",
    "看一下",
    "帮我",
    "帮忙",
    "可视化",
    "看板",
    "页面",
    "生成",
}


def clean_candidate(value: str) -> str | None:
    candidate = re.sub(r"\s+", "", value)
    candidate = re.sub(r"^(请|麻烦|帮我|帮忙|补充|信息|分析|查询|查看|看看|看一下|研究|诊断|评估|生成|做一个|做下|比较|对比|一下)+", "", candidate)
    candidate = re.sub(
        r"(股票|个股|股份|公司)?(最近|近期|近|今天|这段时间|的|行情|走势|K线|K线图|成交量|技术指标|技术|指标|财务|基本面|公告|怎么样|如何|怎么|可视化|看板|页面).*$",
        "",
        candidate,
    )
    candidate = re.sub(r"^(?:A股|港股|美股)", "", candidate).strip()
    if candidate.endswith("板块"):
        candidate = candidate[:-2]
    if len(candidate) < 2 or len(candidate) > 12:
        return None
    if any(word == candidate or word in candidate for word in GENERIC_WORDS):
        return None
    return candidate


def target_candidates(question: str) -> list[str]:
    normalized = SYMBOL_CODE_PATTERN.sub(" ", question.strip())
    parts = re.split(r"[，。！？?；;、,：:\n\r]|(?:和)|(?:与)|(?:及)|(?:以及)|(?:VS)|(?:vs)|(?:对比)|(?:比较)", normalized)
    lookahead = re.findall(
        r"[\u4e00-\u9fffA-Za-z]{2,14}(?=(?:最近|近期|近|今天|股票|个股|股份|行情|走势|K\s*线|成交量|技术指标|财务|基本面|公告|怎么样|如何|怎么))",
        normalized,
    )
    result: list[str] = []
    for raw in [*parts, *lookahead]:
        candidate = clean_candidate(raw)
        if candidate and candidate not in result:
            result.append(candidate)
    return result[:8]


def build_questions(missing: list[str], is_recommendation: bool, is_comparison: bool) -> list[str]:
    questions: list[str] = []
    if "target" in missing:
        questions.append("你想分析哪个股票、指数或 ETF？请给名称或代码。")
    if "comparison_universe" in missing:
        questions.append("你要对比哪些标的？请给至少两个名称或代码。")
    if "investment_constraints" in missing:
        questions.append(
            "这是投资建议类问题，请补充投资周期、风险偏好和市场范围；我会基于数据做分析，不直接给确定性买卖结论。"
            if is_recommendation
            else "请补充投资周期、风险偏好或约束条件，方便后续做风险口径一致的分析。"
        )
    if "analysis_goal" in missing:
        questions.append(
            "你更希望比较行情趋势、基本面、估值、风险，还是综合评分？"
            if is_comparison
            else "你更关注行情技术、基本面、公告事件、回测，还是综合诊断？"
        )
    return questions[:3]


def assess(question: str, capability: str | None = None) -> dict[str, Any]:
    text = " ".join(question.split())
    if not text or not (FINANCIAL_KEYWORDS.search(text) or capability):
        return {
            "required": False,
            "reason": "当前请求不是需要平台量化取数的金融分析任务。",
            "missing": [],
            "questions": [],
            "confidence": 0.9,
        }

    codes = SYMBOL_CODE_PATTERN.findall(text)
    known = list({symbol for keyword, symbol in KNOWN_SYMBOL_KEYWORDS if keyword in text})
    candidates = target_candidates(text)
    has_broad_market_target = bool(BROAD_MARKET_TARGET.search(text))
    target_count = max(len(set([*codes, *known])), len(candidates))
    has_target = target_count > 0 or has_broad_market_target
    is_comparison = bool(COMPARISON.search(text)) or capability == "asset_comparison"
    is_recommendation = bool(RECOMMENDATION.search(text))
    has_goal = bool(GOAL_KEYWORDS.search(text))
    has_constraints = bool(INVESTMENT_CONSTRAINT.search(text))
    missing: list[str] = []

    if not has_target and (len(text) <= 18 or is_recommendation or has_goal):
        missing.append("target")
    if is_comparison and target_count < 2:
        missing.append("comparison_universe")
    if is_recommendation and not has_constraints:
        missing.append("investment_constraints")
    if has_target and not has_goal and not is_recommendation:
        missing.append("analysis_goal")

    unique_missing = list(dict.fromkeys(missing))
    required = len(unique_missing) > 0
    return {
        "required": required,
        "reason": f"任务缺少关键输入：{', '.join(unique_missing)}。" if required else "任务意图足够明确，可进入取数、证据和看板生成流程。",
        "missing": unique_missing,
        "questions": build_questions(unique_missing, is_recommendation, is_comparison),
        "confidence": 0.82 if required else 0.86,
        "target_candidates": candidates,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Assess whether a QuantPilot task needs clarification.")
    parser.add_argument("--question", required=True, help="User question or task instruction.")
    parser.add_argument("--capability", default=None, help="Optional QuantPilot capability id.")
    args = parser.parse_args()
    print(json.dumps(assess(args.question, args.capability), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
