---
name: platform-ui-product-design
description: Use this skill when designing, refactoring, reviewing, or polishing QuantPilot platform pages, generated-page templates, React components, layouts, dashboards, settings panels, navigation, tables, modals, charts, and UI states to make the frontend more beautiful, consistent, responsive, accessible, and production-ready using the QuantPilot-adapted UI/UX Pro Max design workflow.
---

# QuantPilot 平台 UI 产品设计

这个 skill 面向 QuantPilot 主平台前端：`src/app` 页面、`src/components` 组件、控制台、设置、列表、详情、弹窗、导航和响应式体验。生成工作空间里的金融分析看板继续使用 `dashboard-visualization`；本 skill 只负责平台自身的页面开发质量。

本 skill 参考 `nextlevelbuilder/ui-ux-pro-max-skill` 的设计智能思路：先判断产品类型，再选择页面模式、视觉风格、配色、字体、动效、UX 规则、技术栈规则和图表规则。QuantPilot 的落地版见 `references/ui-ux-pro-max-adapter.md`。

## 何时使用

- 用户要求“页面更好看”“UI 优化”“前端重构”“布局调整”“补页面入口”“控制台/设置/列表/表格/弹窗更专业”。
- 修改 `src/app/**`、`src/components/**`、`src/app/globals.css`、`tailwind.config.ts` 或 shadcn 风格基础组件。
- 为技能管理、评测链路、运维平台、数据平台、策略平台、工作空间、设置、首页和聊天页新增或调整界面。
- 生成工作空间页面“不好看”时，本 skill 作为审美和 UX 规则来源；实际生成文件仍由 `dashboard-visualization` 执行。

## 标准工作流

1. 先读取目标页面、相邻组件和设计基线：`docs/ui-shadcn-migration.md`、`src/components/ui/*`、`src/components/quant/*primitives*`。
2. 读取 `references/ui-ux-pro-max-adapter.md`，按“产品类型 -> 页面模式 -> 风格 -> 配色 -> 字体 -> UX 规则 -> 技术栈规则 -> 图表规则”做一次设计决策。
3. 明确信息层级：顶部任务栏或页面标题、主工作流、关键指标、列表/图表、详情面板、次级诊断。
4. 优先复用现有组件和 token；只有多个页面会共同受益时才新增业务 primitive。
5. 补齐状态：loading、empty、error、success、disabled、pending、long text、权限/连接缺失和列表分页。
6. 实现后至少跑 `npm run lint` 和 `npm run type-check`；大范围 UI 变更再跑 `npm run build` 或页面 smoke。
7. 对可视页面变更，检查 375px、768px、1440px 宽度下无文字溢出、遮挡、布局跳动和不可点击控件。

## QuantPilot 视觉原则

- 产品气质是量化 Agent 工作台：克制、密集、可扫描、可信赖；不要做营销页式巨型 hero、装饰卡片堆和空洞口号。
- 默认页面模式是 Data-Dense Dashboard / Real-Time Operations，不是通用 SaaS landing page。
- 首屏优先呈现真实可用的操作、数据、状态和入口；控制台页面不要让说明性文案占据主要空间。
- 页面分区使用全宽 band 或受控内容区；card 只用于重复项、详情、弹窗和真正需要边界的工具，不要 card 套 card。
- 圆角默认 `rounded-md` 或 8px 以内；阴影轻，边框清晰，避免玻璃拟态和厚重浮层。
- 配色以中性底色和语义状态为主：emerald 表示可用/成功，amber 表示排队/警告，red 表示失败/风险，blue 表示运行/信息，slate 表示未知/静默。
- A 股涨跌红绿只用于行情、图表和市场收益语境，不要污染平台运维状态色。
- 避免一整页紫蓝渐变、米色/棕色主题、装饰光球、背景斑点、远程图片/字体和无意义插画。
- 字体使用项目现有字体或系统字体；不要负字距，不要用 viewport 缩放字体；工具页标题保持紧凑。
- 图标优先使用 `lucide-react`；按钮、导航、工具栏和状态提示不要新写手工 SVG，除非已有组件确实没有可替代图标。
- 动效只服务状态变化、层级切换和交互反馈；默认 150-300ms，使用 transform/opacity，尊重 `prefers-reduced-motion`。

## 组件使用地图

- 基础控件：`src/components/ui/button.tsx`、`badge.tsx`、`card.tsx`、`input.tsx`、`label.tsx`、`select.tsx`、`separator.tsx`、`sheet.tsx`、`textarea.tsx`、`alert-dialog.tsx`。
- 量化控制台 primitive：`src/components/quant/console-primitives.tsx`、`eval-console-primitives.tsx`、`eval-console-shell.tsx`、`workspace-console-primitives.tsx`。
- 复杂业务组件：评测视图在 `src/components/quant/eval-*-view.tsx`，设置在 `src/components/settings/**`，聊天在 `src/components/chat/**`。
- class 合并统一使用 `cn()` from `src/lib/utils`；不要手写重复 class 拼接工具。

## 布局和交互规则

- 控制台优先使用左侧/顶部导航、sticky header、主内容区、右侧或 sheet 详情；移动端把导航折成横向滚动或简洁菜单。
- 同一页面只保留一个主动作；刷新、导入、导出、筛选、排序、更多操作放入工具栏或菜单。
- 列表超过 10 条默认分页；评测集等已有 page size 常量时跟随本地 primitive。
- 表格列要有稳定宽度或响应式隐藏策略，长文本使用截断、tooltip、详情 sheet 或二级行，不要挤爆容器。
- 数字、状态、时间、路径、来源、版本、运行 ID 等字段要适合扫描：对齐一致，标签短，语义色稳定。
- 弹窗和 sheet 必须有明确标题、关闭方式、焦点态和提交/取消状态；危险操作必须二次确认。
- 图标按钮必须有 `aria-label` 或 tooltip；键盘焦点可见；禁用态不能只靠颜色表达。

## 状态设计要求

- Loading：优先 skeleton 或稳定尺寸占位，避免加载后大幅跳动。
- Empty：说明缺什么，并给出一个可执行动作，例如创建、导入、刷新、连接服务。
- Error：显示失败原因、重试入口和可定位上下文，不要只写“出错了”。
- Pending/Running：展示步骤、队列位置、最近更新时间或可取消入口。
- Success：给出结果摘要和下一步入口，不要只显示绿色 badge。
- Long text：任何来自用户、文件、路径、错误栈、模型输出的文本都必须考虑换行、截断和详情展开。

## 验收清单

- 页面符合平台气质：真实工作台优先，少装饰，多可用信息。
- 已完成一次 UI/UX Pro Max 风格的设计决策：页面模式、风格、配色、字体、交互、图表和反模式都明确。
- 复用现有 UI/quant primitives，新增组件命名清晰且有跨页面价值。
- 375px、768px、1440px 下无重叠、溢出、错位和不可点击区域。
- loading、empty、error、disabled、pending、long text 和分页状态可用。
- 导航入口、页面标题、按钮文案和 URL 语义一致。
- `npm run lint`、`npm run type-check` 通过；大改后补 `npm run build` 或 smoke。
