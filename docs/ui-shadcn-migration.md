# QuantPilot UI 组件迁移约定

QuantPilot 后续 UI 逐步向 shadcn/ui 的组件组织方式收敛，但保留现有量化 Agent 产品风格，不照搬示例页面细节。

## 当前基线

- `components.json` 作为 shadcn 组件配置入口。
- `components/ui/*` 存放可复用基础组件。
- `lib/utils/index.ts` 提供 `cn()`，统一处理 Tailwind class 合并。
- `app/globals.css` 和 `tailwind.config.ts` 提供 shadcn token，主色保持 QuantPilot 红色系。

## 迁移顺序

1. 基础控件：Button、Input、Textarea、Label、Badge、Card、Separator。
2. 高频业务面板：首页输入框、任务记录抽屉、技能管理页。
3. 复杂交互组件：Dialog、Tabs、Select、Command、Dropdown Menu。
4. 生成工作空间模板：只复用设计 token 和布局原则，不直接依赖平台组件。

## 设计原则

- 优先使用 `components/ui` 的基础组件，再补充业务组件。
- 保持量化工作台的密度和可扫描性，不做营销页式大卡片堆叠。
- 视觉样式可二次开发，但交互状态、可访问性和键盘行为尽量沿用 shadcn/Radix 模式。
- 页面迁移按模块推进，避免一次性重写影响 Agent、预览和验证主链路。
