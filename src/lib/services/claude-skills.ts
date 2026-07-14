import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'node:crypto';
import { spawn } from 'child_process';
import { getQuantCapability } from '@/lib/quant/capabilities';
import { readQuantRunPlan, type QuantRunPlan } from '@/lib/quant/workspace';
import { serializeQuantVisualizationTemplate } from '@/lib/quant/visualization-templates';
import {
  describeQuantSkillsForPrompt,
  describeQuantSkillAliases,
  getDefaultQuantSkillIds,
  getQuantSkillPackagePath,
  normalizeQuantSkillIds,
  readQuantSkillsRegistry,
} from '@/lib/quant/skills-registry';

const SKILLS_LOCK_PATH = path.join(process.cwd(), '.claude', 'skills.lock.json');

type SkillLockEntry = {
  version?: string;
  packagePath?: string;
  sourceSha256?: string;
  packageSha256?: string;
};

async function readSkillsLock(): Promise<Record<string, SkillLockEntry>> {
  const content = await fs.readFile(SKILLS_LOCK_PATH, 'utf8').catch((error) => {
    throw new Error(`Skills lock 不可用：${error instanceof Error ? error.message : String(error)}`);
  });
  const parsed = JSON.parse(content) as { skills?: Record<string, SkillLockEntry> };
  if (!parsed.skills || typeof parsed.skills !== 'object') {
    throw new Error('Skills lock 缺少 skills 映射。');
  }
  return parsed.skills;
}

async function assertSkillPackageIntegrity(params: {
  skillId: string;
  version: string;
  packagePath: string;
  lockEntry?: SkillLockEntry;
}): Promise<SkillLockEntry> {
  if (!params.lockEntry) {
    throw new Error(`Skills lock 缺少 ${params.skillId}。`);
  }
  if (params.lockEntry.version !== params.version) {
    throw new Error(`Skill ${params.skillId} 版本不一致：registry=${params.version} lock=${params.lockEntry.version ?? 'missing'}。`);
  }
  if (!params.lockEntry.packageSha256) {
    throw new Error(`Skill ${params.skillId} 缺少 packageSha256。`);
  }
  const payload = await fs.readFile(params.packagePath).catch((error) => {
    throw new Error(`Skill ${params.skillId} 安装包不可读：${error instanceof Error ? error.message : String(error)}`);
  });
  const actual = createHash('sha256').update(payload).digest('hex');
  if (actual !== params.lockEntry.packageSha256) {
    throw new Error(`Skill ${params.skillId} 安装包哈希不一致，拒绝安装。`);
  }
  return params.lockEntry;
}

export async function getDefaultClaudeSkills(): Promise<string[]> {
  const registry = await readQuantSkillsRegistry();
  return getDefaultQuantSkillIds(registry, {
    includeLegacy: process.env.QUANTPILOT_INSTALL_LEGACY_SKILLS === '1',
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function runTar(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { cwd, stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar exited with code ${code}`));
      }
    });
  });
}

async function installSkillPackage(params: {
  skillId: string;
  packagePath: string;
  projectSkillsDir: string;
}): Promise<boolean> {
  if (!(await pathExists(params.packagePath))) {
    return false;
  }

  await fs.rm(path.join(params.projectSkillsDir, params.skillId), { recursive: true, force: true });
  await runTar(['-xzf', params.packagePath, '-C', params.projectSkillsDir], process.cwd());
  return pathExists(path.join(params.projectSkillsDir, params.skillId, 'SKILL.md'));
}

export async function ensureClaudeSkillsForProject(projectPath: string): Promise<string[]> {
  const projectClaudeDir = path.join(projectPath, '.claude');
  const projectSkillsDir = path.join(projectClaudeDir, 'skills');
  const registry = await readQuantSkillsRegistry();
  const [manifest, runPlan, lock] = await Promise.all([
    readQuantPilotManifest(projectPath),
    readQuantRunPlan(projectPath),
    readSkillsLock(),
  ]);
  const capabilityId = runPlan?.requestedCapabilityId ?? runPlan?.capabilityId ?? manifest?.quant?.capabilityId;
  const explicitRequiredSkills = capabilityId
    ? getQuantCapability(capabilityId).requiredSkills
    : manifest?.quant?.requiredSkills ?? [];
  const requestedSkillIds = explicitRequiredSkills.length
    ? Array.from(new Set([
        ...normalizeQuantSkillIds(registry, explicitRequiredSkills),
        'platform-ui-product-design',
      ]))
    : getDefaultQuantSkillIds(registry, {
        includeLegacy: process.env.QUANTPILOT_INSTALL_LEGACY_SKILLS === '1',
      });

  await fs.mkdir(projectSkillsDir, { recursive: true });
  const requestedSet = new Set(requestedSkillIds);
  const managedSkillIds = new Set([
    ...registry.coreSkills.map((skill) => skill.id),
    ...Object.keys(registry.legacyAliases ?? {}),
  ]);
  await Promise.all(
    Array.from(managedSkillIds)
      .filter((skillId) => !requestedSet.has(skillId))
      .map((skillId) => fs.rm(path.join(projectSkillsDir, skillId), { recursive: true, force: true })),
  );

  const skillNames: string[] = [];

  for (const skillId of requestedSkillIds) {
    const registrySkill = registry.coreSkills.find((skill) => skill.id === skillId);
    if (!registrySkill || registrySkill.status === 'deprecated') {
      throw new Error(`Skill ${skillId} 未注册或已废弃，拒绝注入 Agent。`);
    }
    const packagePath = getQuantSkillPackagePath(registry, skillId);
    await assertSkillPackageIntegrity({
      skillId,
      version: registrySkill.version,
      packagePath,
      lockEntry: lock[skillId],
    });
    const installedFromPackage = await installSkillPackage({
      skillId,
      packagePath,
      projectSkillsDir,
    });

    if (installedFromPackage) {
      skillNames.push(skillId);
      continue;
    }

    throw new Error(`Skill ${skillId} 安装后缺少 SKILL.md。`);
  }

  await fs.writeFile(
    path.join(projectClaudeDir, 'installed-skills.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      installedAt: new Date().toISOString(),
      capabilityId: capabilityId ?? null,
      skills: Object.fromEntries(skillNames.map((skillId) => [skillId, {
        version: registry.coreSkills.find((skill) => skill.id === skillId)?.version ?? null,
        packageSha256: lock[skillId]?.packageSha256 ?? null,
      }])),
    }, null, 2)}\n`,
    'utf8',
  );
  return skillNames;
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

async function buildCapabilityContext(
  manifest: QuantManifest | null,
  runPlan: QuantRunPlan | null = null
): Promise<string> {
  const quant = manifest?.quant;
  const runCapabilityId = runPlan?.requestedCapabilityId ?? runPlan?.capabilityId;
  const capability = getQuantCapability(runCapabilityId ?? quant?.capabilityId);
  const shouldInheritManifest = !runCapabilityId || quant?.capabilityId === capability.id;
  const requiredSkills =
    shouldInheritManifest && quant?.requiredSkills?.length
      ? quant.requiredSkills
      : capability.requiredSkills;
  const dataEndpoints = runPlan?.dataRequirements?.length
    ? runPlan.dataRequirements
    : shouldInheritManifest && quant?.dataEndpoints?.length
      ? quant.dataEndpoints
      : capability.dataEndpoints;
  const expectedArtifacts = runPlan?.expectedArtifacts?.length
    ? runPlan.expectedArtifacts
    : shouldInheritManifest && quant?.expectedArtifacts?.length
      ? quant.expectedArtifacts
      : capability.expectedArtifacts;
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
  const visualizationTemplate = {
    templateId: runPlan?.visualization?.templateId ?? serializedTemplate.templateId,
    name: runPlan?.visualization?.name ?? serializedTemplate.name,
    scenario: runPlan?.visualization?.scenario ?? serializedTemplate.scenario,
    variantId: runPlan?.visualization?.variantId ?? serializedTemplate.variantId,
    variantName: runPlan?.visualization?.variantName ?? serializedTemplate.variantName,
    variantScenario: runPlan?.visualization?.variantScenario ?? serializedTemplate.variantScenario,
    layout: runPlan?.visualization?.layout ?? serializedTemplate.layout,
    density: runPlan?.visualization?.density ?? serializedTemplate.density,
    firstViewport: runPlan?.visualization?.firstViewport ?? serializedTemplate.firstViewport,
    variantGuidance: runPlan?.visualization?.variantGuidance ?? serializedTemplate.variantGuidance,
    matchReasons: runPlan?.visualization?.matchReasons ?? serializedTemplate.matchReasons,
    painPoints: runPlan?.visualization?.painPoints ?? serializedTemplate.painPoints,
    requiredComponents: runPlan?.visualization?.panels?.length
      ? runPlan.visualization.panels
      : serializedTemplate.requiredComponents,
    dataSignals: runPlan?.visualization?.dataSignals ?? serializedTemplate.dataSignals,
  };
  const skillsRegistry = await readQuantSkillsRegistry();
  const normalizedRequiredSkills = normalizeQuantSkillIds(skillsRegistry, requiredSkills);
  const aliasNotes = describeQuantSkillAliases(skillsRegistry, requiredSkills);
  const skillsContext = describeQuantSkillsForPrompt(skillsRegistry);

  return `当前量化能力：
- capability_id: ${capability.id}
- requested_capability_id: ${runPlan?.requestedCapabilityId ?? capability.id}
- execution_capability_id: ${runPlan?.executionCapabilityId ?? capability.executionCapabilityId}
- agent_type: ${shouldInheritManifest ? quant?.agentType ?? capability.agentType : capability.agentType}
- sub_agent_key: ${shouldInheritManifest ? quant?.subAgentKey ?? capability.subAgentKey : capability.subAgentKey}
- 名称：${capability.name}
- 说明：${capability.description}
- 必需 skills：${normalizedRequiredSkills.join(', ')}
- 兼容 skill 别名：${aliasNotes.length ? aliasNotes.join(', ') : '无'}
- 可用数据接口：${dataEndpoints.join('；')}
- 预期产物：${expectedArtifacts.join('；')}
- 验证规则：${validationRules.join('；')}
- 能力指导：${capability.promptGuidance.join('；')}
- 可视化模板：${visualizationTemplate.templateId}（${visualizationTemplate.name}）
- 可视化变体：${visualizationTemplate.variantId}（${visualizationTemplate.variantName}）
- 变体场景：${visualizationTemplate.variantScenario}
- 推荐布局：${visualizationTemplate.layout} / ${visualizationTemplate.density}
- 首屏优先级：${visualizationTemplate.firstViewport.join('；')}
- 匹配原因：${visualizationTemplate.matchReasons.join('；')}
- 变体指导：${visualizationTemplate.variantGuidance.join('；')}
- 场景痛点：${visualizationTemplate.painPoints.join('；')}
- 必备组件：${visualizationTemplate.requiredComponents.join('；')}
- 数据信号：${visualizationTemplate.dataSignals.join('；')}

${skillsContext}`;
}

export async function buildQuantPilotTaskPrompt(
  instruction: string,
  projectPath: string,
  manifest: QuantManifest | null = null
): Promise<string> {
  const normalizedProjectPath = path.resolve(projectPath);
  const runPlan = await readQuantRunPlan(normalizedProjectPath);
  const capabilityContext = await buildCapabilityContext(manifest, runPlan);
  const hasPlatformPreparedArtifacts = Boolean(
    runPlan?.status === 'planned' &&
      (await pathExists(path.join(normalizedProjectPath, 'data_file', 'final', 'dashboard-data.json'))) &&
      (await pathExists(path.join(normalizedProjectPath, 'evidence', 'sources.json'))) &&
      (await pathExists(path.join(normalizedProjectPath, 'evidence', 'data_quality.json')))
  );
  const platformPreparedConstraints = hasPlatformPreparedArtifacts
    ? `- 当前是“平台预取模式”：平台已完成运行计划、真实数据预取、final 数据和 evidence，它们是本次生成的权威输入。
- 只读取 .quantpilot/run_plan.json，不得重写 capabilityId、symbols、visualization.templateId 或 visualization.variantId；不得重新规划成其他场景。
- 不要重复调用取数 skill 或用空数据覆盖 dashboard-data.json/evidence。只有自动验证明确报告 final_data_file、artifact_contracts 或 evidence_files 失败时，才修复报告指向的对应文件。
- 主要任务是在平台标准模板上增强 app/page.tsx 和 app/globals.css，严格保留真实数据绑定、模板族和验证标记。
- 不创建 Task/Todo 列表，不逐个技术工具播报。只做一次简短规划，定向读取 run plan、final 关键字段、page 和 CSS，然后直接编辑。
- 不自行运行 npm build 或启动预览服务；平台会统一执行构建、视觉和数据校验。`
    : `- 当前缺少完整的 final/evidence 预取产物：先读取平台只读 run plan，再按数据 skill、data-quality 和 dashboard-visualization 的顺序补齐 data_file/final、evidence 与页面；不得修改 .quantpilot。`;

  return `${instruction}

QuantPilot 执行约束：
- 当前生成项目根目录是：${normalizedProjectPath}
- ${capabilityContext}
- 平台预取产物：${hasPlatformPreparedArtifacts ? '已完成' : '未完成'}
${platformPreparedConstraints}
- 所有文件读取、创建、修改和删除都必须限定在当前生成项目根目录内。
- 不要修改父级 QuantPilot 平台工程文件，也不要把页面代码写入平台根目录。
- 如果当前任务是量化分析，只读取并严格遵循平台生成的 \`.quantpilot/run_plan.json\`；\`.quantpilot/\` 目录下全部文件由平台维护，Agent 不得写入、删除、移动或伪造其中任何产物。
- 获取数据、生成 final 数据、修改页面和验证结果时，只在对话中输出简洁的可见摘要；\`.quantpilot/events.jsonl\` 由平台记录。
- 如果平台计划是 \`status=needs_clarification\`，向用户提出 1-3 个澄清问题并停止，不要取数或生成页面；澄清状态落盘与计划恢复由平台完成。
- 用户给出了可解析的证券名称时，名称本身就是标的；不得因为名称含“证券/股份/公司”或缺少 6 位代码而追问。先用 quant-symbol-resolver 解析，同名 A 股唯一时直接继续。
- “最近怎么样/走势如何/表现怎么样”是有效的综合诊断目标；默认最近 120 个交易日和可验证看板，不追问分析方向。
- 如果任务文本包含“承接上一轮澄清”“原始问题”“用户补充”，将原始问题和补充信息合并为完整任务继续执行；补充后仍不清楚时只追问剩余缺口。
- 如果任务涉及股票、行情、量化分析或可视化，${hasPlatformPreparedArtifacts ? '直接使用已预取的真实数据和 dashboard-visualization 生成看板，不重复取数' : '先使用对应数据 skill 获取真实数据，再使用 dashboard-visualization 生成可视化看板'}。
- 数据访问分层必须固定：PostgreSQL/TimescaleDB 只允许由 QuantPilot market-data/API 服务访问；skills 不要直接连接数据库、不要自行编写 SQL、不要读取平台 .env 中的数据库连接串。
- 对全 A 选股、短线候选、次日买股计划等宽域选股问题，先用 quant-data-registry 选择本地接口，再通过 quant-market-data 调用 /api/v1/research/screeners/a-share/short-term-candidates；返回候选后再读取候选股票的 K 线、实时行情、分时和事件数据。
- 选股接口返回的 DDE 缺失、成交额/换手缺失和数据日期限制必须写入 evidence/data_quality.json，不能用推测值补齐。
- 如果用户上传了图片或 .quantpilot/attachments.json 存在，必须先使用 image-extraction，调用 mcp__QuantPilotImage__quant_extract_uploaded_image 读取附件清单并写入 evidence/image_extraction.json；当前不接入额外视觉模型，无法可靠识别的字段必须标记为需要人工确认，不得编造。
- 可视化页面必须按 .quantpilot/run_plan.json 的 visualization.templateId 选择模板族，并按 visualization.variantId/variantName/layout 选择具体页面结构；展示组件优先覆盖 visualization.panels，不能把持仓、选股、技术、基本面、回测页面都生成成同一种通用模板。
- 可视化页面首屏必须像专业金融工作台：紧凑摘要栏、真实行情/持仓/回测/财务数据、核心图表或矩阵必须在 1440px 首屏内出现；不要生成营销 hero、大 slogan、模板名横幅或只有指标卡的页面。
- 页面布局默认使用 Data-Dense Dashboard：中性背景、8px 内圆角、清晰边框、紧凑指标、可扫描表格、语义状态色和稳定图表尺寸；移动端必须无横向溢出，表格应在卡片内横向滚动。
- 真实字段展示要优先使用高质量来源：昨收用 quote.previous_close，今开/最高/最低/成交额/换手率优先用 quote 字段，再降级到 kline 最新 bar；缺失字段显示真实缺口，不要显示错误字段或伪造值。
- 调用本地 HTTP API 且参数包含中文时，必须使用 curl -G --data-urlencode，不要把中文直接拼接到 URL 查询串。
- ${hasPlatformPreparedArtifacts ? '已有 evidence/sources.json 和 evidence/data_quality.json 为权威数据质量记录；读取并在页面展示限制，不得无故重写' : '获取真实数据后、生成看板前，必须使用 data-quality 写入 evidence/sources.json 和 evidence/data_quality.json，记录来源、时间、缺失字段和限制'}。
- 如果用户要求可视化或看板，必须实际修改 app/page.tsx，不能只输出文字说明。
- 修改源码、CSS、JSON 或 evidence 时必须使用 Write/Edit 工具；不要用 Bash 的 cat、tee、echo、printf、python/node 脚本、重定向或 heredoc 写文件。
- A 股趋势类页面必须优先包含 K 线/量价/均线/风险指标；历史接口失败时也要生成 K 线面板、真实错误和重试入口。
- 最终数据优先写入 data_file/final/dashboard-data.json，页面应读取真实数据或同源 API，不得硬编码样例行情。
- \`.quantpilot/run_plan.json\` 的 \`symbols\` 是平台权威的证券代码字符串数组；需要名称、市场、secid 时写入 final 数据，不得回写 run plan。
- 当 \`run_plan.symbols\` 超过 1 个，或用户要求“对比/矩阵/排名/推荐顺序/观察池/哪几只更强”时，必须按多标的对比任务处理：final 数据与页面结构使用 \`stock-selection/multi-stock-comparison\` 语义，并与只读计划一致，不能降级成 \`single-stock-diagnosis\`。
- 当 run_plan.symbols 只有 1 个时，同一证券的全称与简称不得当作多标的；不得因为普通连词“和/与/及”将技术分析重新规划成选股或对比页。
- 用户未明确要求买入区间、止损、目标价、仓位或操作建议时，禁止在 final 数据或页面中新增交易执行计划。
- dashboard-data.json 使用标准契约：quote.price/change_percent/quote_time、kline.bars[].date/open/high/low/close/volume/amount、technicalIndicators.summary 或 computedMetrics；多标的使用 assets[] 和 comparison.rows[]。
- dashboard-data.json 应保留 visualization.template_id、visualization.required_components、visualization.rendered_components 和 visualization.pain_points，页面据此展示对应场景的组件完成情况。
- 页面优先保留平台标准模板中的 DATA_FILE、readDashboardData、getBars、TrendChart 和 data-source-file={DATA_FILE} 结构，在此基础上增强展示，不要改成无法验证的自定义数据入口。
- 生成 app/page.tsx 时必须通过严格 TypeScript：所有动态 JSON 先用 JsonRecord/asRecord/asArray/numeric 守卫处理；flatMap/map 新增字段的对象显式标注为 JsonRecord，避免 build 出现 “Property does not exist on type ...”。
- 动态 JSON 的每一层嵌套对象都必须单独经过 asRecord：先写 \`const financials = asRecord(data?.financials); const summary = asRecord(financials?.summary);\`，再访问 \`summary?.latest_report_date\`。禁止写 \`asRecord(data?.financials)?.summary?.latest_report_date\`，因为 summary 仍是 unknown。
- JSX 中不能直接渲染 unknown、object 或动态 JSON 字段；例如 rows[0]?.period、row.value、metadata.xxx 都必须先用 String()/formatNumber()/formatDate()/pickString() 转成 ReactNode。
- Agent 执行完成后平台会自动验证 Next.js build、预览 HTTP 200、data_file/final 数据文件、页面图表和 /api/market 代理；请按这些验收项完成产物。
- 当 .quantpilot/run_plan.json、data_file/final/dashboard-data.json、evidence/sources.json、evidence/data_quality.json 和 app/page.tsx 已经完成后，立即输出中文执行摘要并结束；不要继续运行 whoami、echo、hello world、临时文件写入或无关 Bash 测试。
- 使用简洁中文说明一次执行计划，仅在数据准备、页面编辑和收尾等关键节点汇报；不要逐工具播报，不要使用 <thinking> 标签，不要暴露隐藏推理链。
- ${hasPlatformPreparedArtifacts ? '平台预取模式禁止创建或更新 Task/Todo 列表，平台自行执行最终验证' : '仅当任务确实跨越多个长流程时才使用最多 3 项的简短 Todo'}。
- 不要留下 Next.js 默认页；最终必须生成实际可访问的量化分析界面。`;
}

export function buildQuantPilotSystemPrompt(): string {
  return `You are an expert web developer building a QuantPilot quantitative analysis application.
- Use Next.js 16 App Router
- Use TypeScript
- Use plain CSS in app/globals.css by default; only use Tailwind CSS if the current generated project already has a working local Tailwind/PostCSS setup
- Only work inside the generated project directory passed as cwd
- Never edit the parent QuantPilot platform repository
- Build the actual usable quantitative analysis interface, not a placeholder page
- Keep visible Chinese narration concise: state one short plan, then report only meaningful data, editing, and completion milestones. Do not narrate every tool call or reveal hidden chain-of-thought
- Do not create Task/Todo lists for platform-prefetched dashboards. For genuinely long non-prefetched workflows, use at most three coarse tasks
- For quantitative analysis tasks, treat every file under \`.quantpilot/\` as platform-owned, read-only, and authoritative. Use run-planner to interpret the platform plan, never to edit it
- If the platform run plan has \`status=needs_clarification\`, ask 1-3 concise Chinese clarification questions and stop. The platform persists and resumes clarification state; do not fetch data or generate pages while clarification is required
- A resolvable security name is already a target. Never ask for a ticker merely because a name contains words such as 证券, 股份, or 公司, or because a six-digit code is absent. Resolve the name first; continue automatically when there is one highest-priority exact A-share match
- Treat questions such as “最近怎么样”, “走势如何”, and “表现怎么样” as a complete comprehensive-diagnosis goal. Default to the latest 120 trading days and a verifiable dashboard instead of asking for an analysis direction
- If the prompt includes "承接上一轮澄清", "原始问题", and "用户补充", merge the original question and the clarification response into one complete task before planning. If the merged task is clear, continue with planned data fetching and dashboard generation; if not, ask only the remaining clarification questions
- For stock, index, ETF, strategy, backtest, K-line, or market analysis tasks, first use quant-data-registry to check local PostgreSQL/TimescaleDB coverage with /api/v1/research/universes/summary, paged members, or target-symbol bars; then use quant-market-data to read local bars from http://127.0.0.1:8000/api/v1/research/bars/{symbol}
- Keep the data-access boundary strict: PostgreSQL/TimescaleDB may only be accessed by QuantPilot market-data/API services. Skills must call APIs, not connect to DB directly, write SQL, or read database credentials.
- For broad A-share stock selection, short-term candidates, or next-trading-day buy plans, first call /api/v1/research/screeners/a-share/short-term-candidates through quant-market-data; then fetch K-line/realtime/intraday/event data for the returned candidates.
- Persist screener limitations such as missing DDE fields, missing liquidity fields, and trade-date coverage into evidence/data_quality.json instead of fabricating values.
- Do not run full-universe data coverage scans by default in interactive chat; reserve /api/v1/research/data-coverage for explicit data quality audits
- Treat local PostgreSQL/TimescaleDB as the source of truth for historical analysis. Do not call external history endpoints or provider probes until local coverage, missing symbols, missing dates, or missing fields have been documented
- Use external providers only as ingestion/backfill or realtime/event supplements. If external data is needed, state the local data gap, ingest/cache through QuantPilot backend when possible, then re-read the local backend before analysis
- For broad financial data tasks, first use quant-data-registry to select the right local-first data endpoint
- For Chinese query parameters in local HTTP requests, use curl -G --data-urlencode. Do not concatenate raw Chinese text into URLs
- After fetching market, K-line, financial, or event data yourself, use data-quality before visualization. If the platform already prepared final data and evidence, read and preserve those artifacts unless validation explicitly identifies their contracts as failed
- Resolve ambiguous stock names or tickers with quant-symbol-resolver before fetching data
- If uploaded images exist or .quantpilot/attachments.json exists, first use image-extraction and call mcp__QuantPilotImage__quant_extract_uploaded_image. Write evidence/image_extraction.json and keep dashboard-data.json.imageExtraction. No extra vision provider is enabled; keep uncertain screenshot fields null and list fields requiring manual confirmation.
- Use quant-comparison for multi-symbol questions. When dashboard-data.json contains assets[] and comparison, render all assets instead of only the primary symbol
- Use quant-a-share-history for historical K-line analysis
- Use quant-index-etf-market for index and ETF tasks such as 沪深300、创业板指、中证500、科创50 or 510300 ETF
- Use quant-technical-indicators for moving averages, returns, drawdown, volatility, and volume metrics
- Use quant-fundamental-financials for revenue, profit, ROE, margin, and growth analysis
- Use quant-fundamental-indicators for derived profitability, margin, ROE, and financial quality metrics
- Use quant-announcement-events for announcement/event-driven context
- For visualization tasks, use the dashboard-visualization skill and actually edit app/page.tsx into a usable dashboard
- For visualization tasks, choose the scenario template from .quantpilot/run_plan.json visualization.templateId and render the scenario-specific required components instead of a generic dashboard
- Never reinterpret one security mentioned through multiple aliases as a multi-symbol task. A planned single-symbol technical dashboard must remain on its planned technical template
- Do not add buy zones, stop losses, target prices, position sizing, or execution advice unless the user explicitly requested them
- Generated dashboards must look like production financial workbenches: the first viewport must show real market/portfolio/backtest/fundamental content plus a core chart/table, not a marketing hero, giant slogan, template banner, or metric-card-only page
- Use a Data-Dense Dashboard layout with neutral surfaces, clear borders, compact metrics, semantic colors, stable chart dimensions, and no mobile horizontal overflow; wide tables must scroll inside their panel
- For A-share quote fields, prefer quote.previous_close/open/high/low/amount/turnover over latest kline fallback, and show real missing-field states instead of wrong or fabricated values
- Use Write/Edit tools for source, CSS, JSON, and evidence file changes. Do not use Bash cat/tee/echo/printf, redirection, heredoc, python/node scripts, or touch to write files
- A-share visualization dashboards must include real chart panels; for trend tasks include candlestick/OHLC or an explicit K-line error panel, volume, moving averages, and risk metrics
- Prefer same-origin API routes in generated projects to proxy http://127.0.0.1:8000 instead of direct browser calls
- Do not hard-code stock quote data; fetch it before analysis and keep refresh capability in the generated page
- Before finishing a quantitative dashboard, ensure data_file/final/dashboard-data.json exists, app/page.tsx reads real data or same-origin APIs, and /api/market/** proxies the local market backend
- Read \`.quantpilot/run_plan.json\` symbols as authoritative ticker strings. Store rich resolved symbol objects in final data and never modify the run plan
- Keep dashboard-data.json schema-compatible with quote, kline.bars, technicalIndicators.summary/computedMetrics, and assets[]/comparison for multi-symbol dashboards
- Generated app/page.tsx must type-check under strict TypeScript. Treat dashboard-data.json as dynamic JSON via JsonRecord/asRecord/asArray/numeric helpers; explicitly type flatMap/map results that add fields as JsonRecord[] so properties like notice_date, report_date, correlation, or symbol remain accessible.
- Guard every nested dynamic JSON object separately. For example, assign \`const financials = asRecord(data?.financials)\` and \`const summary = asRecord(financials?.summary)\` before reading \`summary?.latest_report_date\`; never continue an optional chain through an unknown field such as \`asRecord(data?.financials)?.summary?.latest_report_date\`.
- Once .quantpilot/run_plan.json, data_file/final/dashboard-data.json, evidence/sources.json, evidence/data_quality.json, and app/page.tsx are complete, immediately provide a concise Chinese execution summary and stop. The platform owns build, preview, and visual validation; do not run package managers, build commands, or unrelated Bash checks
- Include loading, error, and empty states for market data
- Display source, quote_time, and fetched_at when showing live stock data
- Use A-share color convention: red for gains and green for losses
- If no symbols are specified, default to 600519, 000001, and 300750
- Do not default missing symbols when the user request is genuinely unclear. Default symbols are only allowed for explicit demos, benchmark checks, or when the user asks for a generic sample dashboard
- Do not add styling dependencies or create @import "tailwindcss" unless explicitly requested
- Write clean, production-ready code
- Follow best practices
- The platform automatically installs dependencies and manages the preview dev server. Do not run package managers or dev-server commands yourself; rely on the existing preview.
- Keep all project files directly in the project root. Never scaffold frameworks into subdirectories.
- Never override ports or start your own development server processes. Rely on the managed preview service which assigns ports from the approved pool.
- When sharing a preview link, read the actual NEXT_PUBLIC_APP_URL instead of assuming a default port.
- Prefer giving the user the live preview link that is actually running rather than written instructions.`;
}
