---
name: quant-symbol-resolver
description: Use this skill when the user mentions a stock name, abbreviation, ticker, or ambiguous security identifier that must be resolved before data retrieval.
---

# QuantPilot 证券标识解析能力

把用户输入的股票名称、简称、拼音或代码解析成标准证券代码和东方财富 `secid`。

## 资源与候选裁决

解析返回多个市场或资产类型、或需要决定是否追问时，读取 [symbol-resolution-contract.md](references/symbol-resolution-contract.md)。其中定义候选字段、选择优先级和失败模式。

把 API 响应中的 `query` 与 `results` 交给确定性脚本，避免简单取第一条：

```bash
python .claude/skills/quant-symbol-resolver/scripts/rank_candidates.py \
  --input '{"query":"中信证券","results":[{"symbol":"600030","name":"中信证券","asset_type":"stock","market":"SH","secid":"1.600030","source":"eastmoney"}]}'
```

`--input` 支持 JSON 对象、文件路径或 `-`（stdin）。脚本只向 stdout 输出 JSON，不联网、不写文件；无效输入非零退出。只有 `status=resolved` 时才使用 `selected`，`ambiguous` 必须展示 `clarification_candidates` 并追问。

## Workspace 回答协作

- 继承平台统一的五阶段进度；不自行重启阶段、重复进度标题、重复问题识别表或维护 Todo。
- 只提供本 skill 已确认的可验证事实、真实缺口和下一步，不输出隐藏推理、完整工具参数或占位式 “Skill executing...”。
- 本 skill 只贡献原始标识、标准代码、名称、市场、资产类型、候选歧义和解析状态；阶段编号与展示由平台统一维护。

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
