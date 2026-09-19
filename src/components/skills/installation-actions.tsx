"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  SkillsMarketData,
  SkillsMarketSkill,
} from "@/lib/skills/market";
import type { SkillAgentTarget } from "@/lib/agent/skills/catalog-store";

export function SkillsInstallationActions({
  projectId,
  target,
  skill,
  project,
  disabled,
  onChanged,
}: {
  projectId: string;
  target: SkillAgentTarget;
  skill: SkillsMarketSkill;
  project: SkillsMarketData["project"];
  disabled: boolean;
  onChanged: () => void;
}) {
  const [version, setVersion] = useState(skill.version);
  const [busy, setBusy] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const deployment = project?.deployment;
  const installed = deployment?.skillIds.includes(skill.id);
  async function mutate(action: "install" | "uninstall" | "rollback") {
    if (disabled || busy) return;
    const intent =
      action === "install"
        ? `安装 ${skill.name} v${version}`
        : action === "uninstall"
          ? `卸载 ${skill.name}；依赖它的任务将无法执行`
          : "恢复此 Agent 上一次安装的完整技能集合";
    if (
      !window.confirm(
        `确认在当前项目的 ${target} 中${intent}？${overwrite ? "\n已确认覆盖受管技能的本地修改。" : ""}`,
      )
    )
      return;
    setBusy(true);
    setMessage("");
    setFailed(false);
    try {
      const response = await fetch("/api/skills/installations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          target,
          action,
          skillId: skill.id,
          version,
          expectedRevision: deployment?.id ?? null,
          overwriteModified: overwrite,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success)
        throw new Error(payload.error || "安装操作失败。");
      setMessage("项目技能版本已更新。");
      setOverwrite(false);
      onChanged();
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-3 space-y-3 rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">
        {target === "pi-agent"
          ? deployment
            ? "执行版本已固定；平台发版不会自动升级此项目。"
            : "首次安装会固定平台当前稳定技能集，后续可逐项管理。"
          : "安装标准技能文件；外部 Agent 的工具接入和实际运行效果尚未验证。请在外部 Agent 中重新加载技能。"}
      </p>
      <label className="flex flex-wrap items-center gap-2 text-sm">
        安装版本
        <select
          aria-label="安装版本"
          value={version}
          onChange={(event) => setVersion(event.target.value)}
          disabled={busy || disabled}
          className="rounded border bg-background p-2"
        >
          {skill.releases
            .filter((release) => release.installable)
            .map((release) => (
              <option key={release.version} value={release.version}>
                v{release.version}
              </option>
            ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={overwrite}
          onChange={(event) => setOverwrite(event.target.checked)}
          disabled={busy || disabled}
        />
        覆盖受管技能的本地修改（保留非受管技能）
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => void mutate("install")}
          disabled={
            busy ||
            disabled ||
            !skill.packageVerified ||
            !skill.releases.some(
              (release) => release.version === version && release.installable,
            )
          }
        >
          {busy ? "处理中…" : installed ? "安装所选版本" : "安装并固定版本"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void mutate("uninstall")}
          disabled={busy || disabled || !installed}
        >
          卸载
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void mutate("rollback")}
          disabled={busy || disabled || !deployment?.canRollback}
        >
          回退上次安装
        </Button>
      </div>
      {deployment && (
        <p className="text-xs text-muted-foreground">
          最近维护：{deployment.actor} ·{" "}
          {new Date(deployment.updatedAt).toLocaleString("zh-CN")}
        </p>
      )}
      {message && (
        <p
          role={failed ? "alert" : "status"}
          className={failed ? "text-sm text-destructive" : "text-sm"}
        >
          {message}
        </p>
      )}
    </div>
  );
}
