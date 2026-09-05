import fs from 'fs/promises';
import { ensureQuantWorkspace } from '@/lib/domains/finance/workspace';
import {
  type QuantValidationCheck,
  type QuantValidationRepairPlan,
  type QuantValidationReport,
  VALIDATION_REPAIR_PLAN_RELATIVE_PATH,
} from './contracts';
import { validationRepairPlanPath } from './files';

function actionsForFailedCheck(check: QuantValidationCheck): string[] {
  switch (check.id) {
    case 'next_build':
      return [
        '根据失败详情定位并修复 TypeScript、Next.js 或 CSS 错误。',
        '动态 JSON 字段必须使用 JsonRecord、asRecord、asArray、numeric 等守卫函数处理。',
      ];
    case 'preview_http_200':
      return [
        '根据失败详情修复页面加载时抛出的运行时异常。',
        '保持 app/page.tsx、app/layout.tsx 和 app/globals.css 的导入与渲染链路有效。',
      ];
    case 'visual_presentation':
      return [
        '只查看 .data-agent/visual-validation.json 指向的失败 viewport、截图与指标。',
        '修复桌面/移动端布局：首屏不能空白，不能横向溢出，文本不能互相遮挡。',
        '把独立白色圆角卡片网格合并为连续金融工作台：主画布共用背景，以细分区线、连续指标带、主图、矩阵和表格建立层级；移除重复圆角、阴影和 card 套 card。',
        '指标带按实际数量均衡分栏；移除桌面端 N+1 孤项和大片空白，避免金额、价格和百分比拆行或竖排。',
        '移动端 390x844 首屏必须露出一个可用的核心图表、矩阵或表格；如果摘要区过高，压缩或下移次要指标和免责声明，并移除用户可见的渠道证据、模板名称与组件契约说明。',
      ];
    case 'final_data_file':
      return [
        '生成或修复 data_file/final/dashboard-data.json。',
        '读取 .data-agent/finance-run-plan.json 和现有 raw/final/evidence 数据，按真实数据重组 final 文件，不要只创建空 JSON。',
        '确保 final 数据包含 symbol/name/source/as_of、quote.price/change_percent/quote_time，以及 kline.bars[] 或 history.bars[]；每根 K 线至少包含 date/open/high/low/close/volume 或 amount。',
        '多标的任务必须覆盖 run_plan.symbols 中的全部代码，并写入 requestedSymbols、assets[] 与 comparison.rows[]；comparison.rows[] 必须包含 symbol/name、价格或收益、回撤/波动/成交额等可排序字段。',
        'final 数据必须包含 visualization.template_id、variant_id、required_components 和 rendered_components，并与 run_plan.visualization.templateId 对齐。',
      ];
    case 'evidence_files':
      return [
        '生成 evidence/sources.json，记录 source、endpoint、fetched_at/as_of、样本量和 artifact_path。',
        '生成 evidence/data_quality.json，记录 status、datasets/checks、缺失字段、警告和限制。',
        '不要把鉴权凭据、会话凭据或密钥值写入 evidence。',
      ];
    case 'artifact_contracts':
      return [
        '只查看 .data-agent/artifact-contracts.json 中失败的契约项。',
        '只修复 evidence/*.json 或 data_file/final/dashboard-data.json 的结构字段；run_plan、generation-state 和其他 .data-agent 结构由平台重建。',
      ];
    case 'artifact_policy':
      return [
        '移除外部 CDN、远程脚本、远程样式、远程字体、远程媒体和浏览器直连外部 API。',
        '页面资源必须本地化；浏览器取数只能读取 data_file/final/dashboard-data.json 或同源 /api/market/**。',
        '移除 MOCK_DATA、SAMPLE_DATA、STATIC_QUOTES、示例数据、模拟数据、占位数据和明文密钥。',
      ];
    case 'dashboard_data_binding':
      {
        const tradingPlanFailure = /交易执行计划|交易计划|买入区间|止损|目标价|仓位|操作建议/.test(
          `${check.summary}\n${check.details ?? ''}`
        );
        return [
        '让 app/page.tsx 使用 QuantPilot 标准数据绑定结构读取 data_file/final/dashboard-data.json。',
        '保留 DATA_FILE、readDashboardData()、getBars() 或 data-source-file={DATA_FILE} 等标准入口。',
        ...(tradingPlanFailure
          ? [
              '必须实际编辑 app/page.tsx：删除 getTradingPlanRows、priceRange、TradingPlanPanel、tradingRows 变量和 <TradingPlanPanel ... /> 调用。',
              '必须实际编辑 app/globals.css：删除 .trading-plan-grid、.trade-card、.trade-title、.trade-rationale、.trade-abandon 等交易计划样式，或确保页面不再引用这些 class。',
              '除“不是买卖建议/不构成交易指令”这类免责声明外，页面不得残留短线交易计划、买入区间、止损、目标价或仓位上限。',
            ]
          : []),
        '不要把完整行情、K 线、财务或公告对象内联到页面代码。',
        ];
      }
    case 'chart_presence':
      return [
        '补齐真实金融图表：K 线/OHLC、成交量、均线、财务趋势、收益/回撤/波动或风险指标。',
        '图表必须有语义染色、坐标/图例/tooltip/title 等读图辅助。',
        '用户明确要求“累计收益曲线/收益曲线/净值曲线/折线图”时必须绘制带日期轴、统一尺度和图例的折线图，不能用柱状图、指标卡或 sparkline 替代。',
        '用户明确要求“相关性矩阵/热力图/分散风险图谱”时必须绘制真实矩阵或热力图，并展示标的标签、数值和颜色刻度。',
      ];
    case 'market_proxy':
      return [
        '创建 app/api/market/[...path]/route.ts。',
        '将 /api/market/** 转发到 http://127.0.0.1:8000/api/v1/** 并保留 query 参数。',
        '前端刷新行情时调用 /api/market/**，不要从浏览器直连 8000 或外部接口。',
      ];
    default:
      return [
        '根据失败摘要和细节定位关联文件，只修复该失败项。',
      ];
  }
}

const REPAIR_SCOPE_BY_CHECK_ID: Record<string, readonly string[]> = {
  next_build: ['app/page.tsx', 'app/globals.css'],
  preview_http_200: ['app/page.tsx', 'app/globals.css'],
  visual_presentation: ['app/page.tsx', 'app/globals.css'],
  final_data_file: ['data_file/final/**'],
  evidence_files: ['evidence/**'],
  artifact_contracts: ['data_file/final/**', 'evidence/**'],
  artifact_policy: ['app/page.tsx', 'app/globals.css'],
  dashboard_data_binding: ['app/page.tsx', 'app/globals.css', 'data_file/final/**'],
  chart_presence: ['app/page.tsx', 'app/globals.css'],
  market_proxy: ['app/api/market/[...path]/route.ts'],
};

function repairWritablePaths(failedChecks: QuantValidationCheck[]): string[] {
  const paths = new Set<string>();
  for (const check of failedChecks) {
    for (const writablePath of REPAIR_SCOPE_BY_CHECK_ID[check.id] ?? []) {
      paths.add(writablePath);
    }
  }
  const preferredOrder = [
    'app/page.tsx',
    'app/globals.css',
    'app/api/market/[...path]/route.ts',
    'data_file/final/**',
    'evidence/**',
  ];
  return [...paths].sort((left, right) => {
    const leftIndex = preferredOrder.indexOf(left);
    const rightIndex = preferredOrder.indexOf(right);
    return (leftIndex < 0 ? preferredOrder.length : leftIndex)
      - (rightIndex < 0 ? preferredOrder.length : rightIndex);
  });
}

/**
 * Converts platform-owned validation failures into the only additional paths
 * a repair run may mutate. The typed-tool policy consumes this result; the
 * prompt is explanatory and is never the authority boundary.
 */
export function quantValidationRepairWritableGlobs(
  report: QuantValidationReport,
): string[] {
  return repairWritablePaths(report.checks.filter((check) => check.status === 'failed'));
}

function formatChineseList(values: string[]): string {
  if (values.length <= 1) {
    return values[0] ?? '无';
  }
  if (values.length === 2) {
    return `${values[0]} 和 ${values[1]}`;
  }
  return `${values.slice(0, -1).join('、')} 和 ${values.at(-1)}`;
}

function targetedReadsForFailedChecks(failedChecks: QuantValidationCheck[]): string[] {
  const paths = new Set<string>([
    '.data-agent/validation.json（仅失败项）',
    '.data-agent/validation-repair-plan.json（仅本轮步骤）',
  ]);
  for (const check of failedChecks) {
    switch (check.id) {
      case 'visual_presentation':
        paths.add('.data-agent/visual-validation.json（仅失败 viewport 和其截图路径）');
        paths.add('app/page.tsx 与 app/globals.css（只读相关区段）');
        break;
      case 'next_build':
      case 'preview_http_200':
        paths.add('失败详情点名的 app/** 文件与相关导入');
        break;
      case 'final_data_file':
        paths.add('.data-agent/finance-run-plan.json（只读 symbols/visualization）');
        paths.add('data_file/final/dashboard-data.json');
        break;
      case 'evidence_files':
        paths.add('evidence/sources.json 与 evidence/data_quality.json');
        break;
      case 'artifact_contracts':
        paths.add('.data-agent/artifact-contracts.json（仅失败契约）');
        paths.add('失败契约指向的 final/evidence 文件');
        break;
      case 'dashboard_data_binding':
        paths.add('app/page.tsx 的数据读取与绑定区段');
        paths.add('data_file/final/dashboard-data.json 的顶层结构');
        break;
      case 'chart_presence':
      case 'artifact_policy':
      case 'market_proxy':
        paths.add('失败详情点名的 app/** 文件与相关区段');
        break;
      default:
        paths.add('失败详情明确指向的文件或区段');
    }
  }
  return [...paths];
}

function completionConditionForFailedCheck(check: QuantValidationCheck): string {
  switch (check.id) {
    case 'next_build':
      return '报告点名的类型、导入或样式错误已在关联 app 文件中消除。';
    case 'preview_http_200':
      return '报告点名的页面加载异常已消除，渲染入口不再抛错。';
    case 'visual_presentation':
      return '失败 viewport 的首屏主体可见，且无空白、横向溢出或文本遮挡。';
    case 'final_data_file':
      return 'dashboard-data.json 覆盖计划标的、真实数据字段和 visualization 契约。';
    case 'evidence_files':
      return 'sources 与 data_quality evidence 完整记录来源、时效、质量和限制。';
    case 'artifact_contracts':
      return 'artifact-contracts 报告中的失败 JSON 字段已在 final/evidence 中补齐。';
    case 'artifact_policy':
      return '报告点名的远程资源、浏览器外连、mock 或敏感字面量已移除。';
    case 'dashboard_data_binding':
      return '页面通过标准入口读取 final 数据，且未内联完整行情对象。';
    case 'chart_presence':
      return '用户任务要求的核心金融图表及读图辅助已实际渲染。';
    case 'market_proxy':
      return '同源 /api/market/** 路由按报告要求存在并保留查询参数。';
    default:
      return `${check.name} 的失败摘要已被对应文件修改直接解决。`;
  }
}

export function buildQuantValidationRepairPlan(report: QuantValidationReport): QuantValidationRepairPlan {
  const failedChecks = report.checks.filter((check) => check.status === 'failed');
  return {
    schemaVersion: 1,
    status: 'needed',
    projectId: report.projectId,
    reportPath: report.reportPath,
    repairPlanPath: VALIDATION_REPAIR_PLAN_RELATIVE_PATH,
    steps: failedChecks.map((check) => ({
      checkId: check.id,
      checkName: check.name,
      summary: check.summary,
      actions: actionsForFailedCheck(check),
      ...(check.details ? { details: truncateForPrompt(check.details, 1_000) } : {}),
    })),
    createdAt: new Date().toISOString(),
  };
}

export async function writeValidationRepairPlan(projectPath: string, report: QuantValidationReport) {
  const repairPlanPath = validationRepairPlanPath(projectPath);
  if (report.passed) {
    await fs.rm(repairPlanPath, { force: true }).catch(() => undefined);
    return;
  }

  await ensureQuantWorkspace(projectPath);
  const plan = buildQuantValidationRepairPlan(report);
  await fs.writeFile(repairPlanPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
}

function truncateForPrompt(value: string, limit = 1_500): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, limit)}\n...内容已截断...`;
}

export function buildQuantValidationRepairInstruction(
  report: QuantValidationReport,
  options: { originalInstruction?: string } = {}
): string {
  const failedChecks = report.checks.filter((check) => check.status === 'failed');
  const repairPlan = buildQuantValidationRepairPlan(report);
  const failedSummary = failedChecks
    .map((check, index) => {
      const details = check.details ? `\n   细节：${truncateForPrompt(check.details)}` : '';
      return `${index + 1}. ${check.name}（${check.id}）：${check.summary}${details}`;
    })
    .join('\n');
  const repairSteps = repairPlan.steps
    .map((step, index) => {
      const actions = step.actions.map((action, actionIndex) => `   ${actionIndex + 1}. ${action}`).join('\n');
      return `${index + 1}. ${step.checkName}（${step.checkId}）\n${actions}`;
    })
    .join('\n');

  const original = options.originalInstruction
    ? `\n原始用户需求：\n${truncateForPrompt(options.originalInstruction, 1_000)}\n`
    : '';
  const failedCheckIds = failedChecks.map((check) => check.id);
  const writablePaths = repairWritablePaths(failedChecks);
  const targetedReads = targetedReadsForFailedChecks(failedChecks);
  const completionConditions = failedChecks
    .map((check) => `- ${check.id}：${completionConditionForFailedCheck(check)}`)
    .join('\n');

  return `QuantPilot failure-scoped repair packet

目标：只修复本轮失败项，保留已有真实数据、有效分析和无关页面内容。${original}

修复范围：
- 失败 ID：${failedCheckIds.join('、') || '报告状态异常但未提供失败 ID'}
- 唯一可写范围：${formatChineseList(writablePaths)}
- 整个 \`.data-agent/**\` 是平台只读计划、报告与状态；你不得修改它。其结构修复和重新生成由平台负责。
- 定向读取：${targetedReads.join('；')}
- 不要扫描或通读未被失败项指向的目录和文件。

失败项：
${failedSummary || '无失败项，但验证报告状态为失败，请重新检查产物。'}

最小修复动作：
${repairSteps || '请重新检查验证报告并补齐缺失产物。'}

完成条件（平台复验前候选）：
${completionConditions || '- 报告未提供失败 ID；仅提交已能由失败详情证明的修复。'}

执行契约：
1. 使用本轮提供的 typed tools 定向读取和修改；只在需要新建失败产物时使用 write_file，否则优先 edit_file。
2. 必须实际修改失败项关联文件，但不得顺带重写未失败模块；不得写入 mock、占位数据、凭据或密钥。
3. 不要执行 shell、安装依赖、启动开发服务器、构建、预览或循环复验。构建、预览与自动验证由 QuantPilot 平台统一执行。
4. 完成上述失败项对应修改后，调用 submit_result，artifacts 只列出本轮实际修改的工作区相对路径；提交即结束本次物理运行，等待平台独立验证。`;
}
