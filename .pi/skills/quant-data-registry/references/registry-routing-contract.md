# 数据注册表与本地优先路由契约

在选择数据端点、判断本地覆盖是否足够或设计 provider 降级链时读取本参考。只需要调用单个已知端点时不必加载。

## 决策顺序

1. 调用 `/api/v1/registry`，确认当前运行实例实际暴露的能力。
2. 对股票池先调用 `/api/v1/research/universes/summary`；分页读取成员。
3. 对明确标的先调用 `/api/v1/research/bars/{symbol}` 判断历史覆盖。
4. 只有全池质量审计才调用 `/api/v1/research/data-coverage`。
5. 本地缺区间或关键字段时才调用外部 provider/ingestion。
6. 补数后重新读取本地库，最终分析以持久化数据为准。

## 端点责任

| 端点 | 用途 | 不应用于 |
| --- | --- | --- |
| `/api/v1/registry` | 能力与 provider 边界 | 返回业务数据 |
| `/api/v1/research/universes/summary` | 股票池规模、ready 数、bar 数、最新时间 | 返回全量成员 |
| `/api/v1/research/universes/{id}/members` | 分页读取成员 | 全池质量审计 |
| `/api/v1/research/bars/{symbol}` | 可复现本地 OHLCV 与增强字段 | 实时盘口 |
| `/api/v1/research/data-coverage` | 全池覆盖和质量审计 | 每轮普通问答前置调用 |
| `/api/v1/quotes/realtime/{symbol}` | 实时快照 | 替代历史样本 |
| `/api/v1/ingestion/baostock/history` | 东方财富不可达时补历史增强字段 | 直接作为最终事实源而不回读 |
| `/api/v1/ingestion/akshare/history` | 聚合接口补数与验证 | 假定底层 provider 一定可用 |

## 覆盖判定输入

`scripts/select_data_route.py` 接受：

```json
{
  "operation": "historical_bars",
  "symbol": "600519",
  "required_fields": ["amount", "turnover"],
  "local_coverage": {
    "available": true,
    "covers_range": true,
    "missing_fields": []
  },
  "provider_availability": {
    "eastmoney": true,
    "baostock": true
  }
}
```

只有 `available=true`、`covers_range=true` 且关键字段无缺口时，才能直接选择本地 bars。脚本不会联网或猜测 provider 状态，所有布尔值必须来自真实 API 证据。

## 必须保留的证据

每个最终使用的数据集至少记录：

- `source` 或 provider。
- 实际 endpoint。
- `artifact_path`。
- `fetched_at` 与数据本身的 `as_of`/`quote_time`。
- `summary.first_ts`、`summary.last_ts`、`summary.row_count`（适用于时间序列）。
- 缺失字段和降级警告。

## Provider 降级边界

- 东方财富历史 K 线可提供成交额、振幅、涨跌幅、涨跌额和换手率时优先使用。
- Baostock 可在东方财富不可达时补增强字段；补数成功后必须回读本地 bars。
- AKShare 可能仍依赖东方财富，调用成功与底层数据成功必须分开判断。
- 腾讯 K 线通常只有 OHLCV。它不能证明成交额、换手率等增强字段可用。
- 所有 provider 都不可用时，返回真实缺口并停止依赖这些数据的结论。

## 常见失败模式

| 失败 | 正确处理 |
| --- | --- |
| 注册表端点失败 | 不猜测能力；报告服务不可用 |
| 本地 bars 存在但区间不足 | 只补缺失区间，随后回读 |
| 全池接口数据过大 | 改用 summary + 分页 members |
| 补数返回 HTTP 200 但无行写入 | 视为失败，保留原缺口 |
| provider 缺少关键字段 | 降级状态写入 data quality，不用零值伪装 |
| 时间戳只有请求时间 | 不把 `fetched_at` 当成行情 `as_of` |
