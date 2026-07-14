---
name: quant-symbol-resolver
description: Use this skill when the user mentions a stock name, abbreviation, ticker, or ambiguous security identifier that must be resolved before data retrieval.
---

# QuantPilot 证券标识解析能力

把用户输入的股票名称、简称、拼音或代码解析成标准证券代码和东方财富 `secid`。

## API

```bash
curl -G 'http://127.0.0.1:8000/api/v1/symbols/resolve' \
  --data-urlencode 'query=茅台' \
  --data-urlencode 'count=5'
curl -G 'http://127.0.0.1:8000/api/v1/symbols/resolve' \
  --data-urlencode 'query=600519' \
  --data-urlencode 'count=5'
```

## 工作流程

1. 用户没有给出明确 6 位代码时，先调用本能力。
2. 先比较规范化后的名称，再按 A 股、指数 / ETF、港股、债券的顺序选择，并记录 `symbol`、`name`、`market`、`secid`。
3. 若有且只有一个同名 A 股，即使同时返回港股或债券候选，也直接选择该 A 股继续；例如“中信证券”优先解析为 `600030` / `SH` / `1.600030`。
4. 只有多个同优先级证券都可能是用户目标时，才展示候选并追问；不得仅因为用户没给代码就中止。
5. 后续行情、K 线、财务、公告查询使用解析后的 `symbol` 或 `secid`。
6. `query` 包含中文时必须使用 `curl -G --data-urlencode`，不要把中文直接拼进 URL。

## 禁止事项

- 不要把中文股票名直接传给行情接口。
- 不要把中文查询词直接拼接到 URL 查询串。
- 不要把“中信证券”“杭钢股份”这类名称因为包含“证券”“股份”等词而判定为泛词。
- 不要在存在多个同优先级候选时假定唯一结果。
