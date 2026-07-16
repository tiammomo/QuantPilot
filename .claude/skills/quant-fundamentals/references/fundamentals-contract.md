# 基本面统一合同与失败模式

## 数据身份

- 每个结果绑定标准 `symbol`；多标的结果按 `assets[]` 分隔，禁止跨资产补字段。
- 保存 `source`、`fetched_at`/`as_of`、`report_date` 和 `notice_date`。`report_date` 表示会计期间结束，`notice_date` 表示市场可获知时间。
- 结论只能使用分析时点已披露的数据；做历史归因或回测时不得使用未来公告。

## Final data 形状

```json
{
  "financials": {"reports": [], "source": "...", "fetched_at": "..."},
  "fundamentalIndicators": {"points": [], "summary": {}, "data_quality": {}},
  "announcements": {"announcements": [], "source": "...", "fetched_at": "..."},
  "valuation": {"method": "pe_eps_scenario", "assets": [], "data_quality": {}}
}
```

不得用 `valuation` 反向填充 quote 或 financials。估值的 `base_metrics` 属于输入事实，`assumptions` 属于情景，`implied_price` 属于算术结果。

## 跨期与跨表对齐

1. 按 `report_date` 对齐财务和衍生指标；按 `notice_date` 对齐公告与市场反应。
2. 先确认 `data_type` 是累计、单季还是年度，再比较增长；未知时只展示原值。
3. 金额比率只在分子分母同币种、同量纲、同期间时计算。
4. 百分比统一存 percentage points，例如 `12.5` 表示 `12.5%`，不是 `0.125`；若上游口径未知则标 warning，不猜测。
5. 重述报告保留最新版本并记录重述事实，不把两个版本当两个期间。

## 估值门槛

- 只有 `price > 0`、`eps > 0`、`pe > 0` 时生成 PE/EPS implied price。
- 亏损、零 EPS 或负 PE 时不套用 PE 倍数；返回空 scenarios 并说明需使用其他方法。
- 不把当前 PE、目标 PE 或 EPS 增长假设描述为市场共识，除非有独立来源。

## 事件证据

- 标题只能支持“存在某主题公告”，不能支持金额、完成状态、影响方向或因果。
- 需要金额、比例、期限、条件、交易对手或监管结论时读取正文/PDF。
- “公告后上涨/下跌”只是时间邻近；至少同时检查市场、行业和既有趋势。

## 失败模式

| 情况 | 处理 |
| --- | --- |
| symbol 与 run plan 不一致 | error，停止合并 |
| 无 report_date 或来源 | warning；不做跨期结论 |
| 单季与累计口径混合 | error；分组后再比较 |
| 分母为零/负值 | 指标置 null 并解释 |
| 公告只有标题 | 标记 `needs_full_text=true` |
| 估值输入不足或亏损 | 空 scenarios，不补造 |
| 数据时间晚于分析时点 | error，排除未来信息 |
