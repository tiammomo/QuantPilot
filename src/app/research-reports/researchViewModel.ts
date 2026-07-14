import type { ResearchReportSnapshot } from "@/lib/quant/research-reports";

type JsonRecord = Record<string, unknown>;

export type ResearchCandidate = {
  symbol: string;
  name: string;
  score: number | null;
  changePercent: number | null;
  tradeDate: string;
  signals: string[];
  warnings: string[];
};

export type ResearchCoverage = {
  universeId: string;
  readyCount: number;
  memberCount: number;
  coverageRatio: number;
};

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function reportCandidates(report: ResearchReportSnapshot): ResearchCandidate[] {
  return array(record(report.structured).candidates).map((value) => {
    const item = record(value);
    return {
      symbol: string(item.symbol) || string(item.code) || "-",
      name: string(item.name, "未命名标的"),
      score: number(item.score),
      changePercent: number(item.changePercent),
      tradeDate: string(item.tradeDate),
      signals: array(item.signals).filter((entry): entry is string => typeof entry === "string"),
      warnings: array(item.warnings).filter((entry): entry is string => typeof entry === "string"),
    };
  });
}

export function reportCoverage(report: ResearchReportSnapshot): ResearchCoverage | null {
  const coverage = record(record(report.structured).coverage);
  const universeId = string(coverage.universeId);
  const readyCount = number(coverage.readyCount);
  const memberCount = number(coverage.memberCount);
  const coverageRatio = number(coverage.coverageRatio);
  if (!universeId && readyCount == null && memberCount == null && coverageRatio == null) return null;
  return {
    universeId: universeId || "未绑定股票池",
    readyCount: readyCount ?? 0,
    memberCount: memberCount ?? 0,
    coverageRatio: coverageRatio ?? 0,
  };
}

export function reportRisks(report: ResearchReportSnapshot): string[] {
  return array(record(report.structured).risks).filter((entry): entry is string => typeof entry === "string");
}

export function formatResearchTime(value: string | null, includeYear = false) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    ...(includeYear ? { year: "numeric" as const } : {}),
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
