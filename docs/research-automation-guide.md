# 投研情报中心与日报自动化指南

投研情报中心把“观察池、数据采样、报告契约、主题洞察、推送回执”串成一条可验证链路。它参考多数据源日报项目的优点，但不把 QuantPilot 变成外部 API Key 拼装脚本：真实行情仍从本地 market-data 读取，报告先保存为结构化对象，再由页面、推送和后续 LLM 摘要共同使用。

入口：`http://localhost:3000/research-reports`

## 当前能做什么

页面分为四个视图：

| 视图 | 主要问题 |
| --- | --- |
| 研究总览 | 研究链路是否就绪、最新结论是什么、下一步应生成还是排查来源 |
| 报告库 | 历史评分、风险、候选、正文、证据和复核清单如何回看 |
| 主题洞察 | 哪些候选与信号反复出现、覆盖率与证据可用性如何 |
| 源与自动化 | 观察池计划、provider、生成运行和推送回执是否正常 |

| 能力 | 当前状态 | 说明 |
| --- | --- | --- |
| 自选池订阅 | 已落库 | 默认生成 `QuantPilot 每日核心观察池`，绑定 `a-share-sample-research-pool` 和少量核心标的 |
| 证据采样 | 已接入 | 读取本地股票池摘要、短线候选筛选和 ClickHouse health |
| 日报契约 | 已落库 | 同时保存 Markdown、结构化 JSON、评分、建议、风险等级和 evidence |
| 推送记录 | 已接 adapter | 支持企业微信、飞书、钉钉和 Discord webhook；无密钥时保留 dry-run 或失败配置记录 |
| 新闻舆情 | 预留 | 不默认依赖付费搜索 API；等企业数据源或自建 SearxNG/Jina 等源稳定后再接 |

生成日报不会输出确定性买卖指令。它只能作为研究、复盘和风险检查材料。

## 数据模型

Prisma 表位于 `prisma/schema.prisma`：

| 表 | 责任 |
| --- | --- |
| `research_watchlists` | 观察池、市场范围、定时计划和关联推送通道 |
| `research_report_runs` | 每次生成任务的状态、开始结束时间、错误和元信息 |
| `research_reports` | 日报正文、结构化 JSON、评分、建议、风险和证据 |
| `notification_channels` | 企业微信、飞书、钉钉、Telegram、Discord、邮件等通道配置 |
| `notification_deliveries` | 每次推送或 dry-run 推送的记录 |

## API

| 路由 | 方法 | 责任 |
| --- | --- | --- |
| `/api/research/reports` | `GET` | 返回情报中心数据、观察池、近期报告、运行历史和推送记录 |
| `/api/research/reports` | `POST` | 执行 `run-daily-report` 生成日报，或执行 `send-latest-report` 推送最新日报 |

示例：

```bash
curl -s http://localhost:3000/api/research/reports
curl -s -X POST http://localhost:3000/api/research/reports \
  -H 'Content-Type: application/json' \
  -d '{"action":"run-daily-report","dryRun":true}'
curl -s -X POST http://localhost:3000/api/research/reports \
  -H 'Content-Type: application/json' \
  -d '{"action":"send-latest-report","dryRun":false}'
```

## 推送通道配置

默认通道是企业微信 dry-run，不会真实发送。要启用真实 webhook，需要两步：

1. 把对应 webhook 写入本地环境变量或部署环境。

```bash
QUANTPILOT_WXWORK_RESEARCH_WEBHOOK="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
QUANTPILOT_FEISHU_RESEARCH_WEBHOOK="https://open.feishu.cn/open-apis/bot/v2/hook/..."
QUANTPILOT_DINGTALK_RESEARCH_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=..."
QUANTPILOT_DISCORD_RESEARCH_WEBHOOK="https://discord.com/api/webhooks/..."
```

2. 把 `notification_channels.is_dry_run` 改为 `false`，并确认 `channel_type` 是 `wxwork`、`feishu`、`dingtalk` 或 `discord`。

发送失败不会让日报生成失败，但会写入 `notification_deliveries.status=failed` 和 `error`，页面会展示失败原因。

## 设计边界

- Next.js 主应用负责订阅、运行记录、报告契约和推送记录。
- Python market-data 负责行情事实、股票池、筛选器、TimescaleDB 和 ClickHouse。
- 外部新闻、舆情、预测市场和真实推送都以 adapter 形式接入，不写进页面组件。
- 付费 API 不是默认依赖；如果企业已有接口，应作为 provider adapter 注入，并记录 evidence 来源。
- 真实推送 adapter 必须先写 delivery，再执行发送，失败时保留错误和 payload 摘要。

## 后续扩展顺序

1. 增加新闻搜索 provider registry，支持企业源、自建 SearxNG、Jina、Tavily 等。
2. 增加 LLM synthesis adapter，把 evidence 变成更自然的研究摘要。
3. 增加定时 worker，把日报运行从用户点击迁到独立任务。
4. 增加报告质量评测，检查证据缺失、过度建议和风险提示缺失。
