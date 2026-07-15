import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  MoAgentTool,
  MoAgentToolContext,
  MoAgentToolResult,
} from "@/lib/agent/types";
import { createInspectDashboardContractTool } from "./dashboard-contract";
import { createMoAgentTools } from "./index";

const context: MoAgentToolContext = {
  runId: "run-dashboard-contract",
  turn: 1,
  toolCallId: "call-dashboard-contract",
  operationId: "op_dashboard_contract",
  signal: new AbortController().signal,
};

async function invoke(
  tool: MoAgentTool,
  input: unknown = {},
): Promise<MoAgentToolResult> {
  const parsed = tool.parseInput ? tool.parseInput(input) : input;
  return tool.execute(parsed, context);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("inspect_dashboard_contract tool", () => {
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-contract-"));
    outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "moagent-contract-outside-"),
    );
  });

  afterEach(async () => {
    await Promise.all([
      fs.rm(workspace, { recursive: true, force: true }),
      fs.rm(outside, { recursive: true, force: true }),
    ]);
  });

  async function createCompleteFixture(): Promise<void> {
    await fs.mkdir(path.join(workspace, "app", "api", "market", "[...path]"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspace, "app", "page.tsx"),
      [
        "import fs from 'fs/promises';",
        "const DATA_FILE = 'data_file/final/dashboard-data.json';",
        "const SOURCES_FILE = 'evidence/sources.json';",
        "",
        "function getBars(data: unknown) {",
        "  return Array.isArray(data) ? data : [];",
        "}",
        "",
        "const MetricCard = ({ value }: { value: number }) => <strong>{value}</strong>;",
        "",
        "function PriceChart({ bars }: { bars: number[] }) {",
        "  const chartPoints = bars.map((value, index) => ({ value, index }));",
        "  return <svg>{chartPoints.map((point) => <path key={point.index} />)}</svg>;",
        "}",
        "",
        "export default async function Page() {",
        '  const raw = await fs.readFile(DATA_FILE, "utf8");',
        '  const sources = await fs.readFile(SOURCES_FILE, "utf8");',
        '  const response = await fetch("/api/market/api/v1/quotes/realtime/600519");',
        "  const bars = getBars(JSON.parse(raw));",
        "  return <main><MetricCard value={bars.length} /><PriceChart bars={bars} />{sources}{response.status}</main>;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspace, "app", "globals.css"),
      [
        ".dashboard {",
        "  display: grid;",
        "  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));",
        "  overflow-x: clip;",
        "  font-size: clamp(14px, 2vw, 18px);",
        "}",
        "@media (max-width: 720px) {",
        "  .dashboard { grid-template-columns: 1fr; }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspace, "app", "api", "market", "[...path]", "route.ts"),
      [
        "const MARKET_API_BASE = 'http://127.0.0.1:8000';",
        "export async function GET(request: Request) {",
        "  return fetch(MARKET_API_BASE + new URL(request.url).pathname);",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeJson(path.join(workspace, ".quantpilot", "run_plan.json"), {
      status: "planned",
      capabilityId: "stock_diagnosis",
      symbols: ["600519"],
      timeRange: "最近 120 个交易日",
      dataRequirements: ["quote", "kline", "financials"],
      expectedArtifacts: [
        "data_file/final/dashboard-data.json",
        "app/page.tsx",
      ],
      validationRules: ["build passes", "chart exists"],
      visualization: {
        required: true,
        templateId: "stock-diagnosis-v1",
        panels: ["price", "kline", "risk"],
        firstViewport: ["symbol", "price", "chart"],
      },
    });
    await writeJson(
      path.join(workspace, "data_file", "final", "dashboard-data.json"),
      {
        generatedAt: "2026-07-15T00:00:00Z",
        quote: { price: 1_500, privatePayload: "RAW-BUSINESS-SECRET" },
        kline: {
          bars: Array.from({ length: 120 }, (_, index) => ({
            date: `2026-01-${index}`,
            close: index,
            privatePayload: "RAW-BUSINESS-SECRET",
          })),
        },
        visualization: {
          template_id: "stock-diagnosis-v1",
          required_components: ["price", "kline"],
          rendered_components: ["price", "kline"],
          missing_components: [],
        },
      },
    );
    await writeJson(path.join(workspace, "evidence", "sources.json"), {
      sources: [
        {
          dataset: "实时行情",
          status: "ok",
          endpoint: "/private/RAW-BUSINESS-SECRET",
        },
        { dataset: "历史 K 线", status: "warning" },
      ],
    });
    await writeJson(path.join(workspace, "evidence", "data_quality.json"), {
      status: "warning",
      datasets: [
        { status: "ok", missing_fields: [] },
        { status: "warning", missing_fields: ["turnover"] },
      ],
      checks: [{ status: "warning" }],
      warnings: ["RAW-BUSINESS-SECRET"],
      limitations: ["RAW-BUSINESS-SECRET"],
    });
  }

  it("returns one bounded structural index without raw page, CSS, or business payloads", async () => {
    await createCompleteFixture();
    const tool = createInspectDashboardContractTool({
      workspaceRoot: workspace,
      maxOutputChars: 12_000,
    });

    const result = await invoke(tool);

    expect(tool).toMatchObject({
      name: "inspect_dashboard_contract",
      effect: "read",
      idempotency: "intrinsic",
    });
    expect(tool.description).toContain("initial_dashboard_contract");
    expect(tool.description).toContain("query_text_file-ready");
    expect(tool.description).toContain("never means validation passed");
    expect(result).toMatchObject({
      ok: true,
      data: {
        schemaVersion: 1,
        inspectedFiles: 7,
        missingRequiredFiles: [],
        contentTruncated: false,
      },
    });
    if (!result.ok || !result.content)
      throw new Error("Expected inspection content");
    expect(result.content.length).toBeLessThanOrEqual(12_000);
    expect(result.content).not.toContain("RAW-BUSINESS-SECRET");
    expect(result.content).not.toContain("return <main>");
    expect(result.content).not.toContain("grid-template-columns:");

    const report = JSON.parse(result.content);
    expect(report).toMatchObject({
      runPlan: {
        status: "planned",
        capabilityId: "stock_diagnosis",
        symbols: ["600519"],
        visualization: { templateId: "stock-diagnosis-v1" },
      },
      artifacts: {
        finalData: { validJson: true, hasQuote: true, barCount: 120 },
        sources: { validJson: true, sourceCount: 2 },
        dataQuality: {
          validJson: true,
          status: "warning",
          datasetCount: 2,
          missingFieldCount: 1,
        },
      },
      pageContract: {
        dataBinding: {
          standardFinalDataPath: true,
          sameOriginMarketApi: true,
        },
        chart: { hasChartSignal: true },
      },
      marketProxy: { exists: true },
    });
    expect(report.responsive.mediaQueryLines.length).toBeGreaterThan(0);
    expect(report.responsive.overflowGuardLines.length).toBeGreaterThan(0);
    expect(report.outline.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "function", name: "getBars", line: 5 }),
        expect.objectContaining({
          kind: "component",
          name: "MetricCard",
          line: 9,
        }),
        expect.objectContaining({
          kind: "component",
          name: "PriceChart",
          line: 11,
        }),
        expect.objectContaining({ kind: "component", name: "Page", line: 16 }),
      ]),
    );
  });

  it("fails closed when a fixed contract path escapes through a symbolic link", async () => {
    await fs.mkdir(path.join(workspace, "app"), { recursive: true });
    const outsidePage = path.join(outside, "page.tsx");
    await fs.writeFile(outsidePage, "HOST-SECRET\n", "utf8");
    await fs.symlink(outsidePage, path.join(workspace, "app", "page.tsx"));

    const result = await invoke(
      createInspectDashboardContractTool({
        workspaceRoot: workspace,
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "SYMLINK_ESCAPE_DENIED" },
    });
    expect(JSON.stringify(result)).not.toContain("HOST-SECRET");
  });

  it("preserves an actionable UI edit map inside the 6000-character runtime budget", async () => {
    await createCompleteFixture();
    const pagePath = path.join(workspace, "app", "page.tsx");
    const stylePath = path.join(workspace, "app", "globals.css");
    const originalPage = await fs.readFile(pagePath, "utf8");
    const panels = Array.from({ length: 18 }, (_, index) =>
      `const ResearchPanel${index} = () => <article className="research-panel-${index}">panel</article>;`,
    ).join("\n");
    const panelUsages = Array.from(
      { length: 18 },
      (_, index) => `<ResearchPanel${index} />`,
    ).join("");
    await fs.writeFile(
      pagePath,
      originalPage
        .replace(
          "export default async function Page() {",
          `${panels}\n\nexport default async function Page() {`,
        )
        .replace(
          "return <main>",
          `return <main className="dashboard">${panelUsages}`,
        ),
      "utf8",
    );
    const cardRules = Array.from(
      { length: 18 },
      (_, index) =>
        `.research-panel-${index} { border: 1px solid #ddd; border-radius: 12px; background: white; box-shadow: 0 2px 8px #0001; }`,
    ).join("\n");
    await fs.appendFile(stylePath, `\n${cardRules}\n`, "utf8");

    const result = await invoke(
      createInspectDashboardContractTool({
        workspaceRoot: workspace,
        maxOutputChars: 6_000,
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      data: { contentTruncated: true },
    });
    if (!result.ok || !result.content)
      throw new Error("Expected bounded UI inspection");
    expect(result.content.length).toBeLessThanOrEqual(6_000);
    expect(() => JSON.parse(result.content!)).not.toThrow();
    const report = JSON.parse(result.content);
    expect(report.files).toMatchObject({
      page: { path: "app/page.tsx", exists: true },
      styles: { path: "app/globals.css", exists: true },
    });
    expect(report.uiInspection).toMatchObject({
      root: {
        component: "Page",
        classNames: ["dashboard"],
      },
      preparedVisualEdit: {
        status: "card_surfaces_detected",
        pageMarker: {
          present: false,
          action: expect.stringContaining("financial-workbench"),
        },
        minimalReadsBeforeEdit: expect.arrayContaining([
          expect.objectContaining({
            path: "app/page.tsx",
            anchors: ["dashboard"],
          }),
          expect.objectContaining({
            path: "app/globals.css",
            anchors: expect.arrayContaining([".research-panel-0"]),
          }),
        ]),
      },
    });
    expect(report.uiInspection.styles.cardSurfaceCandidates.length).toBeGreaterThan(0);
    expect(report.uiInspection.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "PriceChart",
          range: expect.any(Array),
          renderLines: expect.any(Array),
        }),
      ]),
    );
    expect(result.content).not.toContain("grid-template-columns:");
    expect(result.content).not.toContain("return <main");
    expect(result.content).not.toContain("read_file_range");
  });

  it("reports oversized files without reading or echoing their contents", async () => {
    await fs.mkdir(path.join(workspace, "app"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, "app", "page.tsx"),
      "OVERSIZED-PRIVATE-BODY".repeat(1_000),
      "utf8",
    );

    const result = await invoke(
      createInspectDashboardContractTool({
        workspaceRoot: workspace,
        maxFileBytes: 128,
        maxOutputChars: 3_000,
      }),
    );

    expect(result).toMatchObject({ ok: true });
    if (!result.ok || !result.content)
      throw new Error("Expected bounded inspection");
    expect(result.content.length).toBeLessThanOrEqual(3_000);
    expect(result.content).not.toContain("OVERSIZED-PRIVATE-BODY");
    const report = JSON.parse(result.content);
    expect(report.files.page).toMatchObject({
      exists: true,
      analysisSkipped: "file_too_large",
    });
    expect(report).not.toHaveProperty("outline.entries.0");
  });

  it("returns a useful missing-file diagnostic and rejects caller-selected paths", async () => {
    const tool = createInspectDashboardContractTool({
      workspaceRoot: workspace,
    });
    const result = await invoke(tool);

    expect(result).toMatchObject({
      ok: true,
      data: {
        inspectedFiles: 0,
        missingRequiredFiles: expect.arrayContaining([
          "app/page.tsx",
          "app/globals.css",
          ".quantpilot/run_plan.json",
          "data_file/final/dashboard-data.json",
        ]),
      },
    });
    if (!result.ok || !result.content)
      throw new Error("Expected missing-file report");
    expect(JSON.parse(result.content).files.page).toMatchObject({
      path: "app/page.tsx",
      exists: false,
    });
    expect(() =>
      tool.parseInput?.({ pagePath: "../outside/page.tsx" }),
    ).toThrow(/does not accept paths/);
  });

  it("is installed by default in both generation and repair registries", () => {
    for (const profile of ["generation", "repair"] as const) {
      const tools = createMoAgentTools({
        workspaceRoot: workspace,
        profile,
        ...(profile === "repair" ? { profileAllowedWriteGlobs: [] } : {}),
        includeImageExtraction: false,
      });
      expect(
        tools.filter((tool) => tool.name === "inspect_dashboard_contract"),
      ).toHaveLength(1);
    }
  });
});
