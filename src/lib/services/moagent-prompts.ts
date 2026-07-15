import fs from 'fs/promises';
import path from 'path';
import { getQuantCapability } from '@/lib/quant/capabilities';
import { readQuantRunPlan, type QuantRunPlan } from '@/lib/quant/workspace';
import { serializeQuantVisualizationTemplate } from '@/lib/quant/visualization-templates';

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

type QuantManifest = {
  quant?: {
    capabilityId?: string;
    agentType?: string;
    subAgentKey?: string;
    requiredSkills?: string[];
    dataEndpoints?: string[];
    expectedArtifacts?: string[];
    validationRules?: string[];
  };
};

export async function readQuantPilotManifest(projectPath: string): Promise<QuantManifest | null> {
  try {
    const content = await fs.readFile(path.join(projectPath, '.quantpilot', 'manifest.json'), 'utf8');
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? (parsed as QuantManifest) : null;
  } catch {
    return null;
  }
}

function buildCapabilityContext(
  manifest: QuantManifest | null,
  runPlan: QuantRunPlan | null = null,
): string {
  const quant = manifest?.quant;
  const runCapabilityId = runPlan?.requestedCapabilityId ?? runPlan?.capabilityId;
  const capability = getQuantCapability(runCapabilityId ?? quant?.capabilityId);
  const shouldInheritManifest = !runCapabilityId || quant?.capabilityId === capability.id;
  const requiredSkills = shouldInheritManifest && quant?.requiredSkills?.length
    ? quant.requiredSkills
    : capability.requiredSkills;
  const validationRules = runPlan?.validationRules?.length
    ? runPlan.validationRules
    : shouldInheritManifest && quant?.validationRules?.length
      ? quant.validationRules
      : capability.validationRules;
  const serializedTemplate = serializeQuantVisualizationTemplate(capability.id, {
    instruction: runPlan?.question,
    symbolCount: runPlan?.symbols?.length,
    requestedVariantId: runPlan?.visualization?.variantId,
    dataSignals: runPlan?.visualization?.dataSignals,
  });
  const visualization = {
    templateId: runPlan?.visualization?.templateId ?? serializedTemplate.templateId,
    variantId: runPlan?.visualization?.variantId ?? serializedTemplate.variantId,
    variantName: runPlan?.visualization?.variantName ?? serializedTemplate.variantName,
    scenario: runPlan?.visualization?.variantScenario ?? serializedTemplate.variantScenario,
    layout: runPlan?.visualization?.layout ?? serializedTemplate.layout,
    density: runPlan?.visualization?.density ?? serializedTemplate.density,
    firstViewport: runPlan?.visualization?.firstViewport ?? serializedTemplate.firstViewport,
    guidance: runPlan?.visualization?.variantGuidance ?? serializedTemplate.variantGuidance,
    painPoints: runPlan?.visualization?.painPoints ?? serializedTemplate.painPoints,
    components: runPlan?.visualization?.panels?.length
      ? runPlan.visualization.panels
      : serializedTemplate.requiredComponents,
  };

  return `任务合同：
- 能力：${capability.id} / ${capability.name}；执行能力：${runPlan?.executionCapabilityId ?? capability.executionCapabilityId}
- 标的：${runPlan?.symbols?.join(', ') || '以只读运行计划为准'}
- 必需能力：${requiredSkills.join(', ')}
- 页面模板：${visualization.templateId} / ${visualization.variantId}（${visualization.variantName}）
- 场景：${visualization.scenario}
- 布局与密度：${visualization.layout} / ${visualization.density}
- 首屏：${visualization.firstViewport.join('；')}
- 必备内容：${visualization.components.join('；')}
- 场景约束：${visualization.painPoints.join('；')}
- 变体指导：${visualization.guidance.join('；')}
- 验收：${validationRules.join('；')}`;
}

export async function hasPlatformPreparedQuantArtifacts(
  projectPath: string,
  runPlan?: QuantRunPlan | null,
): Promise<boolean> {
  const normalizedProjectPath = path.resolve(projectPath);
  const authoritativePlan = runPlan ?? await readQuantRunPlan(normalizedProjectPath);
  if (authoritativePlan?.status !== 'planned') return false;
  const readiness = await Promise.all([
    'data_file/final/dashboard-data.json',
    'evidence/sources.json',
    'evidence/data_quality.json',
  ].map((relativePath) => pathExists(path.join(normalizedProjectPath, relativePath))));
  return readiness.every(Boolean);
}

export async function buildQuantPilotTaskPrompt(
  instruction: string,
  projectPath: string,
  manifest: QuantManifest | null = null,
): Promise<string> {
  const normalizedProjectPath = path.resolve(projectPath);
  const runPlan = await readQuantRunPlan(normalizedProjectPath);
  const prepared = await hasPlatformPreparedQuantArtifacts(normalizedProjectPath, runPlan);
  const capabilityContext = buildCapabilityContext(manifest, runPlan);
  const modeConstraints = prepared
    ? `平台预取模式：
- 平台已准备真实 final/evidence；它们是权威输入。不得重复取数、重写计划或覆盖数据。
- 平台会随任务注入 initial_dashboard_contract，包含计划、数据/evidence 摘要、页面合同和源码 outline；直接据此工作，不要重复检查。仅当快照标记缺失/失败时才调用 inspect_dashboard_contract。
- final/evidence 如确需细节，只用 query_json 查询精确 JSON Pointer；禁止用 read_file/read_file_range 顺序扫描这些大 JSON。
- 页面源码优先用 query_text_file 按组件、函数或 CSS selector 锚点取上下文；只读取待修改位置，禁止遍历完整 page.tsx/globals.css。
- 若需求只是视觉/布局重构且页面合同完整，不查询业务 JSON 或 evidence；基于 initial_dashboard_contract，最多各用一次批量锚点查询定位页面根节点和相关 CSS，然后直接做一次连贯编辑。
- 在现有标准模板上做一次连贯编辑，保留 DATA_FILE、readDashboardData、getBars、TrendChart、data-source-file 和同源 market proxy 合同。
- 不创建 Todo，不调用行情 API，不运行 build/preview，不做无关 list/search；平台负责最终验证。`
    : `数据准备模式：
- 先遵循只读 run plan，通过 quant_api_get 和本次 capability skills 获取真实数据；数据库只允许由 QuantPilot API 访问。
- 完成 data_file/final/dashboard-data.json、evidence/sources.json、evidence/data_quality.json 后，再调用 inspect_dashboard_contract 并定向编辑页面。
- API 查询参数使用 query 对象；不得连接数据库、读取凭据、调用外部 CDN 或编造缺失数据。`;

  return `${instruction}

工作目录：${normalizedProjectPath}
平台预取产物：${prepared ? '已完成' : '未完成'}

${capabilityContext}

执行策略：
${modeConstraints}

视觉语言（硬约束）：
- 采用专业交易终端/投研工作台的连续画布：顶部行情带、主图工作区、侧栏或下方研究区，以细分隔线、对齐和留白建立层级。
- 禁止卡片宫格：不要把每个指标、结论、图表、来源分别包成圆角浮层；不要批量使用 card、shadow、gradient、glass、巨大圆角和胶囊标签。
- 指标做成同一行情带中的列或表格单元；图表使用共享坐标与连续面板；研究内容使用章节、表格、时间线和分隔栏。
- 首屏必须出现真实行情和核心主图/矩阵，不能是 hero、slogan、模板名横幅或一排指标卡。桌面端信息密集，移动端重排为连续纵向章节且页面无横向溢出。
- A 股红涨绿跌；颜色只表达语义，排版、边框和数值对齐承担主要层级。图表尺寸稳定，宽表仅在自身容器内滚动。

业务与代码底线：
- \`.quantpilot/**\` 永远只读；所有写操作限定在当前项目，绝不修改父级平台。
- 若计划为 needs_clarification，只问 1-3 个剩余问题并停止。否则可解析的证券名称和“最近怎么样”已构成完整任务，不重新追问或改写计划。
- 昨收/开高低/成交额/换手优先使用 quote 字段；缺失值显示真实缺口，绝不硬编码或臆造行情。
- 多标的必须覆盖全部 assets/comparison；单标的不得因名称别名被改成多标的。未明确要求时，不增加买入区间、止损、目标价、仓位或确定性收益建议。
- 动态 JSON 每层使用 JsonRecord/asRecord/asArray/numeric 守卫，JSX 不直接渲染 unknown；保持严格 TypeScript 可构建。
- 只用已注册的 typed tools 写文件；不使用 shell。完成必要源码编辑后立即调用 submit_result，中文摘要简短列出产物，不再继续探索。`;
}

export function buildQuantPilotSystemPrompt(): string {
  return `You are MoAgent, QuantPilot's first-party workspace agent.
- Build a real Next.js 16 App Router quantitative interface in the provided workspace. Use strict TypeScript and the existing local CSS/toolchain; add no styling dependency or remote asset.
- The workspace boundary and typed-tool policy are absolute. Never edit the parent platform, read credentials, use shell/subprocesses, or mutate \`.quantpilot/**\`.
- The platform run plan, final data, and evidence are authoritative. Preserve real data binding and same-origin market proxy contracts; never fabricate, hard-code, or silently replace missing financial data.
- Start from the injected initial_dashboard_contract; call inspect_dashboard_contract only when that snapshot is absent or reports a failed/missing contract. Query structured artifacts or anchored source directly; do not enumerate the workspace or sequentially read large files.
- For a visual-only refinement with a complete contract, do not query financial JSON/evidence; locate the root JSX and relevant CSS anchors in at most two batched source queries, then edit.
- Design a continuous, data-dense trading/research terminal—not a card gallery. Use aligned quote strips, shared chart workspaces, tables, timelines, section rails, hairline dividers, and restrained square surfaces. Avoid repeated rounded cards, shadows, gradients, glass effects, giant hero text, decorative badges, and metric-card grids.
- The first 1440px viewport must expose the core market/portfolio/backtest/fundamental evidence and its main chart or matrix. Use red-up/green-down for A shares, stable chart dimensions, accessible contrast, and responsive reflow without page-level horizontal overflow.
- Preserve the planned scenario/template and all required components. Do not invent execution advice unless explicitly requested. Show source, time, limitations, loading/error/empty states, and honest data gaps.
- Keep visible Chinese narration to one short plan and meaningful milestones. Do not reveal hidden reasoning or narrate tools.
- The platform owns build, preview, and validation. Make the smallest coherent source edit that satisfies the contract, then call submit_result with a concise Chinese summary and artifact paths; never stop before the terminal tool.`;
}
