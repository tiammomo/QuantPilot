# 技术指标计算合同

## 输入

接受根级 `bars`、`kline.bars`、`history.bars`、API `data`，或直接 bar 数组。每根 bar 至少需要可比较的 `date`/`trade_date`/`time` 与有限正 `close`。

元数据必须保留：

- `symbol`；
- `period`：daily/weekly/monthly/minute*；
- `adjustment`：none/qfq/hfq；
- `source` 与 `fetched_at`（若上游提供）。

## 规范化

1. 将时间键转为字符串并升序排列。
2. 重复时间键视为歧义并失败；不要静默选择某条。
3. close 非正或非有限的 bar 排除并 warning；如果没有有效 bar 则失败。
4. volume 缺失保留 null；不要用零填充。
5. 不对复权类型做自动转换；输出中回显调用口径。

## 公式

- `return_pct_t = (close_t / close_{t-1} - 1) × 100`。
- `drawdown_pct_t = (close_t / running_peak_t - 1) × 100`。
- `MA_n` 为最近完整 n 个有效 close 的算术平均；样本不足为 null。
- 区间收益：首尾有效 close 的简单收益。
- 最大回撤：所有逐期 drawdown 的最小值。
- 年化波动：逐期对数收益的样本标准差乘 `sqrt(annualization) × 100`；日线默认 252，其他周期必须显式指定合理 annualization。
- 20 期均量仅使用存在且非负的 volume；不足 20 个有效 volume 时为 null。

## 输出

`points` 保存 date、close、volume、return_pct、drawdown_pct 与各 MA；`summary` 保存 sample_size、latest_close、period_return_pct、max_drawdown_pct、volatility_annualized_pct、avg_volume20 和 latest moving averages。所有百分数为 percentage points。

## 质量门

| 情况 | 处理 |
| --- | --- |
| JSON 或根结构无效 | 非零退出 |
| 无时间键/有效 close | 排除；最终为空则非零退出 |
| 重复时间键 | 非零退出 |
| 样本少于最大 MA 窗口 | warning，对应 MA 为 null |
| 收益样本少于 2 | 波动为 null + warning |
| adjustment 未知 | warning，不猜复权 |
