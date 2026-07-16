# 行情数据契约

## 事实优先级

1. `quant-data-registry` 的覆盖信息决定是否已有本地数据。
2. `/api/v1/research/bars/{symbol}` 返回的本地标准化 bars 是历史研究事实源。
3. `/api/v1/quotes/realtime/{symbol}` 只回答最新快照。
4. ingestion/provider 响应只证明补数动作发生；补数后必须回读本地 bars。

外部源不可覆盖已有本地历史事实而不留下来源与原因。进行可复现分析时，至少保存 `provider/source`、`fetched_at`、样本首尾时间和记录数。

## Skills 聚合取数合同

单标的需要多类数据时使用 `GET /api/v1/analysis/context/{symbol}`。`include` 是逗号分隔的最小区块集合，可选 `quote`、`history`、`technical`、`financials`、`fundamental`、`announcements`。

- `schema_version=1` 是当前合同版本。
- 顶层 `status=ready` 表示所有请求区块可直接使用；`partial` 表示至少一个区块成功但存在缺失或质量警告；`unavailable` 表示所有请求区块失败。
- `sections.<name>.status`、`duration_ms`、`data_quality` 和 `error` 必须随原始数据一起保存。
- `error.retryable=true` 表示上游或依赖暂时不可用，可以重试；参数错误不可重试。
- `technical` 复用 `history`，`fundamental` 复用 `financials`。依赖失败时派生区块返回 `DEPENDENCY_UNAVAILABLE`，不得自行生成替代数据。
- `partial` 不是整次失败。Skills 可以继续使用成功区块，但结论不得覆盖失败区块所需的分析范围。

## 标准 bars 对象

验证器接受以下最小结构：

```json
{
  "symbol": "600519.SH",
  "timeframe": "daily",
  "adjustment": "qfq",
  "source": "quant.stock_bars",
  "bars": [
    {
      "ts": "2026-07-13",
      "open": 1400.0,
      "high": 1420.0,
      "low": 1390.0,
      "close": 1410.0,
      "volume": 100000,
      "amount": 141000000
    }
  ],
  "summary": {
    "first_ts": "2026-07-13",
    "last_ts": "2026-07-13",
    "row_count": 1
  }
}
```

`date`、`datetime` 或 `timestamp` 可代替 bar 的 `ts`。数值字符串可被解析，但新生成数据应优先写 JSON number。布尔值不是合法数值。

## 必须满足的不变量

- `symbol` 非空，`bars` 非空，bars 时间严格递增且不重复。
- 每根 bar 均有时间、`open/high/low/close`；OHLC 必须有限且非负。
- `high >= max(open, close, low)` 且 `low <= min(open, close, high)`。
- 若存在 `volume`、`amount`、`turnover`，值必须有限且非负。
- 若存在 `summary`，`row_count` 必须等于 bars 长度，首尾时间必须与序列一致。
- `source` 或 `provider` 至少存在一个；缺失时可读取数据但不能声称数据血缘完整。

## 时间和字段语义

- `quote_time/as_of` 是市场事实时间；`fetched_at` 是系统抓取时间，二者不可混用。
- 日/周/月 bars 的复权口径必须显式记录为 `none/qfq/hfq`。
- `volume`、`amount`、`turnover`、`amplitude` 是不同字段，不得互相推导为“真实原值”。
- 指数的 volume/amount 可能与 ETF 口径不同；跨资产比较前必须标准化单位并披露限制。

## 补数决策

只有满足以下条件才补数：本地覆盖缺目标标的、目标时间范围不足，或任务所需字段真实缺失。补数请求前记录 `symbols`、缺失区间、缺失字段和选择提供方的原因。失败不得生成占位 bars。

## 校验结果语义

`scripts/validate_market_bars.py` 输出：

- `ok: true`：结构和基础数值不变量通过，可以进入计算。
- `errors[]`：阻断项，脚本退出码为 1。
- `warnings[]`：不阻断但必须进入数据质量说明，例如缺少来源或覆盖摘要。
- 输入不可读或不是 JSON 时退出码为 2，stdout 仍为 JSON。
