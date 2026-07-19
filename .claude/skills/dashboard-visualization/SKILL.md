---
name: dashboard-visualization
description: Generate, repair, or enhance real-data Next.js/HTML quantitative dashboards with financial charts, matrices, responsive layouts, and evidence-backed states. Use after data preparation or whenever the user asks for a visualization page, market dashboard, research workbench, or validation repair.
---

# QuantPilot 金融可视化看板能力

这个 skill 负责把已获取的行情、财务、公告和分析结果转换为真正可运行的可视化页面。它不是“写分析说明”的 skill；触发后必须产出或更新页面文件。

视觉和交互直接遵循本 skill 内的 Continuous Financial Workbench、可访问性、响应式、图表可读性和反模式约束；运行时 skill capsule 会注入当前任务所需的场景与判读片段，无需再加载其他 UI skill。功能正确但明显粗糙、不专业或像默认模板的页面不算完成。

## Bundled Resources

- 只读取与权威 `templateId` 匹配的 [场景化模板段落](references/scenario_templates.md)，不要顺序加载整份模板矩阵。
- 选择指标与主图前读取 [可视化判读清单](references/visual_judgement.md) 中相关标题。
- 校验 final 数据形态、模板、标的覆盖和 mock/远程资源风险时读取 [Dashboard 数据契约](references/dashboard-data-contract.md)。
- 在提交页面前运行 `python scripts/validate_dashboard_contract.py --input data_file/final/dashboard-data.json`；多标的任务为每个标的追加 `--expected-symbol <symbol>`。

## Workspace 回答协作

- 继承平台统一的五阶段进度；不自行重启阶段、重复进度标题、重复问题识别表或维护 Todo。
- 只提供本 skill 已确认的可验证事实、真实缺口和下一步，不输出隐藏推理、完整工具参数或占位式 “Skill executing...”。
- 本 skill 只贡献模板与变体、真实数据绑定、必备组件、修改产物、视觉缺口和待平台验收项；阶段编号与展示由平台统一维护。

## 何时必须使用

当用户希望生成、修复或增强以下内容时，必须使用本 skill：

- 可视化界面、HTML 看板、量化分析页面、行情大屏、投研 dashboard。
- K 线、趋势、量价、均线、收益、回撤、波动率、财务趋势、公告时间线。
- 已经通过 `quant-market-data`、`quant-a-share-history`、`quant-fundamental-financials` 或其他金融 skill 拿到数据后，需要呈现结果。

## 不可妥协的交付要求

1. 必须修改当前生成项目内的 `app/page.tsx`，必要时同步修改 `app/globals.css`、`app/layout.tsx` 或创建 `app/api/**/route.ts`。
2. 必须生成可访问、可交互、可刷新的页面；不能只回复文字、不能只写计划、不能留下 Next.js 默认页。
3. 如果用户问的是股票、行情或趋势，页面必须包含真实图表区域，不允许只用指标带替代图表。
4. 如果历史 K 线接口失败，页面必须显示真实错误和降级视图，但仍要保留 K 线面板和重试能力。
5. 数据必须来自 QuantPilot 本地后端或已经获取到的真实结果，不得编造行情、财报或 K 线。
6. 完成后必须能通过平台自动验证：Next.js build、预览 HTTP 200、`data_file/final/dashboard-data.json`、`evidence/sources.json`、`evidence/data_quality.json`、金融图表存在性和 `/api/market` 代理检查。
7. 不要把当前取到的数据大段硬编码进 `app/page.tsx`；页面必须读取 `data_file/final/dashboard-data.json`，或通过同源 `/api/market/**` 刷新。
8. 生成项目默认已有金融看板模板时，必须在模板上增强，不要推倒重写成营销页、说明页或只有指标带的静态页。
9. 如果 `dashboard-data.json` 包含 `assets[]` 或 `comparison`，这是多标的任务；页面必须展示全部标的的对比矩阵和图表，不能只展示根字段中的主标的 `quote/kline`。
10. 修改 `app/page.tsx`、`app/globals.css`、JSON 或 evidence 文件必须使用 Write/Edit 工具，不要用 Bash 的 `cat >`、`tee`、`echo >`、`printf >`、heredoc、python/node 脚本或 `touch` 写文件。
11. 必须按具体分析场景选择可视化模板，不能把持仓、选股、技术、基本面、回测都生成成同一种通用金融页面。
12. 页面必须通过 TypeScript/Next.js build。`dashboard-data.json` 是动态 JSON，读取后统一用 `JsonRecord`、`asRecord()`、`asArray()`、`numeric()` 这类守卫函数处理；不要让 `flatMap/map` 推断出过窄对象类型后再访问额外字段。
13. 多标的任务不得降级成单股模板。只要只读 run plan 中 `symbols.length > 1`、`assets[]`、`comparison.rows[]` 或用户要求对比/矩阵/排名/推荐顺序/观察池，就以 run plan 的 `visualization.templateId` 为权威，并让 `dashboard-data.json.visualization.template_id` 和页面采用对应的 `stock-selection`/多标的对比结构；绝不回写 run plan。
14. 禁止引用外部 CDN、远程脚本、远程样式、远程图片、远程字体或浏览器直连外部 API；页面必须使用本地代码、本地 CSS/SVG 和同源 `/api/market/**`。
15. 禁止留下 `MOCK_DATA`、`SAMPLE_DATA`、`STATIC_QUOTES`、示例数据、模拟数据、占位数据；如果数据不足，展示真实缺口和重试入口。
16. 禁止把 token、api key、cookie、authorization 或任何密钥写入页面、evidence、final 数据或配置文件。
17. 禁止把多个迷你 sparkline 当作主要可视化交付。Sparkline 只能作为资产行辅助图；页面必须额外提供至少一个带坐标/日期/图例/数值标签的主图、对比图或矩阵。
18. 如果平台自动验证失败，本 skill 必须进入自修复模式：定向读取 repair plan 中的失败 ID、文件指针及必要的 visual-validation 片段，实际修改页面、final 数据或 evidence，然后调用 `submit_result`；平台负责重新 build、preview 和 validation，不能只输出修复计划或解释。
19. “最终数据文件存在，但没有通过真实数据形态检查”不是可忽略警告。必须修复 `data_file/final/dashboard-data.json` 的标准字段和页面数据绑定，让数据形态、模板 ID、标的覆盖和图表组件同时满足验证。
20. 生成页面前必须先做金融可视化判读：识别时间字段、维度字段、指标字段、指标口径和可用图表；口径敏感指标不能错误聚合或用内部公式文案直接展示给用户。
21. 用户明确要求“累计收益曲线”“收益曲线”“净值曲线”或“折线图”时，必须绘制真正的时间序列折线图，包含日期轴、统一收益率尺度、图例和数值提示；不能用柱状图、指标带、排名条或 sparkline 替代。
22. 用户明确要求“相关性矩阵”“热力图”“相关性与分散风险图谱”时，必须绘制真实矩阵/热力图或等价矩阵表，包含行列标的、相关系数、颜色刻度和缺失样本说明。
23. 未被用户明确要求时，不得新增短线交易计划、买入区、卖出区、止损、目标价、调仓指令或交易执行建议。投研对比页默认只输出事实、风险、排序依据、数据限制和下一步研究线索。
24. 多标的投研对比任务优先级是：标的覆盖、指标矩阵、累计收益折线、收益/回撤/波动对比、相关性矩阵或流动性矩阵、数据时间与质量。不要用单股行情页或持仓页结构承载。
25. `.quantpilot/**` 全部属于平台只读产物，包括 run plan、manifest、generation state/queue、events、validation、repair plan、artifact contracts 和视觉报告。只能读取并据此修改 `app/**`、final 数据或 evidence，禁止编辑、删除、追加或伪造任何 `.quantpilot` 文件。
26. `evidence/sources.json`、渠道端点、技术文件路径、缓存状态属于后台审计证据，页面不得生成“数据信源渠道”“技术证据”专门分区；用户侧只展示研究必需的更新时间、报告期、样本口径和质量/缺失提示。
27. `visualization.templateId`、`variantId`、模板名称、`required_components` 和“必备组件/已渲染”状态只用于生成与验证，不能作为“场景模板”或契约表格渲染给用户。
28. 指标带必须按实际指标数量选择列数和响应式布局。桌面宽屏可保持单行；发生换行时末行必须均匀填满容器，禁止固定六列承载七项形成 `6 + 1` 孤项和大面积空白。数值使用 tabular 数字、合理字号与不拆行策略，空间不足时改为均衡 `4 + 3`、`3 + 2` 等布局或下移次要指标。

## 平台预取模式

当 `.quantpilot/run_plan.json` 为 `planned`，且 `data_file/final/dashboard-data.json`、`evidence/sources.json`、`evidence/data_quality.json` 已存在时，平台已完成规划和取数。此时执行以下低自由度流程：

1. 把 run plan、final 数据和 evidence 当作权威输入，不重新调用 run-planner 或取数 skill。
2. 只读 run plan；不修改 `capabilityId`、`symbols`、`visualization.templateId`、`visualization.variantId`。
3. 优先在平台已有 `app/page.tsx` 和 `app/globals.css` 上增强，保留 `DATA_FILE`、`readDashboardData`、`getBars`、`TrendChart` 和 `data-source-file` 验证结构。
4. 只有验证报告明确指向 `final_data_file`、`artifact_contracts` 或 `evidence_files` 时，才修复对应数据文件；不得用空对象或自定义 schema 覆盖。
5. 单个证券的全称与简称是同一标的；`symbols.length === 1` 时不得因“和/与/及”改成选股或多标的模板。
6. 用户没有明确要求交易执行时，不得添加买入区、止损、目标价、仓位或操作建议。
7. 不创建 Task/Todo 列表；定向读取必要片段后直接编辑，调用 `submit_result` 后停止，由平台统一执行 build、preview 和 validation。

## 标准工作流

1. 确认用户问题需要哪些数据：实时行情、历史 K 线、财务、公告、组合对比。
2. 缺数据时使用当前运行时已选择的量化 skill capsule 和 typed data tools 完成取数；不要手动加载无关 skill，也不要绕过平台工具自行调用外部命令。
3. 优先使用 Task Packet、skill capsule 和 `initial_dashboard_contract` 中已有的信息。只对缺失上下文做定向读取：按路径、失败指针、字段名或行区间读取必要片段，不要顺序全量读取 `app/page.tsx`、CSS、final 数据和全部 evidence，也不要重复读取提示词已经提供的内容。
4. 从只读 run plan 中只提取 `visualization.templateId`、`variantId`、`layout`、`firstViewport` 和 `variantGuidance`。优先使用运行时注入的 `references/scenario_templates.md` 对应二级标题；确需查看源 reference 时，只读取匹配模板的 `##` 段落，不读整份文件。
5. 使用运行时注入的 `references/visual_judgement.md` 相关标题完成可视化判读：确认时间/维度/指标字段、指标能否累加、比率/收益/回撤口径、首屏主图或矩阵，以及哪些组件必须保留空态；只补读当前任务缺失的判读段落。
6. 做一次 UI/UX Pro Max 风格的设计决策：金融/量化页面默认使用 Data-Dense Dashboard，不使用营销 landing；确定页面模式、语义配色、图表类型、表格 fallback、响应式策略和反模式。
7. 设计看板信息架构：先展示结论和核心指标，再展示图表、数据表、用户可读的数据质量与口径；渠道来源继续写入后台 evidence。
   - 投研/量化看板不要使用营销落地页式巨型 hero。顶部应是紧凑的报告摘要栏或工具栏：小标题、核心判断、关键指标和数据状态并排展示。
   - 首屏应尽快露出核心指标、图表或持仓矩阵；`h1` 只用于页面主题，桌面端建议不超过 40px，移动端不超过 32px。
   - 结论句应放在摘要栏或状态条中，不要做成占据半屏的大字口号。
   - 首页提问生成的默认看板必须像可用的金融工作台：首屏包含真实标的名称、行情/持仓/回测/财务核心数字、更新时间、数据状态和至少一个核心图表或矩阵。
   - 单标的行情页推荐首屏顺序：紧凑数据源状态条 → 标的与价格区 → 开高低收/成交额/换手等 meta row → 2-3 条可读的趋势/量能/结论摘要 → K 线主图和信号侧栏。
   - 移动端 390x844 首屏必须露出核心图表、矩阵或表格主体；如果图表被标题、摘要栏、meta row、质量说明或免责声明挤到首屏以下，必须压缩/下移这些次要内容，把 K 线/持仓矩阵/对比矩阵提前。
   - 技术分析模板在移动端优先显示：数据状态、标的与价格、K 线主图、成交量或量化信号；财务、公告和详细质量说明放到下方。
   - 不渲染数据信源端点、缓存状态或模板名称；免责声明与用户可读的质量说明放在底部或次要区域。
   - 移动端必须没有页面级横向溢出；宽表格、长代码、长接口名只能在所属数据区内部滚动或截断，不得撑开 `body`。
   - `holding-analysis`、调仓建议、截图持仓和组合风控页面不要生成 `hero-band`、深色大 VaR 卡、巨型标题或模板名称区；页面应直接从账户/组合摘要指标、持仓矩阵或核心风险面板开始。
   - VaR、样本口径、刷新接口和非投资建议声明应放入连续指标带、风险模块、数据质量或底部说明，不要占据首屏顶部。
8. 实现页面文件并确保有加载、错误、空数据、刷新状态。
9. 页面刷新数据时优先复用或创建同源 API route 代理到 `http://127.0.0.1:8000`，避免浏览器 CORS 或网络策略影响。
10. 使用 `data-quality` 写入 `evidence/sources.json` 与 `evidence/data_quality.json`，记录来源、接口、时间戳、样本长度、缺失字段、警告和限制。
11. 将最终看板数据写入 `data_file/final/dashboard-data.json`，字段中保留 `symbol`、`source`、`fetched_at`、`quote_time` 或对应数据源时间。
12. 完成允许范围内的修改后调用一次 `submit_result`，在摘要中说明改动、数据视图和已知限制，然后立即停止。不要自行运行 build、启动 preview、轮询报告或触发 validation；这些步骤由平台执行。

## 自动修复模式

当看到 `QuantPilot 自动验证未通过`、`validation-repair-plan.json`、`看板验证未通过` 或用户指出生成页面仍停留在失败页时，按以下流程处理：

1. 先定向读取 `.quantpilot/validation-repair-plan.json` 中当前失败 ID、允许修改路径和证据指针，再读取 `.quantpilot/validation.json` 中对应失败项；仅打开这些指针命中的页面、final 数据或 evidence 片段，不顺序全量读取整个工作空间。
2. 如果失败项指向视觉问题，再定向读取 `.quantpilot/visual-validation.json` 中对应 failures、viewport metrics 和 screenshotPath；只围绕当前截图问题调整首屏、图表、移动端或横向溢出。
3. 上述验证报告以及 `.quantpilot/artifact-contracts.json`、`.quantpilot/generation-state.json`、`.quantpilot/generation-queue.json` 均为平台只读产物。不得编辑、删除或伪造 viewport、截图、passed 状态或验证结果；修复完页面、final 数据或 evidence 后等待平台重新验证。
4. 不得在生成 workspace 中安装 Playwright/Chromium 或修改依赖来规避视觉验收。浏览器缺失属于平台运行环境问题，不是看板源码修复项。
5. 针对失败项实际修复：
   - `final_data_file`：补齐标准数据契约，保证 `symbol/name/source/as_of`、`quote`、`kline.bars[]` 或多标的 `requestedSymbols/assets[]/comparison.rows[]` 可被验证提取。
   - `dashboard_data_binding`：让页面读取 `data_file/final/dashboard-data.json` 或同源 `/api/market/**`，禁止页面只渲染静态文案。
   - `chart_presence`/`visual_presentation`：补齐足够尺寸的主图、矩阵或表格，首屏必须有真实金融数据和核心图表。
   - `artifact_policy`：移除 CDN、远程资源、mock/static 数据和敏感字段。
   - 模板不一致：保持 `.quantpilot/run_plan.json` 不变，只把 final 数据 `visualization.template_id/variant_id` 和页面结构对齐到只读 run plan。
6. 修复当前失败集后调用一次 `submit_result` 并停止。不得自行运行 build、启动 preview、触发 validation、轮询报告或伪造通过状态；平台会统一执行并在需要时发起下一轮定向修复。
7. 提交摘要只说明已修复项、修改产物和真实外部限制，不声称尚未由平台确认的验证结果。

## TypeScript 稳定性规则

生成 `app/page.tsx` 时必须按严格 TypeScript 写法处理动态金融数据：

- 所有从 JSON 读取的数据先进入 `JsonRecord | null` 或 `JsonRecord[]`，不要直接把 `unknown` 当作具体对象访问。
- 嵌套对象的每一层都必须单独经过 `asRecord()`；禁止在 `unknown` 字段上继续可选链，例如 `asRecord(data?.financials)?.summary?.latest_report_date` 仍然会触发 TypeScript 错误。应改为：

```ts
const financials = asRecord(data?.financials);
const financialSummary = asRecord(financials?.summary);
const latestReportDate = String(financialSummary?.latest_report_date ?? '—');
```

- `assets[]`、`comparison.rows[]`、`announcements.announcements[]`、`financials.reports[]` 等动态数组必须写成 `JsonRecord[]`：

```ts
const assets = asArray(data?.assets)
  .map(asRecord)
  .filter((item): item is JsonRecord => Boolean(item));
```

- 对 `flatMap()` 里新增字段的对象必须显式标注为 `JsonRecord`，避免 TypeScript 推断成 `{ symbol: unknown; name: unknown }` 这类窄类型：

```ts
const rows: JsonRecord[] = assets.flatMap((asset) => {
  const announcements = asRecord(asset.announcements);
  return asArray(announcements?.announcements)
    .map(asRecord)
    .filter((item): item is JsonRecord => Boolean(item))
    .map((item): JsonRecord => ({
      ...item,
      symbol: item.symbol ?? asset.symbol,
      name: item.name ?? asset.name,
    }));
});
```

- 排序、格式化和渲染时一律使用 `row['field']` 或 `row.field` 的 `unknown` 值进入 `String()`、`numeric()`、`formatDate()`、`formatNumber()`，不要声明不完整的结构类型。
- JSX 中不能直接渲染动态 JSON 的 unknown/object 字段；例如 `rows[0]?.period`、`row.value`、`source.metadata` 必须先进入 `String()`、`formatDate()`、`formatNumber()` 或 `pickString()` 后再渲染。
- 不能用 `as any` 扫过类型错误；如果字段不确定，增加守卫函数或把数组显式标注为 `JsonRecord[]`。
- 如果页面新增公告、财务、估值、相关性、流动性等模块，代码必须满足严格 TypeScript，确保平台 build 不会报告 “Property does not exist on type ...”。

## 场景模板选择

开始实现前只消费当前任务需要的上下文：Task Packet 中的只读 run plan 关键字段、运行时注入的匹配场景模板段落，以及可视化判读的相关标题。若运行时未注入某项，再定向读取对应路径/标题；不得为了“完整了解”顺序全量读取 run plan、两份 reference 或所有业务文件。

按 `run_plan.visualization.templateId` 选择模板族；再按 `run_plan.visualization.variantId` 选择具体页面变体。`templateId` 解决“是什么场景”，`variantId` 解决“这一页应该长成什么结构”。如果缺失，按 final 数据字段推断模板族：

- `holding-analysis`：持仓、调仓、组合风险、截图持仓。
- `stock-selection`：选股、多标的横向比较、候选排序。
- `single-stock-diagnosis`：单只股票综合诊断。
- `technical-timing`：K 线、均线、突破、技术择时。
- `fundamental-research`：财务、基本面、盈利质量、公告。
- `strategy-research`：策略假设、信号实验、参数敏感性和研究设计。
- `backtest-review`：策略回测、净值、交易明细。
- `sector-rotation`：指数、ETF、行业和板块轮动。

选择模板后，页面必须覆盖该模板的 `required_components`。如果数据不足，组件仍要以“缺数据/待补充”的形式出现，不能直接删除。

同一模板族内可以有多个高质量变体，不要把所有问题都做成同一套万能页面：

- `single-stock-diagnosis`：综合指挥台、基本面快照。
- `technical-timing`：K 线交易观察台、突破观察清单。
- `fundamental-research`：财务质量账簿、报告期趋势看板。
- `stock-selection`：多标的排名矩阵、相关性与分散风险图谱、强弱与流动性筛选台。
- `sector-rotation`：板块轮动雷达、板块资金流观察台。
- `strategy-research`：策略假设画布、信号实验室。
- `backtest-review`：回测绩效复盘、交易行为复盘。
- `holding-analysis`：组合风险控制台、调仓计划工作台。

如果 `dashboard-data.json.visualization.variant_id` 与 run plan 不一致，以 run plan 为准；如果没有 variant 字段，则依据用户问题、`assets[]`/`comparison.rows[]`/`holdings[]`/`backtest` 等数据形态选择最接近的变体，并在页面结构上体现该变体的 `firstViewport` 和 `variant_guidance`。

## 标准数据契约

为了让平台预取、验证和标准模板稳定工作，优先使用下面字段；字段可以补充，但不要改名或只写自定义结构：

- 只读 `.quantpilot/run_plan.json` 的 `symbols` 是权威证券代码字符串数组，例如 `["600519"]`。如果需要保存名称、市场、secid，请放在 `resolvedSymbols[]` 或 final 数据中，不得回写 run plan。
- 单标的 final 数据必须包含：
  - `symbol`、`name`、`asset_type`、`source`、`as_of`
  - `quote.price`、`quote.change_percent`、`quote.quote_time`
  - `kline.bars[]`，每条包含 `date/open/high/low/close/volume/amount/change_percent`
  - `technicalIndicators.summary` 或 `computedMetrics`
  - 可选 `financials.reports[]`、`fundamentalIndicators.summary`、`announcements.announcements[]`
- 多标的 final 数据必须包含 `requestedSymbols`、`assets[]`、`comparison.rows[]`；每个 `assets[]` 元素继续使用同样的单标的结构。
- 多标的页面如果只拿到 4/5 只等部分标的，仍要展示覆盖摘要、缺失标的、失败原因和已成功标的对比；不能退回单股页，也不能只展示第一只标的。
- final 数据应包含 `visualization.template_id`、`visualization.variant_id`、`visualization.layout`、`visualization.first_viewport`、`visualization.required_components`、`visualization.rendered_components`、`visualization.missing_components`、`visualization.pain_points`。
- 多标的页面展示指标时优先使用 `comparison.rows[]` 的标准字段：`period_return`、`max_drawdown`、`volatility20d`、`avg_amount_20d/amount`、`turnover`、`composite_score`、`selection_view`；不要只从 `assets[].technicalIndicators.summary.return_120d_pct` 推断，避免字段名不一致导致页面显示错误排序。
- 页面优先保留平台标准模板的 `DATA_FILE`、`readDashboardData()`、`getBars()`、`TrendChart` 和 `data-source-file={DATA_FILE}` 结构，只在其上增强展示。
- 如果平台已经预取出 `dashboard-data.json`，不要再用空对象覆盖它，也不要把 `kline.bars` 改成只有模型自己知道的字段名。
- 页面展示实时行情字段时优先级必须正确：`quote.previous_close/open/high/low/amount/turnover/volume` 优先，只有 quote 缺失时才降级到 `kline.bars.at(-1)`；不要用最新收盘价冒充昨收，不要因为 K 线 amount/turnover 缺失而忽略 quote 中的成交额和换手率。
- 当 K 线字段来自不同 provider 且部分字段缺失时，应在数据质量或表格中真实显示缺口；可以用实时 quote 补充“今日”指标带，但不能把补充字段反写成历史 K 线事实。
- 指标带必须保留用户可读口径说明。收益、回撤、波动、胜率、仓位、ROE、换手率等比率类指标要说明时间窗口、覆盖对象和计算口径；不能裸写内部字段名、公式或“分子/分母”。
- 缺数据不是半成品。不要把大量 `-` 直接散落在首屏；关键指标缺失时使用“待接入/待确认/等待数据写入”等明确状态，并在图表区域保留专业空态，说明已预留 OHLC、均线、成交量或矩阵渲染区域。
- 空态也必须有设计质量：首屏仍要呈现标的、数据源、更新时间状态、指标框架、图表/矩阵占位和下一步可执行线索；不能退化成 Next.js 默认页、纯说明页或一堆灰色占位。

## A 股行情看板最低标准

如果用户的问题涉及 A 股个股、指数或组合，至少包含：

- 实时行情指标带：最新价、涨跌幅、开盘、最高、最低、昨收、成交量、成交额、市值、行情时间。
- K 线主图：蜡烛图或 OHLC 图，必须能区分涨跌；叠加 MA5、MA10、MA20 中至少两条均线。
- 成交量副图：与 K 线共用日期维度，涨跌颜色遵循 A 股习惯。
- 量化指标区：区间涨跌幅、最大回撤、年化/区间波动率、均线多空状态、放量/缩量提示、突破/跌破提示。
- 数据明细表：至少展示最近 10 根 K 线的日期、开高低收、成交额、涨跌幅、换手率。
- 数据状态与质量：展示 final 数据中的更新时间、样本长度、报告期、缺失字段和限制说明；渠道、端点、缓存状态与内部文件路径只保留在 evidence 后台证据中，不单独渲染信源卡片或列表。

## 多标的对比看板最低标准

如果最终数据包含 `assets[]` 或用户问题包含“对比/组合/相对强弱”，至少包含：

- 标的覆盖：页面显式展示 `requestedSymbols` 或 `assets[].symbol` 中的全部标的。
- 指标矩阵：每个标的展示最新价、涨跌幅、区间收益、最大回撤、波动、成交额或成交量。
- 对比图表：至少一个 SVG/canvas 图表比较区间收益；另一个图表或矩阵比较波动/回撤。
- 如果用户要求累计收益曲线，主图必须是多条折线共享同一日期轴和收益率刻度，基准日统一为窗口首日或明示的起点。
- 如果 `variantId` 是 `selection-correlation-risk-map`，或 required components 包含“相关性矩阵”，页面必须提供相关性热力图/矩阵，不能只写相关性结论文字。
- 多标的对比图必须有统一尺度、数值标签和正负方向；收益/回撤/波动条不能只画相对宽度而没有基线或数值。资产行内 K 线缩略图不算必备对比图。
- 相对强弱摘要：展示收益领先、回撤较小、波动较低等结果，结果必须来自 `comparison.rows[]` 或 `assets[].computedMetrics`。
- 数据状态与覆盖：逐只标的展示行情时间、样本量、成功/失败和缺失字段；渠道名称、接口类型与技术文件路径写入 evidence，不生成用户可见的逐渠道卡片。

## 财务看板最低标准

如果用户的问题涉及财务、基本面或业绩，至少包含：

- 营收、归母净利润、ROE、毛利率、EPS、同比增速指标带。
- 趋势图：营收和净利润至少一个折线/柱状组合图，ROE/毛利率至少一个趋势图。
- 报告期表格：展示报告期、营收、净利润、ROE、毛利率、同比。
- 简短分析摘要：只总结数据事实和风险提示，不构成投资建议。

## 推荐页面结构

通用结构只作为兜底。优先使用 `references/scenario_templates.md` 中对应场景的组件矩阵：

- 顶部：紧凑报告摘要、数据状态和场景结论。
- 中上：该场景最关键的痛点组件，例如持仓矩阵、候选矩阵、K 线主图、财务趋势或回测净值。
- 中部：图表、指标矩阵、风险或质量解释。
- 下部：明细表、缺失字段、样本口径、限制和非投资建议声明；信源端点与技术证据留在后台 evidence。

## 图表实现建议

不要为了图表额外安装依赖。优先使用以下方式：

- 用 SVG 实现 K 线、均线、成交量、折线、柱状图。
- 用 CSS grid/table 实现数据明细和指标矩阵。
- 尺寸必须响应式，图表容器要有稳定高度，避免数据加载后布局跳动。
- A 股颜色：上涨红色，下跌绿色，中性灰色。
- 所有涨跌、收益、回撤、风险和质量状态必须使用语义染色，不允许只靠文字表达。A 股涨跌使用红涨绿跌；回撤、风险暴露、亏损、缺失和失败要用绿色/红色/琥珀色等明确区分，且颜色含义在同一页面保持一致。
- K 线/OHLC 图必须有背景网格、价格刻度、日期刻度、MA 图例和 hover `title` 或等效 tooltip；成交量副图必须和 K 线共用涨跌颜色。
- 多标的柱状/横向对比图必须按正负或有利/不利分色，并展示数值标签，不能只给灰色进度条。
- 数据质量、缺失字段和限制说明要有状态色：`ok`/可用为绿色，`warning`/缺失为琥珀色，`error`/失败为红色。
- 图表必须有坐标/日期/价格标签或 tooltip/悬浮信息中的至少一种；金融主图建议同时具备坐标标签和 tooltip。
- 时间序列图不能切换或伪装成饼图；排名图必须有统一尺度和明确排序依据；双轴图必须说明左右轴指标，避免把价格、成交额和收益率混成一个刻度。
- tooltip 或 hover 信息要展示日期/报告期、标的、指标名称和格式化数值；不要把 `undefined`、对象字面量、内部字段名或未格式化大数暴露给用户。
- 图表旁边必须有数值摘要或表格 fallback。K 线/OHLC 的可访问性天然较弱，必须提供最近数据表和关键数值区。
- 多标的页中的 K 线缩略图必须保留足够宽度，数字不要被挤压成竖排；如果分区宽度不足，隐藏次要指标或改成横向滚动/表格，而不是让金额、MA 和百分比逐字断行。
- 实时/大量时序图表一次可见点位要克制；蜡烛图桌面建议不超过 500 根可见，移动端优先缩短窗口或分页/切换时间范围。
- 趋势、收益、风险、质量状态不能只靠颜色区分；同时使用文本、图例、图标、填充/描边差异或表格列。

## 视觉质量门槛

生成页面必须看起来像专业金融/量化工作台：

- 默认风格是 Continuous Financial Workbench：一个连续分析画布，中性底、细分区线、紧凑行情/指标带、占主导的图表或矩阵、可扫描表格。
- 禁止使用 card grid、重复悬浮白色圆角盒、阴影 tile、card 套 card；`section` / `article` 不应默认变成卡片。相邻内容优先共用边界，通过 `border-top` / `border-bottom` / 竖向分隔线和留白建立层级。
- 只有弹窗、popover、tooltip、显式告警和确实需要从画布脱离的临时状态可以使用独立容器；普通指标、财务项、持仓项和信号项应进入连续数据带、矩阵、表格或分栏。
- 首屏必须出现真实金融数据或可执行操作，不要用大 slogan、模板名、深色空卡或品牌 hero 占位。
- 首屏桌面端必须在 900px 高度内同时看到：核心结论/摘要、至少 4 个真实指标、一个图表/矩阵/表格入口和更新时间或数据状态。
- 首屏移动端必须在 844px 高度内看到：核心标的和价格、至少 2 个真实指标、一个核心图表/矩阵/表格主体；不能只看到标题、摘要栏和指标列表。
- 指标带列数必须与指标数量和容器宽度匹配；桌面端不得出现末行单个窄指标及其后的大片空白。换行后的每一行应均匀占满，数值不得逐字或按小数点拆行。
- 当真实指标暂缺时，至少 4 个核心指标位置必须显示明确的“待接入/待确认”状态，图表区域必须显示有信息量的空态文案，而不是只显示空坐标轴或 `-`。
- 主分析分区默认直角、无阴影；图表内框或控件可使用不超过 4px 的轻微圆角。避免大面积渐变、装饰背景、单色调页面和“报告封面式”布局。
- 关键数字使用 tabular/monospace 风格；长标题、长公告和长质量说明必须能换行、截断或在内部滚动，不得撑爆数据区。
- 颜色必须语义化：A 股涨跌可红涨绿跌；运行/信息用蓝，缺失/警告用 amber，失败/风险用 red，成功/可用用 emerald。
- 字体层级克制，工具型页面标题不要过大；数字使用 tabular/monospace 风格以减少跳动。
- 交互动效只用于 hover、展开、过滤、刷新、sheet/modal 进入退出；默认 150-300ms，尊重 reduced-motion。
- 375px、768px、1440px 下不能有文字重叠、按钮挤爆、表格遮挡或图表高度塌陷。
- 375px 移动端 `documentElement.scrollWidth` 不得大于 `clientWidth`；如果表格很宽，给 `.table-wrap` 设置 `overflow-x:auto; max-width:100%`，同时给 grid 子项设置 `min-width:0`。

## Next.js 代理示例

QuantPilot 新建项目默认已经预置同源代理和基础金融看板。如果下列文件已存在，优先复用并增强，不要重复创建冲突目录：

- `app/api/market/[...path]/route.ts`
- `app/page.tsx`
- `app/globals.css`

如果代理缺失，按下面示例创建：

```ts
// app/api/market/[...path]/route.ts
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const url = new URL(request.url);
  const target = new URL(`http://127.0.0.1:8000/api/v1/${path.join('/')}`);
  url.searchParams.forEach((value, key) => target.searchParams.set(key, value));
  const response = await fetch(target, { cache: 'no-store' });
  const body = await response.text();
  return new NextResponse(body, {
    status: response.status,
    headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/json' },
  });
}
```

前端调用：

```ts
await fetch('/api/market/quotes/realtime/600519', { cache: 'no-store' });
await fetch('/api/market/quotes/history/600519?period=daily&adjustment=qfq&limit=120', { cache: 'no-store' });
```

## 预置模板增强规则

1. 优先保留 `data_file/final/dashboard-data.json` 的读取逻辑。
2. 可以扩展 `TrendChart`、连续指标带、数据表和用户可读的数据口径说明，但不要退回静态样例页、渠道证据卡片或卡片网格。
3. 如果任务涉及指数或 ETF，保留 `asset_type`、数据时间/质量、K 线、成交量和技术指标展示；渠道明细仍只写入 evidence。
4. 如果任务涉及个股基本面，再补充财务趋势、ROE/毛利率和公告列表。
5. 如果任务涉及多标的，优先读取 `assets[]` 和 `comparison`，保留单标的主图作为可选细节，不要把多标的页面降级成主标的页面。
6. 页面最终仍需通过平台自动验证：build、HTTP 200、final 数据、evidence、图表和 `/api/market`。
7. 页面必须通过产物策略验证：无外部 CDN/远程资源、无 mock/static 数据、无明文密钥，且保留 `.quantpilot/run_plan.json`、final 数据和 evidence 标准产物。

## 生成页面验收清单

提交前逐项自检：

- `app/page.tsx` 包含 `data_file/final/dashboard-data.json` 或 `/api/market` 数据入口。
- `app/page.tsx` 包含 `<svg>` 或 `<canvas>` 图表实现，且不是装饰性占位图。
- 趋势类任务包含 K 线/OHLC、成交量和至少两条均线。
- 财务类任务包含财务趋势、报告期表格和连续指标带。
- 回测类任务包含净值曲线、回撤/收益/胜率、交易明细和参数假设。
- 多标的、组合或风控类任务如果 final 数据包含 `correlation`，页面必须展示相关性矩阵或 Top pairs；如果包含 `liquidity`，页面必须展示成交额、换手代理、Amihud 或流动性等级。
- 如果 final 数据包含 `valuation`，页面必须展示防守/中性/进攻估值情景、核心假设和缺失字段 warning，不要把情景价包装成承诺收益。
- 如果 final 数据包含 `trendTemplate`，页面必须展示趋势状态、样本长度、MA20/MA60、回撤、量能比和确认/减仓/观察触发条件。
- 页面必须展示或隐式覆盖 `visualization.required_components`，并把无法渲染的组件写入数据质量或缺口说明。
- 页面展示更新时间、样本量、报告期或数据质量限制；渠道、缓存状态、端点和文件路径只写入后台 evidence，不生成独立信源/技术证据分区。
- 页面不展示场景模板名称、模板 ID、必备组件清单或“已渲染”状态。
- 连续指标带没有桌面端 `N + 1` 孤项、大面积空白、数字竖排或数值拆行。
- 没有 Next.js 默认页文案，没有 `SAMPLE_DATA`、`MOCK_DATA`、`STATIC_QUOTES` 等静态样例数据。
- 没有 `https://cdn...`、`unpkg`、`jsdelivr`、`cdnjs`、远程 `<script>`、远程 `<link>`、远程字体或浏览器直连 `http(s)` 接口。
- 不修改父级 QuantPilot 平台工程，只修改当前生成项目。

## 禁止事项

- 不要编造行情、财报、公告、K 线。
- 不要只写说明文字而不生成页面。
- 不要把图表做成静态截图。
- 不要只做“趋势占位区”；必须呈现真实数据或真实错误状态。
- 不要创建和任务无关的示例项目。
- 不要修改父级 QuantPilot 平台工程。
- 不要启动开发服务器；QuantPilot 会管理预览服务。
- 不要通过 Bash 重定向或 heredoc 写源码文件；这会破坏平台的过程记录和自动验证。
- 不要通过 CDN 或远程 npm 模块加载图表库；金融图表优先用平台模板内置的 SVG/CSS/React 组件实现。
