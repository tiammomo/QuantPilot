# 指数与 ETF 行情契约

## 资产识别

输入必须显式带 `asset_type: index|etf`。代码只能作为解析线索，不能单独证明资产类型；以 symbol resolver 和行情响应的资产元数据为准。

常见例子：

| 名称 | 检索代码 | 规范示例 | 资产类型 |
| --- | --- | --- | --- |
| 沪深 300 | 000300 | 000300.SH | index |
| 创业板指 | 399006 | 399006.SZ | index |
| 中证 500 | 000905 | 000905.SH | index |
| 科创 50 | 000688 | 000688.SH | index |
| 沪深 300 ETF | 510300 | 510300.SH | etf |

## 规范证据对象

实时任务的最小结构：

```json
{
  "symbol": "000300.SH",
  "name": "沪深300",
  "asset_type": "index",
  "source": "eastmoney",
  "as_of": "2026-07-15T15:00:00+08:00",
  "fetched_at": "2026-07-15T15:00:02+08:00",
  "quote": {"price": 4012.3, "change_percent": 0.4}
}
```

历史任务可不含 `quote`，但必须含非空 `bars`；每根 bar 使用 `ts/date/trade_date/timestamp` 之一和 OHLC。若同时含 quote 与 bars，两者可以有不同事实时间，但必须分别记录。

## 不变量

- `symbol`、`asset_type`、`source/provider`、`as_of/quote_time` 或历史覆盖时间必须可确认。
- `asset_type` 不得为 `stock`，指数不得伪装成 ETF，ETF 不得继承指数点位的单位描述。
- quote 的 `price` 必须有限且非负；`change_percent` 存在时必须有限。
- bars 必须按时间严格递增，OHLC 满足最高/最低价包络。
- 数据对象至少包含有效 quote 或有效 bars，不能只有名称和说明文字。

## 资产特有边界

- 指数不走个股财务、公告和总市值解释链路。
- ETF 可以分析成交量、成交额和流动性；净值、溢价率只有响应真实提供时才使用。
- 指数与 ETF 的成交字段口径可能不同，跨类型比较时必须标记单位与提供方定义。
- `as_of` 是市场事实时点，`fetched_at` 是抓取时点；实时性判断应同时使用二者。

## 下游交付

保留 symbol、name、asset_type、source、时间、quote/bars 与质量提示。历史指标必须由同一资产、同一周期、同一复权序列计算。调用 `scripts/validate_index_etf_market.py` 后，只有 `ok: true` 的对象才能进入对比或看板。
