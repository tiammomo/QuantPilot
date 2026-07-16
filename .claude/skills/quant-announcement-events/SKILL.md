---
name: quant-announcement-events
description: Fetch, deduplicate, classify, and evidence-check A-share announcements for earnings, dividends, repurchases, holdings changes, litigation, restructuring, suspension, and other corporate events. Use for event timelines, stock-move context, corporate actions, or announcement risk review.
---

# QuantPilot 公告事件

## 执行流程

1. 解析标准证券代码，调用 `/api/v1/events/announcements/{symbol}?limit=20`。
2. 按公告标识或“日期 + 规范化标题”去重，保留原始标题、披露时间、来源、URL/PDF URL。
3. 用脚本做确定性主题分类和“需要正文核验”标记；分类不是情绪或影响结论。
4. 涉及金额、比例、交易对手、条件或风险结论时读取公告正文；标题证据不足则明确缺口。
5. 生成按时间排序的事件线；与价格联动只能描述时间邻近和待验证假设。

## 按需加载参考

- 当需要事件归类、正文证据、时间归因、去重或风险判断时，读取 [公告证据合同与因果边界](references/announcement-evidence-contract.md)。
- 仅展示已核验公告链接列表时，可不加载完整因果边界说明。

## 确定性脚本

```bash
python3 scripts/classify_events.py announcements.json
python3 scripts/classify_events.py - < announcements.json
```

脚本向 stdout 输出去重后的 events、taxonomy 和 data quality；`-o/--output` 可选。无可识别公告时非零退出。

## Workspace 协作与质量门

- 继承平台阶段；只贡献标的、事件类型、公告时间、来源、证据链接和不确定性。
- 不输出隐藏推理、完整工具参数、占位进度或重复 Todo。
- 不凭标题断言利好/利空，不把公告与价格相关性说成已证明因果。
