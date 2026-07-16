# 技术与风险指标方法合同

## Bars 前置合同

- 使用同一 `symbol`、`period`、`adjustment`、交易日历和时区。
- 先按可比较时间键升序排列；重复时间键必须失败或显式去重，不能静默双计。
- close 必须为有限正数。volume/amount 缺失只影响量能指标，不应伪造成零成交。
- 多标的比较不能混用 `none`、`qfq`、`hfq`。

## 收益、波动与回撤

- 展示收益用简单收益：`(P_t / P_0 - 1) × 100`。
- 相关性使用对数收益：`ln(P_t / P_{t-1})`，再按日期内连接。
- 年化波动率使用有效日收益的样本标准差（`n-1`）乘 `sqrt(annualization)`；日线默认 252。样本少于 2 时为 null。
- 最大回撤使用运行峰值：`min(P_t / max(P_0..P_t) - 1) × 100`，结果不大于零。
- MA/均量只有达到完整窗口后才输出，不能用不足窗口的均值冒充 MA20/MA60。

## 相关性

- 每对标的只使用共同收益日期，输出 `overlap`。
- 少于 3 个共同收益点时 Pearson 为 null；实际解释建议至少 20 个。
- 常数序列方差为零时相关性为 null。
- 相关性不是稳定因果或未来风险保证；需报告样本窗口。

## 流动性

- `avg_amount_20d` 和 `avg_volume_20d` 分开，金额单位必须来自上游。
- Amihud proxy：`mean(abs(return_t) / amount_t)`；只有 amount 为正时纳入。
- `turnover_proxy_pct = amount / float_market_cap × 100` 只是代理，不等同交易所换手率。
- 流动性阈值只有金额单位确认一致时才可用于等级；否则输出 unknown。

## Trend template

trend score 是确定性检查表，不是买卖信号。必须同时输出输入指标、reasons、triggers、sample_size 和 warnings；样本不足 60 根时不得称为稳定中期趋势。

## 失败模式

| 情况 | 处理 |
| --- | --- |
| 周期/复权混合 | error |
| bars 逆序或重复 | 先规范化；重复无法裁决则 error |
| 无正 close | error |
| 相关性 overlap 不足 | null + warning |
| amount 单位未知 | 不做绝对阈值评级 |
| 样本不足窗口 | 指标 null + warning |
