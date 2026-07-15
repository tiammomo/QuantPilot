import fs from "node:fs/promises";
import type { MoAgentTool } from "@/lib/agent/types";
import { MoAgentToolError, throwIfAborted } from "./errors";
import type { MoAgentFileToolOptions } from "./filesystem";
import { inputRecord } from "./input";
import { MoAgentWorkspacePolicy } from "./path-policy";
import {
  DEFAULT_TOOL_OUTPUT_CHARS,
  DEFAULT_TOOL_TIMEOUT_MS,
  executeMoAgentTool,
  truncateToolOutput,
} from "./runtime";

const DEFAULT_MAX_INSPECTION_FILE_BYTES = 2_000_000;
const MAX_OUTLINE_ENTRIES = 24;
const MAX_SIGNAL_LINES = 12;
const MAX_COMPONENT_CLASSES = 10;
const MAX_COMPONENT_RENDER_LINES = 4;
const MAX_LAYOUT_REGIONS = 18;
const MAX_STYLE_RULES = 12;
const MAX_QUERY_TEXT_ANCHORS = 12;

const FILE_CANDIDATES = {
  page: ["app/page.tsx", "src/app/page.tsx"],
  styles: ["app/globals.css", "src/app/globals.css", "styles/globals.css"],
  marketProxy: [
    "app/api/market/[...path]/route.ts",
    "src/app/api/market/[...path]/route.ts",
  ],
  runPlan: [".quantpilot/run_plan.json"],
  finalData: ["data_file/final/dashboard-data.json"],
  sources: ["evidence/sources.json"],
  dataQuality: ["evidence/data_quality.json"],
} as const;

type JsonRecord = Record<string, unknown>;
type FileKey = keyof typeof FILE_CANDIDATES;

interface InspectedFile {
  path: string;
  exists: boolean;
  bytes?: number;
  totalLines?: number;
  analysisSkipped?: "file_too_large" | "binary_file" | "not_a_file";
  content?: string;
}

interface PublicFileSummary {
  path: string;
  exists: boolean;
  bytes?: number;
  totalLines?: number;
  analysisSkipped?: InspectedFile["analysisSkipped"];
}

interface OutlineEntry {
  kind: "component" | "function";
  name: string;
  line: number;
  endLine: number;
  renderLines: number[];
  classNames: string[];
}

interface InspectDashboardContractOutput {
  schemaVersion: 1;
  inspectedFiles: number;
  missingRequiredFiles: string[];
  contentTruncated: boolean;
  originalContentChars: number;
}

export interface DashboardContractInspectionOptions extends Pick<
  MoAgentFileToolOptions,
  "workspaceRoot" | "timeoutMs" | "maxOutputChars" | "maxFileBytes"
> {}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function boundedString(value: unknown, maxChars = 160): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function boundedStrings(
  value: unknown,
  maxItems = 12,
  maxChars = 120,
): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => boundedString(item, maxChars))
    .filter((item): item is string => item !== null)
    .slice(0, maxItems);
}

function boundedNumbers(value: unknown, maxItems = 8): number[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is number => Number.isSafeInteger(item) && item > 0)
        .slice(0, maxItems)
    : [];
}

function publicFile(file: InspectedFile): PublicFileSummary {
  return {
    path: file.path,
    exists: file.exists,
    ...(file.bytes === undefined ? {} : { bytes: file.bytes }),
    ...(file.totalLines === undefined ? {} : { totalLines: file.totalLines }),
    ...(file.analysisSkipped === undefined
      ? {}
      : { analysisSkipped: file.analysisSkipped }),
  };
}

function textLineCount(content: string): number {
  if (!content) return 0;
  const newlines = content.match(/\n/g)?.length ?? 0;
  return newlines + (content.endsWith("\n") ? 0 : 1);
}

async function inspectFirstExistingFile(options: {
  policy: MoAgentWorkspacePolicy;
  candidates: readonly string[];
  maxFileBytes: number;
  signal: AbortSignal;
}): Promise<InspectedFile> {
  for (const candidate of options.candidates) {
    throwIfAborted(options.signal);
    let resolved;
    try {
      resolved = await options.policy.resolveReadPath(candidate);
    } catch (error) {
      if (
        error instanceof MoAgentToolError &&
        error.code === "PATH_NOT_FOUND"
      ) {
        continue;
      }
      // A fixed contract path resolving through an unsafe link is a workspace
      // integrity failure, not a missing-file condition. Fail closed.
      throw error;
    }
    const stat = await fs.stat(resolved.canonicalPath);
    if (!stat.isFile()) {
      return {
        path: resolved.relativePath,
        exists: true,
        bytes: stat.size,
        analysisSkipped: "not_a_file",
      };
    }
    if (stat.size > options.maxFileBytes) {
      return {
        path: resolved.relativePath,
        exists: true,
        bytes: stat.size,
        analysisSkipped: "file_too_large",
      };
    }
    const buffer = await fs.readFile(resolved.canonicalPath, {
      signal: options.signal,
    });
    if (buffer.includes(0)) {
      return {
        path: resolved.relativePath,
        exists: true,
        bytes: buffer.byteLength,
        analysisSkipped: "binary_file",
      };
    }
    const content = buffer.toString("utf8");
    return {
      path: resolved.relativePath,
      exists: true,
      bytes: buffer.byteLength,
      totalLines: textLineCount(content),
      content,
    };
  }
  return { path: options.candidates[0], exists: false };
}

function parseJson(file: InspectedFile): {
  validJson: boolean | null;
  record: JsonRecord | null;
} {
  if (!file.exists || file.content === undefined) {
    return { validJson: null, record: null };
  }
  try {
    const parsed: unknown = JSON.parse(file.content);
    return {
      validJson: true,
      record: isRecord(parsed) ? parsed : null,
    };
  } catch {
    return { validJson: false, record: null };
  }
}

function topLevelKeys(record: JsonRecord | null): string[] {
  return record
    ? Object.keys(record)
        .map((key) => boundedString(key, 80) ?? "")
        .filter(Boolean)
        .slice(0, 32)
    : [];
}

function summarizeRunPlan(file: InspectedFile): JsonRecord {
  const parsed = parseJson(file);
  const plan = parsed.record;
  const visualization = isRecord(plan?.visualization)
    ? plan.visualization
    : null;
  return {
    validJson: parsed.validJson,
    status: boundedString(plan?.status, 48),
    capabilityId: boundedString(plan?.capabilityId, 80),
    requestedCapabilityId: boundedString(plan?.requestedCapabilityId, 80),
    executionCapabilityId: boundedString(plan?.executionCapabilityId, 80),
    symbols: boundedStrings(plan?.symbols, 16, 32),
    timeRange: boundedString(plan?.timeRange, 100),
    dataRequirements: boundedStrings(plan?.dataRequirements, 12, 120),
    expectedArtifacts: boundedStrings(plan?.expectedArtifacts, 12, 160),
    validationRuleCount: Array.isArray(plan?.validationRules)
      ? plan.validationRules.length
      : 0,
    visualization: {
      required: visualization?.required === true,
      templateId: boundedString(visualization?.templateId, 100),
      variantId: boundedString(visualization?.variantId, 100),
      panels: boundedStrings(visualization?.panels, 16, 100),
      firstViewport: boundedStrings(visualization?.firstViewport, 10, 100),
    },
  };
}

function nestedArrayLength(
  record: JsonRecord | null,
  parent: string,
  child: string,
): number {
  const container = isRecord(record?.[parent]) ? record[parent] : null;
  return Array.isArray(container?.[child]) ? container[child].length : 0;
}

function summarizeFinalData(file: InspectedFile): JsonRecord {
  const parsed = parseJson(file);
  const value = parsed.record;
  const visualization = isRecord(value?.visualization)
    ? value.visualization
    : null;
  const assets = records(value?.assets);
  const primaryAsset = assets[0] ?? null;
  const comparison = isRecord(value?.comparison) ? value.comparison : null;
  return {
    validJson: parsed.validJson,
    topLevelKeys: topLevelKeys(value),
    generatedAtPresent:
      typeof value?.generatedAt === "string" ||
      typeof value?.generated_at === "string",
    hasQuote: isRecord(value?.quote) || isRecord(primaryAsset?.quote),
    assetCount: assets.length,
    barCount: Math.max(
      nestedArrayLength(value, "kline", "bars"),
      nestedArrayLength(value, "history", "bars"),
      nestedArrayLength(primaryAsset, "kline", "bars"),
    ),
    comparisonRowCount: Array.isArray(comparison?.rows)
      ? comparison.rows.length
      : 0,
    warningCount: Array.isArray(value?.warnings) ? value.warnings.length : 0,
    visualization: {
      templateId: boundedString(visualization?.template_id, 100),
      requiredComponentCount: Array.isArray(visualization?.required_components)
        ? visualization.required_components.length
        : 0,
      renderedComponentCount: Array.isArray(visualization?.rendered_components)
        ? visualization.rendered_components.length
        : 0,
      missingComponentCount: Array.isArray(visualization?.missing_components)
        ? visualization.missing_components.length
        : 0,
    },
  };
}

function statusCounts(items: JsonRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items.slice(0, 200)) {
    const status = boundedString(item.status, 32)?.toLowerCase() ?? "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function summarizeSources(file: InspectedFile): JsonRecord {
  const parsed = parseJson(file);
  const value = parsed.record;
  const sources = records(value?.sources);
  return {
    validJson: parsed.validJson,
    topLevelKeys: topLevelKeys(value),
    sourceCount: sources.length,
    sampledStatusCounts: statusCounts(sources),
    datasets: sources
      .map((source) => boundedString(source.dataset, 100))
      .filter((dataset): dataset is string => dataset !== null)
      .slice(0, 16),
  };
}

function summarizeDataQuality(file: InspectedFile): JsonRecord {
  const parsed = parseJson(file);
  const value = parsed.record;
  const datasets = records(value?.datasets);
  return {
    validJson: parsed.validJson,
    topLevelKeys: topLevelKeys(value),
    status: boundedString(value?.status, 32),
    datasetCount: datasets.length,
    checkCount: Array.isArray(value?.checks) ? value.checks.length : 0,
    warningCount: Array.isArray(value?.warnings) ? value.warnings.length : 0,
    limitationCount: Array.isArray(value?.limitations)
      ? value.limitations.length
      : 0,
    missingFieldCount: datasets.reduce(
      (total, dataset) =>
        total +
        (Array.isArray(dataset.missing_fields)
          ? dataset.missing_fields.length
          : 0),
      0,
    ),
    sampledStatusCounts: statusCounts(datasets),
  };
}

function linesOf(file: InspectedFile): string[] {
  const lines = file.content?.split(/\r?\n/) ?? [];
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
}

function matchingLines(
  lines: readonly string[],
  pattern: RegExp,
  maxLines = MAX_SIGNAL_LINES,
): number[] {
  const matches: number[] = [];
  for (
    let index = 0;
    index < lines.length && matches.length < maxLines;
    index += 1
  ) {
    pattern.lastIndex = 0;
    if (pattern.test(lines[index])) matches.push(index + 1);
  }
  return matches;
}

function classNamesInLines(
  lines: readonly string[],
  startLine = 1,
  endLine = lines.length,
  maxItems = MAX_COMPONENT_CLASSES,
): string[] {
  const names = new Set<string>();
  const startIndex = Math.max(0, startLine - 1);
  const endIndex = Math.min(lines.length, endLine);
  const addTokens = (value: string) => {
    for (const token of value.split(/\s+/)) {
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(token)) continue;
      names.add(token);
      if (names.size >= maxItems) break;
    }
  };
  for (let index = startIndex; index < endIndex && names.size < maxItems; index += 1) {
    const line = lines[index];
    if (!line.includes("className")) continue;
    for (const literal of line.matchAll(/className\s*=\s*["'`]([^"'`]+)["'`]/g)) {
      addTokens(literal[1] ?? "");
      if (names.size >= maxItems) break;
    }
    for (const expression of line.matchAll(/className\s*=\s*\{([^}]*)\}/g)) {
      for (const quoted of (expression[1] ?? "").matchAll(/["'`]([A-Za-z_][A-Za-z0-9_ -]{0,180})["'`]/g)) {
        addTokens(quoted[1] ?? "");
        if (names.size >= maxItems) break;
      }
      if (names.size >= maxItems) break;
    }
  }
  return Array.from(names);
}

function buildOutline(file: InspectedFile): {
  entries: OutlineEntry[];
  omitted: number;
} {
  const lines = linesOf(file);
  const declarations: Array<{
    kind: "component" | "function";
    name: string;
    line: number;
    defaultExport: boolean;
  }> = [];
  const declaration =
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
  const arrow =
    /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;
  for (const [index, line] of lines.entries()) {
    const match = line.match(declaration) ?? line.match(arrow);
    if (!match?.[1]) continue;
    const name = match[1].slice(0, 96);
    declarations.push({
      kind: /^[A-Z]/.test(name) ? "component" : "function",
      name,
      line: index + 1,
      defaultExport: /^export\s+default\b/.test(line),
    });
  }

  const essentialFunctions = new Set([
    "readDashboardData",
    "readSourcesEvidence",
    "getBars",
    "getAssets",
    "getComparisonRows",
    "getHoldings",
    "getPortfolio",
  ]);
  const prioritized = declarations.filter(
    (entry) =>
      entry.kind === "component" ||
      entry.defaultExport ||
      essentialFunctions.has(entry.name),
  );
  const selected = prioritized.slice(0, MAX_OUTLINE_ENTRIES);
  const entries = selected.map((entry) => {
    const declarationIndex = declarations.findIndex(
      (candidate) => candidate.line === entry.line && candidate.name === entry.name,
    );
    const next = declarations[declarationIndex + 1];
    const endLine = Math.max(entry.line, (next?.line ?? (lines.length + 1)) - 1);
    const usagePattern = new RegExp(`<${entry.name}\\b`);
    const renderLines = matchingLines(lines, usagePattern, MAX_COMPONENT_RENDER_LINES)
      .filter((line) => line < entry.line || line > endLine);
    return {
      kind: entry.kind,
      name: entry.name,
      line: entry.line,
      endLine,
      renderLines,
      classNames: classNamesInLines(lines, entry.line, endLine),
    };
  });
  return {
    entries,
    omitted: Math.max(0, declarations.length - entries.length),
  };
}

function buildPageSignals(page: InspectedFile): JsonRecord {
  const lines = linesOf(page);
  const finalDataPathLines = matchingLines(
    lines,
    /data_file\/final\/dashboard-data\.json/,
  );
  const sameOriginMarketLines = matchingLines(
    lines,
    /["'`]\/api\/market(?:\/|["'`])/,
  );
  const chartMarkupLines = matchingLines(
    lines,
    /<(?:svg|canvas)\b|ResponsiveContainer|(?:Line|Bar|Area|Composed|Scatter)Chart\b|KLine|Candlestick/i,
  );
  const chartDataLines = matchingLines(
    lines,
    /getBars\b|bars\.(?:map|slice)|chartPoints\b|candles?\b|ohlc/i,
  );
  const sourceEvidenceLines = matchingLines(
    lines,
    /evidence\/sources\.json|SOURCES_FILE|readSourcesEvidence|data_quality/i,
  );
  return {
    clientComponent: lines
      .slice(0, 8)
      .some((line) => /['"]use client['"]/.test(line)),
    dataBinding: {
      standardFinalDataPath: finalDataPathLines.length > 0,
      standardFinalDataPathLines: finalDataPathLines,
      serverFileReadLines: matchingLines(
        lines,
        /fs\.readFile|readDashboardData/,
      ),
      sameOriginMarketApi: sameOriginMarketLines.length > 0,
      sameOriginMarketApiLines: sameOriginMarketLines,
    },
    chart: {
      hasChartSignal: chartMarkupLines.length > 0 && chartDataLines.length > 0,
      markupOrLibraryLines: chartMarkupLines,
      dataDerivationLines: chartDataLines,
    },
    evidenceDisplayLines: sourceEvidenceLines,
  };
}

function buildProxySignals(proxy: InspectedFile): JsonRecord {
  const lines = linesOf(proxy);
  return {
    exists: proxy.exists,
    path: proxy.path,
    localBackendTargetLines: matchingLines(
      lines,
      /127\.0\.0\.1:8000|localhost:8000|MARKET_API_BASE|QUANT.*API.*BASE/i,
    ),
    forwardingFetchLines: matchingLines(lines, /\bfetch\s*\(/),
    exportedMethodLines: matchingLines(
      lines,
      /export\s+(?:async\s+)?function\s+(?:GET|POST)|export\s*\{[^}]*GET/,
    ),
  };
}

function buildResponsiveSignals(styles: InspectedFile): JsonRecord {
  const lines = linesOf(styles);
  return {
    mediaQueryLines: matchingLines(lines, /@media\b/i),
    overflowGuardLines: matchingLines(
      lines,
      /overflow-x\s*:\s*(?:auto|hidden|clip)/i,
    ),
    responsiveGridLines: matchingLines(
      lines,
      /minmax\s*\(|auto-(?:fit|fill)|grid-template-columns/i,
    ),
    fluidSizeLines: matchingLines(lines, /clamp\s*\(|\b(?:vw|dvw|svw)\b/i),
  };
}

function cssBlockEndLine(lines: readonly string[], startIndex: number): number {
  let depth = 0;
  let started = false;
  for (let index = startIndex; index < lines.length; index += 1) {
    for (const character of lines[index]) {
      if (character === "{") {
        depth += 1;
        started = true;
      } else if (character === "}") {
        depth -= 1;
      }
    }
    if (started && depth <= 0) return index + 1;
  }
  return lines.length;
}

function gridTrackHint(block: string): string | null {
  const value = block.match(/grid-template-columns\s*:\s*([^;\n}]+)/i)?.[1];
  if (!value) return null;
  const repeated = value.match(/repeat\(\s*(\d+)/i)?.[1];
  if (repeated) return `${repeated}-track`;
  if (/auto-(?:fit|fill)/i.test(value)) return "auto-responsive";
  if (/\b1fr\b/.test(value) && !/minmax|\s+\S+\s+/i.test(value.trim())) {
    return "single-track";
  }
  const minmaxCount = value.match(/minmax\s*\(/gi)?.length ?? 0;
  if (minmaxCount >= 2) return `${minmaxCount}-region-split`;
  if (minmaxCount === 1) return "split-with-fluid-region";
  return "custom-tracks";
}

function buildVisualSourceMap(
  page: InspectedFile,
  styles: InspectedFile,
  outline: ReturnType<typeof buildOutline>,
): JsonRecord {
  const pageLines = linesOf(page);
  const styleLines = linesOf(styles);
  const usedClasses = new Set(classNamesInLines(pageLines, 1, pageLines.length, 500));
  const defaultComponentLine = pageLines.findIndex((line) =>
    /^export\s+default\s+(?:async\s+)?function\b/.test(line),
  ) + 1;
  const rootComponent = outline.entries.find(
    (entry) => entry.line === defaultComponentLine,
  ) ?? outline.entries.find((entry) => entry.kind === "component" && entry.renderLines.length === 0) ?? null;
  const rootStart = rootComponent?.line ?? 1;
  const rootEnd = rootComponent?.endLine ?? pageLines.length;
  const rootMainLine = matchingLines(
    pageLines.slice(Math.max(0, rootStart - 1), rootEnd),
    /<main\b/,
    1,
  ).map((line) => line + rootStart - 1)[0] ?? null;
  const rootMainClasses = rootMainLine
    ? classNamesInLines(pageLines, rootMainLine, rootMainLine, 12)
    : [];
  const layoutRegions: JsonRecord[] = [];
  for (
    let index = Math.max(0, rootStart - 1);
    index < Math.min(pageLines.length, rootEnd) && layoutRegions.length < MAX_LAYOUT_REGIONS;
    index += 1
  ) {
    const match = pageLines[index].match(/<(main|header|section|article|aside|footer)\b/i);
    if (!match?.[1]) continue;
    layoutRegions.push({
      tag: match[1].toLowerCase(),
      line: index + 1,
      classNames: classNamesInLines(pageLines, index + 1, index + 1, 8),
    });
  }
  const structuralClasses = new Set([
    ...rootMainClasses,
    ...layoutRegions.flatMap((region) => boundedStrings(region.classNames, 8, 48)),
  ]);

  const rules: Array<{
    selector: string;
    startLine: number;
    endLine: number;
    referenced: boolean;
    display: string | null;
    gridTracks: string | null;
    maxRadiusPx: number;
    shadow: boolean;
    border: boolean;
    surface: boolean;
    cardCandidate: boolean;
  }> = [];
  for (let index = 0; index < styleLines.length; index += 1) {
    const braceIndex = styleLines[index].indexOf("{");
    if (braceIndex < 0) continue;
    let selectorStart = index;
    while (selectorStart > 0 && styleLines[selectorStart - 1].trim().endsWith(",")) {
      selectorStart -= 1;
    }
    const selector = boundedString(
      `${styleLines.slice(selectorStart, index).join(" ")} ${styleLines[index].slice(0, braceIndex)}`,
      220,
    );
    if (!selector || selector.startsWith("@") || selector.includes(";")) continue;
    const selectorClasses = Array.from(selector.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g))
      .map((match) => match[1]);
    if (selectorClasses.length === 0) continue;
    const endLine = cssBlockEndLine(styleLines, index);
    const block = styleLines.slice(index, endLine).join("\n");
    const radii = Array.from(block.matchAll(/border-radius\s*:\s*([0-9.]+)px/gi))
      .map((match) => Number.parseFloat(match[1] ?? "0"))
      .filter(Number.isFinite);
    const maxRadiusPx = radii.length > 0 ? Math.max(...radii) : 0;
    const shadow = /box-shadow\s*:\s*(?!none\b)[^;\n}]+/i.test(block);
    const border = /(?:^|[;{\n]\s*)border(?:-(?:top|right|bottom|left|inline|block))?\s*:/i.test(block);
    const surface = /(?:^|[;{\n]\s*)background(?:-color)?\s*:/i.test(block);
    const referenced = selectorClasses.some((name) => usedClasses.has(name));
    const display = block.match(/display\s*:\s*(grid|flex|block|inline-flex|inline-grid)/i)?.[1]?.toLowerCase() ?? null;
    const excludedDetachedControl = /(?:badge|pill|button|tooltip|popover|toast|tag|dot|legend|track|candle|change|source)(?:\b|-)/i.test(selector);
    const containerSignal = /(?:hero|panel|card|item|channel|summary|metric|tile|box)(?:\b|-)/i.test(selector);
    const cardCandidate =
      referenced &&
      !excludedDetachedControl &&
      containerSignal &&
      (shadow || (maxRadiusPx >= 6 && (border || surface)));
    rules.push({
      selector,
      startLine: selectorStart + 1,
      endLine,
      referenced,
      display,
      gridTracks: gridTrackHint(block),
      maxRadiusPx,
      shadow,
      border,
      surface,
      cardCandidate,
    });
  }

  const layoutRules = rules
    .filter((rule) => rule.referenced && (rule.display === "grid" || rule.display === "flex" || rule.gridTracks))
    .sort((left, right) => {
      const score = (rule: (typeof rules)[number]) => {
        const selectorClasses = Array.from(rule.selector.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g))
          .map((match) => match[1]);
        return (
          (selectorClasses.some((name) => structuralClasses.has(name)) ? 8 : 0) +
          (/command-center|content-grid|chart-zone|main-grid|holding-grid|comparison|selection|metric-(?:bar|strip)/i.test(rule.selector) ? 4 : 0) +
          (rule.gridTracks ? 2 : 0) +
          (rule.display === "grid" ? 1 : 0)
        );
      };
      return score(right) - score(left) || left.startLine - right.startLine;
    })
    .slice(0, MAX_STYLE_RULES)
    .map((rule) => ({
      selector: rule.selector,
      range: [rule.startLine, rule.endLine],
      display: rule.display,
      gridTracks: rule.gridTracks,
    }));
  const cardSurfaceCandidates = rules
    .filter((rule) => rule.cardCandidate)
    .slice(0, MAX_STYLE_RULES)
    .map((rule) => ({
      selector: rule.selector,
      range: [rule.startLine, rule.endLine],
      reasons: [
        ...(rule.maxRadiusPx >= 6 ? [`rounded-${rule.maxRadiusPx}px`] : []),
        ...(rule.shadow ? ["shadow"] : []),
        ...(rule.border ? ["boxed-border"] : []),
        ...(rule.surface ? ["detached-surface"] : []),
      ],
    }));
  const markerLine = matchingLines(
    pageLines,
    /data-visual-language=["']financial-workbench["']/,
    1,
  )[0] ?? null;
  const pageQueryAnchor = rootMainClasses[0] ?? (rootMainLine ? "<main" : null);
  const cssQueryAnchors = Array.from(new Set(
    cardSurfaceCandidates.flatMap((candidate) =>
      Array.from(candidate.selector.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g))
        .map((match) => `.${match[1]}`),
    ),
  )).slice(0, MAX_QUERY_TEXT_ANCHORS);

  return {
    root: {
      component: rootComponent?.name ?? null,
      range: rootComponent ? [rootComponent.line, rootComponent.endLine] : null,
      mainLine: rootMainLine,
      classNames: rootMainClasses,
      financialWorkbenchMarkerLine: markerLine,
    },
    regions: layoutRegions,
    components: outline.entries
      .filter((entry) => entry.kind === "component" && entry.renderLines.length > 0)
      .sort((left, right) => (left.renderLines[0] ?? Number.MAX_SAFE_INTEGER) - (right.renderLines[0] ?? Number.MAX_SAFE_INTEGER))
      .map((entry) => ({
        name: entry.name,
        range: [entry.line, entry.endLine],
        renderLines: entry.renderLines,
        classNames: entry.classNames,
      })),
    styles: {
      usedClassCount: usedClasses.size,
      inspectedRuleCount: rules.length,
      layoutRules,
      cardSurfaceCandidates,
    },
    preparedVisualEdit: {
      status: cardSurfaceCandidates.length > 0 ? "card_surfaces_detected" : "continuous_canvas_ready",
      objective:
        "Use one continuous financial-workbench canvas with hairline section dividers, contiguous metric strips, dominant charts/matrices, and dense tables; remove repeated rounded/shadowed surfaces.",
      pageMarker: markerLine
        ? { present: true, line: markerLine }
        : {
            present: false,
            targetRange: rootMainLine ? [rootMainLine, rootMainLine] : null,
            action: 'Add data-visual-language="financial-workbench" to the root <main>.',
          },
      cssTargetSelectors: cardSurfaceCandidates.map((item) => item.selector),
      cssRecipe: [
        "Scope the override to the root financial-workbench marker.",
        "Set major hero/panel/card surfaces to border-radius:0 and box-shadow:none.",
        "Replace detached surface gaps with shared border-bottom/border-left dividers.",
        "Keep pills, badges, tooltips, alerts, chart marks, and controls exempt.",
      ],
      minimalReadsBeforeEdit: [
        ...(pageQueryAnchor
          ? [{ path: page.path, anchors: [pageQueryAnchor] }]
          : []),
        ...(styles.exists && cssQueryAnchors.length > 0
          ? [{ path: styles.path, anchors: cssQueryAnchors }]
          : []),
      ],
    },
  };
}

function selectedFields(record: JsonRecord | null, keys: readonly string[]): JsonRecord {
  return Object.fromEntries(
    keys
      .filter((key) => record?.[key] !== undefined)
      .map((key) => [key, record?.[key]]),
  );
}

function compactUiInspection(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const styles = isRecord(value.styles) ? value.styles : null;
  const prepared = isRecord(value.preparedVisualEdit)
    ? value.preparedVisualEdit
    : null;
  return {
    root: value.root,
    regions: records(value.regions).slice(0, 12),
    components: records(value.components).slice(0, 14).map((component) => ({
      ...selectedFields(component, ["name", "range", "renderLines"]),
      classNames: boundedStrings(component.classNames, 5, 48),
    })),
    styles: styles
      ? {
          usedClassCount: styles.usedClassCount,
          inspectedRuleCount: styles.inspectedRuleCount,
          layoutRules: records(styles.layoutRules).slice(0, 8),
          cardSurfaceCandidates: records(styles.cardSurfaceCandidates).slice(0, 8),
        }
      : null,
    preparedVisualEdit: prepared,
  };
}

function compactPageContract(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const dataBinding = isRecord(value.dataBinding) ? value.dataBinding : null;
  const chart = isRecord(value.chart) ? value.chart : null;
  return {
    clientComponent: value.clientComponent === true,
    dataBinding: dataBinding
      ? {
          standardFinalDataPath: dataBinding.standardFinalDataPath === true,
          standardFinalDataPathLines: boundedNumbers(dataBinding.standardFinalDataPathLines, 3),
          serverFileReadLines: boundedNumbers(dataBinding.serverFileReadLines, 4),
          sameOriginMarketApi: dataBinding.sameOriginMarketApi === true,
          sameOriginMarketApiLines: boundedNumbers(dataBinding.sameOriginMarketApiLines, 4),
        }
      : null,
    chart: chart
      ? {
          hasChartSignal: chart.hasChartSignal === true,
          markupOrLibraryLines: boundedNumbers(chart.markupOrLibraryLines, 6),
          dataDerivationLines: boundedNumbers(chart.dataDerivationLines, 6),
        }
      : null,
    evidenceDisplayLines: boundedNumbers(value.evidenceDisplayLines, 5),
  };
}

function compactReport(report: JsonRecord): JsonRecord {
  const files = isRecord(report.files) ? report.files : null;
  const runPlan = isRecord(report.runPlan) ? report.runPlan : null;
  const artifacts = isRecord(report.artifacts) ? report.artifacts : null;
  const finalData = isRecord(artifacts?.finalData) ? artifacts.finalData : null;
  const sources = isRecord(artifacts?.sources) ? artifacts.sources : null;
  const dataQuality = isRecord(artifacts?.dataQuality)
    ? artifacts.dataQuality
    : null;
  return {
    schemaVersion: 1,
    advisory: report.advisory,
    reportTruncated: true,
    files: {
      page: files?.page,
      styles: files?.styles,
      marketProxy: files?.marketProxy,
    },
    requiredArtifacts: {
      runPlan: isRecord(files?.runPlan) ? files.runPlan.exists : false,
      finalData: isRecord(files?.finalData) ? files.finalData.exists : false,
      sources: isRecord(files?.sources) ? files.sources.exists : false,
      dataQuality: isRecord(files?.dataQuality) ? files.dataQuality.exists : false,
    },
    missingRequiredFiles: report.missingRequiredFiles,
    task: runPlan
      ? {
          ...selectedFields(runPlan, [
            "status",
            "capabilityId",
            "requestedCapabilityId",
            "symbols",
            "timeRange",
            "visualization",
          ]),
        }
      : null,
    dataHealth: {
      finalData: selectedFields(finalData, [
        "validJson",
        "generatedAtPresent",
        "hasQuote",
        "assetCount",
        "barCount",
        "comparisonRowCount",
        "warningCount",
        "visualization",
      ]),
      sources: selectedFields(sources, [
        "validJson",
        "sourceCount",
        "sampledStatusCounts",
      ]),
      dataQuality: selectedFields(dataQuality, [
        "validJson",
        "status",
        "datasetCount",
        "checkCount",
        "warningCount",
        "limitationCount",
        "missingFieldCount",
      ]),
    },
    pageContract: compactPageContract(report.pageContract),
    marketProxy: report.marketProxy,
    responsive: report.responsive,
    uiInspection: compactUiInspection(report.uiInspection),
    nextActions: report.nextActions,
  };
}

function minimalReport(report: JsonRecord): JsonRecord {
  const compact = compactReport(report);
  const ui = isRecord(compact.uiInspection) ? compact.uiInspection : null;
  const compactTask = isRecord(compact.task) ? compact.task : null;
  const compactStyles = isRecord(ui?.styles) ? ui.styles : null;
  const compactPrepared = isRecord(ui?.preparedVisualEdit)
    ? ui.preparedVisualEdit
    : null;
  return {
    schemaVersion: 1,
    advisory: report.advisory,
    reportTruncated: true,
    files: compact.files,
    missingRequiredFiles: report.missingRequiredFiles,
    task: compactTask
      ? {
          capabilityId: compactTask.capabilityId,
          symbols: compactTask.symbols,
          visualization: isRecord(compactTask.visualization)
            ? selectedFields(compactTask.visualization, ["templateId", "variantId"])
            : null,
        }
      : null,
    pageContract: compact.pageContract,
    uiInspection: ui
      ? {
          root: ui.root,
          regions: records(ui.regions).slice(0, 10),
          components: records(ui.components).slice(0, 10).map((component, index) => ({
            ...selectedFields(component, ["name", "range", "renderLines"]),
            ...(index < 3
              ? { classNames: boundedStrings(component.classNames, 5, 48) }
              : {}),
          })),
          styles: compactStyles
            ? {
                usedClassCount: compactStyles.usedClassCount,
                layoutRules: records(compactStyles.layoutRules).slice(0, 6),
                cardSurfaceCandidates: records(compactStyles.cardSurfaceCandidates)
                  .slice(0, 8)
                  .map((candidate) => selectedFields(candidate, ["selector", "range"])),
              }
            : null,
          preparedVisualEdit: compactPrepared
            ? selectedFields(compactPrepared, [
                "status",
                "objective",
                "pageMarker",
                "cssRecipe",
                "minimalReadsBeforeEdit",
              ])
            : null,
        }
      : null,
    nextAction:
      "If this snapshot was injected as initial_dashboard_contract, do not call inspect_dashboard_contract again. Pass each minimalReadsBeforeEdit object directly to query_text_file (one batched call per path), then perform one targeted edit; never scan full TSX/CSS files.",
  };
}

function renderBoundedReport(
  report: JsonRecord,
  maxOutputChars: number,
): {
  content: string;
  truncated: boolean;
  originalChars: number;
} {
  const full = JSON.stringify(report, null, 2);
  if (full.length <= maxOutputChars) {
    return { content: full, truncated: false, originalChars: full.length };
  }
  const compact = JSON.stringify(compactReport(report));
  if (compact.length <= maxOutputChars) {
    return { content: compact, truncated: true, originalChars: full.length };
  }
  const minimal = JSON.stringify(minimalReport(report));
  if (minimal.length <= maxOutputChars) {
    return { content: minimal, truncated: true, originalChars: full.length };
  }
  const output = truncateToolOutput(minimal, maxOutputChars);
  return {
    content: output.text,
    truncated: true,
    originalChars: full.length,
  };
}

function parseInput(value: unknown): Record<string, never> {
  const record = inputRecord(value);
  if (Object.keys(record).length > 0) {
    throw new MoAgentToolError(
      "INVALID_TOOL_INPUT",
      "inspect_dashboard_contract does not accept paths or other arguments.",
    );
  }
  return {};
}

export function createInspectDashboardContractTool(
  options: DashboardContractInspectionOptions,
): MoAgentTool<Record<string, never>, InspectDashboardContractOutput> {
  let policyPromise: Promise<MoAgentWorkspacePolicy> | undefined;
  const policy = () =>
    (policyPromise ??= MoAgentWorkspacePolicy.create({
      workspaceRoot: options.workspaceRoot,
    }));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_TOOL_OUTPUT_CHARS;
  const maxFileBytes =
    options.maxFileBytes ?? DEFAULT_MAX_INSPECTION_FILE_BYTES;

  return {
    name: "inspect_dashboard_contract",
    description:
      "Inspect the generated dashboard contract before editing. When initial_dashboard_contract is already injected, do not call this tool again. Otherwise call this first instead of reading page.tsx/globals.css sequentially; it returns a bounded component/layout map, CSS selector ranges, card-surface refactor targets, and query_text_file-ready batched literal anchors for one targeted edit. It is diagnostic only and never means validation passed.",
    effect: "read",
    idempotency: "intrinsic",
    observationCache: "workspace_generation",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    parseInput,
    execute: (_input, context) =>
      executeMoAgentTool(context.signal, timeoutMs, async (signal) => {
        const workspacePolicy = await policy();
        const pairs = await Promise.all(
          (
            Object.entries(FILE_CANDIDATES) as Array<
              [FileKey, readonly string[]]
            >
          ).map(
            async ([key, candidates]) =>
              [
                key,
                await inspectFirstExistingFile({
                  policy: workspacePolicy,
                  candidates,
                  maxFileBytes,
                  signal,
                }),
              ] as const,
          ),
        );
        const files = Object.fromEntries(pairs) as Record<
          FileKey,
          InspectedFile
        >;
        const fileSummaries = Object.fromEntries(
          pairs.map(([key, file]) => [key, publicFile(file)]),
        ) as Record<FileKey, PublicFileSummary>;
        const missingRequiredFiles = pairs
          .filter(([, file]) => !file.exists)
          .map(([, file]) => file.path);
        const outline = buildOutline(files.page);
        const report: JsonRecord = {
          schemaVersion: 1,
          advisory:
            "If this report is injected as initial_dashboard_contract, do not call inspect_dashboard_contract again. Pass each uiInspection.preparedVisualEdit.minimalReadsBeforeEdit object directly to query_text_file; every object's anchors are already batched for that path. This diagnostic does not run build/preview/visual validation and does not prove the dashboard is correct.",
          files: fileSummaries,
          missingRequiredFiles,
          runPlan: summarizeRunPlan(files.runPlan),
          artifacts: {
            finalData: summarizeFinalData(files.finalData),
            sources: summarizeSources(files.sources),
            dataQuality: summarizeDataQuality(files.dataQuality),
          },
          pageContract: buildPageSignals(files.page),
          marketProxy: buildProxySignals(files.marketProxy),
          responsive: buildResponsiveSignals(files.styles),
          outline,
          uiInspection: buildVisualSourceMap(files.page, files.styles, outline),
          nextActions: [
            "Do not call inspect_dashboard_contract when this report arrived as initial_dashboard_contract.",
            "Pass each uiInspection.preparedVisualEdit.minimalReadsBeforeEdit object directly to query_text_file: one call per path with all listed literal anchors.",
            "Make the smallest edit; only re-query exact changed anchors when necessary before submit_result.",
          ],
        };
        const rendered = renderBoundedReport(report, maxOutputChars);
        return {
          ok: true,
          data: {
            schemaVersion: 1,
            inspectedFiles: pairs.filter(([, file]) => file.exists).length,
            missingRequiredFiles,
            contentTruncated: rendered.truncated,
            originalContentChars: rendered.originalChars,
          },
          content: rendered.content,
        };
      }),
  };
}
