# Skills 治理规范

QuantPilot 的 skills 采用“少量规范 Skill ID + tgz 包发布 + MoAgent runtime capsule”的方式管理。目标是让每个 Skill 的能力边界、版本、变更、打包产物、运行时投影和安装结果都可追溯。

仓库根目录的 `.moagent/**` 是唯一 Skill 权威源和 MoAgent 受信编译输入；完整性由 registry/lock、版本与 SHA-256 校验提供，目前没有密码学签名。生成工作空间的 `.moagent/skills/` 是可检查的参考镜像，不是执行发现源，Agent 不会改写该镜像。

如果是第一次学习或修改 skill，先读 [Skills 编写与迭代教程](learning/07-skills-authoring.md)。本文偏治理规范，教程会更详细解释 skill 是什么、怎么写、怎么发布、怎么把用户反馈沉淀成长期规则。

## 核心原则

1. 核心 skill 数量保持克制，新增能力优先并入已有核心 skill。
2. 一个 skill 代表一类稳定能力，不代表一个接口、一个页面或一个临时提示词。
3. Skill 只能使用 registry 中登记的规范 ID；未知 ID 直接失败，不做 alias 转换。
4. 修改 skill 必须同步更新版本、changelog、打包产物和 lock。
5. 能用 Python 脚本稳定计算的内容，不要只写成提示词规则。
6. `SKILL.md` 保持短而硬，复杂模板、字段说明和场景矩阵放到 `references/`。
7. Skill ID 按能力 scope 命名：只有量化域能力使用 `quant-`，平台 UI 使用 `platform-`，通用工作流、图片、证据和可视化能力不使用 QuantPilot 或 quant 前缀。
8. `SKILL.md` 是完整源材料，不直接进入模型上下文。MoAgent 只加载与当前 phase、信号和 typed tools 兼容的原子 capsule；必需 section 超出预算时失败关闭，不截断工作流。
9. 每个源码 Skill 都必须是完整技能包：`SKILL.md`、`references/`、`scripts/`、`agents/openai.yaml` 缺一不可；`assets/` 仅在确有输出模板或素材时加入。
10. 每个 reference 和 script 都必须由 `SKILL.md` 直接导航并说明使用时机；不允许孤儿资源，也不在 Skill 包中放 README、CHANGELOG 或安装指南。

## 目录职责

| 路径 | 作用 |
| --- | --- |
| `.moagent/skills.registry.json` | 唯一能力注册表，记录核心 Skill、版本、边界、输入输出、脚本和验证规则 |
| `.moagent/skills.changelog.json` | 权威版本变更记录 |
| `.moagent/skills.lock.json` | 打包锁，记录源目录 hash、压缩包 hash、文件数和版本 |
| `.moagent/skills/<skill-id>/` | 完整源码技能包，必须包含 `SKILL.md`、`references/`、`scripts/`、`agents/openai.yaml`；按需包含 `assets/` |
| `.moagent/skill-packages/<skill-id>.tgz` | 规范发布包，供 MoAgent 编译器校验和安装 |
| `.moagent/skill-packages/versions/**` | 已发布版本的不可变快照 |
| `config/moagent-skill-capsules.json` | MoAgent 可执行投影：phase、工具依赖、领域增量、完成条件，以及按模板/标题选择的 reference |
| `<workspace>/.moagent/skills/<skill-id>/` | 项目初始化生成的可检查参考镜像；当前 Agent 执行不从这里加载 |

## 当前核心 skill 边界

| Skill | 作用 |
| --- | --- |
| `run-planner` | 意图澄清、澄清承接、任务规划和 run plan |
| `query-rewrite` | 消费平台 LLM-first 语义合同，守住 Resolver 和失败关闭边界 |
| `quant-data-registry` | 数据源选择、主备源和降级说明 |
| `quant-symbol-resolver` | 股票、指数、ETF 标的解析 |
| `image-extraction` | 持仓截图、表格截图和用户上传图片的结构化提取 |
| `quant-market-data` | 实时行情、历史 K 线、指数 ETF、批量行情 |
| `quant-fundamentals` | 财务报表、财务指标、公告和估值情景 |
| `quant-indicators` | 技术指标、风险、相关性、流动性和趋势模板 |
| `quant-backtest` | 策略参数、回测执行、交易明细和限制说明 |
| `data-quality` | 来源、时效、缺失字段、异常值和证据文件 |
| `platform-ui-product-design` | 主平台 UI、控制台、组件状态和响应式体验 |
| `dashboard-visualization` | 基于已验证数据生成可视化看板 |

短期不要再新增顶层 skill。新增能力优先放入上述大类；确实需要拆分时，必须说明不能合并的原因。

## 命名规则

核心 skill 必须在 `.moagent/skills.registry.json` 中声明 `scope`。命名由 `scope` 决定：

| Scope | 命名规则 | 例子 |
| --- | --- | --- |
| `quant` | 必须使用 `quant-` 前缀 | `quant-market-data`、`quant-backtest` |
| `platform` | 必须使用 `platform-` 前缀 | `platform-ui-product-design` |
| `workflow` | 不使用 `quant-` 或 `platform-` | `run-planner` |
| `input` | 不使用 `quant-` 或 `platform-` | `image-extraction` |
| `evidence` | 不使用 `quant-` 或 `platform-` | `data-quality` |
| `visualization` | 不使用 `quant-` 或 `platform-` | `dashboard-visualization` |

旧 ID 不再接受。重命名 Skill 属于 major 变更，调用方、registry、capsule、lock 和 capability 必须在同一版本提交中原子更新。`npm run check:skills` 会拒绝 `legacyAliases` 字段和未登记源码目录。

## Skill 边界

每个 skill 必须明确：

- 输入：需要哪些字段、文件或用户问题。
- 输出：会写哪些文件，或者返回哪些结构化结果。
- 禁止事项：不能做什么，不能伪造什么。
- 依赖能力：会调用哪些后端接口或脚本。
- 验证方式：如何判断本 skill 的结果可用。

## Python 脚本使用原则

每个源码 Skill 必须配套至少一个确定性脚本，但脚本属于平台能力，不代表 MoAgent 获得 Python 或 Shell 工具。只有显式注册为 typed tool 或由平台阶段调用的脚本才能执行：

- 适合脚本：意图槽位检测、字段映射、收益/回撤/波动计算、数据质量扫描、信源探针、schema 校验。
- 不适合脚本：长篇分析结论、投资建议措辞、页面审美判断。
- 脚本默认只读或输出 JSON 到 stdout；写文件时必须写到生成项目内的约定目录。
- 脚本输入输出必须有稳定 JSON 契约，便于 Agent 和平台复用。
- 脚本必须支持 `--help`，使用非零退出码表达合同失败，并由对应 reference 记录输入输出示例。

## 数据源接入原则

新增数据源先进入候选测试池，不直接替换主链路：

1. 登记信源能力、覆盖市场、是否需要 key、限制和适合场景。
2. 通过探针接口验证可用性、延迟、字段完整度和错误类型。
3. 通过 `data-quality` 写入来源和缺失字段。
4. 只有当探针稳定后，才作为某个正式接口的主源或降级源。

## 版本规则

使用 semver：

- `patch`：只修文案、示例、错别字，不改变输出契约。
- `minor`：新增脚本、references、输出字段、验证规则或场景模板。
- `major`：修改 Skill 边界、删除输出字段、重命名 Skill 或破坏已有 workspace 假设。

当前阶段多数 skill 未到 1.0，仍按上述语义执行。

## 管理工作台流程

优先使用本地 `/skills` 管理工作台：

```text
http://localhost:3000/skills
```

推荐流程：

1. 在 `/skills` 中选择需要维护的核心 skill。
2. 在线编辑 `SKILL.md`、`scripts/`、`references/`，或上传 `.zip`、`.tgz`、`.tar.gz`。
3. 确认输入输出、禁止事项、脚本契约和验证方式都写清楚。
4. 填写 semver 版本号、发布摘要和变更点。
5. 生成发布前 diff。
6. 点击发布后，平台会更新 registry、changelog、tgz 包和 lock。
7. 运行 `npm run check:skills`，必要时再跑相关 benchmark 或生成项目验证。

工作台的上传发布会限制到已登记核心 skill，并拒绝路径穿越、软链接、硬链接和异常文件数量。发布或打包失败时会回滚 registry、changelog、lock 和压缩包；上传包失败时会回滚源码目录。

## 命令行修改流程

需要在命令行手工处理时，遵循同样顺序：

1. 修改 `.moagent/skills/<skill-id>/` 下的 `SKILL.md`、`scripts/` 或 `references/`。
2. 更新 `.moagent/skills.registry.json` 中该 skill 的 `version`、`boundary`、`outputs`、`scripts` 或 `validation`。
3. 更新 `.moagent/skills.changelog.json`，新增同版本 release，写明日期、摘要和变更点。
4. 为新版本生成 `.moagent/skill-packages/versions/<skill-id>/<version>.tgz` 不可变快照；已有同版本快照不得覆盖。手工发布容易遗漏这一项，因此发布版本仍优先使用 `/skills`。
5. 运行：

```bash
npm run package:skills -- <skill-id>
npm run check:skills
```

如果修改影响 MoAgent 的执行顺序、阶段、工具依赖或 reference 选择，还必须同步更新 `config/moagent-skill-capsules.json`。纯背景说明、长示例和平台脚本说明不应复制进 capsule。

Workspace 回答展示由 `workspaceResponseContract` 统一治理。所有 Skill 继承同一套五阶段协议，只贡献本领域可验证事实、真实缺口和下一步；不得各自复制识别表、重启阶段编号或输出占位式执行文案。该共享合同是平台展示元数据，不进入模型的 capsule 文本，因此同步 12 个核心 Skill 不会产生 12 份重复 Token。

如果一次修改多个核心 skill，可运行：

```bash
npm run package:skills
npm run check:skills
```

需要确认平台类型时继续运行：

```bash
npm run type-check
```

## 新增核心 skill 的门槛

只有满足以下任意条件，才新增核心 skill：

- 需要独立脚本或独立数据契约，合并到现有 skill 会明显增加边界混乱。
- 生命周期不同，例如独立的外部数据源治理、独立的实时 gateway、独立的组合优化引擎。
- 验证规则和输入输出与现有核心 skill 完全不同。

否则优先：

- 放到已有 skill 的 `references/`。
- 放到已有 skill 的 `scripts/`。
- 在 `.moagent/skills.registry.json` 中扩展该核心 skill 的 `outputs` 或 `validation`。

## 发布检查会挡住什么

`npm run check:skills` 会检查：

- 注册表 schema 和核心 skill 数量上限。
- 所有源码 Skill 是否同时具备 `SKILL.md`、`references/`、`scripts/` 和 `agents/openai.yaml`。
- frontmatter 是否只含 `name` / `description`，资源是否由 `SKILL.md` 直接导航，是否存在孤儿或冗余辅助文件。
- `agents/openai.yaml` 是否包含真实的根级 `interface`，短描述长度是否合法，`default_prompt` 是否实际引用 `$skill-id`。
- scripts 是否具备可执行位、合法语法和 `--help`，而不是只有占位文件。
- 核心 Skill 是否在 registry 登记完整 scripts/references 路径，且不存在未登记或 alias 源目录。
- 版本号是否符合 semver。
- 每个核心 skill 是否有对应 changelog release。
- 每个核心 skill 是否有 lock entry。
- lock 中的版本、源目录 hash、文件数和 tgz hash 是否与当前文件一致，tgz 内容树是否与 source hash 完全相同。
- 当前 release 是否存在不可变快照，且快照是否与当前 tgz 完全一致。
- registry 和 Skill 条目是否完全不含已废弃的 `legacyAliases` 字段。
- 每个核心 skill 是否恰好有一个合法 runtime capsule，phase 和 typed-tool 名是否有效。
- capsule reference 是否位于对应 skill 的 `references/*.md`、是否存在且不是 symlink。
- runtime capsule 是否混入 MoAgent 不支持的 MCP、Bash、curl、Python 或 `npm run` 指令。

如果修改了尚未发布的 skill 但忘记重新打包，会出现 source/package hash mismatch，需要重新运行：

```bash
npm run package:skills -- <skill-id>
```

已经存在版本快照的 Skill 不允许在同一版本下重打并覆盖发布内容；应提升 semver、补 changelog，再通过管理工作台发布新版本。

## Skill 压缩包

项目初始化镜像与 Agent 执行编译顺序：

1. registry 按 capability 选择核心 skills，lock 必须同时匹配版本和可用输入的 SHA-256。
2. 编译器优先读取仓库根目录 `.moagent/skills/<skill-id>` 并校验 source hash 与文件数。
3. 只有 source 不存在时，才回退读取 `.moagent/skill-packages/<skill-id>.tgz`；除 package hash 外，还会拒绝链接/特殊条目和超限内容，并验证包内 `path + content` 树与 source lock 完全一致。
4. 创建项目时，编译器把 capability 的完整受检 Skill 集合及显式附加 Skill 安装为 `<workspace>/.moagent/skills/` 参考镜像；安装集合不受单次执行 phase 裁剪。创建服务只以安装成功或抛错作为结果，不把 receipt 注入 Agent。
5. 每次 Agent 执行重新按第 1～3 步验证受信输入，再按 phase、附件、标的解析、template/variant 和当前 typed-tool 名称选择 capsule。
6. 稳定 Kernel 只接收 skill manifest；动态 user task 依次接收 Task Packet、完整的原子 Skill Capsules 和标为 untrusted data 的 initial dashboard contract。reference 由编译器按 Markdown 二级标题精确注入，模型不再读取相对 reference 路径。

## 产物策略

生成项目完成后，平台验证会执行统一的产物策略检查：

- 页面和配置不得引用外部 CDN、远程脚本、远程样式、远程字体、远程媒体或浏览器直连外部 API。
- 浏览器取数只能读取 `data_file/final/dashboard-data.json` 或同源 `/api/market/**`。
- 不得留下 `MOCK_DATA`、`SAMPLE_DATA`、`STATIC_QUOTES`、示例数据、模拟数据或占位数据。
- 不得把 token、api key、cookie、authorization 等敏感信息写入生成项目。
- 必须保留 `.data-agent/finance-run-plan.json`、`data_file/final/dashboard-data.json`、`evidence/sources.json` 和 `evidence/data_quality.json`。

这些规则会进入 `.data-agent/validation.json`，失败后会作为修复指令反馈给 Agent。

## 后续建议

- 为高风险脚本增加最小有效/无效 golden fixture，并在 CI 执行。
- 对涉及真实 API 响应的 Skill 增加脱敏合同样例，不在 Skill 包内复制生产数据。
- 在 GitHub Actions 中持续运行 `npm run check:skills` 和关键脚本回归。
