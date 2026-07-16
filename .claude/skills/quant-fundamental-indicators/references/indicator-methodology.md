# 财务指标方法与质量门

## 指标定义

- 净利率：`parent_net_profit / revenue × 100`。仅当两者同期间、同币种、同量纲且 `revenue != 0` 时计算。
- 毛利率：优先使用披露或后端标准字段；缺少营业成本口径时不要自行推导。
- 加权 ROE：优先使用披露的 `weighted_roe`；没有平均净资产和期间利润时不要从期末净资产猜算。
- 营收/净利润同比：优先使用同口径上游字段；基期为零或符号跨零时，百分比增长可能无经济意义，保留 warning。

所有百分比输出为 percentage points。例如净利率 `0.123 × 100 = 12.3`。

## 汇总语义

- `latest_*` 取最新有效 `report_date` 的值，不从列表输入顺序推断。
- `avg_roe`、`avg_gross_margin`、`avg_net_margin` 是有效期间的简单算术平均；名称中不要写 weighted。
- summary 同时保存每个平均值的有效样本数。不同指标可有不同样本数。
- 亏损期的净利率可以为负；不要截断为零。收入为零时净利率为 null。

## 输入兼容

脚本可识别：

- 根级 `reports`；
- `financials.reports`；
- 根级 `points`；
- API `data` 列表；
- 直接报告数组。

报告期字段按 `report_date`、`period`、`date` 依次兼容。数值字符串可去逗号和末尾 `%`，但单位倍率不猜测。

## 失败与降级

| 情况 | 处理 |
| --- | --- |
| 无可识别报告 | error，非零退出 |
| 报告期重复 | warning；保留确定性选中的一条 |
| revenue 为零 | `net_margin=null` |
| 分子/分母缺失 | 不计算，保留现有可信字段 |
| 百分比看似 ratio 但无单位元数据 | 不自动缩放，warning |
| 有效样本少于 2 | summary 可输出 latest，但平均值标低样本 warning |
| ROE 只能猜算 | 置 null，不生成伪指标 |
