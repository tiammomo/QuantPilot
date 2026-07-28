# 证券标识解析契约

在解析结果包含多个市场/资产类型、需要判断是否追问或需要核对响应字段时读取本参考。明确的六位代码不必加载。

## API 输入

必须使用 URL 编码传递名称：

```bash
curl -G 'http://127.0.0.1:8000/api/v1/symbols/resolve' \
  --data-urlencode 'query=中信证券' \
  --data-urlencode 'count=5'
```

不要将中文直接拼接到 URL，也不要把名称直接传给行情端点。

## 候选最小字段

| 字段 | 含义 |
| --- | --- |
| `query` | 原始解析词 |
| `symbol` | 标准证券代码，例如 `600519` |
| `name` | 标准名称；允许为 `null` |
| `asset_type` | `stock`、`index`、`etf`、`fund` 等 |
| `market` | `SH`、`SZ`、`BJ`、`HK`、`US` 或 `UNKNOWN` |
| `secid` | provider 使用的证券 ID，例如 `1.600519` |
| `source` | 解析结果来源 |
| `raw` | 仅供诊断的原始响应；不要传入后续页面 |

## 确定性选择规则

按以下优先级选择，而不是总取第一条：

1. 代码或规范化名称精确匹配。
2. 名称前缀匹配。
3. 包含匹配。
4. 同等匹配下优先 `stock`，然后 `index`、`etf`、`fund`。
5. 同为股票时优先 A 股市场 `SH`/`SZ`/`BJ`，然后才是其他市场。

若唯一精确 A 股候选与港股、债券或基金候选同时出现，直接采用 A 股。例如“中信证券”应优先 `600030` / `SH`。如果最高优先级仍有两个候选，则返回候选并追问，不得猜测。

`scripts/rank_candidates.py` 接受原始 API 的 `results`，也接受同结构的 `candidates`：

```json
{
  "query": "中信证券",
  "results": [
    {
      "symbol": "600030",
      "name": "中信证券",
      "asset_type": "stock",
      "market": "SH",
      "secid": "1.600030",
      "source": "eastmoney"
    }
  ]
}
```

脚本返回 `resolved`、`ambiguous` 或 `no_match`。只有 `resolved` 的 `selected` 可进入后续取数。

## 后续契约

把以下字段保留在最终数据或证据中：

```json
{
  "original_query": "茅台",
  "symbol": "600519",
  "name": "贵州茅台",
  "asset_type": "stock",
  "market": "SH",
  "secid": "1.600519",
  "source": "eastmoney",
  "status": "resolved"
}
```

后续数据接口使用 `symbol` 或明确需要的 `secid`。不要使用原始中文查询词。

## 失败模式

| 现象 | 处理 |
| --- | --- |
| `results=[]` | 标记 `no_match`，请用户给更多上下文或代码 |
| 多个同优先级 A 股 | 标记 `ambiguous` 并展示名称、代码、市场 |
| 只有名称、无 `secid` | 可保留候选，但调用需要 `secid` 的端点前重新解析 |
| 代码与名称相互冲突 | 不自动覆盖用户代码；展示冲突并确认 |
| provider 超时 | 标记解析失败，不把本地别名推断冒充 API 结果 |
| 名称含“股份”“证券”“公司” | 将其视为名称组成，不视为泛词 |
