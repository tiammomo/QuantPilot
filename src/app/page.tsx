"use client";
import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  CircleAlert,
  CircleCheckBig,
  CircleDashed,
  FolderKanban,
  Home,
  LayoutGrid,
  Settings,
  XCircle,
  Sparkles,
  ChevronRight,
  UserRound,
  Users,
} from "lucide-react";
import GlobalSettings from "@/components/settings/GlobalSettings";
import { useGlobalSettings } from "@/contexts/GlobalSettingsContext";
import { getDefaultModelForCli, getModelDisplayName } from "@/lib/constants/cliModels";
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
import { TaskDrawer } from "@/components/task/TaskDrawer";
import { CreateTaskForm } from "@/components/task/CreateTaskForm";
import type { UploadedImage } from "@/components/task/CreateTaskForm";
import { useAuth } from "@/contexts/AuthContext";
import type { Project as ProjectSummary } from "@/types/project";
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
} from "@/lib/quant/capabilities";
import { cn } from "@/lib/utils";
import homeAnimeResearcher from "@/assets/home-anime-quant-researcher-v3.webp";
import homeAnimeResearcherAvatar from "@/assets/home-anime-quant-researcher-avatar-v1.webp";

const fetchAPI = globalThis.fetch || fetch;
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

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
        project?.preferredCli ?? project?.preferred_cli
      );
      const selected = normalizeModelForAssistant(
        preferred,
        project?.selectedModel ?? project?.selected_model
      );
      return {
        id: project.id,
        name: project.name,
        description: project.description ?? null,
        status: project.status,
        previewUrl: project.previewUrl ?? project.preview_url ?? null,
        createdAt:
          project.createdAt ?? project.created_at ?? new Date().toISOString(),
        updatedAt: project.updatedAt ?? project.updated_at,
        lastActiveAt: project.lastActiveAt ?? project.last_active_at ?? null,
        lastMessageAt:
          project.lastMessageAt ?? project.last_message_at ?? null,
        initialPrompt: project.initialPrompt ?? project.initial_prompt ?? null,
        services: project.services,
        preferredCli: preferred as ProjectSummary["preferredCli"],
        selectedModel: selected,
        fallbackEnabled:
          project.fallbackEnabled ?? project.fallback_enabled ?? false,
        quantCapabilityId: getQuantCapability(
          project.quantCapabilityId ?? project.quant_capability_id
        ).id,
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
  const recentProjects = projects.slice(0, 3);
  const readyCapabilities = QUANT_CAPABILITIES.filter((capability) => capability.status === "ready");
  const accountName = user?.name || user?.email || "研究员";
  const accountInitial = accountName.slice(0, 1).toUpperCase();

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
        setProjects([]);
        return;
      }
      const payload = await r.json();
      if (payload?.success === false) {
        setProjects([]);
        return;
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
    } catch {
      setProjects([]);
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
    const params = new URLSearchParams();
    if (selectedAssistant) params.set("cli", selectedAssistant);
    if (selectedModel) params.set("model", selectedModel);
    router.push(
      `/${project.id}/chat${params.toString() ? "?" + params.toString() : ""}`
    );
  };

  const handleSubmit = async () => {
    if ((!prompt.trim() && uploadedImages.length === 0) || isCreatingProject)
      return;
    setIsCreatingProject(true);
    const projectId = `project-${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 9)}`;

    try {
      const r = await fetchAPI(`${API_BASE}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          name: prompt.slice(0, 50) + (prompt.length > 50 ? "..." : ""),
          initialPrompt: prompt.trim(),
          preferredCli: selectedAssistant,
          selectedModel,
          quantCapabilityId: selectedCapability,
          quantCapabilitySource: "default",
        }),
      });
      if (!r.ok) {
        showToast("创建任务失败", "error");
        setIsCreatingProject(false);
        return;
      }
      const payload = await r.json();
      const projectData =
        payload && typeof payload === "object" ? payload.data ?? payload : payload;
      const createdProjectId: string | undefined = projectData?.id ?? projectId;

      // Upload images
      let imageData: any[] = [];
      if (uploadedImages.length > 0) {
        for (const image of uploadedImages) {
          if (!image.file) continue;
          const fd = new FormData();
          fd.append("file", image.file);
          const uploadR = await fetchAPI(
            `${API_BASE}/api/assets/${createdProjectId}/upload`,
            { method: "POST", body: fd }
          );
          if (uploadR.ok) {
            const result = await uploadR.json();
            imageData.push({
              name: result.filename || image.name,
              path: result.path,
              public_url:
                typeof result.public_url === "string"
                  ? result.public_url
                  : undefined,
            });
          }
        }
      }

      // Fire initial prompt
      if (prompt.trim()) {
        await fetchAPI(`${API_BASE}/api/chat/${createdProjectId}/act`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instruction: prompt.trim(),
            images: imageData,
            isInitialPrompt: true,
            cliPreference: selectedAssistant,
            selectedModel,
            quantCapabilityId: selectedCapability,
            quantCapabilitySource: "default",
          }),
        }).catch(() => null);
      }

      // Cleanup and navigate
      uploadedImages.forEach((img) => {
        if (img.url) URL.revokeObjectURL(img.url);
      });
      setUploadedImages([]);
      setPrompt("");
      const params = new URLSearchParams();
      if (selectedAssistant) params.set("cli", selectedAssistant);
      if (selectedModel) params.set("model", selectedModel);
      router.push(
        `/${createdProjectId}/chat${params.toString() ? "?" + params.toString() : ""}`
      );
    } catch {
      showToast("创建任务失败", "error");
    } finally {
      setIsCreatingProject(false);
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
    const cap = QUANT_CAPABILITIES.find((c) => c.id === capabilityId);
    if (cap && !prompt.trim()) {
      setPrompt(cap.inputHint);
    }
    document.getElementById("task-input")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const handleStarterClick = (starter: (typeof RESEARCH_STARTERS)[number]) => {
    setSelectedCapability(starter.capabilityId);
    setPrompt(starter.prompt);
    document.getElementById("task-input")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  // --- Render ---
  return (
    <div className="home-shell relative flex min-h-screen flex-col overflow-x-clip bg-background text-foreground">
      <header className="platform-header sticky top-0 z-40 flex h-16 shrink-0 items-center justify-between px-3 md:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#ee6b4d] to-[#d84d35] text-sm font-bold text-white shadow-[0_8px_20px_-10px_rgba(224,83,57,0.8)]">Q</div>
          <h1 className="text-base font-bold tracking-tight sm:text-lg">QuantPilot</h1>

          <nav className="ml-4 hidden items-center gap-1 md:flex" aria-label="首页导航">
            <Button type="button" variant="ghost" size="sm" className="h-10 gap-2 rounded-none border-b-2 border-primary px-3 text-xs font-semibold text-foreground">
              <Home className="h-3.5 w-3.5" />首页
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setTaskDrawerOpen(true)} className="h-10 gap-2 rounded-none px-3 text-xs font-semibold text-muted-foreground">
              <FolderKanban className="h-3.5 w-3.5" />项目
              {projects.length > 0 ? <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">{projects.length}</span> : null}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => router.push("/skills")} className="h-10 gap-2 rounded-none px-3 text-xs font-semibold text-muted-foreground">
              <LayoutGrid className="h-3.5 w-3.5" />能力中心
            </Button>
            <PlatformSwitcher />
          </nav>
        </div>

        <div className="flex items-center gap-1.5">
          <div className="md:hidden"><PlatformSwitcher /></div>
          <ThemeToggle compact />
          <Button type="button" onClick={() => setShowGlobalSettings(true)} variant="ghost" size="icon" className="hidden h-9 w-9 rounded-none sm:inline-flex" aria-label="全局设置">
            <Settings className="h-4 w-4" />
          </Button>
          {user?.role === "admin" ? (
            <Button type="button" onClick={() => router.push("/admin/users")} variant="ghost" size="icon" className="hidden h-9 w-9 rounded-none lg:inline-flex" aria-label="用户管理">
              <Users className="h-4 w-4" />
            </Button>
          ) : null}
          <Button type="button" onClick={() => router.push("/account/usage")} variant="ghost" className="hidden h-9 gap-2 rounded-none px-2.5 sm:inline-flex" aria-label="打开我的账号">
            <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-primary text-[10px] font-bold text-primary-foreground">{accountInitial || <UserRound className="h-3.5 w-3.5" />}</span>
            <span className="max-w-24 truncate text-xs font-semibold">{accountName}</span>
          </Button>
        </div>
      </header>

      <main className="platform-content flex-1 px-4 pb-28 pt-4 md:px-6 md:pb-16 md:pt-5">
        <div className="mx-auto w-full max-w-[90rem]">
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="flex flex-col gap-3 border-b border-border/60 pb-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.08em] text-primary">
                <Sparkles className="h-3.5 w-3.5" />量化研究工作台
              </div>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <h2 className="text-xl font-bold tracking-[-0.03em] sm:text-2xl">{greeting}，{accountName}</h2>
                <p className="text-xs leading-5 text-muted-foreground sm:text-sm">从问题出发，在同一工作区完成取数、分析与可视化。</p>
              </div>
            </div>
            <div className="flex w-full items-center justify-between border-y border-border/60 py-2 text-[11px] text-muted-foreground sm:w-auto sm:justify-start sm:border-y-0 sm:py-0">
              <button type="button" onClick={() => setTaskDrawerOpen(true)} className="group inline-flex items-baseline gap-1 px-2 transition-colors hover:text-foreground sm:px-3">
                <strong className="text-base text-foreground group-hover:text-primary">{projects.length}</strong>项研究
              </button>
              <span aria-hidden="true" className="h-5 w-px bg-border" />
              <span className="inline-flex items-baseline gap-1 px-2 sm:px-3"><strong className="text-base text-amber-600">{runningProjects}</strong>运行中</span>
              <span aria-hidden="true" className="h-5 w-px bg-border" />
              <span className="inline-flex items-baseline gap-1 px-2 sm:px-3"><strong className="text-base text-emerald-600">{readyProjects}</strong>看板就绪</span>
            </div>
          </motion.section>

          <section className="mt-2 sm:mt-4">
            <motion.article
              id="task-input"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: 0.08, ease: "easeOut" }}
              className="relative isolate overflow-hidden border-b border-border/55 py-4 sm:py-6"
            >
              <div className="pointer-events-none absolute inset-0 -z-20 bg-[linear-gradient(135deg,hsl(var(--background)),hsl(var(--primary)/0.045)_52%,hsl(var(--background)))]" />
              <div className="pointer-events-none absolute left-1/2 top-0 -z-10 h-52 w-[52rem] max-w-[92vw] -translate-x-1/2 rounded-full bg-primary/[0.08] blur-3xl" />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute right-1 top-0 hidden h-32 w-80 overflow-hidden xl:block dark:hidden"
              >
                <Image
                  src={homeAnimeResearcher}
                  alt=""
                  fill
                  sizes="320px"
                  className="object-cover object-[50%_25%] saturate-[1.04] [mask-image:radial-gradient(ellipse_at_66%_44%,black_32%,transparent_76%)]"
                />
                <div className="absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background to-transparent" />
              </div>

              <div className="relative z-10">
                <div className="relative text-center">
                  <h3 className="text-[1.7rem] font-bold tracking-[-0.035em] sm:text-3xl">今天想研究什么？</h3>
                  <p className="mx-auto mt-1 max-w-2xl text-xs leading-5 text-muted-foreground sm:text-sm">
                    <span className="sm:hidden">说清标的、时间和目标。</span>
                    <span className="hidden sm:inline">说清标的、时间和目标，系统会自动补全取数、证据与验证步骤。</span>
                  </p>
                  <div aria-hidden="true" className="absolute right-0 -top-2 h-14 w-14 overflow-hidden sm:hidden dark:hidden [mask-image:radial-gradient(circle,black_50%,transparent_74%)]">
                    <Image src={homeAnimeResearcherAvatar} alt="" fill sizes="64px" className="object-cover" />
                  </div>
                </div>

                <div className="mt-3 flex justify-start gap-4 overflow-x-auto pb-0.5 sm:justify-center [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {readyCapabilities.slice(0, 4).map((capability) => (
                    <button
                      key={capability.id}
                      type="button"
                      aria-pressed={selectedCapability === capability.id}
                      onClick={() => handleCapabilityCardClick(capability.id)}
                      className={cn(
                        "shrink-0 border-b-2 px-1 py-1.5 text-xs font-semibold transition-colors",
                        selectedCapability === capability.id
                          ? "border-primary text-primary"
                          : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
                      )}
                    >
                      {capability.name}
                    </button>
                  ))}
                </div>

                <div className="mx-auto mt-2 w-full max-w-[76rem]">
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
                  />
                </div>

                <div className="mt-3 hidden items-center justify-center gap-3 overflow-x-auto pb-1 sm:flex [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  <span className="shrink-0 text-[11px] font-semibold text-muted-foreground">试试</span>
                  {RESEARCH_STARTERS.map((starter) => (
                    <button
                      key={starter.label}
                      type="button"
                      onClick={() => handleStarterClick(starter)}
                      className="shrink-0 border-b border-border px-0.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                    >
                      {starter.label}
                    </button>
                  ))}
                </div>
              </div>
            </motion.article>
          </section>

          <motion.section
            id="recent-projects"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.18, ease: "easeOut" }}
            className="mt-4 sm:mt-5"
          >
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-lg font-bold tracking-tight">最近研究</p>
                <p className="mt-0.5 text-xs text-muted-foreground">回到最近的分析上下文。</p>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => setTaskDrawerOpen(true)} className="h-8 gap-1 rounded-none border-b border-border px-1 text-xs">
                查看全部 {projects.length > 0 ? `(${projects.length})` : ""}<ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>

            {projectsLoading ? (
              <div className="mt-3 divide-y divide-border border-y border-border/70">
                {[0, 1, 2].map((item) => <div key={item} className="h-16 animate-pulse bg-muted/35" />)}
              </div>
            ) : recentProjects.length > 0 ? (
              <div className="mt-3 divide-y divide-border border-y border-border/70">
                {recentProjects.map((project, index) => {
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
                      className="group grid w-full grid-cols-[2rem_minmax(0,1fr)_auto_1rem] items-center gap-3 py-3.5 text-left transition-colors hover:bg-muted/25 md:grid-cols-[2.5rem_minmax(0,1fr)_6.5rem_7.5rem_6rem_1.25rem] md:gap-4"
                    >
                      <span className="font-mono text-[11px] text-muted-foreground/60">{String(index + 1).padStart(2, "0")}</span>
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-bold transition-colors group-hover:text-primary">{title}</h3>
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{detail}</p>
                      </div>
                      <span className="hidden text-[11px] font-semibold text-muted-foreground md:block">{getCapabilityShortName(project.quantCapabilityId)}</span>
                      <span className={cn(
                        "inline-flex items-center justify-end gap-1 whitespace-nowrap text-[10px] font-semibold md:justify-start md:text-[11px]",
                        status.tone === "amber" && "text-amber-600",
                        status.tone === "red" && "text-red-600",
                        status.tone === "green" && "text-emerald-600",
                        status.tone === "slate" && "text-muted-foreground",
                      )}>
                        <StatusIcon className="h-3 w-3" />{status.label}
                      </span>
                      <span className="hidden text-[11px] text-muted-foreground md:block">{formatTime(project.lastMessageAt || project.createdAt)}</span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-primary" />
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="mt-3 border-y border-dashed border-border py-7 text-center text-sm text-muted-foreground">创建第一个任务后，最近研究会出现在这里。</div>
            )}
          </motion.section>
        </div>
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-40 grid h-16 grid-cols-4 border-t border-border/80 bg-background/95 px-2 backdrop-blur-xl md:hidden" aria-label="移动端首页导航">
        <button type="button" aria-current="page" className="flex flex-col items-center justify-center gap-0.5 border-t-2 border-primary text-[10px] font-semibold text-primary"><Home className="h-4 w-4" />首页</button>
        <button type="button" onClick={() => setTaskDrawerOpen(true)} className="flex flex-col items-center justify-center gap-0.5 border-t-2 border-transparent text-[10px] font-semibold text-muted-foreground"><FolderKanban className="h-4 w-4" />项目</button>
        <button type="button" onClick={() => router.push("/skills")} className="flex flex-col items-center justify-center gap-0.5 border-t-2 border-transparent text-[10px] font-semibold text-muted-foreground"><LayoutGrid className="h-4 w-4" />能力</button>
        <button type="button" onClick={() => router.push("/account/usage")} className="flex flex-col items-center justify-center gap-0.5 border-t-2 border-transparent text-[10px] font-semibold text-muted-foreground"><UserRound className="h-4 w-4" />我的</button>
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
          <div className="fixed bottom-4 right-4 z-50">
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
