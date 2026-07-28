# QuantPilot 平台 UI 交付契约

在实现平台页面、控制台、设置、表格、导航或弹窗时读取本文件。它定义可机器检查的状态矩阵；视觉风格选择继续读取 `ui-ux-pro-max-adapter.md`。

## 状态矩阵

为本次页面准备一个 JSON 对象：

```json
{
  "page": "/skills",
  "primary_action": "发布 Skill",
  "viewports": [375, 768, 1440],
  "states": {
    "loading": true,
    "empty": true,
    "error": true,
    "disabled": true,
    "pending": true,
    "long_text": true
  },
  "accessibility": {
    "keyboard_focus": true,
    "icon_labels": true,
    "semantic_headings": true,
    "color_independent_status": true
  },
  "evidence": ["lint", "type-check", "desktop-smoke", "mobile-smoke"]
}
```

`true` 表示实现中存在可到达、可验证的对应状态，而不是只在任务清单中写过该词。页面不适用某状态时仍应提供安全退化；例如没有提交按钮，也需要说明为何不存在 disabled/pending 交互。

## 响应式契约

- `375`：核心操作可触达；页面不产生非预期横向滚动；宽表格只在自己的容器内滚动。
- `768`：导航、过滤器和主内容不互相遮挡；详情面板有明确折叠策略。
- `1440`：内容密度提升，但正文行宽、表格列和侧栏不无限拉伸。
- 长路径、错误、用户输入和模型文本必须换行、截断或进入可访问的详情视图。

## 可访问性契约

- 核心动作可由键盘完成，焦点态可见。
- 图标按钮有可读标签；状态不能只靠颜色表达。
- 标题层级、表格语义、表单标签和错误关联正确。
- 动效尊重 `prefers-reduced-motion`。

## 机器校验

运行：

```bash
python scripts/validate_state_matrix.py --input state-matrix.json --pretty
```

退出码 `0` 表示合同字段完整；退出码 `1` 表示缺少状态、断点、可访问性或验收证据。脚本不会判断页面是否真的好看，也不会代替 Playwright 或人工评审。
