import fs from 'fs/promises';
import path from 'path';
import { QUANT_VISUAL_VALIDATION_RELATIVE_PATH } from '@/lib/quant/artifacts';
import { appendQuantWorkspaceEvent, ensureQuantWorkspace } from '@/lib/quant/workspace';

export type QuantVisualValidationStatus = 'passed' | 'failed' | 'warning';

export interface QuantVisualViewportResult {
  id: 'desktop' | 'mobile';
  width: number;
  height: number;
  screenshotPath: string;
  status: QuantVisualValidationStatus;
  failures: string[];
  warnings: string[];
  metrics: {
    textLength: number;
    svgCount: number;
    canvasCount: number;
    rectCount: number;
    graphicCount: number;
    visibleGraphicCount: number;
    bodyArea: number;
    textBlockCount: number;
    firstViewportTextLength: number;
    firstViewportGraphicCount: number;
    firstViewportTableCount: number;
    firstViewportHasMarketLanguage: boolean;
    firstViewportHasCoreVisual: boolean;
    largeChartCount: number;
    firstViewportLargeChartCount: number;
    tinyChartCount: number;
    squashedMetricCount: number;
    orphanedMetricRowCount: number;
    contentRegionCount: number;
    cardLikeSurfaceCount: number;
    firstViewportCardLikeSurfaceCount: number;
    cardGridClusterCount: number;
    cardLikeSurfaceRatio: number;
    firstViewportCardLikeSurfaceRatio: number;
    hasFinancialWorkbenchMarker: boolean;
    oversizedHeroLike: boolean;
    horizontalOverflow: boolean;
    blankLike: boolean;
    hasMarketLanguage: boolean;
    hasDataFreshnessLanguage: boolean;
  };
}

export interface QuantSurfaceCompositionMetrics {
  contentRegionCount: number;
  cardLikeSurfaceCount: number;
  firstViewportCardLikeSurfaceCount: number;
  cardGridClusterCount: number;
  cardLikeSurfaceRatio: number;
  firstViewportCardLikeSurfaceRatio: number;
}

export function assessMetricStripBalance(params: {
  viewportId: 'desktop' | 'mobile';
  orphanedMetricRowCount: number;
}): string[] {
  if (params.viewportId !== 'desktop' || params.orphanedMetricRowCount <= 0) {
    return [];
  }

  return [
    `检测到 ${params.orphanedMetricRowCount} 个指标带末行只有一个窄指标，产生大面积空白；请按指标数量采用均衡网格或让末项填满整行。`,
  ];
}

export function assessCoreVisualPresence(params: {
  svgCount: number;
  canvasCount: number;
  rectCount: number;
  visibleGraphicCount: number;
  firstViewportTableCount: number;
}): string[] {
  const hasRecognizableGraphic =
    params.svgCount + params.canvasCount > 0 ||
    params.rectCount >= 12 ||
    params.visibleGraphicCount >= 12;
  if (hasRecognizableGraphic || params.firstViewportTableCount > 0) {
    return [];
  }
  return ['页面缺少可识别的图表元素。'];
}

export function assessFinancialWorkbenchSurface(metrics: QuantSurfaceCompositionMetrics): {
  failures: string[];
  warnings: string[];
} {
  const cardGridDominates =
    metrics.cardGridClusterCount > 0 ||
    (metrics.firstViewportCardLikeSurfaceCount >= 4 && metrics.firstViewportCardLikeSurfaceRatio >= 0.65) ||
    (metrics.cardLikeSurfaceCount >= 8 && metrics.cardLikeSurfaceRatio >= 0.6);

  if (cardGridDominates) {
    return {
      failures: [
        '页面由独立圆角卡片网格主导；金融看板应使用连续工作台画布，以分区线、数据带、主图、矩阵和表格组织内容。',
      ],
      warnings: [],
    };
  }

  if (metrics.firstViewportCardLikeSurfaceCount >= 4 || metrics.cardLikeSurfaceCount >= 8) {
    return {
      failures: [],
      warnings: [
        '页面独立卡片式容器偏多，建议合并为连续数据区并减少圆角、阴影和重复外框。',
      ],
    };
  }

  return { failures: [], warnings: [] };
}

export interface QuantVisualValidationReport {
  schemaVersion: 1;
  projectId: string;
  requestId?: string | null;
  status: QuantVisualValidationStatus;
  passed: boolean;
  previewUrl: string;
  reportPath: string;
  screenshotDir: string;
  viewports: QuantVisualViewportResult[];
  failures: string[];
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

const SCREENSHOT_DIR = path.join('tmp', 'visual-checks');
const VIEWPORTS: Array<{ id: 'desktop' | 'mobile'; width: number; height: number }> = [
  { id: 'desktop', width: 1440, height: 900 },
  { id: 'mobile', width: 390, height: 844 },
];

function nowIso() {
  return new Date().toISOString();
}

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'visual';
}

function uniq(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function statusFromIssues(failures: string[], warnings: string[]): QuantVisualValidationStatus {
  if (failures.length > 0) return 'failed';
  if (warnings.length > 0) return 'warning';
  return 'passed';
}

export function isVisualValidationInfrastructureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /Executable doesn't exist|playwright install|Cannot find (?:module|package).*playwright|browserType\.launch/i.test(
    message
  );
}

async function writeReport(projectPath: string, report: QuantVisualValidationReport) {
  await ensureQuantWorkspace(projectPath);
  await fs.writeFile(
    path.join(projectPath, QUANT_VISUAL_VALIDATION_RELATIVE_PATH),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8'
  );
}

async function validateViewport(params: {
  browser: Awaited<ReturnType<typeof import('playwright').chromium.launch>>;
  projectPath: string;
  projectId: string;
  requestId?: string | null;
  previewUrl: string;
  timestamp: string;
  viewport: { id: 'desktop' | 'mobile'; width: number; height: number };
}): Promise<QuantVisualViewportResult> {
  const page = await params.browser.newPage({
    viewport: {
      width: params.viewport.width,
      height: params.viewport.height,
    },
    deviceScaleFactor: 1,
    isMobile: params.viewport.id === 'mobile',
  });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedResources: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });
  page.on('response', (response) => {
    const type = response.request().resourceType();
    if (response.status() >= 400 && ['document', 'script', 'stylesheet', 'font', 'image'].includes(type)) {
      failedResources.push(`${response.status()} ${type} ${response.url()}`);
    }
  });

  const screenshotDir = path.join(params.projectPath, SCREENSHOT_DIR);
  await fs.mkdir(screenshotDir, { recursive: true });
  const relativeScreenshotPath = path.posix.join(
    SCREENSHOT_DIR,
    `${safeName(params.projectId)}-${params.viewport.id}-${params.timestamp}.png`
  );
  const absoluteScreenshotPath = path.join(params.projectPath, relativeScreenshotPath);

  const failures: string[] = [];
  const warnings: string[] = [];
  try {
    const response = await page.goto(params.previewUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    if (!response?.ok()) {
      failures.push(`预览地址未返回 2xx：${response?.status() ?? '无响应'}`);
    }
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    await page.screenshot({ path: absoluteScreenshotPath, fullPage: true });

    const metrics = await page.evaluate(() => {
      const rects = Array.from(document.querySelectorAll('svg, canvas, rect, path, polyline'));
      const charts = Array.from(document.querySelectorAll('svg, canvas')).map((element) => {
        const rect = element.getBoundingClientRect();
        const visible = rect.width > 4 && rect.height > 4 && window.getComputedStyle(element).display !== 'none';
        const text = element.closest('section,article,div')?.textContent || '';
        return {
          visible,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          area: rect.width * rect.height,
          hasMarketContext: /K\s*线|K线|成交量|均线|MA5|MA10|MA20|收益|回撤|波动|对比|矩阵|强弱|排名/i.test(text),
        };
      });
      const largeCharts = charts.filter((chart) => chart.visible && chart.width >= 280 && chart.height >= 140 && chart.hasMarketContext);
      const tinyCharts = charts.filter((chart) => chart.visible && chart.width < 260 && chart.height < 140);
      const visibleGraphicCount = rects.filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 4 && rect.height > 4 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0;
      }).length;
      const bodyText = document.body.innerText || '';
      const bodyRect = document.body.getBoundingClientRect();
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const firstViewportElements = Array.from(document.querySelectorAll('h1,h2,h3,p,li,td,th,span,strong,article,section,svg,canvas,table'))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.bottom > 0 && rect.top < viewportHeight && rect.width > 4 && rect.height > 4 && style.visibility !== 'hidden' && style.display !== 'none';
        });
      const firstViewportText = firstViewportElements
        .map((element) => element.textContent || '')
        .join(' ')
        .replace(/\s+/g, '');
      const firstViewportGraphicCount = firstViewportElements.filter((element) =>
        ['svg', 'canvas'].includes(element.tagName.toLowerCase()) ||
        element.querySelector?.('svg,canvas,rect,path,polyline')
      ).length;
      const firstViewportTableCount = firstViewportElements.filter((element) =>
        element.tagName.toLowerCase() === 'table' || element.querySelector?.('table')
      ).length;
      const headingElements = Array.from(document.querySelectorAll('h1,.name,.price')).filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < viewportHeight;
      });
      const squashedMetricCount = Array.from(document.querySelectorAll('dd,td,strong,em,.metric-value,.price-box span,.price-box em')).filter((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.textContent || '').trim();
        if (text.length < 4 || rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(element);
        const lineHeight = Number.parseFloat(style.lineHeight || style.fontSize || '16');
        return rect.height > Math.max(34, lineHeight * 2.2) && rect.width < 72;
      }).length;
      const orphanedMetricRowCount = Array.from(document.querySelectorAll(
        'main .metric-strip, main .comparison-metrics, main .selection-metrics, main .portfolio-metrics, main .risk-strip'
      )).filter((container) => {
        const containerRect = container.getBoundingClientRect();
        const containerStyle = window.getComputedStyle(container);
        if (
          containerRect.width < 240 ||
          containerRect.height < 40 ||
          containerStyle.visibility === 'hidden' ||
          containerStyle.display === 'none'
        ) {
          return false;
        }

        const rows = new Map<number, DOMRect[]>();
        for (const child of Array.from(container.children)) {
          const rect = child.getBoundingClientRect();
          const style = window.getComputedStyle(child);
          if (rect.width <= 4 || rect.height <= 4 || style.visibility === 'hidden' || style.display === 'none') {
            continue;
          }
          const rowKey = Math.round(rect.top / 4) * 4;
          rows.set(rowKey, [...(rows.get(rowKey) ?? []), rect]);
        }

        const orderedRows = Array.from(rows.entries()).sort(([left], [right]) => left - right).map(([, rects]) => rects);
        if (orderedRows.length < 2 || orderedRows[0].length < 3) {
          return false;
        }
        const lastRow = orderedRows[orderedRows.length - 1];
        return lastRow.length === 1 && lastRow[0].width < containerRect.width * 0.72;
      }).length;
      const oversizedHeading = headingElements.some((element) => {
        const style = window.getComputedStyle(element);
        const fontSize = Number.parseFloat(style.fontSize || '0');
        const rect = element.getBoundingClientRect();
        return fontSize > 64 || rect.height > viewportHeight * 0.22;
      });
      const contentRegions = Array.from(new Set(document.querySelectorAll(
        'main section, main article, main [class*="card" i], main [class*="panel" i]'
      ))).filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width >= 120 && rect.height >= 52 && style.visibility !== 'hidden' && style.display !== 'none';
      });
      const cardLikeRegions = contentRegions.filter((element) => {
        // Keep this predicate inline. The callback passed to page.evaluate is
        // serialized into the browser; a named local helper is rewritten by
        // the server-side TS transform with an out-of-scope `__name` helper.
        if (element.matches('dialog,[role="dialog"],[role="alert"],[popover],.alert,.warning,.error,.tooltip,.popover,.toast')) {
          return false;
        }
        const style = window.getComputedStyle(element);
        const parentStyle = element.parentElement ? window.getComputedStyle(element.parentElement) : null;
        const radii = [
          style.borderTopLeftRadius,
          style.borderTopRightRadius,
          style.borderBottomRightRadius,
          style.borderBottomLeftRadius,
        ].map((value) => Number.parseFloat(value || '0'));
        const rounded = Math.max(...radii) >= 6;
        const hasBorder = [style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle]
          .some((value) => value !== 'none');
        const elevated = style.boxShadow !== 'none' && !/^rgba?\(0, 0, 0, 0\)/.test(style.boxShadow);
        const surfaceContrast = Boolean(
          parentStyle &&
          style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
          style.backgroundColor !== 'transparent' &&
          style.backgroundColor !== parentStyle.backgroundColor
        );
        return rounded && (hasBorder || elevated || surfaceContrast);
      });
      const cardLikeSet = new Set(cardLikeRegions);
      const cardGridClusterCount = Array.from(new Set(cardLikeRegions.map((element) => element.parentElement).filter(Boolean)))
        .filter((parent): parent is HTMLElement => parent instanceof HTMLElement)
        .filter((parent) => {
          const display = window.getComputedStyle(parent).display;
          if (display !== 'grid' && display !== 'flex') return false;
          return Array.from(parent.children).filter((child) => cardLikeSet.has(child)).length >= 3;
        }).length;
      const firstViewportRegions = contentRegions.filter((element) => element.getBoundingClientRect().top < viewportHeight);
      const firstViewportCardLikeRegions = cardLikeRegions.filter((element) => element.getBoundingClientRect().top < viewportHeight);
      return {
        textLength: bodyText.replace(/\s+/g, '').length,
        svgCount: document.querySelectorAll('svg').length,
        canvasCount: document.querySelectorAll('canvas').length,
        rectCount: document.querySelectorAll('rect').length,
        graphicCount: rects.length,
        visibleGraphicCount,
        bodyArea: Math.max(0, bodyRect.width * bodyRect.height),
        textBlockCount: Array.from(document.querySelectorAll('h1,h2,h3,p,li,td,th,span')).filter((element) => {
          const text = (element.textContent || '').trim();
          const rect = element.getBoundingClientRect();
          return text.length > 0 && rect.width > 8 && rect.height > 8;
        }).length,
        firstViewportTextLength: firstViewportText.length,
        firstViewportGraphicCount,
        firstViewportTableCount,
        firstViewportHasMarketLanguage: /最新价|实时|价格|price|K\s*线|成交量|均线|财务|回撤|波动|净值|持仓|收益|风险/i.test(firstViewportText),
        firstViewportHasCoreVisual: largeCharts.some((chart) => chart.top < viewportHeight) || firstViewportTableCount > 0,
        largeChartCount: largeCharts.length,
        firstViewportLargeChartCount: largeCharts.filter((chart) => chart.top < viewportHeight).length,
        tinyChartCount: tinyCharts.length,
        squashedMetricCount,
        orphanedMetricRowCount,
        contentRegionCount: contentRegions.length,
        cardLikeSurfaceCount: cardLikeRegions.length,
        firstViewportCardLikeSurfaceCount: firstViewportCardLikeRegions.length,
        cardGridClusterCount,
        cardLikeSurfaceRatio: cardLikeRegions.length / Math.max(1, contentRegions.length),
        firstViewportCardLikeSurfaceRatio: firstViewportCardLikeRegions.length / Math.max(1, firstViewportRegions.length),
        hasFinancialWorkbenchMarker: Boolean(document.querySelector('[data-visual-language="financial-workbench"]')),
        oversizedHeroLike: oversizedHeading && firstViewportGraphicCount === 0 && firstViewportTableCount === 0,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
        blankLike: bodyText.trim().length < 80 && rects.length < 8,
        hasMarketLanguage: /最新价|实时|价格|price|K\s*线|成交量|均线|财务|回撤|波动|净值|持仓|收益|风险/i.test(bodyText),
        hasDataFreshnessLanguage: /更新时间|更新：|数据截至|数据时间|行情时间|报告期|样本区间|样本窗口/i.test(bodyText),
      };
    });

    if (metrics.blankLike || metrics.textLength < 120) {
      failures.push('首屏内容过少，页面疑似空白或未完成渲染。');
    }
    if (metrics.horizontalOverflow) {
      failures.push('页面存在横向溢出。');
    }
    if (!metrics.hasMarketLanguage) {
      failures.push('页面缺少行情、K 线、财务、风险或持仓等金融语义。');
    }
    if (!metrics.firstViewportHasMarketLanguage || metrics.firstViewportTextLength < 80) {
      failures.push('首屏缺少真实金融数据、行情指标或可用分析内容。');
    }
    if (metrics.oversizedHeroLike) {
      failures.push('首屏疑似营销式大标题或空 hero，占用了核心金融内容位置。');
    }
    if (params.viewport.id === 'desktop' && metrics.firstViewportGraphicCount + metrics.firstViewportTableCount === 0) {
      warnings.push('桌面首屏没有图表或表格，可能需要把核心可视化上移。');
    }
    if (!metrics.firstViewportHasCoreVisual) {
      failures.push('首屏没有可用的核心图表、矩阵或表格；迷你 sparkline/装饰图不能替代主图。');
    }
    if (metrics.largeChartCount === 0 && metrics.firstViewportTableCount === 0) {
      failures.push('页面没有检测到足够尺寸的金融主图或数据矩阵。');
    }
    if (metrics.tinyChartCount >= 3 && metrics.largeChartCount === 0) {
      failures.push('页面主要由迷你图组成，缺少带坐标/刻度/上下文的主图。');
    }
    if (metrics.squashedMetricCount > 0) {
      failures.push(`检测到 ${metrics.squashedMetricCount} 个数字或指标被挤压成多行，图表或数据区宽度需要调整。`);
    }
    failures.push(...assessMetricStripBalance({
      viewportId: params.viewport.id,
      orphanedMetricRowCount: metrics.orphanedMetricRowCount,
    }));
    const surfaceAssessment = assessFinancialWorkbenchSurface(metrics);
    failures.push(...surfaceAssessment.failures);
    warnings.push(...surfaceAssessment.warnings);
    if (!metrics.hasDataFreshnessLanguage) {
      warnings.push('页面缺少数据更新时间、报告期或样本口径说明。');
    }
    failures.push(...assessCoreVisualPresence(metrics));
    if (metrics.textBlockCount < 6) {
      warnings.push('页面可读文本块较少，可能缺少摘要、指标或说明。');
    }

    warnings.push(...consoleErrors.slice(0, 8).map((item) => `console error：${item}`));
    failures.push(...pageErrors.map((item) => `页面运行错误：${item}`));
    failures.push(...failedResources.map((item) => `资源加载失败：${item}`));

    return {
      ...params.viewport,
      screenshotPath: relativeScreenshotPath,
      status: statusFromIssues(failures, warnings),
      failures: uniq(failures),
      warnings: uniq(warnings),
      metrics,
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

export async function validateQuantVisualPresentation(params: {
  projectPath: string;
  projectId: string;
  previewUrl: string;
  requestId?: string | null;
}): Promise<QuantVisualValidationReport> {
  const projectPath = path.resolve(params.projectPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const createdAt = nowIso();

  let browser: Awaited<ReturnType<typeof import('playwright').chromium.launch>> | null = null;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const viewports = await Promise.all(
      VIEWPORTS.map((viewport) =>
        validateViewport({
          browser: browser!,
          projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          previewUrl: params.previewUrl,
          timestamp,
          viewport,
        })
      )
    );
    const failures = uniq(viewports.flatMap((viewport) => viewport.failures.map((failure) => `${viewport.id}：${failure}`)));
    const warnings = uniq(viewports.flatMap((viewport) => viewport.warnings.map((warning) => `${viewport.id}：${warning}`)));
    const updatedAt = nowIso();
    const status = statusFromIssues(failures, warnings);
    const report: QuantVisualValidationReport = {
      schemaVersion: 1,
      projectId: params.projectId,
      requestId: params.requestId ?? null,
      status,
      passed: status !== 'failed',
      previewUrl: params.previewUrl,
      reportPath: QUANT_VISUAL_VALIDATION_RELATIVE_PATH,
      screenshotDir: SCREENSHOT_DIR,
      viewports,
      failures,
      warnings,
      createdAt,
      updatedAt,
    };
    await writeReport(projectPath, report);
    await appendQuantWorkspaceEvent(projectPath, {
      event_type: 'visual_validation_completed',
      stage: 'validation',
      status: status === 'failed' ? 'error' : status === 'warning' ? 'warning' : 'success',
      run_id: params.requestId ?? undefined,
      artifact_path: QUANT_VISUAL_VALIDATION_RELATIVE_PATH,
      summary: status === 'failed'
        ? `视觉验收未通过：${failures.length} 个阻断项。`
        : status === 'warning'
          ? `视觉验收通过但有 ${warnings.length} 个警告。`
          : '视觉验收通过。',
      created_at: updatedAt,
    });
    return report;
  } catch (error) {
    const updatedAt = nowIso();
    const message = error instanceof Error ? error.message : String(error);
    const infrastructureUnavailable = isVisualValidationInfrastructureError(error);
    const warning =
      '视觉截图验收已跳过：当前运行环境未安装 Playwright Chromium；运行 npx playwright install chromium 后可恢复桌面端和移动端截图验收。';
    const report: QuantVisualValidationReport = {
      schemaVersion: 1,
      projectId: params.projectId,
      requestId: params.requestId ?? null,
      status: infrastructureUnavailable ? 'warning' : 'failed',
      passed: infrastructureUnavailable,
      previewUrl: params.previewUrl,
      reportPath: QUANT_VISUAL_VALIDATION_RELATIVE_PATH,
      screenshotDir: SCREENSHOT_DIR,
      viewports: [],
      failures: infrastructureUnavailable ? [] : [`视觉验收执行异常：${message}`],
      warnings: infrastructureUnavailable ? [warning] : [],
      createdAt,
      updatedAt,
    };
    await writeReport(projectPath, report);
    await appendQuantWorkspaceEvent(projectPath, {
      event_type: 'visual_validation_completed',
      stage: 'validation',
      status: infrastructureUnavailable ? 'warning' : 'error',
      run_id: params.requestId ?? undefined,
      artifact_path: QUANT_VISUAL_VALIDATION_RELATIVE_PATH,
      summary: infrastructureUnavailable ? warning : '视觉验收执行异常。',
      created_at: updatedAt,
    });
    return report;
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

export async function readQuantVisualValidationReport(projectPath: string): Promise<QuantVisualValidationReport | null> {
  const content = await fs.readFile(path.join(projectPath, QUANT_VISUAL_VALIDATION_RELATIVE_PATH), 'utf8').catch(() => null);
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed as QuantVisualValidationReport : null;
  } catch {
    return null;
  }
}
