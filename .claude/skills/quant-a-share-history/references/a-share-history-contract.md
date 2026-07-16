# A 股历史序列契约

## 适用范围

该契约用于沪深 A 股日、周、月和分钟 K 线进入收益、回撤、波动、筛选、回测或可视化之前的核验。它不适用于单点实时 quote。

## 最小输入

```json
{
  "symbol": "000001.SZ",
  "timeframe": "daily",
  "adjustment": "qfq",
  "source": "quant.stock_bars",
  "bars": [
    {
      "trade_date": "2026-07-13",
      "open": 12.1,
      "high": 12.5,
      "low": 12.0,
      "close": 12.4,
      "volume": 10000
    }
  ],
  "summary": {
    "first_ts": "2026-07-13",
    "last_ts": "2026-07-13",
    "row_count": 1
  }
}
```

## 代码与口径

- 规范代码使用六位数字加 `.SH` 或 `.SZ`；接收小写后缀但输出应规范化为大写。
- `timeframe` 可为 `daily/weekly/monthly/minute1/minute5/minute15/minute30/minute60`。
- `adjustment` 只能为 `none/qfq/hfq`。默认分析口径为 `qfq`，但不得默默覆盖输入口径。
- 日线 `trade_date/ts/date` 应为 ISO 日期；分钟线可使用带时区或明确市场时区的 ISO datetime。

## 序列不变量

- bars 必须按时间严格递增，不能重复交易时间。
- OHLC 均有限且非负，并满足最高/最低价包络。
- 成交量、成交额、换手率存在时不得为负。
- `trade_status` 表示停牌时，零成交量可以成立；不得擅自删除停牌记录并宣称交易日完整。
- `summary.row_count/first_ts/last_ts` 存在时必须与 bars 一致。

## 样本选择

- 指标窗口为 `N` 时，至少需要 `N` 根有效 bars；长期结论应额外保留热身样本。
- 周线/月线优先由同口径本地日线聚合；不得混用不同复权口径拼接序列。
- 开始/结束日期是过滤边界，不代表期间每个自然日都应有记录。交易日缺口需结合交易日历、停牌状态判断。

## 提供方限制

- 东方财富历史 K 线可作为补数入口；Baostock 用于 A 股字段补足；AKShare 用于聚合接口验证。
- 腾讯兜底 OHLCV 不能证明 `amount` 或 `turnover` 真实存在。
- 任何补数完成后都要回读 `/api/v1/research/bars/{symbol}` 并以回读结果为分析输入。

## 校验与失败

运行 `scripts/validate_a_share_history.py`。结构错误、代码/周期/复权非法、时间重复、OHLC 不一致或摘要冲突均为阻断错误，退出码 1。来源、摘要或可选流动性字段缺失只形成 warning，必须进入最终数据质量说明。
