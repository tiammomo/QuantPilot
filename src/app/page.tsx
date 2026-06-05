"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import {
  Boxes,
  CheckCircle2,
  Clock3,
  Compass,
  MapPin,
  Menu,
  ShieldCheck,
  Sparkles,
  XCircle,
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
import { Sidebar, ROLE_MODULES } from "@/components/layout/Sidebar";
import { TaskDrawer } from "@/components/task/TaskDrawer";
import { CreateTaskForm } from "@/components/task/CreateTaskForm";
import type { UploadedImage } from "@/components/task/CreateTaskForm";
import type { Project as ProjectSummary } from "@/types/project";
import { fetchCliStatusSnapshot, createCliStatusFallback } from "@/hooks/useCLI";
import type { CLIStatus } from "@/types/cli";
import {
  ACTIVE_CLI_BRAND_COLORS,
  ACTIVE_CLI_MODEL_OPTIONS,
  ACTIVE_CLI_OPTIONS,
  ACTIVE_CLI_OPTIONS_MAP,
  DEFAULT_ACTIVE_CLI,
  normalizeModelForCli,
  sanitizeActiveCli,
  type ActiveCliId,
} from "@/lib/utils/cliOptions";
import {
  DEFAULT_TRAVEL_CAPABILITY_ID,
  getTravelCapability,
  type TravelCapabilityId,
} from "@/lib/travel/capabilities";

const fetchAPI = globalThis.fetch || fetch;
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

const ASSISTANT_OPTIONS = ACTIVE_CLI_OPTIONS.map(({ id, name }) => ({ id, name }));
const assistantBrandColors = ACTIVE_CLI_BRAND_COLORS;
const MODEL_OPTIONS_BY_ASSISTANT = ACTIVE_CLI_MODEL_OPTIONS;

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
        travelCapabilityId: getTravelCapability(
          project.travelCapabilityId ?? project.travel_capability_id
        ).id,
      };
    },
    [sanitizeAssistant, normalizeModelForAssistant]
  );

  const [selectedAssistant, setSelectedAssistant] =
    useState<ActiveCliId>(DEFAULT_ASSISTANT);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  const [selectedCapability, setSelectedCapability] =
    useState<TravelCapabilityId>(DEFAULT_TRAVEL_CAPABILITY_ID);
  const [usingGlobalDefaults, setUsingGlobalDefaults] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  const [cliStatus, setCLIStatus] = useState<CLIStatus>(() =>
    createCliStatusFallback()
  );
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [uploadedImages, setUploadedImages] = useState<UploadedImage[]>([]);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [homeInputMode, setHomeInputMode] = useState<"chat" | "form">("form");
  const [tripForm, setTripForm] = useState({
    area: "前门",
    duration: "4小时",
    budget: "200",
    persona: "朋友/情侣",
    meal: "中午吃饭",
    preferences: ["少走路", "不想排队"],
  });

  const router = useRouter();
  const prefetchTimers = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const { settings: globalSettings } = useGlobalSettings();

  const availableModels =
    MODEL_OPTIONS_BY_ASSISTANT[selectedAssistant] || [];
  const selectedModelLabel =
    availableModels.find((m) => m.id === selectedModel)?.name ??
    getModelDisplayName(selectedAssistant, selectedModel);
  const selectedRoleModule =
    ROLE_MODULES.find((r) => r.capabilityId === selectedCapability) ??
    ROLE_MODULES[0];
  const runningProjects = projects.filter(
    (p) => p.previewUrl || p.status === "running"
  ).length;
  const isNightMode = false;
  const homeTheme = {
    header: isNightMode
      ? "border-[#3a261d] bg-[#120b08]/92 text-[#fff7ea]"
      : "border-[#ead8c3] bg-[#fffaf2]/95 text-[#24140f]",
    headerTitle: isNightMode ? "text-[#fff7ea]" : "text-[#24140f]",
    headerMeta: isNightMode ? "text-[#f6d8b6]/80" : "text-muted-foreground",
    main: isNightMode
      ? "bg-[#120b08]"
      : "bg-[#f7efe3]",
    heroCard: isNightMode
      ? "border-[#f3c178]/28 bg-[#fff8ec]/96 shadow-[0_36px_120px_rgba(0,0,0,0.58)]"
      : "border-[#e0c39d] bg-[#fffdf8]/96 shadow-[0_32px_90px_rgba(123,77,35,0.18)]",
    eyebrow: isNightMode
      ? "border-[#f0c06f] bg-[#28150f] text-[#ffe8bd]"
      : "border-[#d9b27d] bg-[#fff2dc] text-[#8d2e1d]",
    title: "text-[#24140f]",
    subtitle: "text-[#3c2a20]",
    chip: isNightMode
      ? "border-[#e9c48b] bg-[#fffaf2] text-[#3b261a]"
      : "border-[#e3ccb2] bg-white text-[#4e3729]",
    card: isNightMode
      ? "border-[#e9c48b] bg-[#fffaf2] text-[#3b261a]"
      : "border-[#e3ccb2] bg-white text-[#4e3729]",
    recentButton: isNightMode
      ? "border-[#e9c48b] bg-[#fffaf2] text-[#3b261a] hover:border-[#b73522]/50 hover:bg-[#fff4e6] hover:text-[#b73522]"
      : "border-[#e3ccb2] bg-white text-[#4e3729] hover:border-[#b73522]/40 hover:bg-[#fff4e6] hover:text-[#b73522]",
    inputWrap: isNightMode
      ? "border-[#f2bf72] bg-[#6f2418] shadow-[0_28px_90px_rgba(111,36,24,0.36)]"
      : "border-[#c99863] bg-[#b73522] shadow-[0_28px_80px_rgba(141,46,29,0.22)]",
  };
  const planningModes = ["自由对话", "约束规划", "多轮重排", "本地证据"];
  const areaOptions = [
    "前门",
    "故宫",
    "天安门",
    "王府井",
    "什刹海",
    "北海",
    "南锣鼓巷",
    "雍和宫",
    "颐和园",
    "奥林匹克公园",
    "三里屯",
    "798",
  ];
  const quickPrompts = [
    "前门附近玩4小时，中午吃饭，预算200以内，少走路",
    "故宫附近安排4小时文化路线，少走路，不吃饭",
    "带老人去北海附近玩4小时，中午安排吃饭",
    "情侣在故宫附近玩4小时，想浪漫一点",
  ];
  const trustBadges = [
    { value: "本地 POI", label: "不依赖外部地图 API" },
    { value: "UGC 证据", label: "排队/性价比/环境可解释" },
    { value: "6 Agent", label: "意图、检索、证据、规划、校验" },
    { value: "多轮调整", label: "新增、删除、替换地点" },
  ];
  const featureCards = [
    {
      title: "一句话生成路线",
      text: "输入区域、时长、预算和偏好，自动串联多个北京 POI。",
    },
    {
      title: "像聊天一样重规划",
      text: "支持保留原路线，只局部新增、删除或替换目标地点。",
    },
    {
      title: "证据驱动推荐",
      text: "展示 UGC 排队、性价比、餐饮适配和风险提示。",
    },
  ];

  const toggleTripPreference = (preference: string) => {
    setTripForm((current) => ({
      ...current,
      preferences: current.preferences.includes(preference)
        ? current.preferences.filter((item) => item !== preference)
        : [...current.preferences, preference],
    }));
  };

  const buildTripFormPrompt = () => {
    const preferenceText =
      tripForm.preferences.length > 0
        ? `，偏好${tripForm.preferences.join("、")}`
        : "";
    return `${tripForm.area || "北京"}附近游玩${tripForm.duration || "4小时"}，${tripForm.meal}，预算${tripForm.budget || "200"}以内，同行人群${tripForm.persona}${preferenceText}`;
  };

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
    const name = opt?.name ?? "Claude Code";
    const modelId = normalizeModelForAssistant(normalizedCli, model);
    const label = getModelDisplayName(normalizedCli, modelId);
    return `${name} · ${label}`;
  };

  const getCapabilityShortName = (capabilityId?: string | null) =>
    getTravelCapability(capabilityId).shortName;

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

  const handleSubmit = async (promptOverride?: string) => {
    const promptToSubmit = (promptOverride ?? prompt).trim();
    if ((!promptToSubmit && uploadedImages.length === 0) || isCreatingProject)
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
          name: promptToSubmit.slice(0, 50) + (promptToSubmit.length > 50 ? "..." : ""),
          initialPrompt: promptToSubmit,
          preferredCli: selectedAssistant,
          selectedModel,
          travelCapabilityId: selectedCapability,
        }),
      });
      if (!r.ok) {
        showToast("Failed to create project", "error");
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
      if (promptToSubmit) {
        await fetchAPI(`${API_BASE}/api/chat/${createdProjectId}/act`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instruction: promptToSubmit,
            images: imageData,
            isInitialPrompt: true,
            cliPreference: selectedAssistant,
            selectedModel,
            travelCapabilityId: selectedCapability,
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
      showToast("Failed to create project", "error");
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

  // --- Render ---
  return (
    <div className="relative flex h-screen overflow-hidden bg-background text-foreground">
      <div className="relative z-10 flex h-full w-full">
        {/* Desktop sidebar */}
        <div className="hidden lg:block">
          <Sidebar
            selectedCapability={selectedCapability}
            onSelectCapability={setSelectedCapability}
            onOpenTaskDrawer={() => setTaskDrawerOpen(true)}
            onShowSettings={() => setShowGlobalSettings(true)}
          />
        </div>

        {/* Mobile sidebar overlay */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/20 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          >
            <div className="h-full" onClick={(e) => e.stopPropagation()}>
              <Sidebar
                selectedCapability={selectedCapability}
                onSelectCapability={setSelectedCapability}
                onOpenTaskDrawer={() => setTaskDrawerOpen(true)}
                onShowSettings={() => setShowGlobalSettings(true)}
                isMobile
                onCloseMobile={() => setSidebarOpen(false)}
              />
            </div>
          </div>
        )}

        {/* Main content */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Top bar */}
          <header className={`flex h-16 shrink-0 items-center justify-between border-b px-4 backdrop-blur md:px-6 ${homeTheme.header}`}>
            <div className="flex min-w-0 items-center gap-3">
              <Button
                type="button"
                onClick={() => setSidebarOpen(true)}
                size="icon"
                variant="ghost"
                className="lg:hidden"
                aria-label="打开任务记录"
              >
                <Menu className="h-5 w-5" />
              </Button>
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#b73522] text-base font-black text-white shadow-[0_10px_24px_rgba(183,53,34,0.28)]">
                京
              </div>
              <div className="min-w-0">
                <h1 className={`truncate text-base font-black tracking-tight md:text-lg ${homeTheme.headerTitle}`}>
                  北京旅游 Agent
                </h1>
                <div className={`mt-0.5 hidden items-center gap-2 text-xs md:flex ${homeTheme.headerMeta}`}>
                  <span>任务 {projects.length}</span>
                  <span className="text-[#c9ad8f]">/</span>
                  <span>运行中 {runningProjects}</span>
                  <span className="text-[#c9ad8f]">/</span>
                  <span>{selectedModelLabel}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                onClick={() => router.push("/data-platform")}
                variant="ghost"
                className="inline-flex gap-1.5 px-2 text-xs font-medium sm:gap-2 sm:px-3 sm:text-sm"
              >
                <Clock3 className="h-4 w-4" />
                路线方案
              </Button>
              <Button
                type="button"
                onClick={() => router.push("/data-platform")}
                variant="ghost"
                className="inline-flex gap-1.5 px-2 text-xs font-medium sm:gap-2 sm:px-3 sm:text-sm"
              >
                <ShieldCheck className="h-4 w-4" />
                运行观测
              </Button>
              <Button
                type="button"
                onClick={() => router.push("/data-platform")}
                variant="ghost"
                className="inline-flex gap-1.5 px-2 text-xs font-medium sm:gap-2 sm:px-3 sm:text-sm"
              >
                <Boxes className="h-4 w-4" />
                POI 数据
              </Button>
            </div>
          </header>

          {/* Main area */}
          <main className="relative flex flex-1 flex-col items-center overflow-y-auto bg-[linear-gradient(135deg,#7c3aed_0%,#a855f7_45%,#ec4899_100%)] px-4 py-10 md:justify-center md:py-8">
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_16%,rgba(255,255,255,0.28),transparent_28%),radial-gradient(circle_at_78%_22%,rgba(255,255,255,0.18),transparent_24%),linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0))]" />
              <div className="absolute -left-24 top-20 h-72 w-72 rounded-full bg-white/10 blur-3xl" />
              <div className="absolute bottom-8 right-10 h-96 w-96 rounded-full bg-[#ffccf2]/20 blur-3xl" />
              <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-white/12 to-transparent" />
            </div>

            <section className="relative z-10 flex w-full max-w-5xl flex-col items-center px-2 text-center">
              <div className="text-white">
                <div className="inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/15 px-4 py-2 text-sm font-black text-white shadow-sm backdrop-blur">
                  <Compass className="h-4 w-4" />
                  北京本地 POI / UGC 智能路线规划
                </div>
                <h2 className="mt-7 text-4xl font-black leading-tight tracking-tight md:text-6xl">
                  30 秒生成你的北京旅行计划
                </h2>
                <p className="mx-auto mt-4 max-w-2xl text-base font-semibold leading-8 text-white/82 md:text-lg">
                  输入区域、时长、预算、餐饮和排队偏好，自动生成可执行路线，并支持多轮动态调整。
                </p>
                <div className="mt-6 flex flex-wrap justify-center gap-3">
                  {[
                    { icon: MapPin, label: "本地 POI" },
                    { icon: Sparkles, label: "多 Agent" },
                    { icon: ShieldCheck, label: "约束校验" },
                  ].map(({ icon: Icon, label }) => (
                    <div
                      key={label}
                      className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/15 px-4 py-2 text-sm font-black text-white backdrop-blur"
                    >
                      <Icon className="h-4 w-4" />
                      {label}
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-9 w-full max-w-4xl rounded-[2rem] border border-white/70 bg-[#f7efff]/95 p-7 shadow-[0_34px_100px_rgba(73,20,130,0.2)] backdrop-blur-xl">
                <div className="mb-5 flex flex-wrap justify-center gap-2 rounded-2xl bg-white/40 p-2 text-sm font-black">
                  {[
                    { label: "自由对话", value: "chat" as const },
                    { label: "表单模式", value: "form" as const },
                    { label: "多轮调整", value: "chat" as const },
                  ].map((mode) => {
                    const active = homeInputMode === mode.value;
                    return (
                      <button
                        key={mode.label}
                        type="button"
                        onClick={() => setHomeInputMode(mode.value)}
                        className={`rounded-xl px-5 py-2.5 transition ${
                          active
                            ? "bg-white text-[#6d28d9] shadow-[0_8px_22px_rgba(109,40,217,0.14)]"
                            : "text-[#8f859d] hover:bg-white/60 hover:text-[#6d28d9]"
                        }`}
                      >
                        {mode.label}
                      </button>
                    );
                  })}
                </div>
                {homeInputMode === "form" && (
                <div className="mb-4 rounded-[1.5rem] border border-[#dfe5ee] bg-white p-5 text-left shadow-[0_12px_30px_rgba(38,30,77,0.08)]">
                  <div className="mb-4 flex items-center gap-2 text-lg font-black text-[#252033]">
                    <Sparkles className="h-4 w-4 text-[#8b5cf6]" />
                    快速填写旅行需求
                  </div>
                  <div className="grid gap-4 md:grid-cols-4">
                    <label className="space-y-2 text-sm font-semibold text-[#4b5563]">
                      目标游玩区域
                      <select
                        value={tripForm.area}
                        onChange={(event) =>
                          setTripForm((current) => ({
                            ...current,
                            area: event.target.value,
                          }))
                        }
                        className="h-12 w-full rounded-xl border border-[#d9e1ec] bg-white px-4 text-sm font-semibold text-[#334155] outline-none transition focus:border-[#8b5cf6] focus:ring-2 focus:ring-[#8b5cf6]/15"
                      >
                        {areaOptions.map((item) => (
                          <option key={item} value={item}>
                            {item}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-2 text-sm font-semibold text-[#4b5563]">
                      游玩时长
                      <select
                        value={tripForm.duration}
                        onChange={(event) =>
                          setTripForm((current) => ({
                            ...current,
                            duration: event.target.value,
                          }))
                        }
                        className="h-12 w-full rounded-xl border border-[#d9e1ec] bg-white px-4 text-sm font-semibold text-[#334155] outline-none transition focus:border-[#8b5cf6] focus:ring-2 focus:ring-[#8b5cf6]/15"
                      >
                        {["3小时", "4小时", "半日", "1天", "2天", "3天"].map((item) => (
                          <option key={item} value={item}>
                            {item}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-2 text-sm font-semibold text-[#4b5563]">
                      预算
                      <input
                        value={tripForm.budget}
                        onChange={(event) =>
                          setTripForm((current) => ({
                            ...current,
                            budget: event.target.value,
                          }))
                        }
                        className="h-12 w-full rounded-xl border border-[#d9e1ec] bg-white px-4 text-sm font-semibold text-[#334155] outline-none transition focus:border-[#8b5cf6] focus:ring-2 focus:ring-[#8b5cf6]/15"
                        placeholder="如：200"
                      />
                    </label>
                    <label className="space-y-2 text-sm font-semibold text-[#4b5563]">
                      同行人群
                      <select
                        value={tripForm.persona}
                        onChange={(event) =>
                          setTripForm((current) => ({
                            ...current,
                            persona: event.target.value,
                          }))
                        }
                        className="h-12 w-full rounded-xl border border-[#d9e1ec] bg-white px-4 text-sm font-semibold text-[#334155] outline-none transition focus:border-[#8b5cf6] focus:ring-2 focus:ring-[#8b5cf6]/15"
                      >
                        {["朋友/情侣", "老人", "亲子", "独自出行"].map((item) => (
                          <option key={item} value={item}>
                            {item}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="mt-3 grid gap-3">
                    <label className="space-y-2 text-sm font-semibold text-[#4b5563]">
                      餐饮需求
                      <select
                        value={tripForm.meal}
                        onChange={(event) =>
                          setTripForm((current) => ({
                            ...current,
                            meal: event.target.value,
                          }))
                        }
                        className="h-12 w-full rounded-xl border border-[#d9e1ec] bg-white px-4 text-sm font-semibold text-[#334155] outline-none transition focus:border-[#8b5cf6] focus:ring-2 focus:ring-[#8b5cf6]/15"
                      >
                        {["中午吃饭", "不吃饭", "想喝咖啡", "安排下午茶", "晚上吃饭"].map((item) => (
                          <option key={item} value={item}>
                            {item}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="mt-4 grid gap-3 border-t border-[#edf1f7] pt-4 md:grid-cols-[1fr_auto]">
                    <div>
                      <div className="mb-2 text-sm font-semibold text-[#4b5563]">
                        兴趣偏好
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {[
                          { label: "少走路", icon: "🚶" },
                          { label: "不想排队", icon: "⏱️" },
                          { label: "经典文化", icon: "🏛️" },
                          { label: "亲子友好", icon: "👨‍👩‍👧" },
                          { label: "室内优先", icon: "🏠" },
                        ].map((item) => {
                          const label = item.label;
                          const active = tripForm.preferences.includes(label);
                          return (
                            <button
                              key={label}
                              type="button"
                              onClick={() => toggleTripPreference(label)}
                              aria-pressed={active}
                              className={`rounded-full border px-4 py-2.5 text-sm font-bold transition ${
                                active
                                  ? "border-[#8ea2ff] bg-[#eef3ff] text-[#4f65d9] shadow-sm"
                                  : "border-[#d9e1ec] bg-white text-[#475569] hover:border-[#b8c4d8] hover:bg-[#f8fbff]"
                              }`}
                            >
                              <span className="mr-1.5">{item.icon}</span>
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setPrompt(buildTripFormPrompt());
                        setHomeInputMode("chat");
                      }}
                      className="self-end rounded-lg bg-[#8eacf6] px-8 py-3.5 text-sm font-black text-white shadow-[0_12px_28px_rgba(96,137,236,0.28)] transition hover:bg-[#7d9df1]"
                    >
                      ✨ 开始规划
                    </button>
                  </div>
                </div>
                )}
                {homeInputMode === "chat" && (
                <div className="rounded-[1.5rem] border border-[#dfe5ee] bg-white p-3 shadow-[0_12px_30px_rgba(38,30,77,0.08)]">
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
                  <button
                    type="button"
                    onClick={() => handleSubmit()}
                    disabled={(!prompt.trim() && uploadedImages.length === 0) || isCreatingProject}
                    className="mt-3 w-full rounded-xl bg-[#8eacf6] px-7 py-3.5 text-sm font-black text-white shadow-[0_12px_30px_rgba(96,137,236,0.26)] transition hover:bg-[#7d9df1] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isCreatingProject ? "规划中..." : "开始规划"}
                  </button>
                </div>
                )}
                {homeInputMode === "chat" && (
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  <span className="w-full text-center text-xs font-bold text-[#7c6f8d]">
                    快捷测试案例，点击自动填入输入框
                  </span>
                  {[
                    "前门附近4小时，中午吃饭，预算200以内",
                    "故宫附近文化路线，少走路，不吃饭",
                    "带老人去北海附近，中午安排吃饭",
                  ].map((sample) => (
                    <button
                      key={sample}
                      type="button"
                      onClick={() => setPrompt(sample)}
                      className="rounded-full border border-white/70 bg-white/85 px-4 py-2 text-sm font-bold text-[#5d3f76] transition hover:bg-white"
                    >
                      {sample}
                    </button>
                  ))}
                </div>
                )}
              </div>
            </section>

            <section className="hidden">
              <div className="text-left">
                <div className="inline-flex items-center gap-2 rounded-full border border-[#d9b27d] bg-[#fff2dc] px-4 py-2 text-sm font-black text-[#8d2e1d]">
                  <Compass className="h-4 w-4" />
                  本地 POI / UGC 驱动
                </div>
                <h2 className="mt-6 text-4xl font-black leading-tight tracking-tight text-[#24140f] md:text-6xl">
                  30 秒生成
                  <span className="block text-[#b73522]">北京可执行路线</span>
                </h2>
                <p className="mt-5 max-w-xl text-base font-semibold leading-8 text-[#4c3729] md:text-lg">
                  输入想去的区域、时间、预算和偏好，系统会自动串联 POI、补充 UGC 证据，并支持后续新增、删除、替换地点。
                </p>
                <div className="mt-6 grid gap-3 sm:grid-cols-3">
                  {[
                    { icon: MapPin, label: "串联 POI" },
                    { icon: Sparkles, label: "多轮重规划" },
                    { icon: ShieldCheck, label: "约束校验" },
                  ].map(({ icon: Icon, label }) => (
                    <div
                      key={label}
                      className="rounded-2xl border border-[#e3ccb2] bg-white px-4 py-3 text-sm font-black text-[#4e3729] shadow-sm"
                    >
                      <Icon className="mb-2 h-4 w-4 text-[#b73522]" />
                      {label}
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-[2rem] border border-[#d6b98f] bg-[#fff8ed] p-3 shadow-[0_24px_60px_rgba(141,46,29,0.16)]">
                <div className="rounded-[1.5rem] border border-[#f2d9ab] bg-white p-3 shadow-inner">
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
                <div className="mt-4 flex flex-wrap gap-2">
                  {[
                    "前门附近玩4小时，中午吃饭，预算200以内，少走路",
                    "故宫附近安排4小时文化路线，少走路，不吃饭",
                    "带老人去北海附近玩4小时，中午安排吃饭",
                  ].map((sample) => (
                    <button
                      key={sample}
                      type="button"
                      onClick={() => setPrompt(sample)}
                      className="rounded-full border border-[#dfc6a4] bg-white px-4 py-2 text-sm font-bold text-[#5c3a27] transition hover:border-[#b73522]/40 hover:bg-[#fff5e8]"
                    >
                      {sample}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <div className={`hidden`}>
              <div className={`mb-5 inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-black shadow-sm ${homeTheme.eyebrow}`}>
                <Compass className="h-3.5 w-3.5" />
                本地 POI / UGC 驱动的北京路线规划
              </div>

              <div className="mb-6 text-center">
                <h2 className={`text-4xl font-black tracking-tight md:text-6xl ${homeTheme.title}`}>
                  把想去的北京
                  <span className="mx-2 inline-block rounded-[1.4rem] bg-[#f1c36c] px-4 py-1 text-[#2c160d] shadow-[0_18px_55px_rgba(241,195,108,0.38)]">
                    串成路线
                  </span>
                </h2>
                <p className={`mx-auto mt-5 max-w-2xl text-base font-semibold leading-8 md:text-lg ${homeTheme.subtitle}`}>
                  输入区域、时长、预算、餐饮和排队偏好，系统会调用多 Agent 从本地数据里筛 POI、读 UGC 证据、生成可执行路线，并支持继续添加、删除、替换地点。
                </p>
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  {[
                    { icon: MapPin, label: "本地 POI 检索" },
                    { icon: Sparkles, label: "多 Agent 编排" },
                    { icon: ShieldCheck, label: "UGC 证据校验" },
                  ].map(({ icon: Icon, label }) => (
                    <span
                      key={label}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-bold shadow-sm ${homeTheme.chip}`}
                    >
                      <Icon className="h-3.5 w-3.5 text-[#b73522]" />
                      {label}
                    </span>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  {planningModes.map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`rounded-full border px-4 py-2 text-sm font-black transition ${
                        isNightMode
                          ? "border-[#efd39d] bg-[#3a1b12] text-[#ffe9bf] hover:bg-[#4a2418]"
                          : "border-[#dec5a3] bg-[#fff8ec] text-[#6b3424] hover:bg-[#ffefd5]"
                      }`}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              </div>

              {/* Dashboard summary cards */}
              {projects.length > 0 && (
                <div className="hidden">
                  {[
                    {
                      label: "全部任务",
                      value: projects.length,
                      color: "text-[#24140f]",
                    },
                    {
                      label: "运行中",
                      value: runningProjects,
                      color: "text-[#0b7a4b]",
                    },
                    {
                      label: "当前模型",
                      value: selectedModelLabel,
                      color: "text-[#b73522]",
                      isText: true,
                    },
                  ].map((card) => (
                    <div
                      key={card.label}
                      className={`flex flex-col items-center gap-1 rounded-2xl border px-3 py-3 shadow-sm ${homeTheme.card}`}
                    >
                      <span
                        className={`text-lg font-bold ${card.color} ${card.isText ? "text-xs font-semibold" : ""}`}
                      >
                        {card.value}
                      </span>
                      <span className="text-xs font-medium text-[#7a6351]">
                        {card.label}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Recent projects */}
              {projects.length > 0 && (
                <div className="hidden">
                  <Clock3 className="h-4 w-4 text-[#8d2e1d]" />
                  <span className="text-sm font-bold text-[#4e3729]">最近任务</span>
                  {projects.slice(0, 4).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => openProject(p)}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-bold transition-colors ${homeTheme.recentButton}`}
                    >
                      {p.name || p.initialPrompt?.slice(0, 20) || "未命名任务"}
                    </button>
                  ))}
                </div>
              )}

              <div className={`w-full max-w-3xl rounded-[2rem] border p-2 ${homeTheme.inputWrap}`}>
                <div className="rounded-[1.6rem] border border-[#f4d49a] bg-white p-3 shadow-inner">
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
              </div>
              <div className="mt-5 flex w-full max-w-3xl flex-wrap justify-center gap-2">
                {quickPrompts.map((sample) => (
                  <button
                    key={sample}
                    type="button"
                    onClick={() => setPrompt(sample)}
                    className={`rounded-full border px-4 py-2 text-sm font-bold transition ${
                      isNightMode
                        ? "border-[#e8c68a] bg-[#fffaf2] text-[#4b261a] hover:bg-[#fff0d0]"
                        : "border-[#dfc6a4] bg-white text-[#5c3a27] hover:border-[#b73522]/40 hover:bg-[#fff5e8]"
                    }`}
                  >
                    {sample}
                  </button>
                ))}
              </div>
              <div className="hidden">
                {trustBadges.map((badge) => (
                  <div
                    key={badge.value}
                    className={`rounded-3xl border p-4 text-center shadow-sm ${homeTheme.card}`}
                  >
                    <div className="text-lg font-black text-[#8d2e1d]">
                      {badge.value}
                    </div>
                    <div className="mt-1 text-xs font-bold leading-5 text-[#6b5546]">
                      {badge.label}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-6 grid w-full gap-3 md:grid-cols-3">
                {featureCards.map((feature) => (
                  <div
                    key={feature.title}
                    className={`rounded-[1.7rem] border p-5 text-left shadow-sm ${homeTheme.card}`}
                  >
                    <div className="text-base font-black text-[#24140f]">
                      {feature.title}
                    </div>
                    <div className="mt-2 text-sm font-semibold leading-6 text-[#6b5546]">
                      {feature.text}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </main>
        </div>

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
                确定要删除 <strong>{deleteModal.project?.name}</strong> 吗？该任务的项目文件与对话记录将被永久删除。
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
      </div>
    </div>
  );
}
