"use client";
import { useEffect, useState, useRef, useCallback, useTransition } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  BriefcaseBusiness,
  CheckCircle2,
  Clock3,
  Gauge,
  Settings,
  ShieldCheck,
  TrendingUp,
  XCircle,
  Sparkles,
  ChevronRight,
  Activity,
  Search,
  BarChart2,
  PieChart,
  Layers,
  Target,
  Zap,
  Loader2,
  Newspaper,
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
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { TaskDrawer } from "@/components/task/TaskDrawer";
import { CreateTaskForm } from "@/components/task/CreateTaskForm";
import type { UploadedImage } from "@/components/task/CreateTaskForm";
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
  QUANT_CAPABILITY_GROUPS,
  type QuantCapabilityId,
} from "@/lib/quant/capabilities";
import { cn } from "@/lib/utils";

const fetchAPI = globalThis.fetch || fetch;
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

const ASSISTANT_OPTIONS = ACTIVE_CLI_OPTIONS.map(({ id, name }) => ({ id, name }));

const CAPABILITY_ICONS: Record<string, React.ReactNode> = {
  stock_diagnosis: <Activity className="h-5 w-5" />,
  technical_analysis: <TrendingUp className="h-5 w-5" />,
  fundamental_analysis: <BarChart2 className="h-5 w-5" />,
  asset_comparison: <Search className="h-5 w-5" />,
  sector_rotation: <PieChart className="h-5 w-5" />,
  strategy_research: <Layers className="h-5 w-5" />,
  backtest_review: <Target className="h-5 w-5" />,
  portfolio_risk: <Zap className="h-5 w-5" />,
};

const CAPABILITY_COLORS: Record<string, string> = {
  stock_diagnosis: "from-blue-500/10 to-blue-600/5 border-blue-200/60 hover:border-blue-300",
  technical_analysis: "from-emerald-500/10 to-emerald-600/5 border-emerald-200/60 hover:border-emerald-300",
  fundamental_analysis: "from-violet-500/10 to-violet-600/5 border-violet-200/60 hover:border-violet-300",
  asset_comparison: "from-amber-500/10 to-amber-600/5 border-amber-200/60 hover:border-amber-300",
  sector_rotation: "from-rose-500/10 to-rose-600/5 border-rose-200/60 hover:border-rose-300",
  strategy_research: "from-cyan-500/10 to-cyan-600/5 border-cyan-200/60 hover:border-cyan-300",
  backtest_review: "from-orange-500/10 to-orange-600/5 border-orange-200/60 hover:border-orange-300",
  portfolio_risk: "from-indigo-500/10 to-indigo-600/5 border-indigo-200/60 hover:border-indigo-300",
};

const CAPABILITY_ICON_COLORS: Record<string, string> = {
  stock_diagnosis: "text-blue-600 bg-blue-100",
  technical_analysis: "text-emerald-600 bg-emerald-100",
  fundamental_analysis: "text-violet-600 bg-violet-100",
  asset_comparison: "text-amber-600 bg-amber-100",
  sector_rotation: "text-rose-600 bg-rose-100",
  strategy_research: "text-cyan-600 bg-cyan-100",
  backtest_review: "text-orange-600 bg-orange-100",
  portfolio_risk: "text-indigo-600 bg-indigo-100",
};

const PLATFORM_NAV_ITEMS = [
  { href: "/strategy-platform", label: "策略", icon: BarChart3 },
  { href: "/research-reports", label: "投研", icon: Newspaper },
  { href: "/ops-platform", label: "治理", icon: ShieldCheck },
  { href: "/business-knowledge", label: "业务", icon: BriefcaseBusiness },
  { href: "/eval-platform", label: "评测", icon: Gauge },
];

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
  const [navigatingPath, setNavigatingPath] = useState<string | null>(null);
  const [isRoutePending, startRouteTransition] = useTransition();

  const router = useRouter();
  const pathname = usePathname();
  const prefetchTimers = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const { settings: globalSettings } = useGlobalSettings();

  const availableModels =
    ACTIVE_CLI_MODEL_OPTIONS[selectedAssistant] || [];
  const selectedModelLabel =
    availableModels.find((m) => m.id === selectedModel)?.name ??
    getModelDisplayName(selectedAssistant, selectedModel);
  const selectedRoleModule =
    QUANT_CAPABILITIES.find((c) => c.id === selectedCapability) ??
    QUANT_CAPABILITIES[0];
  const runningProjects = projects.filter(
    (p) => p.previewUrl || p.status === "running"
  ).length;

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
    }
  }, [normalizeProjectPayload]);

  useEffect(() => {
    load();
    const timers = prefetchTimers.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, [load]);

  useEffect(() => {
    for (const item of PLATFORM_NAV_ITEMS) {
      router.prefetch(item.href);
    }
  }, [router]);

  useEffect(() => {
    setNavigatingPath(null);
  }, [pathname]);

  const prefetchPlatformRoute = useCallback((href: string) => {
    const timers = prefetchTimers.current;
    if (timers.has(href)) return;
    const timer = setTimeout(() => {
      router.prefetch(href);
      timers.delete(href);
    }, 80);
    timers.set(href, timer);
  }, [router]);

  const navigateToPlatform = useCallback((href: string) => {
    if (navigatingPath === href) return;
    setNavigatingPath(href);
    startRouteTransition(() => {
      router.push(href);
    });
  }, [navigatingPath, router]);

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
    const name = opt?.name ?? "DeepSeek Agent";
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
              path: result.absolute_path,
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
    if (cap) {
      setPrompt(cap.inputHint);
    }
    // Scroll to input
    document.getElementById("task-input")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  // --- Group capabilities ---
  const groupedCapabilities = QUANT_CAPABILITY_GROUPS.map((group) => ({
    ...group,
    capabilities: QUANT_CAPABILITIES.filter((c) => c.groupId === group.id),
  }));
  const navigatingItem = PLATFORM_NAV_ITEMS.find((item) => item.href === navigatingPath) ?? null;

  // --- Render ---
  return (
    <div className="home-shell relative flex min-h-screen flex-col overflow-x-clip bg-background text-foreground">
      {/* Top navigation */}
      <header className="platform-header sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between px-3 md:px-6">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground shadow-sm">
            Q
          </div>
          <h1 className="text-base font-bold tracking-tight md:text-lg">
            QuantPilot
          </h1>
          <div className="hidden items-center gap-1.5 md:flex">
            <span className="text-xs text-muted-foreground">·</span>
            <span className="text-xs text-muted-foreground">
              {selectedModelLabel}
            </span>
          </div>
          <div className="mx-1 hidden h-4 w-px bg-border sm:block" />
          <Button
            type="button"
            onClick={() => setTaskDrawerOpen(true)}
            variant="ghost"
            size="sm"
            className="gap-1.5 px-2 text-xs sm:px-3"
          >
            <Clock3 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">最近任务</span>
            {projects.length > 0 && (
              <Badge variant="secondary" className="ml-0.5 h-5 px-1.5 text-[10px]">
                {projects.length}
              </Badge>
            )}
          </Button>
        </div>

        <div className="flex items-center gap-1.5">
          {PLATFORM_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isLoading = navigatingPath === item.href || (isRoutePending && navigatingPath === item.href);
            return (
              <Button
                key={item.href}
                type="button"
                onClick={() => navigateToPlatform(item.href)}
                onPointerEnter={() => prefetchPlatformRoute(item.href)}
                onFocus={() => prefetchPlatformRoute(item.href)}
                variant="ghost"
                size="sm"
                aria-busy={isLoading}
                className="gap-1.5 px-2 text-xs sm:px-3"
              >
                {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
                <span className="hidden sm:inline">{item.label}</span>
              </Button>
            );
          })}

          <div className="mx-1 hidden h-4 w-px bg-border sm:block" />

          <ThemeToggle compact className="sm:hidden" />
          <ThemeToggle className="hidden sm:inline-flex" />

          <Button
            type="button"
            onClick={() => setShowGlobalSettings(true)}
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="设置"
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <AnimatePresence>
        {navigatingItem && (
          <motion.div
            key={navigatingItem.href}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="fixed left-0 right-0 top-14 z-40 border-b border-primary/10 bg-background/90 px-4 py-2 shadow-sm backdrop-blur"
          >
            <div className="mx-auto flex max-w-6xl items-center gap-2 text-xs font-medium text-muted-foreground">
              <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-primary/10">
                <motion.span
                  className="absolute inset-y-0 left-0 rounded-full bg-primary"
                  initial={{ width: "18%" }}
                  animate={{ width: "82%" }}
                  transition={{ duration: 1.1, ease: "easeOut" }}
                />
              </span>
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              正在进入{navigatingItem.label}平台
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main content */}
      <main className="platform-content flex flex-1 flex-col items-center px-4 pb-16 pt-12 md:pb-24 md:pt-20">
        {/* Hero */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="mb-10 text-center md:mb-14"
        >
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border bg-muted/50 px-3 py-1 text-xs text-muted-foreground">
            <Sparkles className="h-3 w-3 text-primary" />
            AI 驱动的量化金融分析平台
          </div>
          <h2 className="text-3xl font-bold tracking-tight md:text-5xl lg:text-6xl">
            <span className="bg-gradient-to-r from-primary via-primary/80 to-primary/60 bg-clip-text text-transparent">
              量化分析
            </span>
            ，一句话搞定
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-sm text-muted-foreground md:text-base">
            描述你的金融分析需求，系统自动识别任务类型，获取真实数据，生成可验证的量化看板
          </p>
        </motion.div>

        {/* Input form */}
        <motion.div
          id="task-input"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1, ease: "easeOut" }}
          className="w-full max-w-3xl"
        >
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
        </motion.div>

        {/* Capability cards */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.25, ease: "easeOut" }}
          className="mt-14 w-full max-w-5xl md:mt-20"
        >
          {groupedCapabilities.map((group) => (
            <div key={group.id} className="mb-8 last:mb-0">
              <div className="mb-3 flex items-center gap-2">
                <h3 className="text-sm font-semibold text-foreground">
                  {group.name}
                </h3>
                <span className="text-xs text-muted-foreground">
                  {group.description}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {group.capabilities.map((cap) => {
                  const isActive = selectedCapability === cap.id;
                  const isPlanned = cap.status === "planned";
                  return (
                    <button
                      key={cap.id}
                      type="button"
                      onClick={() => !isPlanned && handleCapabilityCardClick(cap.id)}
                      disabled={isPlanned}
                      className={cn(
                        "group relative flex flex-col items-start gap-2.5 rounded-xl border bg-gradient-to-br p-4 text-left shadow-[0_12px_28px_-24px_hsl(var(--foreground)/0.35)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_18px_36px_-22px_hsl(var(--foreground)/0.32)]",
                        CAPABILITY_COLORS[cap.id],
                        isActive && "ring-2 ring-primary/30",
                        isPlanned && "opacity-60 cursor-not-allowed"
                      )}
                    >
                      <div className="flex items-center gap-2.5">
                        <div
                          className={cn(
                            "flex h-9 w-9 items-center justify-center rounded-lg",
                            CAPABILITY_ICON_COLORS[cap.id]
                          )}
                        >
                          {CAPABILITY_ICONS[cap.id]}
                        </div>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-semibold">
                              {cap.name}
                            </span>
                            {isPlanned && (
                              <Badge
                                variant="secondary"
                                className="h-4 px-1 text-[10px]"
                              >
                                规划中
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {cap.description}
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {cap.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </motion.div>
      </main>

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
