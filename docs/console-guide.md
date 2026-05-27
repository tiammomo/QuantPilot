# 控制台使用指南

QuantPilot 的控制台按职责拆分。日常开发建议从首页进入，再根据问题类型跳到对应控制台。

## 首页工作台

入口：

```text
http://localhost:3000
```

主要能力：

- 创建自然语言分析任务。
- 选择 Claude Code 或 Codex CLI 运行时。
- 进入项目聊天页。
- 查看生成状态和 workspace 预览。
- 跳转 Skills、评测、策略平台、运维平台和数据平台。

## Skills 管理

入口：

```text
http://localhost:3000/skills
```

适用场景：

- 修改核心 skill 的 `SKILL.md`、`scripts/`、`references/`。
- 查看源码文件树。
- 创建或删除文件和文件夹。
- 上传 `.zip`、`.tgz` 或 `.tar.gz` 作为新版本来源。
- 发布前生成 diff。
- 发布新版本、下载包和回滚历史版本。

发布后建议运行：

```bash
npm run check:skills
npm run package:skills
```

治理规则见 [Skills 治理规范](skills-governance.md)。

## 策略平台

入口：

```text
http://localhost:3000/strategies
```

主要能力：

- 管理策略模板、策略族和成熟度。
- 查看参数口径、样本周期、默认标的和评估指标。
- 查看参数扫描网格、观测指标和执行护栏。
- 对可执行策略发起参数扫描，并把扫描报告落盘到 `data/strategy-scans/`。
- 查看策略版本口径、参数快照和变更记录。
- 查看回测报告归档、报告状态、指标摘要和限制说明。
- 查看策略依赖的数据端点和风险限制。
- 汇总关联策略工作空间。
- 基于模板一键生成策略研究或回测工作空间。

相关 API：

```text
GET /api/quant/strategies
POST /api/quant/strategies
```

`POST /api/quant/strategies` 默认用于生成策略工作空间提示；传入 `action: "run-scan"` 时会运行参数扫描并返回扫描报告。

## 数据平台

入口：

```text
http://localhost:3000/capabilities
```

主要能力：

- 查看量化能力域。
- 查看每个能力依赖的核心 skills。
- 查看后端接口、预期产物和验证规则。
- 查看 artifact contract 覆盖情况。
- 辅助判断新增能力应该进入哪个 skill 或哪个数据接口。

相关 API：

```text
GET /api/quant/capability-center
```

## 运维平台

入口：

```text
http://localhost:3000/workspaces
```

主要能力：

- 汇总本地 `data/projects/project-*` 工作空间。
- 查看健康状态、验证状态、预览状态和产物状态。
- 查看缺失产物、失败检查、视觉检查和修复建议。
- 进入单个工作空间的 trace 视图。

相关 API：

```text
GET /api/workspaces/health
GET /api/workspaces/trace
GET /api/projects/<project_id>/artifact
POST /api/projects/<project_id>/retry-initialization
```

## 生成观测

入口：

```text
http://localhost:3000/observability
```

主要能力：

- 聚合生成链路事件。
- 查看 run plan、验证、修复、队列和产物契约状态。
- 辅助定位生成失败属于规划、取数、Agent 执行、验证还是修复阶段。

相关 API：

```text
GET /api/observability/generation
```

## Agent 评测后台

入口：

```text
http://localhost:3000/evals
```

页面分栏：

- **仪表盘**：查看总体通过率、失败用例、运行队列和最新报告。
- **测试用例**：搜索固定用例，运行单个用例或当前筛选范围。
- **评测集**：按能力、类型和专项组织回归集，支持分页。
- **评测器**：配置运行器、模型、范围和 dry-run 模拟链路。
- **运行队列**：查看排队、运行中、完成和可取消任务。
- **运行记录**：查看历史报告、模型对比和 Skill 版本影响。
- **失败修复**：查看失败修复单和 warning 用例。

评测细节见 [Agent 评测指南](evals-guide.md)。
