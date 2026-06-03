"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CheckCircle2,
  Code2,
  FileText,
  FolderPlus,
  FolderTree,
  History,
  Loader2,
  PackageOpen,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCcw,
  Search,
  TriangleAlert,
  Upload,
  ArrowLeft,
  XCircle,
  Sparkles,
  Package,
  GitBranch,
  Shield,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { formatCompactDate as formatTime } from "@/components/quant/console-primitives";
import {
  SourceTree,
  SourceTreeActionMenuOverlay,
  buildSourceTree,
  filterSourceTree,
  formatBytes,
  type SkillDiffData,
  type SkillsPayload,
  type SourceDirectory,
  type SourceFile,
  type SourceState,
  type SourceTreeActionMenu,
  type SourceTreeActionMenuRequest,
} from "@/components/quant/skills-source-tree";
import { SkillsVersionManagerDialog } from "@/components/quant/skills-version-manager-dialog";
import {
  createSkillFolder,
  deleteSkillFile,
  deleteSkillFolder,
  diffSkillVersion,
  fetchSkillsDashboard,
  publishSkillVersion,
  readSkillFile,
  rollbackSkillVersion,
  saveSkillFile,
  uploadSkillPackage,
} from "@/lib/quant/skills-management-api";
import { cn } from "@/lib/utils";
import type { SkillHealthStatus } from "@/lib/quant/skills-dashboard";

type ToastState = { type: "success" | "error"; message: string } | null;

const statusLabels: Record<SkillHealthStatus, string> = {
  ok: "正常",
  warning: "需同步",
  error: "异常",
};

const statusConfig: Record<SkillHealthStatus, { bg: string; text: string; border: string; dot: string; icon: typeof CheckCircle2 }> = {
  ok: {
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    border: "border-emerald-200",
    dot: "bg-emerald-500",
    icon: CheckCircle2,
  },
  warning: {
    bg: "bg-amber-50",
    text: "text-amber-700",
    border: "border-amber-200",
    dot: "bg-amber-500",
    icon: TriangleAlert,
  },
  error: {
    bg: "bg-red-50",
    text: "text-red-700",
    border: "border-red-200",
    dot: "bg-red-500",
    icon: XCircle,
  },
};

const FILTER_CHIPS: { id: SkillHealthStatus | "all"; label: string; icon?: typeof CheckCircle2 }[] = [
  { id: "all", label: "全部" },
  { id: "ok", label: "正常", icon: CheckCircle2 },
  { id: "warning", label: "需同步", icon: TriangleAlert },
  { id: "error", label: "异常", icon: XCircle },
];

const SKILL_LIST_DEFAULT_WIDTH = 300;
const SKILL_LIST_MIN_WIDTH = 240;
const SKILL_LIST_MAX_WIDTH = 400;

function clampSkillListWidth(width: number) {
  return Math.min(SKILL_LIST_MAX_WIDTH, Math.max(SKILL_LIST_MIN_WIDTH, width));
}

export default function SkillsManagementClient({ initialData }: { initialData: SkillsPayload }) {
  // ── State ─────────────────────────────────────────────────
  const [payload, setPayload] = useState<SkillsPayload>(initialData);
  const [selectedId, setSelectedId] = useState<string | null>(initialData.skills[0]?.id ?? null);
  const [isVersionManagerOpen, setIsVersionManagerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | SkillHealthStatus>("all");
  const [source, setSource] = useState<SourceState | null>(null);
  const [sourceDraft, setSourceDraft] = useState("");
  const [selectedFilePath, setSelectedFilePath] = useState("SKILL.md");
  const [sourceFileQuery, setSourceFileQuery] = useState("");
  const [expandedSourcePaths, setExpandedSourcePaths] = useState<Set<string>>(new Set());
  const [sourceActionMenu, setSourceActionMenu] = useState<SourceTreeActionMenu | null>(null);
  const [isLoadingSource, setIsLoadingSource] = useState(false);
  const [isSavingSource, setIsSavingSource] = useState(false);
  const [deletingFilePath, setDeletingFilePath] = useState<string | null>(null);
  const [creatingFolderBasePath, setCreatingFolderBasePath] = useState<string | null>(null);
  const [deletingFolderPath, setDeletingFolderPath] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [diffData, setDiffData] = useState<SkillDiffData | null>(null);
  const [rollingBackVersion, setRollingBackVersion] = useState<string | null>(null);
  const [releaseVersion, setReleaseVersion] = useState("");
  const [releaseSummary, setReleaseSummary] = useState("");
  const [releaseChanges, setReleaseChanges] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [isDraggingUpload, setIsDraggingUpload] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [skillListWidth, setSkillListWidth] = useState(SKILL_LIST_DEFAULT_WIDTH);
  const [isSkillListCollapsed, setIsSkillListCollapsed] = useState(false);
  const [isResizingSkillList, setIsResizingSkillList] = useState(false);
  const activeSourceRequest = useRef(0);
  const skillListResize = useRef({ startX: 0, startWidth: SKILL_LIST_DEFAULT_WIDTH });

  // ── Derived data ────────────────────────────────────────────
  const filteredSkills = useMemo(() => {
    const kw = query.trim().toLowerCase();
    return payload.skills.filter((skill) => {
      if (filter !== "all" && skill.health.status !== filter) return false;
      if (!kw) return true;
      return [skill.id, skill.name, skill.version, skill.status, skill.boundary, ...skill.inputs, ...skill.outputs, ...skill.scripts, ...skill.legacyAliases]
        .join(" ").toLowerCase().includes(kw);
    });
  }, [payload.skills, query, filter]);

  const selectedSkill =
    filteredSkills.find((s) => s.id === selectedId) ??
    payload.skills.find((s) => s.id === selectedId) ??
    filteredSkills[0] ??
    null;
  const selectedSkillId = selectedSkill?.id ?? null;
  const selectedSkillVersion = selectedSkill?.version ?? "";
  const dirPathsKey = selectedSkill?.source.directories.map((d) => d.path).join("\n") ?? "";

  const sourceDirty = Boolean(source && source.skillId === selectedSkillId && sourceDraft !== source.content);
  const sourceTree = useMemo(() => (selectedSkill ? buildSourceTree(selectedSkill.source.files, selectedSkill.source.directories) : []), [selectedSkill]);
  const visibleSourceTree = useMemo(() => filterSourceTree(sourceTree, sourceFileQuery), [sourceTree, sourceFileQuery]);

  // ── Toast ────────────────────────────────────────────────────
  const showToast = useCallback((t: ToastState) => {
    setToast(t);
    if (t) window.setTimeout(() => setToast(null), 3500);
  }, []);

  // ── Data refresh ─────────────────────────────────────────────
  async function refreshDashboard() {
    const next = await fetchSkillsDashboard();
    setPayload(next);
    return next;
  }

  // ── Source loading ───────────────────────────────────────────
  const loadSource = useCallback(async (skillId: string, filePath = "SKILL.md") => {
    const reqId = activeSourceRequest.current + 1;
    activeSourceRequest.current = reqId;
    setIsLoadingSource(true);
    try {
      const next = await readSkillFile(skillId, filePath);
      if (activeSourceRequest.current !== reqId) return;
      setSource(next);
      setSourceDraft(next.content);
      setSelectedFilePath(next.filePath);
    } catch (error) {
      if (activeSourceRequest.current !== reqId) return;
      showToast({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (activeSourceRequest.current === reqId) setIsLoadingSource(false);
    }
  }, [showToast]);

  function selectSourceFile(file: SourceFile) {
    if (!selectedSkill) return;
    if (!file.editable) { showToast({ type: "error", message: "该文件不支持在线编辑，可通过上传压缩包更新。" }); return; }
    if (sourceDirty && !window.confirm("当前文件有未保存修改，确定切换文件吗？")) return;
    setSelectedFilePath(file.path);
    void loadSource(selectedSkill.id, file.path);
  }

  function selectSkill(skillId: string) {
    if (sourceDirty && !window.confirm("当前文件有未保存修改，确定切换 skill 吗？")) return;
    setSelectedId(skillId);
    setSourceActionMenu(null);
  }

  function toggleSourceDirectory(fp: string) {
    setExpandedSourcePaths((prev) => { const n = new Set(prev); n.has(fp) ? n.delete(fp) : n.add(fp); return n; });
  }

  function openSourceActionMenu(e: React.SyntheticEvent<HTMLButtonElement>, menu: SourceTreeActionMenuRequest) {
    e.preventDefault(); e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    setSourceActionMenu({ ...menu, x: r.right, y: r.bottom } as SourceTreeActionMenu);
  }

  // ── File operations ──────────────────────────────────────────
  async function saveSource() {
    if (!selectedSkill || !source) return;
    setIsSavingSource(true);
    try {
      const next = await saveSkillFile({ skillId: selectedSkill.id, filePath: source.filePath, content: sourceDraft });
      setSource(next); setSourceDraft(next.content); setDiffData(null);
      await refreshDashboard();
      showToast({ type: "success", message: "文件已保存。" });
    } catch (error) {
      showToast({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally { setIsSavingSource(false); }
  }

  async function createSourceFile(basePath?: string) {
    if (!selectedSkill) return;
    if (sourceDirty && !window.confirm("有未保存修改，确定先创建新文件吗？")) return;
    const dp = basePath ? `${basePath}/new_file.md` : "references/provider_notes.md";
    const fp = window.prompt("输入新文件路径", dp)?.trim();
    if (!fp) return;
    setCreatingFolderBasePath(basePath ?? "__root__");
    try {
      const next = await saveSkillFile({ skillId: selectedSkill.id, filePath: fp, content: fp.endsWith(".py") ? "#!/usr/bin/env python3\n" : fp.endsWith(".json") ? "{}\n" : "" });
      setSource(next); setSourceDraft(next.content); setSelectedFilePath(next.filePath); setDiffData(null);
      await refreshDashboard();
      if (basePath) setExpandedSourcePaths((prev) => new Set([...prev, basePath]));
      showToast({ type: "success", message: "文件已创建。" });
    } catch (error) { showToast({ type: "error", message: error instanceof Error ? error.message : String(error) }); }
    finally { setCreatingFolderBasePath(null); }
  }

  async function createSourceFolder(basePath?: string) {
    if (!selectedSkill) return;
    const dp = basePath ? `${basePath}/new-folder` : "references";
    const fp = window.prompt("输入新文件夹路径", dp)?.trim();
    if (!fp) return;
    setCreatingFolderBasePath(basePath ?? "__root__");
    try {
      const next = await createSkillFolder({ skillId: selectedSkill.id, folderPath: fp });
      setPayload(next); setDiffData(null);
      setExpandedSourcePaths((prev) => new Set([...prev, fp, ...(basePath ? [basePath] : [])]));
      showToast({ type: "success", message: "文件夹已创建。" });
    } catch (error) { showToast({ type: "error", message: error instanceof Error ? error.message : String(error) }); }
    finally { setCreatingFolderBasePath(null); }
  }

  async function deleteSourceFile(file?: SourceFile) {
    if (!selectedSkill) return;
    const tf = file ?? selectedSkill.source.files.find((f) => f.path === source?.filePath);
    if (!tf || tf.path === "SKILL.md") return;
    if (!window.confirm(`确定删除 ${tf.path} 吗？`)) return;
    setDeletingFilePath(tf.path);
    try {
      const next = await deleteSkillFile({ skillId: selectedSkill.id, filePath: tf.path });
      setPayload(next); setDiffData(null);
      if (selectedFilePath === tf.path) { setSelectedFilePath("SKILL.md"); setSource(null); setSourceDraft(""); await loadSource(selectedSkill.id, "SKILL.md"); }
      showToast({ type: "success", message: "文件已删除。" });
    } catch (error) { showToast({ type: "error", message: error instanceof Error ? error.message : String(error) }); }
    finally { setDeletingFilePath(null); }
  }

  async function deleteSourceFolder(folder: SourceDirectory) {
    if (!selectedSkill) return;
    if (!window.confirm(`确定删除文件夹 ${folder.path} 及其中所有文件吗？`)) return;
    setDeletingFolderPath(folder.path);
    try {
      const next = await deleteSkillFolder({ skillId: selectedSkill.id, folderPath: folder.path });
      setPayload(next); setDiffData(null);
      if (selectedFilePath === folder.path || selectedFilePath.startsWith(`${folder.path}/`)) { setSelectedFilePath("SKILL.md"); setSource(null); setSourceDraft(""); await loadSource(selectedSkill.id, "SKILL.md"); }
      showToast({ type: "success", message: "文件夹已删除。" });
    } catch (error) { showToast({ type: "error", message: error instanceof Error ? error.message : String(error) }); }
    finally { setDeletingFolderPath(null); }
  }

  // ── Version operations ───────────────────────────────────────
  async function publishVersion() {
    if (!selectedSkill || !diffData) { showToast({ type: "error", message: "请先生成 Diff。" }); return; }
    if (!window.confirm(`确认发布 ${selectedSkill.id} v${releaseVersion}？\n变更：+${diffData.totals.added} ~${diffData.totals.modified} -${diffData.totals.deleted}`)) return;
    setIsPublishing(true);
    try {
      const next = await publishSkillVersion({ skillId: selectedSkill.id, version: releaseVersion, summary: releaseSummary, changes: releaseChanges, status: selectedSkill.status });
      setPayload(next); setReleaseSummary(""); setReleaseChanges(""); setDiffData(null);
      setReleaseVersion(next.skills.find((s) => s.id === selectedSkill.id)?.version ?? releaseVersion);
      showToast({ type: "success", message: "版本已发布。" });
    } catch (error) { showToast({ type: "error", message: error instanceof Error ? error.message : String(error) }); }
    finally { setIsPublishing(false); }
  }

  async function loadVersionDiff() {
    if (!selectedSkill) return;
    if (sourceDirty) { showToast({ type: "error", message: "请先保存当前文件。" }); return; }
    setIsLoadingDiff(true);
    try {
      const d = await diffSkillVersion(selectedSkill.id);
      setDiffData(d);
      showToast({ type: "success", message: d.changed ? "Diff 已生成，请确认后发版。" : "源码与上一版一致。" });
    } catch (error) { showToast({ type: "error", message: error instanceof Error ? error.message : String(error) }); }
    finally { setIsLoadingDiff(false); }
  }

  async function rollbackVersion(version: string) {
    if (!selectedSkill) return;
    if (!window.confirm(`确认回退 ${selectedSkill.id} 到 v${version}？`)) return;
    setRollingBackVersion(version);
    try {
      const next = await rollbackSkillVersion({ skillId: selectedSkill.id, version });
      setPayload(next); setDiffData(null); setReleaseSummary(""); setReleaseChanges(""); setReleaseVersion(version);
      await loadSource(selectedSkill.id, "SKILL.md");
      showToast({ type: "success", message: `已回退到 v${version}。` });
    } catch (error) { showToast({ type: "error", message: error instanceof Error ? error.message : String(error) }); }
    finally { setRollingBackVersion(null); }
  }

  function setSelectedUpload(file: File | null) {
    if (!file) return;
    const fn = file.name.toLowerCase();
    if (!fn.endsWith(".zip") && !fn.endsWith(".tgz") && !fn.endsWith(".tar.gz")) { showToast({ type: "error", message: "仅支持 .zip、.tgz、.tar.gz。" }); return; }
    setUploadFile(file);
  }
  function handlePackageDrop(e: React.DragEvent<HTMLLabelElement>) { e.preventDefault(); setIsDraggingUpload(false); setSelectedUpload(e.dataTransfer.files?.[0] ?? null); }
  async function uploadPackage() {
    if (!selectedSkill || !uploadFile) return;
    setIsUploading(true);
    try {
      const next = await uploadSkillPackage({ skillId: selectedSkill.id, version: releaseVersion, summary: releaseSummary, changes: releaseChanges, status: selectedSkill.status, file: uploadFile });
      setPayload(next); setUploadFile(null); setDiffData(null); setSelectedFilePath("SKILL.md");
      await loadSource(selectedSkill.id, "SKILL.md");
      showToast({ type: "success", message: "上传包已发布为新版本。" });
    } catch (error) { showToast({ type: "error", message: error instanceof Error ? error.message : String(error) }); }
    finally { setIsUploading(false); }
  }
  function handlePackageDragOver(e: React.DragEvent<HTMLLabelElement>) { e.preventDefault(); setIsDraggingUpload(true); }

  // ── Effects ──────────────────────────────────────────────────
  useEffect(() => { if (!selectedSkill && filteredSkills[0]) setSelectedId(filteredSkills[0].id); }, [filteredSkills, selectedSkill]);

  useEffect(() => {
    setSourceActionMenu(null);
    if (!selectedSkillId) return;
    activeSourceRequest.current += 1;
    setSource(null); setSourceDraft(""); setSelectedFilePath("SKILL.md"); setSourceFileQuery("");
    setExpandedSourcePaths(new Set(dirPathsKey ? dirPathsKey.split("\n") : []));
    setIsLoadingSource(false);
    setReleaseVersion(selectedSkillVersion); setReleaseSummary(""); setReleaseChanges(""); setUploadFile(null); setDiffData(null); setIsDraggingUpload(false);
    void loadSource(selectedSkillId, "SKILL.md");
  }, [loadSource, dirPathsKey, selectedSkillId, selectedSkillVersion]);

  useEffect(() => {
    if (!sourceActionMenu) return;
    let canClose = false;
    const t = window.setTimeout(() => { canClose = true; }, 250);
    const close = () => { if (canClose) setSourceActionMenu(null); };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", () => setSourceActionMenu(null));
    window.addEventListener("keydown", () => setSourceActionMenu(null));
    return () => { clearTimeout(t); window.removeEventListener("scroll", close, true); };
  }, [sourceActionMenu]);

  useEffect(() => { if (isVersionManagerOpen) setSourceActionMenu(null); }, [isVersionManagerOpen]);

  useEffect(() => {
    if (isSkillListCollapsed) setIsResizingSkillList(false);
  }, [isSkillListCollapsed]);

  useEffect(() => {
    if (!selectedSkill) return;
    setExpandedSourcePaths((prev) => { const n = new Set(prev); selectedSkill.source.directories.forEach((d) => { if (sourceFileQuery.trim() || selectedFilePath.startsWith(`${d.path}/`)) n.add(d.path); }); return n; });
  }, [selectedSkill, selectedFilePath, sourceFileQuery]);

  useEffect(() => {
    if (!isResizingSkillList) return;

    const move = (event: PointerEvent) => {
      const delta = event.clientX - skillListResize.current.startX;
      setSkillListWidth(clampSkillListWidth(skillListResize.current.startWidth + delta));
    };
    const stop = () => setIsResizingSkillList(false);
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [isResizingSkillList]);

  const startSkillListResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (isSkillListCollapsed) return;
    event.preventDefault();
    skillListResize.current = { startX: event.clientX, startWidth: skillListWidth };
    setIsResizingSkillList(true);
  }, [isSkillListCollapsed, skillListWidth]);

  // ── Render ───────────────────────────────────────────────────
  const pendingCount = payload.totals.warning + payload.totals.error;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Top navigation */}
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between border-b bg-background/80 px-4 backdrop-blur-xl md:px-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild className="shrink-0 h-8 w-8">
            <Link href="/" aria-label="返回首页">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground shadow-sm">
            <Package className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight">Skills 管理</h1>
            <p className="text-[11px] text-muted-foreground hidden sm:block">
              管理 skill 源码、版本、Diff、打包与发布
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Stats pills */}
          <div className="hidden items-center gap-2 md:flex">
            <div className="flex items-center gap-1.5 rounded-full bg-muted/60 px-2.5 py-1 text-xs">
              <span className="font-semibold tabular-nums">{payload.totals.total}</span>
              <span className="text-muted-foreground">技能</span>
            </div>
            <div className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span className="font-semibold tabular-nums">{payload.totals.ok}</span>
            </div>
            {pendingCount > 0 && (
              <div className="flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs text-amber-700">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                <span className="font-semibold tabular-nums">{pendingCount}</span>
              </div>
            )}
          </div>

          <div className="h-4 w-px bg-border hidden md:block" />

          <Button variant="ghost" size="sm" onClick={refreshDashboard} className="gap-1.5 text-xs">
            <RefreshCcw className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">刷新</span>
          </Button>
        </div>
      </header>

      {/* Main content */}
      <div className="relative flex flex-1 overflow-hidden">
        {isSkillListCollapsed && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setIsSkillListCollapsed(false)}
            className="absolute left-3 top-3 z-30 h-8 w-8 rounded-lg border-border/60 bg-card p-0 shadow-sm"
            aria-label="展开 Skill 列表"
            title="展开 Skill 列表"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
        )}

        {/* ── Left: Skill List ───────────────────────────────── */}
        <aside
          className={cn(
            "relative flex shrink-0 flex-col border-r border-border/60 bg-card transition-all duration-300 ease-out",
            isSkillListCollapsed
              ? "min-w-0 -translate-x-4 overflow-hidden border-r-0 opacity-0 pointer-events-none"
              : "translate-x-0 opacity-100"
          )}
          style={{ width: isSkillListCollapsed ? 0 : skillListWidth }}
          aria-hidden={isSkillListCollapsed}
        >
          {/* Search + filter */}
          <div className="border-b border-border/40 p-3 space-y-2.5">
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索 skill..."
                  className="h-8 border-border/60 bg-muted/30 pl-8 text-sm"
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setIsSkillListCollapsed(true)}
                className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-foreground"
                aria-label="收起列表"
                title="收起列表"
              >
                <PanelLeftClose className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex gap-1">
              {FILTER_CHIPS.map((chip) => {
                const isActive = filter === chip.id;
                return (
                  <button
                    key={chip.id}
                    type="button"
                    onClick={() => setFilter(chip.id)}
                    className={cn(
                      "flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-all",
                      isActive
                        ? "bg-primary/10 text-primary ring-1 ring-primary/20"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    )}
                  >
                    {chip.icon && <chip.icon className="h-3 w-3" />}
                    {chip.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Skill cards */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {filteredSkills.map((skill) => {
              const active = selectedSkill?.id === skill.id;
              const config = statusConfig[skill.health.status];
              const StatusIcon = config.icon;
              return (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => selectSkill(skill.id)}
                  className={cn(
                    "w-full rounded-xl border p-3 text-left transition-all",
                    active
                      ? "border-primary/25 bg-primary/5 shadow-sm shadow-primary/5"
                      : "border-transparent hover:border-border/60 hover:bg-muted/30"
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className={cn("truncate text-sm font-semibold", active ? "text-primary" : "text-foreground")}>
                        {skill.name}
                      </p>
                      <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{skill.id}</p>
                    </div>
                    <span className={cn("shrink-0 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold", config.bg, config.text, config.border)}>
                      <StatusIcon className="h-2.5 w-2.5" />
                      {statusLabels[skill.health.status]}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <GitBranch className="h-3 w-3" />
                      v{skill.version}
                    </span>
                    <span className="text-border">·</span>
                    <span>{skill.changelog.releaseCount} 版本</span>
                    <span className="text-border">·</span>
                    <span>{skill.source.fileCount} 文件</span>
                  </div>
                  {skill.health.missing.length > 0 && (
                    <div className="mt-2 flex items-center gap-1 text-[10px] text-amber-600">
                      <TriangleAlert className="h-3 w-3" />
                      需处理: {skill.health.missing.slice(0, 2).join(", ")}
                    </div>
                  )}
                </button>
              );
            })}
            {filteredSkills.length === 0 && (
              <EmptyState title="没有匹配的 skill" description="尝试其他关键词或清除筛选" className="mx-1 border-0 py-8" />
            )}
          </div>

          {/* Resize handle */}
          {!isSkillListCollapsed && (
            <div
              role="separator"
              aria-label="调整列表宽度"
              aria-orientation="vertical"
              tabIndex={0}
              onPointerDown={startSkillListResize}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  setSkillListWidth((width) => clampSkillListWidth(width - 16));
                }
                if (event.key === "ArrowRight") {
                  event.preventDefault();
                  setSkillListWidth((width) => clampSkillListWidth(width + 16));
                }
              }}
              className={cn(
                "absolute -right-1 top-0 z-20 flex h-full w-2 cursor-col-resize items-center justify-center outline-none",
                "after:h-12 after:w-1 after:rounded-full after:bg-border after:opacity-0 after:transition-opacity hover:after:opacity-100 focus-visible:after:opacity-100",
                isResizingSkillList && "after:opacity-100"
              )}
            />
          )}
        </aside>

        {/* ── Right: Editor Area ──────────────────────────────── */}
        <div className={cn("flex min-w-0 flex-1 flex-col overflow-hidden transition-[padding] duration-300", isSkillListCollapsed && "pl-12")}>
          {selectedSkill ? (
            <>
              {/* Skill overview bar */}
              <div className="flex flex-wrap items-center gap-3 border-b border-border/40 bg-card/50 px-4 py-2.5 backdrop-blur">
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10">
                    <Code2 className="h-3.5 w-3.5 text-primary" />
                  </div>
                  <h2 className="truncate text-sm font-bold text-foreground">{selectedSkill.name}</h2>
                  {(() => {
                    const config = statusConfig[selectedSkill.health.status];
                    const StatusIcon = config.icon;
                    return (
                      <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold", config.bg, config.text, config.border)}>
                        <StatusIcon className="h-3 w-3" />
                        {statusLabels[selectedSkill.health.status]}
                      </span>
                    );
                  })()}
                  <span className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    v{selectedSkill.version}
                  </span>
                </div>
                {selectedSkill.health.missing.length > 0 && (
                  <span className="flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-700">
                    <TriangleAlert className="h-3 w-3" />
                    {selectedSkill.health.missing.join(", ")}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  {sourceDirty && (
                    <span className="flex items-center gap-1 text-xs text-amber-600">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                      未保存
                    </span>
                  )}
                  <Button variant="outline" size="sm" onClick={() => setIsVersionManagerOpen(true)} className="gap-1.5 text-xs">
                    <History className="h-3.5 w-3.5" />
                    版本管理
                  </Button>
                  <Button size="sm" onClick={saveSource} disabled={isSavingSource || isLoadingSource || !sourceDirty} className="gap-1.5 text-xs">
                    {isSavingSource ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                    保存
                  </Button>
                </div>
              </div>

              {/* File tree + Editor */}
              <div className="flex flex-1 overflow-hidden">
                {/* File tree panel */}
                <div className="flex w-[260px] shrink-0 flex-col border-r border-border/40 bg-muted/20">
                  <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                      <FolderTree className="h-3.5 w-3.5" /> 文件清单
                    </div>
                    <div className="flex items-center gap-0.5">
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => createSourceFile()} aria-label="新建文件" title="新建文件">
                        <FileText className="h-3 w-3" />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => createSourceFolder()} aria-label="新建文件夹" title="新建文件夹">
                        <FolderPlus className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                  <div className="border-b border-border/40 p-2">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                      <Input value={sourceFileQuery} onChange={(e) => setSourceFileQuery(e.target.value)} placeholder="搜索文件..." className="h-7 border-border/60 bg-card pl-7 text-xs" />
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto p-1.5">
                    <SourceTree
                      nodes={visibleSourceTree}
                      selectedFilePath={selectedFilePath}
                      expandedPaths={expandedSourcePaths}
                      deletingFolderPath={deletingFolderPath}
                      deletingFilePath={deletingFilePath}
                      creatingFolderBasePath={creatingFolderBasePath}
                      openMenuPath={sourceActionMenu?.type === "directory" ? sourceActionMenu.node.path : sourceActionMenu?.file.path ?? null}
                      onToggleDirectory={toggleSourceDirectory}
                      onSelectFile={selectSourceFile}
                      onOpenActionMenu={openSourceActionMenu}
                    />
                  </div>
                </div>

                {/* Editor panel */}
                <div className="flex min-w-0 flex-1 flex-col bg-card">
                  <div className="flex items-center gap-2 border-b border-border/40 px-4 py-2 text-xs text-muted-foreground">
                    <span className="min-w-0 truncate font-mono">{source?.filePath ?? selectedFilePath}</span>
                    {source && <span className="text-border">·</span>}
                    {source && <span>{formatBytes(source.size)}</span>}
                    {source?.updatedAt && <><span className="text-border">·</span><span>{formatTime(source.updatedAt)}</span></>}
                    <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs" onClick={() => loadSource(selectedSkill.id, selectedFilePath)} disabled={isLoadingSource}>
                      {isLoadingSource ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCcw className="h-3 w-3" />}
                    </Button>
                  </div>
                  {isLoadingSource ? (
                    <div className="flex-1 p-4"><Skeleton className="h-full w-full rounded-lg" /></div>
                  ) : (
                    <Textarea
                      value={sourceDraft}
                      onChange={(e) => setSourceDraft(e.target.value)}
                      spellCheck={false}
                      className="min-h-0 flex-1 resize-none rounded-none border-0 font-mono text-xs leading-5 shadow-none focus-visible:ring-0 bg-card"
                      placeholder="选择一个可编辑文件..."
                    />
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState
                title="选择一个 Skill"
                description="从左侧列表选择要编辑的技能包"
                icon={<PackageOpen className="h-8 w-8" />}
              />
            </div>
          )}
        </div>
      </div>

      {/* Version Manager Dialog */}
      <SkillsVersionManagerDialog
        open={isVersionManagerOpen}
        selectedSkill={selectedSkill}
        sourceDirty={sourceDirty}
        releaseVersion={releaseVersion}
        releaseSummary={releaseSummary}
        releaseChanges={releaseChanges}
        uploadFile={uploadFile}
        diffData={diffData}
        isPublishing={isPublishing}
        isUploading={isUploading}
        isLoadingDiff={isLoadingDiff}
        rollingBackVersion={rollingBackVersion}
        isDraggingUpload={isDraggingUpload}
        onClose={() => setIsVersionManagerOpen(false)}
        onVersionChange={setReleaseVersion}
        onSummaryChange={setReleaseSummary}
        onChangesChange={setReleaseChanges}
        onLoadDiff={loadVersionDiff}
        onPublish={publishVersion}
        onRollback={rollbackVersion}
        onUpload={uploadPackage}
        onPackageDrop={handlePackageDrop}
        onPackageDragOver={handlePackageDragOver}
        onPackageDragLeave={() => setIsDraggingUpload(false)}
        onPackageSelect={setSelectedUpload}
      />

      <SourceTreeActionMenuOverlay
        menu={sourceActionMenu}
        deletingFolderPath={deletingFolderPath}
        deletingFilePath={deletingFilePath}
        onClose={() => setSourceActionMenu(null)}
        onSelectFile={selectSourceFile}
        onCreateFile={createSourceFile}
        onCreateFolder={createSourceFolder}
        onDeleteFile={deleteSourceFile}
        onDeleteFolder={deleteSourceFolder}
      />

      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            className="fixed bottom-5 right-5 z-50"
          >
            <div
              className={cn(
                "flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur-xl",
                toast.type === "success"
                  ? "border-emerald-200/60 bg-emerald-50/90 text-emerald-800"
                  : "border-red-200/60 bg-red-50/90 text-red-800"
              )}
            >
              {toast.type === "success" ? (
                <CheckCircle2 className="h-4 w-4 shrink-0" />
              ) : (
                <XCircle className="h-4 w-4 shrink-0" />
              )}
              {toast.message}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
