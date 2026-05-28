# 故障排查

## 一键诊断

优先运行：

```bash
npm run doctor
```

它会快速检查：

- Node、npm、uv 版本。
- Claude / MiniMax 环境变量。
- Claude Code 和 Codex CLI。
- 前端 `3000` 和后端 `8000` 可达性。
- workspace 目录。
- Skills 注册表、lock 和压缩包一致性。
- 生成产物策略。
- 验证修复契约。
- benchmark 覆盖。
- eval 定时器。
- 最近评测报告。

提交前或排查复杂问题时运行完整诊断：

```bash
npm run doctor:full
```

完整诊断会额外运行 `lint`、`type-check`、后端 `ruff` 和后端 `pytest`。

## 3000 端口被占用

```bash
lsof -i :3000
```

释放端口后重新执行：

```bash
npm run dev
```

主前端应优先使用：

```text
http://localhost:3000
```

## 8000 后端不可用

```bash
curl http://127.0.0.1:8000/health
```

如果没有响应：

```bash
cd services/market-data
uv run quantpilot-market-api
```

## Claude Code 找不到 MiniMax 配置

确认 `.env`、`.env.local` 或 `~/.claude/settings.json` 中包含：

- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_MODEL`

然后重启：

```bash
npm run dev
```

可以用脚本写入本机 Claude Code 配置：

```bash
bash claude_code_minimax_env.sh
```

## Codex CLI 没有调用 GPT-5.5

确认：

- `codex --version` 可执行。
- `CODEX_OPENAI_BASE_URL` 已配置。
- `CODEX_OPENAI_API_KEY` 已配置在本地环境或 `~/.codex/auth.json`。
- 前端模型选择为 `Codex CLI / GPT-5.5`。

## 生成页面没有真实行情

先确认后端可用：

```bash
curl "http://127.0.0.1:8000/api/v1/quotes/realtime/600519"
```

再检查生成项目中是否存在：

```text
.claude/skills/
.quantpilot/run_plan.json
.quantpilot/generation-state.json
.quantpilot/generation-queue.json
data_file/final/dashboard-data.json
evidence/sources.json
evidence/data_quality.json
```

## 可视化页面只有静态文案

通常说明取数、final 数据文件或 `quant-visualization-html` 没有完整执行。优先查看：

- 聊天页执行过程。
- `/ops-platform` 工作空间健康。
- `/ops-platform` 链路观测。
- `.quantpilot/events.jsonl`。
- `.quantpilot/validation.json`。
- `.quantpilot/validation-repair-plan.json`。
- `.quantpilot/artifact-contracts.json`。
- `.quantpilot/visual-validation.json`。

## 生成链路卡在运行中

检查：

```text
.quantpilot/generation-state.json
.quantpilot/generation-queue.json
```

如果用户已取消请求但队列仍显示 running，优先查看：

- `POST /api/chat/<project_id>/pause`
- `/ops-platform` 中的 active request。
- `.quantpilot/events.jsonl` 中最近的 queue 事件。

## 自动验证失败后没有修复

检查：

- `.quantpilot/validation.json` 是否存在。
- `.quantpilot/validation-repair-plan.json` 是否生成。
- `.quantpilot/generation-state.json` 中 `repairAttemptCount` 是否增加。
- Agent runtime 是否已被取消。
- `npm run check:validation-repair` 是否通过。

## Playwright 检查时页面可见但点击无效

优先使用：

```text
http://localhost:3000
```

项目已在 `next.config.js` 中允许 `127.0.0.1` 作为本地 dev origin，但日常浏览和截图仍推荐使用 `localhost`。

## Skills 发布后生成项目仍使用旧版本

检查：

```bash
npm run check:skills
npm run package:skills
```

确认这些文件有同步更新：

```text
.claude/skills.registry.json
.claude/skills.lock.json
.claude/skills.changelog.json
.claude/skill-packages/<skill-id>.tgz
```

如果需要临时安装 legacy alias：

```bash
QUANTPILOT_INSTALL_LEGACY_SKILLS=1 npm run dev
```
