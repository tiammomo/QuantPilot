"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Loader2,
  PencilLine,
  ShieldCheck,
  X,
} from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";
const APPROVAL_DECISIONS = new Set(["approve", "edit", "reject"]);

type ApprovalDecision = "approve" | "edit" | "reject";

export interface PendingToolApproval {
  id: string;
  runId: string;
  toolName: string;
  effect: "workspace_write" | "external_write";
  publicInput: Record<string, unknown>;
  reason: string;
  allowedDecisions: ApprovalDecision[];
  requestedAt: string;
  expiresAt: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parsePendingToolApprovals(value: unknown): PendingToolApproval[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const approval = record(item);
    const publicInput = record(approval?.publicInput);
    const allowedDecisions = Array.isArray(approval?.allowedDecisions)
      ? approval.allowedDecisions.filter(
          (decision): decision is ApprovalDecision =>
            typeof decision === "string" &&
            APPROVAL_DECISIONS.has(decision),
        )
      : [];
    if (
      !approval ||
      typeof approval.id !== "string" ||
      typeof approval.runId !== "string" ||
      typeof approval.toolName !== "string" ||
      (approval.effect !== "workspace_write" &&
        approval.effect !== "external_write") ||
      !publicInput ||
      typeof approval.reason !== "string" ||
      typeof approval.requestedAt !== "string" ||
      typeof approval.expiresAt !== "string" ||
      approval.status !== "pending" ||
      !allowedDecisions.includes("approve") ||
      !allowedDecisions.includes("reject")
    ) {
      return [];
    }
    return [{
      id: approval.id,
      runId: approval.runId,
      toolName: approval.toolName,
      effect: approval.effect,
      publicInput,
      reason: approval.reason,
      allowedDecisions,
      requestedAt: approval.requestedAt,
      expiresAt: approval.expiresAt,
    }];
  });
}

function apiMessage(value: unknown, fallback: string): string {
  const body = record(value);
  return typeof body?.message === "string"
    ? body.message
    : typeof body?.error === "string"
      ? body.error
      : fallback;
}

export default function ToolApprovalPanel({
  projectId,
  refreshVersion,
}: {
  projectId: string;
  refreshVersion: number;
}) {
  const [approvals, setApprovals] = useState<PendingToolApproval[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const loadApprovals = useCallback(
    async (signal?: AbortSignal) => {
      if (!projectId) return;
      setIsLoading(true);
      try {
        const response = await fetch(
          `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/agent/approvals?status=pending&limit=20`,
          { cache: "no-store", signal },
        );
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(apiMessage(body, "无法读取待确认操作。"));
        }
        const envelope = record(body);
        setApprovals(parsePendingToolApprovals(envelope?.data));
        setError(null);
      } catch (loadError) {
        if (
          loadError instanceof DOMException &&
          loadError.name === "AbortError"
        ) {
          return;
        }
        setError(
          loadError instanceof Error
            ? loadError.message
            : "无法读取待确认操作。",
        );
      } finally {
        if (!signal?.aborted) setIsLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadApprovals(controller.signal);
    // The durable "requested" event is committed before the application
    // handler inserts its approval row. Retry briefly so a fast realtime fetch
    // cannot miss that deliberately ordered hand-off.
    const retryTimers =
      refreshVersion > 0
        ? [500, 1_500, 3_000].map((delay) =>
            window.setTimeout(() => void loadApprovals(), delay),
          )
        : [];
    return () => {
      controller.abort();
      retryTimers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [loadApprovals, refreshVersion]);

  useEffect(() => {
    if (approvals.length === 0) return;
    const timer = window.setInterval(() => void loadApprovals(), 5_000);
    return () => window.clearInterval(timer);
  }, [approvals.length, loadApprovals]);

  const resolveApproval = async (
    approval: PendingToolApproval,
    decision: ApprovalDecision,
  ) => {
    setSubmittingId(approval.id);
    setError(null);
    try {
      let editedInput: unknown;
      if (decision === "edit") {
        try {
          editedInput = JSON.parse(
            drafts[approval.id] ??
              JSON.stringify(approval.publicInput, null, 2),
          );
        } catch {
          throw new Error("修改后的参数必须是有效的 JSON 对象。");
        }
      }
      const response = await fetch(
        `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/agent/approvals/${encodeURIComponent(approval.id)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision,
            ...(decision === "edit" ? { editedInput } : {}),
          }),
        },
      );
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(apiMessage(body, "确认操作失败，请重试。"));
      }
      setApprovals((current) =>
        current.filter((item) => item.id !== approval.id),
      );
      setEditingId(null);
      await loadApprovals();
    } catch (resolveError) {
      setError(
        resolveError instanceof Error
          ? resolveError.message
          : "确认操作失败，请重试。",
      );
    } finally {
      setSubmittingId(null);
    }
  };

  if (approvals.length === 0 && !error) return null;

  return (
    <section
      aria-label="待确认的工具操作"
      className="mx-8 mt-3 rounded-xl border border-amber-200 bg-amber-50/70 p-4 text-slate-900"
    >
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-amber-700" aria-hidden="true" />
        <h2 className="text-sm font-semibold">操作确认</h2>
        {isLoading && (
          <Loader2
            className="ml-auto h-4 w-4 animate-spin text-slate-400"
            aria-label="正在刷新"
          />
        )}
      </div>
      <p className="mt-1 text-xs text-slate-600">
        MoAgent 已暂停执行。确认前不会产生对应的写入副作用。
      </p>

      <div className="mt-3 space-y-3">
        {approvals.map((approval) => {
          const isSubmitting = submittingId === approval.id;
          const canEdit = approval.allowedDecisions.includes("edit");
          return (
            <article
              key={approval.id}
              className="rounded-lg border border-amber-200/80 bg-white p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">{approval.toolName}</div>
                  <p className="mt-0.5 text-xs text-slate-600">
                    {approval.reason}
                  </p>
                </div>
                <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] text-slate-600">
                  {approval.effect === "external_write"
                    ? "外部系统写入"
                    : "工作区写入"}
                </span>
              </div>

              <details className="mt-3 text-xs">
                <summary className="cursor-pointer select-none text-slate-600 hover:text-slate-900">
                  查看公开参数
                </summary>
                <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-slate-950 p-3 text-[11px] leading-5 text-slate-100">
                  {JSON.stringify(approval.publicInput, null, 2)}
                </pre>
              </details>

              {editingId === approval.id && (
                <div className="mt-3">
                  <label
                    htmlFor={`approval-input-${approval.id}`}
                    className="text-xs font-medium text-slate-700"
                  >
                    修改参数
                  </label>
                  <textarea
                    id={`approval-input-${approval.id}`}
                    value={
                      drafts[approval.id] ??
                      JSON.stringify(approval.publicInput, null, 2)
                    }
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [approval.id]: event.target.value,
                      }))
                    }
                    className="mt-1 min-h-36 w-full rounded-md border border-slate-300 bg-white p-3 font-mono text-xs outline-none focus:border-amber-500"
                    spellCheck={false}
                  />
                </div>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => void resolveApproval(approval, "approve")}
                  className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  批准执行
                </button>
                {canEdit &&
                  (editingId === approval.id ? (
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => void resolveApproval(approval, "edit")}
                      className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <PencilLine
                        className="h-3.5 w-3.5"
                        aria-hidden="true"
                      />
                      保存并执行
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => setEditingId(approval.id)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <PencilLine
                        className="h-3.5 w-3.5"
                        aria-hidden="true"
                      />
                      修改参数
                    </button>
                  ))}
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => void resolveApproval(approval, "reject")}
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                  拒绝
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {error && (
        <div className="mt-3 flex items-center gap-3 text-xs text-red-700">
          <p role="alert">{error}</p>
          <button
            type="button"
            disabled={isLoading}
            onClick={() => void loadApprovals()}
            className="shrink-0 font-medium underline underline-offset-2 disabled:opacity-50"
          >
            重新加载
          </button>
        </div>
      )}
    </section>
  );
}
