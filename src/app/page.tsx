"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  CircleAlert,
  CircleCheckBig,
  CircleDashed,
  FileChartColumn,
  FolderKanban,
  Home,
  LayoutDashboard,
  MessageSquare,
  Settings,
  XCircle,
  Sparkles,
  ChevronRight,
  ArrowRight,
  Blocks,
  RefreshCcw,
  UserRound,
  Users,
} from "lucide-react";
import { useGlobalSettings } from "@/contexts/GlobalSettingsContext";
import { getDefaultModelForCli, getModelDisplayName } from "@/lib/constants/models";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { PlatformSwitcher } from "@/components/layout/PlatformSwitcher";
import { CreateTaskForm } from "@/components/task/CreateTaskForm";
import type { UploadedImage } from "@/components/task/CreateTaskForm";
import { useAuth } from "@/contexts/AuthContext";
import type { Project as ProjectSummary } from "@/types/project";
import { DEFAULT_DATA_AGENT_PROFILE_ID } from "@/lib/config/data-agent";
import { fetchCliStatusSnapshot, createCliStatusFallback } from "@/hooks/useCLI";
import type { CLIStatus } from "@/types/cli";
import {
  ACTIVE_CLI_MODEL_OPTIONS,
  ACTIVE_CLI_OPTIONS,
  ACTIVE_CLI_OPTIONS_MAP,
  DEFAULT_ACTIVE_CLI,
  normalizeModelForCli,
  sanitizeActiveCli,
  type ActiveCliId,
} from "@/lib/utils/cliOptions";
import {
  DEFAULT_QUANT_CAPABILITY_ID,
  getQuantCapability,
  QUANT_CAPABILITIES,
  type QuantCapabilityId,
} from "@/lib/domains/finance/capabilities";
import { cn } from "@/lib/utils";
import homeAnimeResearcher from "@/assets/home-anime-quant-researcher-v3.webp";
import {
  buildQuestionInstruction,
  questionOutputLabel,
  type QuestionMode,
} from "@/components/chat/question-composer";

const fetchAPI = globalThis.fetch || fetch;
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

const GlobalSettings = dynamic(() => import("@/components/settings/GlobalSettings"), { ssr: false });
const TaskDrawer = dynamic(
  () => import("@/components/task/TaskDrawer").then((module) => module.TaskDrawer),
  { ssr: false },
);

const ASSISTANT_OPTIONS = ACTIVE_CLI_OPTIONS.map(({ id, name }) => ({ id, name }));

const RESEARCH_STARTERS: Array<{
  capabilityId: QuantCapabilityId;
  label: string;
  prompt: string;
}> = [
  {
    capabilityId: "stock_diagnosis",
    label: "贵州茅台近 60 日趋势",
    prompt: "分析贵州茅台近 60 个交易日的趋势、量能、估值与主要风险。",
  },
  {
    capabilityId: "fundamental_analysis",
    label: "宁德时代基本面",
    prompt: "评估宁德时代当前的估值、盈利质量、现金流和成长持续性。",
  },
  {
    capabilityId: "asset_comparison",
    label: "沪深 300 对比中证 500",
    prompt: "对比沪深 300 与中证 500 近一年的收益、波动率、最大回撤和估值水平。",
  },
];

const ACTIVE_PROJECT_STATUSES = new Set(["running", "building", "initializing"]);

function getProjectStatus(project: ProjectSummary) {
  if (project.previewUrl || project.status === "preview_running" || project.status === "active") {
    return { label: "看板就绪", tone: "green", icon: CircleCheckBig } as const;
  }
  if (ACTIVE_PROJECT_STATUSES.has(project.status ?? "")) {
    return { label: "进行中", tone: "amber", icon: CircleDashed } as const;
  }
  if (project.status === "failed" || project.status === "error") {
    return { label: "需要处理", tone: "red", icon: CircleAlert } as const;
  }
  return { label: "草稿", tone: "slate", icon: CircleDashed } as const;
}

function getProjectActionLabel(project: ProjectSummary) {
  if (project.previewUrl || project.status === "preview_running" || project.status === "active") return "查看结果";
  if (project.status === "failed" || project.status === "error") return "查看原因";
  if (ACTIVE_PROJECT_STATUSES.has(project.status ?? "")) return "查看进度";
  return "继续编辑";
}

export default function HomePage() {
  // --- State ---
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);
  const [editingProject, setEditingProject] = useState<ProjectSummary | null>(null);
  const [deleteModal, setDeleteModal] = useState<{
    isOpen: boolean;
    project: ProjectSummary | null;
  }>({ isOpen: false, project: null });
  const [isDeleting, setIsDeleting] = useState(false);
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);
  const [prompt, setPrompt] = useState("");
  const [outputMode, setOutputMode] = useState<QuestionMode>("act");
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [creationStep, setCreationStep] = useState<string | null>(null);

  const DEFAULT_ASSISTANT: ActiveCliId = DEFAULT_ACTIVE_CLI;
  const DEFAULT_MODEL = getDefaultModelForCli(DEFAULT_ASSISTANT);

  const sanitizeAssistant = useCallback(
    (cli?: string | null) => sanitizeActiveCli(cli, DEFAULT_ASSISTANT),
    [DEFAULT_ASSISTANT]
  );
  const normalizeModelForAssistant = useCallback(
    (assistant: string, model?: string | null) =>
      normalizeModelForCli(assistant, model, DEFAULT_ASSISTANT),
    [DEFAULT_ASSISTANT]
  );

  const normalizeProjectPayload = useCallback(
    (project: any): ProjectSummary => {
      const preferred = sanitizeAssistant(
        project?.preferredCli
      );
      const selected = normalizeModelForAssistant(
        preferred,
        project?.selectedModel
      );
      return {
        id: project.id,
        name: project.name,
        description: project.description ?? null,
        status: project.status,
        previewUrl: project.previewUrl ?? null,
        createdAt: project.createdAt ?? new Date().toISOString(),
        updatedAt: project.updatedAt,
        lastActiveAt: project.lastActiveAt ?? null,
        lastMessageAt: project.lastMessageAt ?? null,
        initialPrompt: project.initialPrompt ?? null,
        services: project.services,
        preferredCli: preferred as ProjectSummary["preferredCli"],
        selectedModel: selected,
        agentProfileId: project.agentProfileId ?? DEFAULT_DATA_AGENT_PROFILE_ID,
        quantCapabilityId: getQuantCapability(project.quantCapabilityId).id,
      };
    },
    [sanitizeAssistant, normalizeModelForAssistant]
  );

  const [selectedAssistant, setSelectedAssistant] =
    useState<ActiveCliId>(DEFAULT_ASSISTANT);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [selectedCapability, setSelectedCapability] =
    useState<QuantCapabilityId>(DEFAULT_QUANT_CAPABILITY_ID);
  const [usingGlobalDefaults, setUsingGlobalDefaults] = useState(true);
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  const [cliStatus, setCLIStatus] = useState<CLIStatus>(() =>
    createCliStatusFallback()
  );
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [uploadedImages, setUploadedImages] = useState<UploadedImage[]>([]);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [greeting, setGreeting] = useState("你好");

  const router = useRouter();
  const { settings: globalSettings } = useGlobalSettings();
  const { user } = useAuth();

  const availableModels =
    ACTIVE_CLI_MODEL_OPTIONS[selectedAssistant] || [];
  const selectedRoleModule =
    QUANT_CAPABILITIES.find((c) => c.id === selectedCapability) ??
    QUANT_CAPABILITIES[0];
  const activeProjects = projects.filter((project) =>
    !project.previewUrl && ACTIVE_PROJECT_STATUSES.has(project.status ?? "")
  );
  const runningProjects = activeProjects.length;
  const readyProjects = projects.filter((project) => Boolean(project.previewUrl)).length;
  const recentResults = projects.filter((project) => Boolean(project.previewUrl)).slice(0, 2);
  const recentProjects = projects.filter((project) => !project.previewUrl).slice(0, 3);
  const attentionProject = useMemo(() => {
    const needsAttention = projects.find((project) => project.status === "failed" || project.status === "error");
    const currentlyRunning = projects.find(
      (project) => !project.previewUrl && ACTIVE_PROJECT_STATUSES.has(project.status ?? "")
    );
    return needsAttention ?? currentlyRunning ?? null;
  }, [projects]);
  const readyCapabilities = QUANT_CAPABILITIES.filter((capability) => capability.status === "ready");
  const accountName = user?.name || user?.email || "研究员";
  const accountInitial = accountName.slice(0, 1).toUpperCase();
  const normalizedPrompt = prompt.trim();

  // --- Session persistence ---
  useEffect(() => {
    const isPageRefresh = !sessionStorage.getItem("navigationFlag");
    if (isPageRefresh) {
      sessionStorage.setItem("navigationFlag", "true");
      setIsInitialLoad(true);
      setUsingGlobalDefaults(true);
    } else {
      const storedAssistantRaw = sessionStorage.getItem("selectedAssistant");
      const storedModelRaw = sessionStorage.getItem("selectedModel");
      if (storedModelRaw) {
        setSelectedAssistant(sanitizeAssistant(storedAssistantRaw));
        setSelectedModel(
          normalizeModelForAssistant(
            sanitizeAssistant(storedAssistantRaw),
            storedModelRaw
          )
        );
        setUsingGlobalDefaults(false);
        setIsInitialLoad(false);
        return;
      }
    }
    return () => {};
  }, [sanitizeAssistant, normalizeModelForAssistant]);

  useEffect(() => {
    const currentHour = new Date().getHours();
    setGreeting(currentHour < 11 ? "早上好" : currentHour < 14 ? "中午好" : currentHour < 18 ? "下午好" : "晚上好");
    const storedMode = window.localStorage.getItem("quantpilot-question-mode");
    if (storedMode === "act" || storedMode === "chat") setOutputMode(storedMode);
  }, []);

  const handleOutputModeChange = useCallback((mode: QuestionMode) => {
    setOutputMode(mode);
    window.localStorage.setItem("quantpilot-question-mode", mode);
  }, []);

  useEffect(() => {
    if (!usingGlobalDefaults || !isInitialLoad) return;
    const cli = sanitizeAssistant(globalSettings?.default_cli);
    setSelectedAssistant(cli);
    const modelFromGlobal = globalSettings?.cli_settings?.[cli]?.model;
    setSelectedModel(normalizeModelForAssistant(cli, modelFromGlobal));
  }, [
    globalSettings,
    usingGlobalDefaults,
    isInitialLoad,
    sanitizeAssistant,
    normalizeModelForAssistant,
  ]);

  useEffect(() => {
    if (!isInitialLoad && selectedAssistant && selectedModel) {
      const normalizedAssistant = sanitizeAssistant(selectedAssistant);
      sessionStorage.setItem("selectedAssistant", normalizedAssistant);
      sessionStorage.setItem(
        "selectedModel",
        normalizeModelForAssistant(normalizedAssistant, selectedModel)
      );
    }
  }, [
    selectedAssistant,
    selectedModel,
    isInitialLoad,
    sanitizeAssistant,
    normalizeModelForAssistant,
  ]);

  useEffect(() => {
    const handleBeforeUnload = () =>
      sessionStorage.removeItem("navigationFlag");
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  // --- CLI status ---
  useEffect(() => {
    const checkingStatus = ASSISTANT_OPTIONS.reduce<CLIStatus>(
      (acc, cli) => {
        acc[cli.id] = { installed: true, available: true, configured: true, checking: true };
        return acc;
      },
      createCliStatusFallback()
    );
    setCLIStatus(checkingStatus);
    fetchCliStatusSnapshot()
      .then(setCLIStatus)
      .catch((err) => {
        console.error("Failed to check CLI status:", err);
        setCLIStatus(createCliStatusFallback());
      });
  }, []);

  // --- Data loading ---
  const load = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const r = await fetchAPI(`${API_BASE}/api/projects`);
      if (!r.ok) {
        throw new Error(`项目列表请求失败（${r.status}）`);
      }
      const payload = await r.json();
      if (payload?.success === false) {
        throw new Error(payload?.message || payload?.error || "项目列表加载失败");
      }
      const items: unknown[] = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload)
          ? payload
          : [];
      const normalized: ProjectSummary[] = items
        .filter((p): p is Record<string, unknown> => Boolean(p && typeof p === "object"))
        .map(normalizeProjectPayload);
      const sorted = normalized.sort((a, b) => {
        const aTime = a.lastMessageAt ?? a.createdAt;
        const bTime = b.lastMessageAt ?? b.createdAt;
        if (!aTime) return 1;
        if (!bTime) return -1;
        return new Date(bTime).getTime() - new Date(aTime).getTime();
      });
      setProjects(sorted);
      setProjectsError(null);
    } catch (error) {
      setProjectsError(error instanceof Error ? error.message : "项目列表加载失败");
    } finally {
      setProjectsLoading(false);
    }
  }, [normalizeProjectPayload]);

  useEffect(() => {
    load();
  }, [load]);

  // --- Format helpers ---
  const formatTime = (dateString: string | null) => {
    if (!dateString) return "暂无记录";
    let utc = dateString;
    if (!dateString.endsWith("Z") && !dateString.includes("+") && !dateString.match(/[-+]\d{2}:\d{2}$/)) {
      utc = dateString + "Z";
    }
    const date = new Date(utc);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    if (diffMins < 1) return "刚刚";
    if (diffMins < 60) return `${diffMins} 分钟前`;
    if (diffHours < 24) return `${diffHours} 小时前`;
    if (diffDays < 30) return `${diffDays} 天前`;
    return date.toLocaleDateString("zh-CN", {
      month: "short",
      day: "numeric",
      year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });
  };

  const formatCliInfo = (cli?: string, model?: string) => {
    const normalizedCli = sanitizeAssistant(cli);
    const opt = ACTIVE_CLI_OPTIONS_MAP[normalizedCli];
    const name = opt?.name ?? "MoAgent";
    const modelId = normalizeModelForAssistant(normalizedCli, model);
    const label = getModelDisplayName(normalizedCli, modelId);
    return `${name} · ${label}`;
  };

  const getCapabilityShortName = (capabilityId?: string | null) =>
    getQuantCapability(capabilityId).shortName;

  // --- Actions ---
  const showToast = useCallback(
    (message: string, type: "success" | "error") => {
      setToast({ message, type });
      setTimeout(() => setToast(null), 4000);
    },
    []
  );

  const openDeleteModal = (project: ProjectSummary) =>
    setDeleteModal({ isOpen: true, project });
  const closeDeleteModal = () =>
    setDeleteModal({ isOpen: false, project: null });

  const deleteProject = async () => {
    if (!deleteModal.project) return;
    setIsDeleting(true);
    try {
      const r = await fetchAPI(
        `${API_BASE}/api/projects/${deleteModal.project.id}`,
        { method: "DELETE" }
      );
      if (r.ok) {
        showToast("任务已删除", "success");
        await load();
        closeDeleteModal();
      } else {
        const err = await r.json().catch(() => ({ detail: "删除任务失败" }));
        showToast(err.detail || "删除任务失败", "error");
      }
    } catch {
      showToast("删除任务失败，请重试", "error");
    } finally {
      setIsDeleting(false);
    }
  };

  const updateProject = async (projectId: string, newName: string) => {
    try {
      const r = await fetchAPI(`${API_BASE}/api/projects/${projectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      if (r.ok) {
        showToast("任务名称已更新", "success");
        await load();
        setEditingProject(null);
      } else {
        const err = await r.json().catch(() => ({ detail: "更新任务失败" }));
        showToast(err.detail || "更新任务失败", "error");
      }
    } catch {
      showToast("更新任务失败，请重试", "error");
    }
  };

  const openProject = (project: ProjectSummary) => {
    router.push(`/${project.id}/chat`);
  };

  const handleSubmit = async () => {
    if (isCreatingProject) return;
    if (!prompt.trim()) {
      showToast("请先描述希望研究的问题，图片可以作为补充材料。", "error");
      return;
    }

    setIsCreatingProject(true);
    setCreationStep(pendingProjectId ? "正在重试启动研究" : "正在准备研究空间");
    let createdProjectId = pendingProjectId;

    try {
      if (!createdProjectId) {
        const projectId = `project-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 11)}`;
        const r = await fetchAPI(`${API_BASE}/api/projects`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId,
            name: prompt.slice(0, 50) + (prompt.length > 50 ? "..." : ""),
            initialPrompt: prompt.trim(),
            selectedModel,
            quantCapabilityId: selectedCapability,
            quantCapabilitySource: "manual",
          }),
        });
        const payload = await r.json().catch(() => null);
        if (!r.ok || payload?.success === false) {
          throw new Error(payload?.message || payload?.error || `研究空间创建失败（${r.status}）`);
        }
        const projectData = payload && typeof payload === "object" ? payload.data ?? payload : payload;
        createdProjectId = projectData?.id ?? projectId;
        setPendingProjectId(createdProjectId);
      }

      setCreationStep(uploadedImages.length > 0 ? `正在上传研究材料（0/${uploadedImages.length}）` : "正在提交研究问题");
      const imageData: Array<{ name: string; path: string }> = [];
      const nextImages = [...uploadedImages];
      if (uploadedImages.length > 0) {
        for (let index = 0; index < uploadedImages.length; index += 1) {
          const image = nextImages[index];
          if (image.path) {
            imageData.push({ name: image.name, path: image.path });
            setCreationStep(`正在上传研究材料（${index + 1}/${uploadedImages.length}）`);
            continue;
          }
          if (!image.file) throw new Error(`无法读取图片“${image.name}”，请重新选择后再试。`);
          const fd = new FormData();
          fd.append("file", image.file);
          const uploadR = await fetchAPI(
            `${API_BASE}/api/assets/${createdProjectId}/upload`,
            { method: "POST", body: fd }
          );
          const result = await uploadR.json().catch(() => null);
          if (!uploadR.ok || !result?.path) {
            throw new Error(result?.message || result?.error || `图片“${image.name}”上传失败`);
          }
          const uploaded = {
            name: result.filename || image.name,
            path: result.path as string,
          };
          imageData.push(uploaded);
          nextImages[index] = { ...image, name: uploaded.name, path: uploaded.path };
          setUploadedImages([...nextImages]);
          setCreationStep(`正在上传研究材料（${index + 1}/${uploadedImages.length}）`);
        }
      }

      setCreationStep(outputMode === "act" ? "正在启动看板研究" : "正在启动分析问答");
      const visibleInstruction = prompt.trim();
      const instruction = buildQuestionInstruction(visibleInstruction, outputMode);
      const actResponse = await fetchAPI(`${API_BASE}/api/chat/${createdProjectId}/act`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction,
          displayInstruction: visibleInstruction,
          images: imageData,
          isInitialPrompt: true,
          selectedModel,
          quantCapabilityId: selectedCapability,
          quantCapabilitySource: "manual",
        }),
      });
      const actPayload = await actResponse.json().catch(() => null);
      if (!actResponse.ok || actPayload?.success === false) {
        throw new Error(
          actPayload?.message || actPayload?.error || `研究任务未能启动（${actResponse.status}）`
        );
      }

      uploadedImages.forEach((img) => {
        if (img.url) URL.revokeObjectURL(img.url);
      });
      setUploadedImages([]);
      setPrompt("");
      setPendingProjectId(null);
      const params = new URLSearchParams();
      if (selectedAssistant) params.set("cli", selectedAssistant);
      if (selectedModel) params.set("model", selectedModel);
      params.set("mode", outputMode);
      router.push(
        `/${createdProjectId}/chat${params.toString() ? "?" + params.toString() : ""}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "研究任务启动失败";
      showToast(`${message}。输入和附件已保留，可直接重试。`, "error");
      if (createdProjectId) void load();
    } finally {
      setIsCreatingProject(false);
      setCreationStep(null);
    }
  };

  // --- Assistant/model handlers ---
  const isAssistantSelectable = useCallback(
    (assistant: string) => {
      const status = cliStatus[assistant];
      if (!status || status.checking) return true;
      return Boolean(status.installed || status.available || status.configured);
    },
    [cliStatus]
  );

  const handleAssistantChange = (assistant: string) => {
    if (!isAssistantSelectable(assistant)) return;
    const sanitized = sanitizeAssistant(assistant);
    setUsingGlobalDefaults(false);
    setIsInitialLoad(false);
    setSelectedAssistant(sanitized);
    setSelectedModel(getDefaultModelForCli(sanitized));
  };

  const handleModelChange = (modelId: string) => {
    setUsingGlobalDefaults(false);
    setIsInitialLoad(false);
    setSelectedModel(normalizeModelForAssistant(selectedAssistant, modelId));
  };

  const handleCapabilityChange = (capabilityId: QuantCapabilityId) => {
    setSelectedCapability(capabilityId);
  };

  const handleCapabilityCardClick = (capabilityId: QuantCapabilityId) => {
    setSelectedCapability(capabilityId);
  };

  const handleStarterClick = (starter: (typeof RESEARCH_STARTERS)[number]) => {
    setSelectedCapability(starter.capabilityId);
    setPrompt(starter.prompt);
    document.getElementById("task-input")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const handleCapabilityKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const visibleCapabilities = readyCapabilities.slice(0, 4);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? visibleCapabilities.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + visibleCapabilities.length) % visibleCapabilities.length;
    setSelectedCapability(visibleCapabilities[nextIndex].id);
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-home-capability-index="${nextIndex}"]`)?.focus();
    });
  };

  const renderProjectRow = (project: ProjectSummary, index: number) => {
    const status = getProjectStatus(project);
    const StatusIcon = status.icon;
    const title = project.name || project.initialPrompt || "未命名研究";
    const candidateSummary = project.initialPrompt || project.description || "";
    const normalizedTitle = title.replace(/\.{3}$/, "").trim();
    const isDuplicateSummary = Boolean(
      candidateSummary && normalizedTitle && (
        candidateSummary.startsWith(normalizedTitle) || normalizedTitle.startsWith(candidateSummary)
      )
    );
    const detail = candidateSummary && !isDuplicateSummary
      ? candidateSummary
      : formatCliInfo(project.preferredCli ?? undefined, project.selectedModel ?? undefined);

    return (
      <button
        key={project.id}
        type="button"
        onClick={() => openProject(project)}
        className="group grid min-h-[4.75rem] w-full scroll-mb-24 grid-cols-[2rem_minmax(0,1fr)_auto_1rem] items-center gap-3 px-1 py-3.5 text-left transition-colors hover:bg-muted/25 focus-visible:bg-muted/30 md:grid-cols-[2.5rem_minmax(0,1fr)_6rem_7rem_6.5rem_5.5rem_1.25rem] md:gap-4"
      >
        <span className="font-mono text-[11px] text-muted-foreground/60">{String(index + 1).padStart(2, "0")}</span>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-bold transition-colors group-hover:text-primary">{title}</h3>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{detail}</p>
        </div>
        <span className="hidden text-[11px] font-semibold text-muted-foreground md:block">{getCapabilityShortName(project.quantCapabilityId)}</span>
        <span className={cn(
          "inline-flex items-center justify-end gap-1 whitespace-nowrap text-[10px] font-semibold md:justify-start md:text-[11px]",
          status.tone === "amber" && "text-amber-700 dark:text-amber-400",
          status.tone === "red" && "text-red-700 dark:text-red-400",
          status.tone === "green" && "text-emerald-700 dark:text-emerald-400",
          status.tone === "slate" && "text-muted-foreground",
        )}>
          <StatusIcon className="h-3 w-3" />{status.label}
        </span>
        <span className="hidden text-[11px] text-muted-foreground md:block">{formatTime(project.lastMessageAt || project.createdAt)}</span>
        <span className="hidden text-[11px] font-semibold text-foreground transition-colors group-hover:text-primary md:block">{getProjectActionLabel(project)}</span>
        <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-primary" />
      </button>
    );
  };

  // --- Render ---
  return (
    <div className="home-shell relative flex min-h-screen flex-col overflow-x-clip bg-background text-foreground">
      <header className="platform-header sticky top-0 z-40 flex h-16 shrink-0 items-center justify-between px-3 md:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <Image
            src="/quantpilot-mark.svg"
            alt=""
            width={40}
            height={40}
            priority
            className="h-10 w-10 shrink-0 rounded-xl shadow-[0_10px_22px_-12px_rgba(201,67,49,0.82)]"
          />
          <span className="text-base font-bold tracking-tight sm:text-lg">QuantPilot</span>

          <nav className="ml-4 hidden items-center gap-1 lg:flex" aria-label="首页导航">
            <Button type="button" variant="ghost" size="sm" className="h-11 gap-2 rounded-none border-b-2 border-primary px-3 text-xs font-semibold text-foreground">
              <Home className="h-3.5 w-3.5" />首页
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setTaskDrawerOpen(true)} className="h-11 gap-2 rounded-none px-3 text-xs font-semibold text-muted-foreground">
              <FolderKanban className="h-3.5 w-3.5" />项目
              {projects.length > 0 ? <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">{projects.length}</span> : null}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => router.push("/research-reports")} className="h-11 gap-2 rounded-none px-3 text-xs font-semibold text-muted-foreground">
              <FileChartColumn className="h-3.5 w-3.5" />成果
            </Button>
            <PlatformSwitcher />
          </nav>
        </div>

        <div className="flex items-center gap-1.5">
          <div className="lg:hidden"><PlatformSwitcher /></div>
          <Button type="button" onClick={() => setTaskDrawerOpen(true)} variant="ghost" size="icon" className="hidden h-11 w-11 rounded-lg md:inline-flex lg:hidden" aria-label="打开项目">
            <FolderKanban className="h-4 w-4" />
            <span className="sr-only">项目</span>
          </Button>
          <ThemeToggle compact />
          <Button type="button" onClick={() => setShowGlobalSettings(true)} variant="ghost" size="icon" className="hidden h-11 w-11 rounded-lg sm:inline-flex lg:h-9 lg:w-9" aria-label="全局设置">
            <Settings className="h-4 w-4" />
          </Button>
          {user?.role === "admin" ? (
            <Button type="button" onClick={() => router.push("/admin/users")} variant="ghost" size="icon" className="hidden h-9 w-9 rounded-lg xl:inline-flex" aria-label="用户管理">
              <Users className="h-4 w-4" />
            </Button>
          ) : null}
          <Button type="button" onClick={() => router.push("/account/usage")} variant="ghost" className="hidden h-11 gap-2 rounded-lg px-2 sm:inline-flex lg:h-9" aria-label="打开我的账号">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-[10px] font-bold text-primary-foreground">{accountInitial || <UserRound className="h-3.5 w-3.5" />}</span>
            <span className="hidden max-w-24 truncate text-xs font-semibold xl:inline">{accountName}</span>
          </Button>
        </div>
      </header>

      <main className="platform-content flex-1 scroll-pb-24 px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-4 md:px-6 md:pb-16 md:pt-5">
        <div className="mx-auto w-full max-w-[116rem]">
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="flex flex-col gap-2 border-b border-border/60 pb-3 sm:flex-row sm:items-end sm:justify-between"
          >
            <div className="min-w-0">
              <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.08em] text-primary">
                <Sparkles className="h-3.5 w-3.5" />量化研究工作台
              </div>
              <p className="mt-1 text-lg font-bold tracking-[-0.025em] sm:text-xl">{greeting}，{accountName}</p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">从一个清晰的问题开始，在同一工作区完成取数、分析、验证与可视化。</p>
            </div>
            {projects.length > 0 ? (
              <div className="hidden items-center gap-4 pb-0.5 text-[11px] text-muted-foreground sm:flex">
                <span><strong className="mr-1 text-sm text-foreground">{projects.length}</strong>研究</span>
                {runningProjects > 0 ? <span><strong className="mr-1 text-sm text-amber-700 dark:text-amber-400">{runningProjects}</strong>运行中</span> : null}
                {readyProjects > 0 ? <span><strong className="mr-1 text-sm text-emerald-700 dark:text-emerald-400">{readyProjects}</strong>成果就绪</span> : null}
              </div>
            ) : null}
          </motion.section>

          {attentionProject ? (
            <motion.button
              type="button"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              onClick={() => openProject(attentionProject)}
              className="group mt-3 grid min-h-12 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-y border-border/70 px-1 py-2.5 text-left hover:bg-muted/25"
            >
              {(() => {
                const status = getProjectStatus(attentionProject);
                const StatusIcon = status.icon;
                return <span className={cn("inline-flex items-center gap-1.5 text-xs font-semibold", status.tone === "red" ? "text-red-700 dark:text-red-400" : "text-amber-700 dark:text-amber-400")}><StatusIcon className="h-3.5 w-3.5" />{status.label}</span>;
              })()}
              <span className="truncate text-xs font-semibold sm:text-sm">{attentionProject.name || attentionProject.initialPrompt || "未命名研究"}</span>
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground transition-colors group-hover:text-primary">{getProjectActionLabel(attentionProject)}<ArrowRight className="h-3.5 w-3.5" /></span>
            </motion.button>
          ) : null}

          <section className="mt-2 sm:mt-3">
            <motion.article
              id="task-input"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: 0.08, ease: "easeOut" }}
              className="relative isolate overflow-hidden border-b border-border/55 py-6 sm:py-9"
            >
              <div className="pointer-events-none absolute inset-0 -z-30 bg-[linear-gradient(145deg,hsl(var(--background)),hsl(var(--primary)/0.04)_52%,hsl(var(--background)))]" />
              <div className="pointer-events-none absolute left-1/2 top-2 -z-20 h-64 w-[58rem] max-w-[94vw] -translate-x-1/2 rounded-full bg-primary/[0.075] blur-3xl" />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -right-8 -top-8 -z-10 h-48 w-40 opacity-[0.13] mix-blend-multiply [mask-image:radial-gradient(ellipse_at_62%_42%,black_32%,transparent_76%)] sm:-right-4 sm:-top-24 sm:h-[32rem] sm:w-[26rem] sm:opacity-[0.16] dark:opacity-[0.075] dark:mix-blend-screen"
              >
                <Image
                  src={homeAnimeResearcher}
                  alt=""
                  fill
                  sizes="(max-width: 640px) 160px, 416px"
                  className="object-cover object-top saturate-[1.02]"
                />
              </div>

              <div className="relative z-10">
                <div className="text-center">
                  <h1 className="text-[1.9rem] font-bold tracking-[-0.045em] sm:text-[2.45rem]">今天想研究什么？</h1>
                  <p className="mx-auto mt-1.5 max-w-2xl text-xs leading-5 text-muted-foreground sm:text-sm">
                    <span className="sm:hidden">说清标的、时间和目标。</span>
                    <span className="hidden sm:inline">描述标的、时间范围和希望得到的结论，系统会自动补全取数、证据与验证步骤。</span>
                  </p>
                  <Link
                    href="/skills"
                    className="group mx-auto mt-3 inline-flex min-h-9 max-w-[calc(100vw-2rem)] items-center gap-2 rounded-full border border-primary/20 bg-background/75 px-3.5 py-1.5 text-[11px] font-medium text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:border-primary/45 hover:bg-primary/[0.055] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:text-xs"
                    aria-label="进入 Skills Market，发现更多研究能力"
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <Blocks className="h-3 w-3" />
                    </span>
                    <span className="truncate">
                      <span className="font-semibold text-foreground">探索 Skills Market</span>
                      <span className="hidden sm:inline">，发现更多分析模板与数据工具</span>
                    </span>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-primary transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </div>

                <div role="tablist" aria-label="研究类型" className="mx-auto mt-3 flex max-w-full snap-x snap-mandatory justify-start gap-3 overflow-x-auto overscroll-x-contain px-1 [scrollbar-width:none] sm:justify-center [&::-webkit-scrollbar]:hidden">
                  {readyCapabilities.slice(0, 4).map((capability, index) => (
                    <button
                      key={capability.id}
                      type="button"
                      role="tab"
                      aria-selected={selectedCapability === capability.id}
                      data-home-capability-index={index}
                      onClick={() => handleCapabilityCardClick(capability.id)}
                      onKeyDown={(event) => handleCapabilityKeyDown(event, index)}
                      className={cn(
                        "min-h-11 shrink-0 snap-start border-b-2 px-2 py-2.5 text-xs font-semibold transition-colors",
                        selectedCapability === capability.id
                          ? "border-primary text-primary"
                          : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
                      )}
                    >
                      {capability.name}
                    </button>
                  ))}
                </div>

                <div className="mx-auto mt-2.5 w-full max-w-[70rem]">
                  <CreateTaskForm
                    prompt={prompt}
                    onPromptChange={setPrompt}
                    isCreating={isCreatingProject}
                    onSubmit={handleSubmit}
                    uploadedImages={uploadedImages}
                    onImagesChange={setUploadedImages}
                    selectedAssistant={selectedAssistant}
                    onAssistantChange={handleAssistantChange}
                    assistantOptions={ASSISTANT_OPTIONS}
                    isAssistantSelectable={isAssistantSelectable}
                    selectedModel={selectedModel}
                    onModelChange={handleModelChange}
                    modelOptions={availableModels}
                    selectedRole={selectedRoleModule}
                    outputMode={outputMode}
                    onOutputModeChange={handleOutputModeChange}
                  />
                </div>

                {creationStep ? (
                  <p role="status" aria-live="polite" className="mx-auto mt-2 flex min-h-6 max-w-[70rem] items-center justify-center gap-2 text-xs font-medium text-primary">
                    <RefreshCcw className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{creationStep}
                  </p>
                ) : normalizedPrompt ? (
                  <div aria-live="polite" className="mx-auto mt-2.5 flex max-w-[70rem] flex-wrap items-center justify-center gap-1.5 text-[11px]">
                    <span className="mr-1 inline-flex items-center gap-1 font-semibold text-muted-foreground"><Sparkles className="h-3 w-3 text-primary" />提交后由所选大模型解析</span>
                    <span className="inline-flex min-h-7 items-center rounded-full border border-border/70 bg-background/75 px-2.5 text-foreground">标的原文保真</span>
                    <span className="inline-flex min-h-7 items-center rounded-full border border-border/70 bg-background/75 px-2.5 text-foreground">Resolver 校验证券代码</span>
                    <span className="inline-flex min-h-7 items-center gap-1 rounded-full border border-border/70 bg-background/75 px-2.5 text-foreground">{outputMode === "act" ? <LayoutDashboard className="h-3 w-3 text-primary" /> : <MessageSquare className="h-3 w-3 text-primary" />}{questionOutputLabel(outputMode)}</span>
                  </div>
                ) : null}

                <div className="mx-auto mt-3 flex max-w-full snap-x snap-mandatory items-center justify-start gap-3 overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:none] sm:justify-center [&::-webkit-scrollbar]:hidden">
                  <span className="shrink-0 text-[11px] font-semibold text-muted-foreground">试试</span>
                  {RESEARCH_STARTERS.map((starter) => (
                    <button
                      key={starter.label}
                      type="button"
                      onClick={() => handleStarterClick(starter)}
                      className="min-h-11 shrink-0 snap-start border-b border-border px-1 py-2 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                    >
                      {starter.label}
                    </button>
                  ))}
                </div>
              </div>
            </motion.article>
          </section>

          {projectsError ? (
            <div role="alert" className="mt-5 flex flex-col gap-3 border-y border-red-500/25 bg-red-500/[0.045] px-1 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div><strong className="text-red-700 dark:text-red-400">最近研究加载失败</strong><p className="mt-0.5 text-xs text-muted-foreground">{projectsError}。当前输入仍可正常使用。</p></div>
              <Button type="button" variant="outline" size="sm" onClick={() => void load()} className="min-h-11 gap-1.5 self-start sm:self-auto"><RefreshCcw className="h-3.5 w-3.5" />重试</Button>
            </div>
          ) : null}

          {recentResults.length > 0 ? (
            <motion.section
              id="recent-results"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.14, ease: "easeOut" }}
              className="mt-5"
            >
              <div className="flex items-end justify-between gap-3">
                <div><h2 className="text-lg font-bold tracking-tight">最近成果</h2><p className="mt-0.5 text-xs text-muted-foreground">直接查看已经完成的数据、证据与可视化结论。</p></div>
                <Button type="button" variant="ghost" size="sm" onClick={() => router.push("/research-reports")} className="min-h-11 gap-1 rounded-none border-b border-border px-1 text-xs">成果中心<ChevronRight className="h-3.5 w-3.5" /></Button>
              </div>
              <div className="mt-2 divide-y divide-border border-y border-border/70">{recentResults.map(renderProjectRow)}</div>
            </motion.section>
          ) : null}

          <motion.section
            id="recent-projects"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.18, ease: "easeOut" }}
            className="mt-5 sm:mt-6"
          >
            <div className="flex items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold tracking-tight">继续研究</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">草稿、运行中与需要处理的任务会优先出现在这里。</p>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => setTaskDrawerOpen(true)} className="min-h-11 gap-1 rounded-none border-b border-border px-1 text-xs">
                查看全部 {projects.length > 0 ? `(${projects.length})` : ""}<ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>

            {projectsLoading ? (
              <div role="status" aria-live="polite" aria-label="正在加载最近研究" className="mt-2 divide-y divide-border border-y border-border/70">
                {[0, 1, 2].map((item) => <div key={item} className="h-[4.75rem] animate-pulse bg-muted/35 motion-reduce:animate-none" />)}
              </div>
            ) : recentProjects.length > 0 ? (
              <div className="mt-2 divide-y divide-border border-y border-border/70">{recentProjects.map(renderProjectRow)}</div>
            ) : recentResults.length > 0 ? (
              <div className="mt-2 border-y border-dashed border-border py-5 text-center text-xs text-muted-foreground">当前没有待继续的研究，最近成果可直接查看。</div>
            ) : (
              <div className="mt-2 border-y border-dashed border-border py-6 text-center"><p className="text-sm font-semibold">从上面的示例开始第一项研究</p><p className="mt-1 text-xs text-muted-foreground">系统会保留问题、数据来源、分析过程和最终成果。</p></div>
            )}
          </motion.section>
        </div>
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-40 grid h-[calc(4rem+env(safe-area-inset-bottom))] grid-cols-4 border-t border-border/80 bg-background/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden" aria-label="移动端首页导航">
        <button type="button" aria-current="page" className="flex min-h-11 flex-col items-center justify-center gap-0.5 border-t-2 border-primary text-[10px] font-semibold text-primary"><Home className="h-4 w-4" />首页</button>
        <button type="button" onClick={() => setTaskDrawerOpen(true)} className="flex min-h-11 flex-col items-center justify-center gap-0.5 border-t-2 border-transparent text-[10px] font-semibold text-muted-foreground"><FolderKanban className="h-4 w-4" />项目</button>
        <button type="button" onClick={() => router.push("/research-reports")} className="flex min-h-11 flex-col items-center justify-center gap-0.5 border-t-2 border-transparent text-[10px] font-semibold text-muted-foreground"><FileChartColumn className="h-4 w-4" />成果</button>
        <button type="button" onClick={() => router.push("/account/usage")} className="flex min-h-11 flex-col items-center justify-center gap-0.5 border-t-2 border-transparent text-[10px] font-semibold text-muted-foreground"><UserRound className="h-4 w-4" />我的</button>
      </nav>

      {/* Task drawer */}
      <TaskDrawer
        open={taskDrawerOpen}
        onOpenChange={setTaskDrawerOpen}
        projects={projects}
        editingProject={editingProject}
        onEditProject={setEditingProject}
        onUpdateProject={updateProject}
        onOpenProject={openProject}
        onDeleteProject={openDeleteModal}
        formatTime={formatTime}
        formatCliInfo={formatCliInfo}
        getCapabilityShortName={getCapabilityShortName}
      />

      {/* Global settings */}
      <GlobalSettings
        isOpen={showGlobalSettings}
        onClose={() => setShowGlobalSettings(false)}
      />

      {/* Delete confirmation */}
      <AlertDialog
        open={deleteModal.isOpen && Boolean(deleteModal.project)}
        onOpenChange={(open) => {
          if (!open) closeDeleteModal();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除任务</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除 <strong>{deleteModal.project?.name}</strong>{" "}
              吗？该任务的项目文件与对话记录将被永久删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                deleteProject();
              }}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "删除中..." : "删除任务"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <div
            role={toast.type === "error" ? "alert" : "status"}
            aria-live={toast.type === "error" ? "assertive" : "polite"}
            className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-50 md:bottom-4"
          >
            <motion.div
              initial={{ opacity: 0, y: 50, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 50, scale: 0.9 }}
            >
              <div
                className={`flex max-w-sm items-center gap-3 rounded-lg border px-6 py-4 shadow-lg backdrop-blur-lg ${
                  toast.type === "success"
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-destructive/20 bg-destructive/10 text-destructive"
                }`}
              >
                {toast.type === "success" ? (
                  <CheckCircle2 className="h-5 w-5 shrink-0" />
                ) : (
                  <XCircle className="h-5 w-5 shrink-0" />
                )}
                <p className="text-sm font-medium">{toast.message}</p>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
