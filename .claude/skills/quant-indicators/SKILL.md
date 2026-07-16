---
name: quant-indicators
description: Compute deterministic technical, return, volatility, drawdown, volume, liquidity, correlation, and trend metrics from QuantPilot bars. Use for stock diagnosis, multi-asset comparison, portfolio risk, trend confirmation, liquidity review, or preparing technicalIndicators, computedMetrics, correlation, liquidity, and trendTemplate.
---

# QuantPilot 指标计算

长期承接 `quant-technical-indicators`，把已获取的 K 线转换为可复用结果。

## 执行流程

1. 校验标的、周期、复权、时区、排序、重复日期和样本长度。
2. 只在相同周期与复权口径下计算收益、均线、波动率和回撤。
3. 多标的先按日期内连接收益序列，再计算相关性并报告 overlap。
4. 组合/对比任务同时计算流动性；趋势或调仓问题再生成 trend template。
5. 写入 final data，并记录公式、窗口、样本数、缺失字段和 warnings。

## 按需加载参考

- 当计算或解释收益、波动、回撤、相关性、流动性和趋势状态时，读取 [技术与风险指标方法合同](references/technical-risk-methodology.md)。
- 只运行已选脚本且输入 contract 已由平台验证时，不必加载无关章节。

## 确定性脚本

所有脚本兼容原有文件参数，也支持 `-` 从 stdin 读取并默认向 stdout 输出 JSON：

```bash
python3 scripts/correlation.py - < dashboard-data.json
python3 scripts/liquidity.py - < dashboard-data.json
python3 scripts/trend_template.py - < dashboard-data.json
```

继续支持 `-o/--output`。相关性不足两个有效标的时输出 warning；输入 JSON/根结构无效时非零退出。

## Workspace 协作与质量门

- 继承平台阶段；只贡献指标、窗口、样本量、复权/缺失口径、结果和限制。
- 不输出隐藏推理、完整工具参数、占位进度或重复 Todo。
- 不混用不同周期或复权，不在样本不足时给确定性趋势，不隐藏相关性 overlap。
