---
name: quant-fundamentals
description: Analyze A-share financial reports, derived profitability and growth indicators, announcement evidence, and valuation scenarios. Use for fundamental analysis, earnings quality, valuation, corporate-event context, or when consolidating financials, fundamentalIndicators, announcements, and valuation into QuantPilot final data.
---

# QuantPilot 基本面与事件

把财务、衍生指标、公告和估值组织为可核验的基本面证据；继续兼容 `quant-fundamental-financials`、`quant-fundamental-indicators` 与 `quant-announcement-events`。

## 执行流程

1. 用 `quant-symbol-resolver` 确认标准代码；只处理 run plan 中的标的。
2. 读取 `/fundamentals/financials/{symbol}`、`/indicators/fundamental/{symbol}` 与 `/events/announcements/{symbol}` 的真实返回。
3. 对齐报告期、披露时间、单位、百分比口径和来源；不要把不同口径拼成同一趋势。
4. 仅在用户询问估值、持有依据或情景空间时运行估值脚本；把假设与事实分开。
5. 写入 `financials`、`fundamentalIndicators`、`announcements`、`valuation`，并同步来源与 data quality。
6. 让页面呈现事实、期间、来源、缺口和情景假设；不要输出收益承诺。

## 按需加载参考

- 当合并多个基本面数据集、比较跨期财务、解释公告或生成估值时，读取 [基本面统一合同与失败模式](references/fundamentals-contract.md)。
- 单纯调用确定性估值脚本且输入已经过合同校验时，不必加载整份参考。

## 确定性脚本

从文件读取并保持现有调用兼容：

```bash
python3 scripts/valuation_scenarios.py data_file/final/dashboard-data.json
```

从 stdin 读取并向 stdout 输出 JSON：

```bash
python3 scripts/valuation_scenarios.py - < data_file/final/dashboard-data.json
```

可继续用 `-o/--output` 写文件。EPS、PE 或价格不足时保留 warning 和空 scenarios，不补造数字。

## Workspace 协作与质量门

- 继承平台阶段；只贡献标的、报告期、财务/事件事实、估值假设、来源和缺失字段。
- 不输出隐藏推理、完整工具参数、占位进度或重复 Todo。
- 拒绝把公告标题当正文、把单期累计数当单季数、把估值情景当预测结论。
- 对缺失报告期、单位、来源、时间戳或标的不一致返回 warning/error，不静默降级。
