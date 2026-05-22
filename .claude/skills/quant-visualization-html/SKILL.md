---
name: quant-visualization-html
description: Use this skill to generate a visual HTML/Next.js dashboard after market data has been fetched or when the user asks for a quantitative visualization page.
---

# QuantPilot 可视化 HTML 看板能力

这个 skill 专门负责把已经获取到的数据转换为可视化页面。它不直接抓取外部数据；取数应先使用 `quant-market-data`，页面刷新能力统一调用 QuantPilot 本地行情后端。

## 何时必须使用

当用户希望“生成可视化界面、HTML 看板、量化分析页面、行情大屏、投研 dashboard”时，必须使用这个 skill。

## 标准流程

1. 先确认是否已有数据。
2. 如果没有数据，先使用 `quant-market-data` 获取所需行情数据。
3. 基于已获取的数据设计信息架构。
4. 生成可运行的 Next.js 页面或纯 HTML 看板。
5. 页面中保留刷新能力，通过 QuantPilot 行情后端继续获取最新数据。
6. 修改文件时只改当前生成项目目录内的文件，优先改 `app/page.tsx`、`app/globals.css`、`app/layout.tsx`。

## 页面必须包含

- 明确标题：说明分析对象或看板主题。
- 核心指标卡：最新价、涨跌幅、成交额、市值、行情时间。
- 可视化区块：至少包含一个适合当前问题的数据展示，例如价格卡片、排行表、对比矩阵、趋势占位区、风险/信号区。
- 数据来源说明：展示 `source`、`quote_time`、`fetched_at`。
- 加载状态。
- 错误状态。
- 空数据状态。
- 刷新按钮或自动刷新逻辑。

## A 股视觉约定

- 上涨使用红色。
- 下跌使用绿色。
- 中性使用灰色。
- 数字要格式化，例如成交额用“亿/万”。
- 不要使用过度营销式 hero；量化工具应优先信息密度、可扫描性和反复使用效率。

## Next.js 生成要求

- 使用 Next.js App Router。
- 优先实现 `app/page.tsx` 和 `app/globals.css`。
- 页面必须是实际可用界面，不要留下 Next.js 默认页。
- 前端可以直接调用：

```ts
await fetch("http://127.0.0.1:8000/api/v1/quotes/realtime", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ symbols: ["600519", "000001", "300750"] }),
});
```

如果浏览器跨域阻止直连，可以在生成项目中创建同源 API route 代理到 `http://127.0.0.1:8000`，但不要把行情抓取逻辑重新实现一遍。

## 禁止事项

- 不要编造行情价格。
- 不要只写说明文字而不生成页面。
- 不要把可视化做成静态截图。
- 不要创建和任务无关的示例项目。
- 不要修改父级 QuantPilot 平台工程。
- 不要启动开发服务器；QuantPilot 会管理预览服务。
