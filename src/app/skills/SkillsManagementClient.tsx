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
  ArrowLeft,
  ArrowRight,
  XCircle,
  Sparkles,
  Package,
  GitBranch,
  Shield,
  BookOpen,
  Database,
  BarChart3,
  Workflow,
  Target,
  ImageIcon,
  LayoutGrid,
  Wrench,
  Boxes,
  ScanSearch,
  ListTree,
  Maximize2,
  Minimize2,
  WrapText,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { PlatformSwitcher } from "@/components/layout/PlatformSwitcher";
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

import { SkillsMarket } from "@/components/quant/skills-market";

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

type SkillScope = NonNullable<SkillsPayload["skills"][number]["scope"]>;
const SCOPE_LABELS: Record<SkillScope, string> = {
  workflow: "工作流",
  quant: "量化",
  input: "输入",
  evidence: "证据",
  platform: "平台",
  visualization: "可视化",
};

const SCOPE_CHIPS: Array<{ id: SkillScope | "all"; label: string }> = [
  { id: "all", label: "全部域" },
  { id: "workflow", label: "工作流" },
  { id: "quant", label: "量化" },
  { id: "input", label: "输入" },
  { id: "evidence", label: "证据" },
  { id: "platform", label: "平台" },
  { id: "visualization", label: "可视化" },
];

const SKILL_LIST_DEFAULT_WIDTH = 300;
const SKILL_LIST_MIN_WIDTH = 240;
const SKILL_LIST_MAX_WIDTH = 400;

const SKILL_ICONS: Record<string, typeof Package> = {
  "run-planner": Target,
  "quant-data-registry": Database,
  "quant-symbol-resolver": Search,
  "image-extraction": ImageIcon,
  "quant-market-data": BarChart3,
  "quant-fundamentals": BookOpen,
  "quant-indicators": BarChart3,
  "quant-backtest": Workflow,
  "data-quality": Shield,
  "platform-ui-product-design": LayoutGrid,
  "dashboard-visualization": Sparkles,
};

const SKILL_COLORS: Record<string, { bg: string; ring: string; text: string }> = {
  "run-planner": { bg: "bg-blue-50", ring: "ring-blue-100", text: "text-blue-600" },
  "quant-data-registry": { bg: "bg-emerald-50", ring: "ring-emerald-100", text: "text-emerald-600" },
  "quant-symbol-resolver": { bg: "bg-violet-50", ring: "ring-violet-100", text: "text-violet-600" },
  "image-extraction": { bg: "bg-pink-50", ring: "ring-pink-100", text: "text-pink-600" },
  "quant-market-data": { bg: "bg-cyan-50", ring: "ring-cyan-100", text: "text-cyan-600" },
  "quant-fundamentals": { bg: "bg-amber-50", ring: "ring-amber-100", text: "text-amber-600" },
  "quant-indicators": { bg: "bg-indigo-50", ring: "ring-indigo-100", text: "text-indigo-600" },
  "quant-backtest": { bg: "bg-orange-50", ring: "ring-orange-100", text: "text-orange-600" },
  "data-quality": { bg: "bg-teal-50", ring: "ring-teal-100", text: "text-teal-600" },
  "platform-ui-product-design": { bg: "bg-rose-50", ring: "ring-rose-100", text: "text-rose-600" },
  "dashboard-visualization": { bg: "bg-lime-50", ring: "ring-lime-100", text: "text-lime-600" },
};

function clampSkillListWidth(width: number) {
  return Math.min(SKILL_LIST_MAX_WIDTH, Math.max(SKILL_LIST_MIN_WIDTH, width));
}

function SkillScopeBadge({ scope }: { scope: SkillScope }) {
  const classes: Record<SkillScope, string> = {
    workflow: "border-blue-100 bg-blue-50 text-blue-700",
    quant: "border-cyan-100 bg-cyan-50 text-cyan-700",
    input: "border-pink-100 bg-pink-50 text-pink-700",
    evidence: "border-teal-100 bg-teal-50 text-teal-700",
    platform: "border-rose-100 bg-rose-50 text-rose-700",
    visualization: "border-lime-100 bg-lime-50 text-lime-700",
  };
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold", classes[scope])}>
      {SCOPE_LABELS[scope]}
    </span>
  );
}

export default function SkillsManagementClient({ initialData }: { initialData: SkillsPayload }) {
  // ── State ─────────────────────────────────────────────────
  const [payload, setPayload] = useState<SkillsPayload>(initialData);
  const [viewMode, setViewMode] = useState<"catalog" | "editor">("catalog");
  const [selectedId, setSelectedId] = useState<string | null>(initialData.skills[0]?.id ?? null);
  const [isVersionManagerOpen, setIsVersionManagerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | SkillHealthStatus>("all");
  const [scopeFilter, setScopeFilter] = useState<"all" | SkillScope>("all");
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
  const [isFileTreeCollapsed, setIsFileTreeCollapsed] = useState(false);
  const [isStudioFocusMode, setIsStudioFocusMode] = useState(false);
  const [isEditorWrapping, setIsEditorWrapping] = useState(true);
  const [isResizingSkillList, setIsResizingSkillList] = useState(false);
  const activeSourceRequest = useRef(0);
  const editorTextareaRef = useRef<HTMLTextAreaElement>(null);
  const skillListResize = useRef({ startX: 0, startWidth: SKILL_LIST_DEFAULT_WIDTH });

  // ── Derived data ────────────────────────────────────────────
  const filteredSkills = useMemo(() => {
    const kw = query.trim().toLowerCase();
    return payload.skills.filter((skill) => {
      if (filter !== "all" && skill.health.status !== filter) return false;
      if (scopeFilter !== "all" && skill.scope !== scopeFilter) return false;
      if (!kw) return true;
      return [skill.id, skill.name, skill.version, skill.status, skill.scope, SCOPE_LABELS[skill.scope], skill.boundary, ...skill.inputs, ...skill.outputs, ...skill.scripts]
        .join(" ").toLowerCase().includes(kw);
    });
  }, [payload.skills, query, filter, scopeFilter]);



  const selectedSkill =
    filteredSkills.find((s) => s.id === selectedId) ??
    payload.skills.find((s) => s.id === selectedId) ??
    filteredSkills[0] ??
    null;
  const selectedSkillId = selectedSkill?.id ?? null;
  const selectedSkillVersion = selectedSkill?.version ?? "";
  const dirPathsKey = selectedSkill?.source.directories.map((d) => d.path).join("\n") ?? "";

  const sourceDirty = Boolean(source && source.skillId === selectedSkillId && sourceDraft !== source.content);
  const confirmUnsavedNavigation = useCallback(() => {
    if (!sourceDirty) return true;
    return window.confirm("当前文件有未保存修改，确定离开 Skills 吗？");
  }, [sourceDirty]);
  const writeSkillsUrl = useCallback((nextMode: "catalog" | "editor", skillId: string | null, historyMode: "push" | "replace" = "push") => {
    const url = new URL(window.location.href);
    if (nextMode === "editor") {
      url.searchParams.set("view", "studio");
      if (skillId) url.searchParams.set("skill", skillId);
      else url.searchParams.delete("skill");
    } else {
      url.searchParams.delete("view");
      url.searchParams.delete("skill");
    }
    window.history[historyMode === "push" ? "pushState" : "replaceState"]({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);
  const changeViewMode = useCallback((nextMode: "catalog" | "editor", historyMode: "push" | "replace" = "push") => {
    if (nextMode === viewMode) return true;
    if (nextMode === "catalog" && viewMode === "editor" && sourceDirty && !window.confirm("当前文件有未保存修改，确定返回 Skills Market 吗？")) {
      return false;
    }
    setViewMode(nextMode);
    writeSkillsUrl(nextMode, nextMode === "editor" ? selectedSkillId : null, historyMode);
    return true;
  }, [selectedSkillId, sourceDirty, viewMode, writeSkillsUrl]);
  const sourceTree = useMemo(() => (selectedSkill ? buildSourceTree(selectedSkill.source.files, selectedSkill.source.directories) : []), [selectedSkill]);
  const visibleSourceTree = useMemo(() => filterSourceTree(sourceTree, sourceFileQuery), [sourceTree, sourceFileQuery]);
  const editorStats = useMemo(() => ({
    lines: sourceDraft ? sourceDraft.split("\n").length : 0,
    characters: sourceDraft.length,
  }), [sourceDraft]);
  const documentOutline = useMemo(() => {
    let offset = 0;
    return sourceDraft.split("\n").flatMap((line, lineIndex) => {
      const currentOffset = offset;
      offset += line.length + 1;
      const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
      if (!match) return [];
      return [{
        level: match[1].length,
        text: match[2].replace(/[`*_]/g, ""),
        offset: currentOffset,
        lineIndex,
      }];
    });
  }, [sourceDraft]);

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
    if (skillId === selectedSkillId) return;
    if (sourceDirty && !window.confirm("当前文件有未保存修改，确定切换 skill 吗？")) return;
    setSelectedId(skillId);
    setSourceActionMenu(null);
    writeSkillsUrl("editor", skillId);
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
  useEffect(() => {
    if (!sourceDirty) return;
    const protectUnsavedChanges = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectUnsavedChanges);
    return () => window.removeEventListener("beforeunload", protectUnsavedChanges);
  }, [sourceDirty]);

  useEffect(() => {
    const applyLocation = () => {
      const url = new URL(window.location.href);
      const nextMode = url.searchParams.get("view") === "studio" ? "editor" : "catalog";
      const requestedSkill = url.searchParams.get("skill");
      const nextSkillId = requestedSkill && payload.skills.some((skill) => skill.id === requestedSkill)
        ? requestedSkill
        : selectedSkillId;
      const wouldDiscard = sourceDirty && (nextMode !== viewMode || (nextMode === "editor" && nextSkillId !== selectedSkillId));
      if (wouldDiscard && !window.confirm("当前文件有未保存修改，确定离开吗？")) {
        writeSkillsUrl(viewMode, viewMode === "editor" ? selectedSkillId : null, "replace");
        return;
      }
      setViewMode(nextMode);
      if (nextMode === "editor" && nextSkillId) setSelectedId(nextSkillId);
    };
    applyLocation();
    window.addEventListener("popstate", applyLocation);
    return () => window.removeEventListener("popstate", applyLocation);
  }, [payload.skills, selectedSkillId, sourceDirty, viewMode, writeSkillsUrl]);

  useEffect(() => { if (!selectedSkill && filteredSkills[0]) setSelectedId(filteredSkills[0].id); }, [filteredSkills, selectedSkill]);

  useEffect(() => {
    setSourceActionMenu(null);
    activeSourceRequest.current += 1;
    if (viewMode !== "editor" || !selectedSkillId) { setSource(null); setSourceDraft(""); setIsLoadingSource(false); return; }
    setSource(null); setSourceDraft(""); setSelectedFilePath("SKILL.md"); setSourceFileQuery("");
    setExpandedSourcePaths(new Set(dirPathsKey ? dirPathsKey.split("\n") : []));
    setIsLoadingSource(false);
    setReleaseVersion(selectedSkillVersion); setReleaseSummary(""); setReleaseChanges(""); setUploadFile(null); setDiffData(null); setIsDraggingUpload(false);
    void loadSource(selectedSkillId, "SKILL.md");
    return () => { activeSourceRequest.current += 1; };
  }, [loadSource, dirPathsKey, selectedSkillId, selectedSkillVersion, viewMode]);

  useEffect(() => {
    if (!sourceActionMenu) return;
    let canClose = false;
    const t = window.setTimeout(() => { canClose = true; }, 250);
    const close = () => { if (canClose) setSourceActionMenu(null); };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", close);
    return () => { clearTimeout(t); window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); window.removeEventListener("keydown", close); };
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

  const enterEditor = useCallback((skillId: string) => {
    if (skillId !== selectedSkillId && sourceDirty && !window.confirm("当前文件有未保存修改，确定在 Studio 中打开另一项 Skill 吗？")) {
      return false;
    }
    setSelectedId(skillId);
    setViewMode("editor");
    writeSkillsUrl("editor", skillId);
    return true;
  }, [selectedSkillId, sourceDirty, writeSkillsUrl]);

  const jumpToDocumentHeading = useCallback((offset: number, lineIndex: number) => {
    const textarea = editorTextareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(offset, offset);
    const lineHeight = Number.parseFloat(window.getComputedStyle(textarea).lineHeight) || 20;
    textarea.scrollTop = Math.max(0, (lineIndex - 2) * lineHeight);
  }, []);

  const isSkillRailHidden = isSkillListCollapsed || isStudioFocusMode;

  return (
    <div className="platform-shell flex h-dvh flex-col">
      {/* Top navigation */}
      <header className="platform-header sticky top-0 z-30 flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-2 px-3 py-2 sm:flex-nowrap sm:px-5 lg:px-6">
        <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
          <Button variant="ghost" size="icon" asChild className="h-9 w-9 shrink-0 rounded-xl">
            <Link
              href="/"
              aria-label="返回首页"
              onClick={(event) => {
                if (!confirmUnsavedNavigation()) event.preventDefault();
              }}
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-primary text-primary-foreground shadow-[0_10px_24px_-10px_hsl(var(--primary))]">
            <Boxes className="h-4 w-4" />
            <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-white/30 blur-[1px]" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="whitespace-nowrap text-sm font-black tracking-tight sm:text-base">Skills</h1>
              <span className="hidden rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[9px] font-black tracking-[0.16em] text-primary sm:inline-flex">
                {viewMode === "catalog" ? "MARKET" : "STUDIO"}
              </span>
            </div>
            <p className="hidden truncate text-[11px] text-muted-foreground lg:block">
              {viewMode === "catalog" ? "发现可信研究能力，组合可验证工作流" : "管理源码、版本、Diff、打包与发布"}
            </p>
          </div>
        </div>

        {/* View mode toggle */}
        <div className="order-3 flex w-full items-center gap-1 rounded-xl border border-border/70 bg-muted/50 p-1 sm:order-none sm:w-auto">
            <button
              type="button"
              onClick={() => changeViewMode("catalog")}
              aria-pressed={viewMode === "catalog"}
              className={cn(
                "flex h-8 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs font-bold transition-all sm:flex-none",
                viewMode === "catalog" ? "bg-card text-foreground shadow-sm ring-1 ring-border/50" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <ScanSearch className="h-3.5 w-3.5" />
              市场
            </button>
            <button
              type="button"
              onClick={() => changeViewMode("editor")}
              aria-pressed={viewMode === "editor"}
              className={cn(
                "flex h-8 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs font-bold transition-all sm:flex-none",
                viewMode === "editor" ? "bg-card text-foreground shadow-sm ring-1 ring-border/50" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Wrench className="h-3.5 w-3.5" />
              Studio
            </button>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2">
          {/* Stats pills */}
          <div className="hidden items-center gap-2 xl:flex">
            <div className="flex items-center gap-1.5 rounded-full border border-border/60 bg-card/70 px-2.5 py-1 text-xs">
              <span className="font-bold tabular-nums">{payload.totals.total}</span>
              <span className="text-muted-foreground">核心技能</span>
            </div>

          </div>

          <div className="h-4 w-px bg-border hidden md:block" />

          <PlatformSwitcher beforeNavigate={() => confirmUnsavedNavigation()} />

          <ThemeToggle compact />

          <Button variant="ghost" size="icon" onClick={refreshDashboard} className="h-9 w-9 rounded-xl" aria-label="刷新技能状态" title="刷新技能状态">
            <RefreshCcw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      {/* Main content */}
      {viewMode === "catalog" ? (
        <SkillsMarket refreshKey={payload.generatedAt} onOpenStudio={enterEditor} />
      ) : (
      <div className="platform-content relative flex flex-1 overflow-hidden" role="main">
        {isSkillListCollapsed && !isStudioFocusMode && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setIsSkillListCollapsed(false)}
            className="absolute left-3 top-3 z-30 hidden h-8 w-8 rounded-lg border-border/60 bg-card p-0 shadow-sm md:inline-flex"
            aria-label="展开 Skill 列表"
            title="展开 Skill 列表"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
        )}

        {/* ── Left: Skill List ───────────────────────────────── */}
        <aside
          className={cn(
            "relative hidden shrink-0 flex-col border-r border-border/60 bg-card transition-all duration-300 ease-out md:flex",
            isSkillRailHidden
              ? "min-w-0 -translate-x-4 overflow-hidden border-r-0 opacity-0 pointer-events-none"
              : "translate-x-0 opacity-100"
          )}
          style={{ width: isSkillRailHidden ? 0 : skillListWidth }}
          aria-hidden={isSkillRailHidden}
        >
          {/* Search + filter */}
          <div className="border-b border-border/40 p-3 space-y-2.5">
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="搜索 Studio Skills"
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
            <div className="flex flex-wrap gap-1">
              {SCOPE_CHIPS.map((chip) => {
                const isActive = scopeFilter === chip.id;
                return (
                  <button
                    key={chip.id}
                    type="button"
                    onClick={() => setScopeFilter(chip.id)}
                    className={cn(
                      "rounded-md px-2 py-1 text-xs font-medium transition-all",
                      isActive
                        ? "bg-primary/10 text-primary ring-1 ring-primary/20"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    )}
                  >
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
                      <div className="mt-1 flex min-w-0 items-center gap-1.5">
                        <p className="truncate font-mono text-[11px] text-muted-foreground">{skill.id}</p>
                        <SkillScopeBadge scope={skill.scope} />
                      </div>
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
          {!isSkillRailHidden && (
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
        <div className={cn("flex min-w-0 flex-1 flex-col overflow-hidden transition-[padding] duration-300", isSkillListCollapsed && !isStudioFocusMode && "md:pl-12")}>
          {selectedSkill ? (
            <>
              <div className="platform-nav-scroll flex shrink-0 gap-2 overflow-x-auto border-b border-border/50 bg-card/70 px-3 py-2 md:hidden">
                {filteredSkills.map((skill) => (
                  <button
                    key={skill.id}
                    type="button"
                    onClick={() => selectSkill(skill.id)}
                    className={cn("shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors", skill.id === selectedSkill.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}
                  >
                    {skill.name}
                  </button>
                ))}
              </div>
              {/* Skill overview bar */}
              <div className="flex flex-wrap items-center gap-2 border-b border-border/40 bg-card/50 px-3 py-2.5 backdrop-blur sm:gap-3 sm:px-4">
                <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-2.5">
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
                  <span className="hidden rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground sm:inline-flex">
                    v{selectedSkill.version}
                  </span>
                  <span className="hidden sm:inline-flex"><SkillScopeBadge scope={selectedSkill.scope} /></span>
                </div>
                {selectedSkill.health.missing.length > 0 && (
                  <span className="flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-700">
                    <TriangleAlert className="h-3 w-3" />
                    {selectedSkill.health.missing.join(", ")}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
                  {source && (
                    <span className={cn("hidden items-center gap-1 text-xs sm:flex", sourceDirty ? "text-amber-600" : "text-emerald-600")}>
                      <span className={cn("h-1.5 w-1.5 rounded-full", sourceDirty ? "animate-pulse bg-amber-500" : "bg-emerald-500")} />
                      {sourceDirty ? "未保存" : "已同步"}
                    </span>
                  )}
                  <Button variant="outline" size="sm" onClick={() => setIsVersionManagerOpen(true)} className="gap-1.5 text-xs">
                    <History className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">版本管理</span><span className="sm:hidden">版本</span>
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
                <div className={cn("hidden w-[260px] shrink-0 flex-col border-r border-border/40 bg-muted/20 lg:flex", (isFileTreeCollapsed || isStudioFocusMode) && "lg:hidden")}>
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
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setIsFileTreeCollapsed(true)} aria-label="收起文件树" title="收起文件树">
                        <PanelLeftClose className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                  <div className="border-b border-border/40 p-2">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                      <Input value={sourceFileQuery} onChange={(e) => setSourceFileQuery(e.target.value)} placeholder="搜索文件..." aria-label="搜索 Skill 文件" className="h-7 border-border/60 bg-card pl-7 text-xs" />
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
                  <div className="flex min-h-10 items-center gap-1.5 border-b border-border/40 px-2 py-1.5 text-xs text-muted-foreground sm:gap-2 sm:px-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setIsFileTreeCollapsed((value) => !value)}
                      disabled={isStudioFocusMode}
                      className="hidden h-7 w-7 lg:inline-flex"
                      aria-label={isFileTreeCollapsed ? "展开文件树" : "收起文件树"}
                      title={isFileTreeCollapsed ? "展开文件树" : "收起文件树"}
                    >
                      {isFileTreeCollapsed ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
                    </Button>
                    <span className="min-w-0 truncate font-mono">{source?.filePath ?? selectedFilePath}</span>
                    {source && <span className="text-border">·</span>}
                    {source && <span>{formatBytes(source.size)}</span>}
                    {source?.updatedAt && <><span className="hidden text-border sm:inline">·</span><span className="hidden sm:inline">{formatTime(source.updatedAt)}</span></>}
                    <span className="hidden text-border md:inline">·</span>
                    <span className="hidden tabular-nums md:inline">{editorStats.lines} 行</span>
                    <span className="hidden tabular-nums xl:inline">{editorStats.characters.toLocaleString()} 字符</span>
                    <div className="ml-auto flex items-center gap-0.5">
                      <Button
                        variant={isEditorWrapping ? "secondary" : "ghost"}
                        size="icon"
                        onClick={() => setIsEditorWrapping((value) => !value)}
                        className="h-7 w-7"
                        aria-pressed={isEditorWrapping}
                        aria-label={isEditorWrapping ? "关闭自动换行" : "开启自动换行"}
                        title={isEditorWrapping ? "关闭自动换行" : "开启自动换行"}
                      >
                        <WrapText className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant={isStudioFocusMode ? "secondary" : "ghost"}
                        size="icon"
                        onClick={() => setIsStudioFocusMode((value) => !value)}
                        className="h-7 w-7"
                        aria-pressed={isStudioFocusMode}
                        aria-label={isStudioFocusMode ? "退出专注模式" : "进入专注模式"}
                        title={isStudioFocusMode ? "退出专注模式" : "进入专注模式"}
                      >
                        {isStudioFocusMode ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => loadSource(selectedSkill.id, selectedFilePath)} disabled={isLoadingSource} aria-label="重新载入当前文件" title="重新载入当前文件">
                      {isLoadingSource ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCcw className="h-3 w-3" />}
                      </Button>
                    </div>
                  </div>
                  {isLoadingSource ? (
                    <div className="flex-1 p-4"><Skeleton className="h-full w-full rounded-lg" /></div>
                  ) : (
                    <div className="flex min-h-0 flex-1 overflow-hidden bg-muted/20">
                      <div className="min-w-0 flex-1 p-0 sm:p-3">
                        <div className={cn("mx-auto h-full w-full overflow-hidden border-border/60 bg-card shadow-sm sm:rounded-xl sm:border", isStudioFocusMode ? "max-w-[1440px]" : "max-w-[1120px]")}>
                          <Textarea
                            ref={editorTextareaRef}
                            value={sourceDraft}
                            onChange={(e) => setSourceDraft(e.target.value)}
                            onKeyDown={(event) => {
                              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                                event.preventDefault();
                                if (sourceDirty && !isSavingSource) void saveSource();
                              }
                            }}
                            wrap={isEditorWrapping ? "soft" : "off"}
                            spellCheck={false}
                            className={cn("h-full min-h-0 resize-none rounded-none border-0 bg-card px-5 py-4 font-mono text-[13px] leading-6 shadow-none focus-visible:ring-0 sm:px-7 sm:py-6", isEditorWrapping ? "whitespace-pre-wrap" : "whitespace-pre")}
                            placeholder="选择一个可编辑文件..."
                            aria-label="Skill 源码编辑器"
                          />
                        </div>
                      </div>

                      {!isStudioFocusMode && documentOutline.length > 0 && (
                        <aside className="hidden w-[240px] shrink-0 flex-col border-l border-border/50 bg-card/75 2xl:flex" aria-label="文档大纲">
                          <div className="flex h-10 items-center justify-between border-b border-border/50 px-3">
                            <span className="flex items-center gap-1.5 text-xs font-bold text-foreground"><ListTree className="h-3.5 w-3.5 text-primary" />文档大纲</span>
                            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground">{documentOutline.length}</span>
                          </div>
                          <nav className="flex-1 overflow-y-auto p-2">
                            {documentOutline.map((heading) => (
                              <button
                                key={`${heading.offset}-${heading.text}`}
                                type="button"
                                onClick={() => jumpToDocumentHeading(heading.offset, heading.lineIndex)}
                                className="block w-full truncate rounded-lg py-1.5 pr-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                style={{ paddingLeft: `${8 + (heading.level - 1) * 14}px` }}
                                title={heading.text}
                              >
                                {heading.text}
                              </button>
                            ))}
                          </nav>
                          <div className="border-t border-border/50 px-3 py-2 text-[10px] leading-4 text-muted-foreground">点击标题可定位 · Ctrl / ⌘ + S 保存</div>
                        </aside>
                      )}
                    </div>
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
      )}

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

      {/* Skill Detail Dialog */}
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
