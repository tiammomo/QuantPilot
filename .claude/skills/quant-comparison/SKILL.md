---
name: quant-comparison
description: Build and validate evidence-based comparisons across multiple stocks, ETFs, indices, or portfolio constituents. Use for relative strength, ranking, performance/risk matrices, multi-symbol dashboards, or any task where every requested symbol must share a comparable window and metric definition.
---

# QuantPilot 多标的对比

把多个标的的真实数据标准化到同一窗口和同一计算口径。不得只使用主标的数据代表全部标的。

## 执行流程

1. 从运行计划读取完整 `requestedSymbols`；逐个确认代码、资产类型和数据覆盖。
2. 为所有标的选择共同样本窗口、频率、复权和币种/单位，保留每个标的的来源与截止时间。
3. 读取 [references/comparison-contract.md](references/comparison-contract.md) 后生成 `assets[]` 与 `comparison.rows[]`。
4. 在排名、结论或可视化前执行：

```bash
python3 scripts/validate_comparison.py --input data_file/final/dashboard-data.json
```

5. 缺任一请求标的、存在重复行、窗口不一致或指标不可比时停止；补数或明确返回失败。
6. 校验通过后再计算 leaders，并把事实、计算结果和分析判断分开表达。

## 按需资源

- [references/comparison-contract.md](references/comparison-contract.md)：定义共同窗口、指标方向、缺失值策略、排名与数据血缘；生成或审查比较结果时必须读取。
- [scripts/validate_comparison.py](scripts/validate_comparison.py)：检查请求标的覆盖、行唯一性、共同窗口、必需指标与来源证据。

## Workspace 回答协作

- 继承平台五阶段进度，不重复阶段标题、识别表或 Todo。
- 只贡献标的覆盖、共同窗口、对比口径、领先项、缺失标的和数据限制。
- 不输出隐藏推理、完整工具参数或占位式执行文案。

## 完成门槛

- `requestedSymbols` 中每个标的恰有一个真实资产对象和一个对比行。
- 所有行使用同一窗口和同名同义指标；来源、截止时间和缺失字段可追溯。
- 校验器返回 `ok: true`；否则不得生成 leaders 或宣称完成对比。
- 不输出确定性买卖结论，不把缺失值当零参与排名。
