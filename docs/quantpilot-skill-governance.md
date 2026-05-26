# QuantPilot Skills 治理方案

QuantPilot 的 skills 需要少而清晰。一个 skill 应该代表一类稳定能力，而不是一个接口、一个页面或一个临时提示词。

## 数量控制

建议把核心 skills 控制在 8-10 个以内：

- `quant-run-planner`：意图澄清、任务规划、run plan 生成与承接。
- `quant-data-registry`：数据源、字段契约、缓存、降级和信源选择。
- `quant-symbol-resolver`：证券名称、代码、市场和资产类型解析。
- `quant-image-extraction`：持仓截图、表格截图和用户上传图片的结构化提取。
- `quant-market-data`：实时行情、K 线、指数/ETF 和多源行情兜底。
- `quant-fundamentals`：财务报表、财务指标、公告和事件。
- `quant-indicators`：技术指标、收益、波动、回撤和风险指标计算。
- `quant-backtest`：策略参数、回测执行、交易明细和限制说明。
- `quant-visualization-html`：基于已验证数据生成可视化看板。
- `quant-data-quality`：来源、时效、缺失字段、异常值和证据文件。

当前仓库里已经存在更细的 skills。后续不要继续扩张数量，新增能力优先放入上述大类；确实需要拆分时，必须说明不能合并的原因。

## Skill 边界

每个 skill 必须明确：

- 输入：需要哪些字段、文件或用户问题。
- 输出：会写哪些文件，或者返回哪些结构化结果。
- 禁止事项：不能做什么，不能伪造什么。
- 依赖能力：会调用哪些后端接口或脚本。
- 验证方式：如何判断本 skill 的结果可用。

## Python 脚本使用原则

skills 可以配套 Python 脚本，但脚本要做确定性计算，不替代模型判断：

- 适合脚本：意图槽位检测、字段映射、收益/回撤/波动计算、数据质量扫描、信源探针、schema 校验。
- 不适合脚本：长篇分析结论、投资建议措辞、页面审美判断。
- 脚本默认只读或输出 JSON 到 stdout；写文件时必须写到生成项目内的约定目录。
- 脚本输入输出必须有稳定 JSON 契约，便于 Agent 和平台复用。

## 数据源接入原则

新增数据源先进入候选测试池，不直接替换主链路：

1. 登记信源能力、覆盖市场、是否需要 key、限制和适合场景。
2. 通过探针接口验证可用性、延迟、字段完整度和错误类型。
3. 通过 `quant-data-quality` 写入来源和缺失字段。
4. 只有当探针稳定后，才作为某个正式接口的主源或降级源。

## 当前建议

短期不要再新增顶层 skill。下一阶段优先合并：

- `quant-a-share-history`、`quant-index-etf-market` 合并进 `quant-market-data`。
- `quant-fundamental-financials`、`quant-fundamental-indicators`、`quant-announcement-events` 合并进 `quant-fundamentals`。
- `quant-technical-indicators` 合并进 `quant-indicators`。

合并前保持现有 skill 名称兼容，避免影响已经生成的项目。

## 注册表

项目统一使用 `.claude/skills.registry.json` 记录核心 skill、兼容别名、脚本、接口和验证边界。后续修改 skills 时必须同步更新注册表。

校验命令：

```bash
npm run check:skills
```

校验会检查：

- 核心 skill 是否都有 `SKILL.md`。
- legacy alias 是否指向存在的核心 skill。
- legacy alias 对应目录是否仍存在。
- 核心 skill 数量是否超过目标上限。
- 默认只要求核心 skill 包齐全；需要连 legacy 包一起检查时运行 `npm run check:skills -- --include-legacy`。

Agent prompt 中的 skills 治理摘要由注册表生成，避免 README、prompt 和实际目录互相漂移。

## 管理工作台

本地开发和发布统一使用 `/skills` 页面，避免手工同时修改源码、注册表、changelog、lock 和压缩包。

- 在线编辑：直接修改核心 skill 的 `SKILL.md`，保存后仍是工作副本，需要发布版本才会进入 registry/changelog/lock。
- 发布版本：填写 semver 版本号、发布摘要和变更点，平台会更新 `.claude/skills.registry.json`、`.claude/skills.changelog.json`，并执行单个 skill 打包。
- 上传新包：支持拖拽或选择 `.zip`、`.tgz`、`.tar.gz`，包内必须包含 `SKILL.md`，发布成功后替换对应核心 skill 源目录并重新打包。
- 安全边界：只能操作已经登记的核心 skill，不允许通过上传包新增未知顶层 skill；压缩包会拒绝路径穿越、软链接、硬链接和异常文件数量。
- 失败回滚：发布或打包失败时会回滚 registry、changelog、lock 和压缩包；上传包失败时也会回滚源码目录。

推荐发布顺序：

1. 在 `/skills` 中选择需要维护的 skill。
2. 修改源码或上传包，确认输入输出、禁止事项、脚本契约和验证方式都写清楚。
3. 填写新版本、摘要和变更点，点击发布并打包。
4. 运行 `npm run check:skills`，必要时再跑相关 benchmark 或生成项目验证。

## Skill 压缩包

平台支持把每个 skill 打包成独立压缩包，生成项目时优先从压缩包安装到：

```text
<project>/.claude/skills/<skill-id>
```

默认包目录：

```text
.claude/skill-packages/<skill-id>.tgz
```

打包命令：

```bash
# 打包全部核心 skill 和 legacy alias
npm run package:skills

# 只打包某几个 skill
npm run package:skills -- quant-run-planner quant-market-data
```

生成项目时安装顺序：

1. 默认只安装 10 个核心 skill。
2. 优先读取 `.claude/skill-packages/<skill-id>.tgz` 并解压。
3. 如果压缩包不存在，回退复制 `.claude/skills/<skill-id>` 源目录。
4. 返回实际安装成功的 skill id 给 Claude Code。

兼容旧项目或调试旧能力时，可以临时开启 legacy alias：

```bash
QUANTPILOT_INSTALL_LEGACY_SKILLS=1 npm run dev
```

这样本地开发仍然可以直接改 skill 目录，发布或稳定测试时可以使用压缩包锁定版本。

## 产物策略

生成项目完成后，平台验证会执行统一的产物策略检查：

- 页面和配置不得引用外部 CDN、远程脚本、远程样式、远程字体、远程媒体或浏览器直连外部 API。
- 浏览器取数只能读取 `data_file/final/dashboard-data.json` 或同源 `/api/market/**`，由生成项目的 API route 代理到 QuantPilot 后端。
- 不得留下 `MOCK_DATA`、`SAMPLE_DATA`、`STATIC_QUOTES`、示例数据、模拟数据或占位数据。
- 不得把 token、api key、cookie、authorization 等敏感信息写入生成项目。
- 必须保留 `.quantpilot/run_plan.json`、`data_file/final/dashboard-data.json`、`evidence/sources.json` 和 `evidence/data_quality.json`。

这些规则会进入 `.quantpilot/validation.json`，失败后会作为修复指令反馈给 Agent。
