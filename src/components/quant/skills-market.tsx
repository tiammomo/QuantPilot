"use client";

import { SkillsInstallationActions } from './skills-installation-actions';
import type { SkillAgentTarget } from '@/lib/agent/skills/catalog-store';
import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Package, Search, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SkillsMarketData } from "@/lib/quant/skills-market";
import type { SkillInstallationState } from "@/lib/quant/skills-installation-status";

const PHASES = {
  planning: "规划",
  "data-preparation": "数据准备",
  "workspace-generation": "工作区生成",
  "validation-repair": "验证修复",
  "platform-ui": "平台开发",
};
const SCOPES = {
  workflow: "工作流",
  quant: "量化",
  input: "输入",
  evidence: "证据",
  platform: "平台",
  visualization: "可视化",
};
const INSTALLATION: Record<SkillInstallationState, string> = {
  current: "版本一致",
  outdated: "版本待更新",
  modified: "文件已修改",
  missing: "未安装",
  unverified: "无法核验",
};
const selectClass =
  "h-10 min-w-0 rounded-lg border border-input bg-background px-3 text-sm";
type Project = { id: string; name: string };

async function fetchData<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: "no-store" });
  const result = await response.json();
  if (!response.ok || !result.success)
    throw new Error(result.error || "加载失败，请重试。");
  return result.data;
}

export function SkillsMarket({
  refreshKey,
  onOpenStudio,
}: {
  refreshKey: string;
  onOpenStudio: (id: string) => void;
}) {
  const [data, setData] = useState<SkillsMarketData | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [target, setTarget] = useState<SkillAgentTarget>("pi-agent");
  const [projectError, setProjectError] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("");
  const [capability, setCapability] = useState("");
  const [phase, setPhase] = useState("");
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const detailTrigger = useRef<HTMLButtonElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setProjectError("");
    setProjectsLoading(true);
    fetchData<Project[]>("/api/projects", controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setProjects(value);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setProjectError(reason.message);
      }).finally(() => { if (!controller.signal.aborted) setProjectsLoading(false); });
    return () => controller.abort();
  }, [retry]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetchData<SkillsMarketData>(
      `/api/skills/market${projectId ? `?projectId=${encodeURIComponent(projectId)}${target === "pi-agent" ? "" : `&target=${target}`}` : ""}`,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refreshKey, projectId, target, retry]);

  const filtered = useMemo(
    () =>
      (data?.skills ?? []).filter((skill) => {
        if (scope && skill.scope !== scope) return false;
        if (capability && !skill.capabilities.some((id) => id === capability))
          return false;
        if (
          phase &&
          !skill.phases.some((item) => item.phase === phase && item.compatible)
        )
          return false;
        if (verifiedOnly && !skill.packageVerified) return false;
        return [
          skill.id,
          skill.name,
          skill.boundary,
          skill.version,
          ...skill.inputs,
          ...skill.outputs,
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase());
      }),
    [data, scope, capability, phase, verifiedOnly, query],
  );
  const selected = data?.skills.find((skill) => skill.id === selectedId);
  // Never display the previous project's receipt while a new request is pending or failed.
  const installation =
    !loading && !error && data?.project?.id === projectId && (data.project.target ?? "pi-agent") === target ? data.project : null;
  const installed = (id: string) =>
    installation?.skills.find((skill) => skill.skillId === id);
  const reset = () => {
    setQuery("");
    setScope("");
    setCapability("");
    setPhase("");
    setVerifiedOnly(false);
  };

  return (
    <main className="platform-content flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-7 sm:px-8">
        <section className="rounded-2xl border bg-card p-6">
          <p className="flex items-center gap-2 text-sm font-medium text-primary">
            <ShieldCheck className="h-4 w-4" />
            QuantPilot 内置可信技能
          </p>
          <h1 className="mt-3 text-2xl font-semibold">
            选择研究能力，核验交付版本
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            技能由平台按任务和阶段选用。这里展示发布包完整性、工具兼容性和项目文件状态；研究结果质量由任务评测单独验证。
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <label htmlFor="market-project" className="text-sm font-medium">
              项目安装状态
            </label>
            <select
              id="market-project"
              disabled={projectsLoading}
              className={selectClass}
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">{projectsLoading ? "正在加载项目…" : "仅浏览技能库"}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            {projectId && <label className="flex items-center gap-2 text-sm">安装到 Agent<select aria-label="安装到 Agent" className={selectClass} value={target} onChange={(event) => setTarget(event.target.value as SkillAgentTarget)}>{(data?.targets ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}</select></label>}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRetry((value) => value + 1)}
            >
              重新核验
            </Button>
          </div>
          {projectError && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              项目列表加载失败：{projectError}
            </p>
          )}
          {projectId && (
            <p className="mt-3 text-xs text-muted-foreground">
              {target !== "pi-agent" ? "外部 Agent 安装状态；实际运行尚未验证。" : installation?.execution === "pinned" ? "执行版本已固定；安装目录是可检查的参考副本。" : "尚未固定执行版本，任务使用平台当前发布版。"}
              {installation?.installedAt
                ? `最近安装：${new Date(installation.installedAt).toLocaleString("zh-CN")}`
                : ""}
            </p>
          )}
          {loading && (
            <p role="status" className="mt-3 text-sm">
              正在核验技能{projectId ? "及项目文件" : ""}…
            </p>
          )}
          {error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error} 当前结果已过期，请重新核验。
            </p>
          )}
        </section>
        <section aria-label="技能筛选" className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              aria-label="搜索技能"
              placeholder="搜索名称、能力、输入或输出…"
              className="pl-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <select
              aria-label="能力域"
              className={selectClass}
              value={scope}
              onChange={(event) => setScope(event.target.value)}
            >
              <option value="">全部能力域</option>
              {Object.entries(SCOPES).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            <select
              aria-label="研究能力"
              className={selectClass}
              value={capability}
              onChange={(event) => setCapability(event.target.value)}
            >
              <option value="">全部研究能力</option>
              {data?.capabilities.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.status === "planned" ? "（规划中）" : ""}
                </option>
              ))}
            </select>
            <select
              aria-label="兼容阶段"
              className={selectClass}
              value={phase}
              onChange={(event) => setPhase(event.target.value)}
            >
              <option value="">全部运行阶段</option>
              {Object.entries(PHASES).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={verifiedOnly}
                onChange={(event) => setVerifiedOnly(event.target.checked)}
              />
              仅显示完整性已验证
            </label>
            <Button variant="ghost" size="sm" onClick={reset}>
              清除筛选
            </Button>
          </div>
          <p role="status" className="text-sm text-muted-foreground">
            显示 {filtered.length} / {data?.skills.length ?? 0} 项技能
          </p>
        </section>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((skill) => (
            <button
              key={skill.id}
              type="button"
              onClick={(event) => {
                detailTrigger.current = event.currentTarget;
                setSelectedId(skill.id);
              }}
              className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-5 text-left transition-colors hover:border-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              aria-label={`查看 ${skill.name}`}
            >
              <div className="flex w-full items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-2">
                  <Package className="h-4 w-4" />
                  {SCOPES[skill.scope]}
                </span>
                <span>v{skill.version}</span>
              </div>
              <h2 className="font-semibold">{skill.name}</h2>
              <p className="text-sm leading-6 text-muted-foreground">
                {skill.boundary}
              </p>
              <div className="mt-auto flex flex-wrap gap-2 text-xs">
                <span className="rounded-md bg-muted px-2 py-1">
                  {!loading && !error && skill.packageVerified
                    ? "完整性已验证"
                    : "完整性待核验"}
                </span>
                <span className="rounded-md bg-muted px-2 py-1">
                  {skill.activation === "platform-only"
                    ? "平台开发使用"
                    : "按任务启用"}
                </span>
              </div>
              {projectId && (
                <p className="text-xs font-medium">
                  项目：
                  {installed(skill.id)
                    ? INSTALLATION[installed(skill.id)!.state]
                    : loading
                      ? "核验中"
                      : "无法核验"}
                </p>
              )}
            </button>
          ))}
        </div>
        {!loading && data && filtered.length === 0 && (
          <div className="rounded-xl border border-dashed p-10 text-center">
            <p>没有匹配的技能</p>
            <Button variant="link" onClick={reset}>
              清除筛选
            </Button>
          </div>
        )}
      </div>
      <Dialog.Root
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Content
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (detailTrigger.current?.isConnected)
                detailTrigger.current.focus();
            }}
            className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-background p-6 shadow-xl"
          >
            <Dialog.Title className="pr-8 text-xl font-semibold">
              {selected?.name}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm leading-6 text-muted-foreground">
              {selected?.boundary}
            </Dialog.Description>
            <Dialog.Close
              aria-label="关闭技能详情"
              className="absolute right-4 top-4 rounded p-1 hover:bg-muted"
            >
              <X className="h-5 w-5" />
            </Dialog.Close>
            {selected && (
              <div className="mt-5 space-y-5 text-sm">
                <p className="break-all font-mono text-xs text-muted-foreground">
                  {selected.id} · v{selected.version}
                </p>
                {[
                  ["输入", selected.inputs],
                  ["输出", selected.outputs],
                  ["验收要求", selected.validation],
                ].map(([label, values]) => (
                  <div key={label as string}>
                    <h3 className="font-semibold">{label}</h3>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                      {(values as string[]).map((value) => (
                        <li key={value}>{value}</li>
                      ))}
                    </ul>
                  </div>
                ))}
                <div>
                  <h3 className="font-semibold">运行兼容性</h3>
                  <p className="mt-2 text-xs text-muted-foreground">按平台默认工具集核验，具体任务以执行时所选工具为准。</p>
                  <ul className="mt-2 space-y-2">
                    {selected.phases.map((item) => (
                      <li key={item.phase}>
                        {PHASES[item.phase]}：
                        {item.compatible
                          ? "工具合同兼容"
                          : `不兼容${item.missingTools.length ? `，缺少 ${item.missingTools.join("、")}` : ""}${item.missingAlternative ? "，缺少完整备选工具组" : ""}`}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 break-words text-xs text-muted-foreground">
                    必需工具：{selected.requiredTools.join("、") || "无"}
                    {selected.toolAlternatives.length
                      ? `；备选组：${selected.toolAlternatives.map((group) => group.join(" + ")).join(" 或 ")}`
                      : ""}
                  </p>
                </div>
                {projectId && (
                  <div>
                    <h3 className="font-semibold">项目安装状态</h3>
                    <p className="mt-2">
                      {installed(selected.id)
                        ? INSTALLATION[installed(selected.id)!.state]
                        : "无法核验"}
                      {installed(selected.id)?.installedVersion
                        ? ` · v${installed(selected.id)!.installedVersion}`
                        : ""}
                    </p>
                    <SkillsInstallationActions key={`${projectId}:${target}:${selected.id}`} projectId={projectId} target={target} skill={selected} project={installation} disabled={loading || Boolean(error) || !installation} onChanged={() => setRetry((value) => value + 1)} />
                  </div>
                )}
                <div>
                  <h3 className="font-semibold">版本记录</h3>
                  <ul className="mt-2 space-y-3">
                    {selected.releases.map((release) => (
                      <li key={release.version}>
                        <p>
                          v{release.version} · {release.date}
                        </p>
                        <p className="text-muted-foreground">
                          {release.summary}
                        </p>
                        <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                          {release.changes.map((change) => (
                            <li key={change}>{change}</li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </div>
                <p className="break-all text-xs text-muted-foreground">
                  发布包 SHA-256：{selected.packageSha256 || "未记录"}
                </p>
                <div className="flex flex-wrap gap-3">
                  <Button
                    variant="outline"
                    onClick={() => {
                      onOpenStudio(selected.id);
                      setSelectedId(null);
                    }}
                  >
                    在 Studio 中打开
                  </Button>
                  {!loading && !error && selected.packageVerified ? (
                    <Button asChild>
                      <a
                        href={`/api/skills/${encodeURIComponent(selected.id)}/package`}
                      >
                        下载已验证版本
                      </a>
                    </Button>
                  ) : (
                    <Button disabled>校验通过后可下载</Button>
                  )}
                </div>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}
