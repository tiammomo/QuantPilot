---
name: dashboard-visualization
description: Generate, repair, or enhance real-data Next.js/HTML quantitative dashboards with financial charts, matrices, responsive layouts, and evidence-backed states. Use after data preparation or whenever the user asks for a visualization page, market dashboard, research workbench, or validation repair.
---

# QuantPilot 金融可视化看板能力

把平台准备好的真实数据绑定到可运行、可交互的页面。完成交付必须修改页面文件，并由平台验证数据、build、预览和证据。

## 读取顺序

1. 消费 Task Packet、运行时 capsule 和 `initial_dashboard_contract`，仅定向补读缺失字段。
2. 以只读 `.data-agent/finance-run-plan.json` 的 `symbols`、`templateId`、`variantId` 为准。预取成功后复用 final 数据和 evidence，不重复规划或取数。
3. 按模板选择 [场景组件](references/scenario_templates.md) 的对应二级标题；按图表任务选择 [可视化判读](references/visual_judgement.md) 的相关标题。
4. 数据形态或覆盖失败时读取 [Dashboard 数据契约](references/dashboard-data-contract.md)；类型报错时才读取 [TypeScript 边界](references/typescript-delivery.md)。

## 页面实现

- 在当前项目的 `app/page.tsx`、`app/globals.css` 等文件上增强，保留 `DATA_FILE`、`readDashboardData`、`getBars`、`TrendChart` 与 `data-source-file` 等模板验证结构。
- 通过当前运行时提供的 `apply_dashboard_spec`、`edit_file`、`write_file` 或 `apply_patch` 修改允许的产物；使用前核对工具是否可用。Python 脚本仅用于平台维护和离线验收，不是模型工具。
- 页面读取 `data_file/final/dashboard-data.json`，刷新通过已有同源 `/api/market/**` 代理；不在源码中大段硬编码数据，不重建或放宽平台代理。
- 单标的趋势提供 K 线/OHLC、成交量及至少两条有足够样本的均线；接口失败保留图表面板、真实错误和重试入口。
- 多标的展示全部计划标的、指标矩阵和累计收益对比；不得只绑定根级主标的 `quote/kline`。已有 correlation、liquidity、valuation、trendTemplate 时呈现其结果、假设和缺口。
- 财务展示报告期和趋势；回测展示净值、回撤、交易明细、参数和未建模项。持仓矩阵从账户事实出发，不把普通多标的对比推断成持仓。
- 主图必须具有日期/坐标/图例或数值标签；迷你 sparkline 仅用于辅助。不得以图表截图、静态占位或只有指标卡代替交付。
- 动态 JSON 经逐层对象、数组和有限数值守卫后渲染；零值与缺失值分开，禁止 `as any` 绕过类型错误。

## 视觉和状态验收

- 使用连续金融工作台布局：紧凑摘要、连续指标带、核心图表/矩阵。避免营销 hero、巨型标题、深色大 VaR 卡和模板名称区。
- 390×844 首屏露出核心图表/矩阵主体；375、768、1440px 均无页面级横向溢出。宽表只在自身容器滚动，网格子项设置 `min-width: 0`。
- 指标带随数量均衡换行，不出现孤立末项、数字竖排或数值拆行。数字使用 tabular 排列，图表标注单位与采样周期。
- 覆盖 loading、empty、error、pending、disabled 和 long text，保留键盘焦点、图标标签和不依赖颜色的状态文案。
- 展示更新时间、报告期、样本量及限制。渠道、端点、文件路径、缓存和模板合同放在后台证据中，不生成用户侧技术证据分区。
- 不添加用户未要求的交易执行、买卖点、止损、目标价、仓位或保证收益结论。

## 合同与修复

平台或维护者可运行 [scripts/validate_dashboard_contract.py](scripts/validate_dashboard_contract.py)：

```bash
python3 scripts/validate_dashboard_contract.py --input data_file/final/dashboard-data.json --expected-template technical-timing --expected-symbol 600519
```

- 必须记录 `required_components`、`rendered_components`、`missing_components`；同一组件不能同时已渲染和缺失。缺少数据时保留真实空态与原因，不伪造完成。
- 收到 repair plan 后按失败 ID、文件指针和必要视觉报告定向修改；只修复报告指向的数据或 evidence，不用空对象覆盖现有合同。
- `.data-agent/**` 为平台只读控制面，不能改写计划、事件、状态或报告；仅修改当前生成项目，不能修改父级平台。
- 不引入远程 CDN、脚本、样式、字体、图片、外部浏览器 API、mock 数据或密钥。
- 修改完成后调用一次 `submit_result`，说明已修改产物和真实限制，然后停止。build、preview、validation、完成状态和五阶段进度由平台维护。
