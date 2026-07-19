"use client";
import { useEffect, useState, useRef, useCallback, useMemo, type ChangeEvent, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type UIEvent } from 'react';
import { AnimatePresence } from 'framer-motion';
import { MotionDiv, MotionH3, MotionP, MotionButton } from '@/lib/motion';
import { useRouter, useSearchParams, useParams, usePathname } from 'next/navigation';
import dynamic from 'next/dynamic';
import { FaCode, FaDesktop, FaMobileAlt, FaPlay, FaStop, FaSync, FaCog, FaRocket, FaFolder, FaFolderOpen, FaFile, FaFileCode, FaCss3Alt, FaHtml5, FaJs, FaReact, FaPython, FaDocker, FaGitAlt, FaMarkdown, FaDatabase, FaPhp, FaJava, FaRust, FaVuejs, FaLock, FaHome, FaChevronUp, FaChevronRight, FaChevronDown, FaArrowLeft, FaArrowRight, FaRedo } from 'react-icons/fa';
import { SiTypescript, SiGo, SiRuby, SiSvelte, SiJson, SiYaml, SiCplusplus } from 'react-icons/si';
import { VscJson } from 'react-icons/vsc';
import { ExternalLink, Files, MessageSquareText, MonitorPlay } from 'lucide-react';
import ChatLog from '@/components/chat/ChatLog';
import { ProjectSettings } from '@/components/settings/ProjectSettings';
import ChatInput, { type UploadedImage } from '@/components/chat/ChatInput';
import { DashboardGenerationWaiting } from '@/components/chat/DashboardGenerationWaiting';
import { ChatErrorBoundary } from '@/components/ErrorBoundary';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { useUserRequests } from '@/hooks/useUserRequests';
import { useGlobalSettings } from '@/contexts/GlobalSettingsContext';
import { getDefaultModelForCli, getModelDisplayName } from '@/lib/constants/models';
import {
  ACTIVE_CLI_BRAND_COLORS,
  ACTIVE_CLI_IDS,
  ACTIVE_CLI_MODEL_OPTIONS,
  ACTIVE_CLI_NAME_MAP,
  DEFAULT_ACTIVE_CLI,
  buildActiveModelOptions,
  normalizeModelForCli,
  sanitizeActiveCli,
  type ActiveCliId,
  type ActiveModelOption,
} from '@/lib/utils/cliOptions';
import type { QuantGenerationTerminalSnapshot } from '@/lib/quant/generation-terminal';
import {
  CHAT_PANE_DEFAULT_WIDTH,
  CHAT_PANE_MAX_WIDTH,
  CHAT_PANE_MIN_WIDTH,
  CHAT_PANE_WIDTH_STORAGE_KEY,
  PREVIEW_PANE_MIN_WIDTH,
  clampChatPaneWidth,
  parseStoredChatPaneWidth,
} from './pane-layout';
import { planPreviewReconciliation } from './preview-reconciliation';
import { buildQuestionInstruction } from '@/components/chat/question-composer';

// No longer loading ProjectSettings (managed by global settings on main page)

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

const assistantBrandColors = ACTIVE_CLI_BRAND_COLORS;

const CLI_LABELS = ACTIVE_CLI_NAME_MAP;

const CLI_ORDER = ACTIVE_CLI_IDS;

type MobileWorkspaceView = 'chat' | 'preview' | 'files';
type ProjectAvailability = 'checking' | 'available' | 'missing' | 'error';

type QueuedFollowUp = {
  id: string;
  message: string;
  images: UploadedImage[];
  mode: 'act' | 'chat';
};

type RunActImage = {
  id?: string;
  filename?: string;
  name?: string;
  path?: string;
  url: string;
  assetUrl?: string;
  publicUrl?: string;
  base64?: string;
};

const sanitizeCli = (cli?: string | null) => sanitizeActiveCli(cli, DEFAULT_ACTIVE_CLI);

const sanitizeModel = (cli: string, model?: string | null) => normalizeModelForCli(cli, model, DEFAULT_ACTIVE_CLI);

// Function to convert hex to CSS filter for tinting white images
// Since the original image is white (#FFFFFF), we can apply filters more accurately
const hexToFilter = (hex: string): string => {
  // For white source images, we need to invert and adjust
  const filters: { [key: string]: string } = {
    '#2563EB': 'brightness(0) saturate(100%) invert(34%) sepia(91%) saturate(2269%) hue-rotate(214deg) brightness(96%) contrast(91%)',
  };
  return filters[hex] || filters['#2563EB'];
};

type Entry = { path: string; type: 'file'|'dir'; size?: number };
type ProjectStatus = 'initializing' | 'active' | 'failed';
type QuantValidationState = 'unknown' | 'running' | 'passed' | 'failed';

type QuantValidationRepairPlan = {
  status: 'needed';
  repairPlanPath?: string;
  steps?: Array<{
    checkId?: string;
    checkName?: string;
    summary?: string;
    actions?: string[];
  }>;
};

type CliStatusSnapshot = {
  available?: boolean;
  configured?: boolean;
  models?: string[];
};

type ModelOption = Omit<ActiveModelOption, 'cli'> & { cli: string; supportsImages?: boolean };

const buildModelOptions = (statuses: Record<string, CliStatusSnapshot>): ModelOption[] =>
  buildActiveModelOptions(statuses).map(option => ({
    ...option,
    cli: option.cli,
  }));

// TreeView component for VSCode-style file explorer
interface TreeViewProps {
  entries: Entry[];
  selectedFile: string;
  expandedFolders: Set<string>;
  folderContents: Map<string, Entry[]>;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
  onLoadFolder: (path: string) => Promise<void>;
  level: number;
  parentPath?: string;
  getFileIcon: (entry: Entry) => React.ReactElement;
}

function TreeView({ entries, selectedFile, expandedFolders, folderContents, onToggleFolder, onSelectFile, onLoadFolder, level, parentPath = '', getFileIcon }: TreeViewProps) {
  // Ensure entries is an array
  if (!entries || !Array.isArray(entries)) {
    return null;
  }

  // Group entries by directory
  const sortedEntries = [...entries].sort((a, b) => {
    // Directories first
    if (a.type === 'dir' && b.type === 'file') return -1;
    if (a.type === 'file' && b.type === 'dir') return 1;
    // Then alphabetical
    return a.path.localeCompare(b.path);
  });

  return (
    <>
      {sortedEntries.map((entry, index) => {
        // entry.path should already be the full path from API
        const fullPath = entry.path;
        let entryKey =
          fullPath && typeof fullPath === 'string' && fullPath.trim().length > 0
            ? fullPath.trim()
            : (entry as any)?.name && typeof (entry as any).name === 'string' && (entry as any).name.trim().length > 0
            ? `${parentPath || 'root'}::__named_${(entry as any).name.trim()}`
            : '';
        if (!entryKey || entryKey.trim().length === 0) {
          entryKey = `${parentPath || 'root'}::__entry_${level}_${index}_${entry.type}`;
        }
        const isExpanded = expandedFolders.has(fullPath);
        const indent = level * 8;

        return (
          <div key={entryKey}>
            <div
              className={`group flex items-center h-[22px] px-2 cursor-pointer ${
                selectedFile === fullPath
                  ? 'bg-blue-100 '
                  : 'hover:bg-slate-100 '
              }`}
              style={{ paddingLeft: `${8 + indent}px` }}
              onClick={async () => {
                if (entry.type === 'dir') {
                  // Load folder contents if not already loaded
                  if (!folderContents.has(fullPath)) {
                    await onLoadFolder(fullPath);
                  }
                  onToggleFolder(fullPath);
                } else {
                  onSelectFile(fullPath);
                }
              }}
            >
              {/* Chevron for folders */}
              <div className="w-4 flex items-center justify-center mr-0.5">
                {entry.type === 'dir' && (
                  isExpanded ?
                    <span className="w-2.5 h-2.5 text-slate-600 flex items-center justify-center"><FaChevronDown size={10} /></span> :
                    <span className="w-2.5 h-2.5 text-slate-600 flex items-center justify-center"><FaChevronRight size={10} /></span>
                )}
              </div>

              {/* Icon */}
              <span className="w-4 h-4 flex items-center justify-center mr-1.5">
                {entry.type === 'dir' ? (
                  isExpanded ?
                    <span className="text-amber-600 w-4 h-4 flex items-center justify-center"><FaFolderOpen size={16} /></span> :
                    <span className="text-amber-600 w-4 h-4 flex items-center justify-center"><FaFolder size={16} /></span>
                ) : (
                  getFileIcon(entry)
                )}
              </span>

              {/* File/Folder name */}
              <span className={`text-[13px] leading-[22px] ${
                selectedFile === fullPath ? 'text-blue-700 ' : 'text-slate-700 '
              }`} style={{ fontFamily: "'Segoe UI', Tahoma, sans-serif" }}>
                {level === 0 ? (entry.path.split('/').pop() || entry.path) : (entry.path.split('/').pop() || entry.path)}
              </span>
            </div>

            {/* Render children if expanded */}
            {entry.type === 'dir' && isExpanded && folderContents.has(fullPath) && (
              <TreeView
                entries={folderContents.get(fullPath) || []}
                selectedFile={selectedFile}
                expandedFolders={expandedFolders}
                folderContents={folderContents}
                onToggleFolder={onToggleFolder}
                onSelectFile={onSelectFile}
                onLoadFolder={onLoadFolder}
                level={level + 1}
                parentPath={fullPath}
                getFileIcon={getFileIcon}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export default function ChatPage() {
  const params = useParams<{ project_id: string }>();
  const pathname = usePathname();
  const routeProjectId = params?.project_id;
  const projectIdFromParams = Array.isArray(routeProjectId) ? routeProjectId[0] : routeProjectId;
  const projectId =
    projectIdFromParams ??
    pathname?.split('/').filter(Boolean).find((segment) => segment.startsWith('project-')) ??
    '';
  const router = useRouter();
  const searchParams = useSearchParams();
  const isVisualCheck = searchParams?.get('visualCheck') === '1';

  // NEW: UserRequests state management
  const {
    hasActiveRequests,
    createRequest,
    startRequest,
    completeRequest
  } = useUserRequests({ projectId });

  const [projectName, setProjectName] = useState<string>('');
  const [projectDescription, setProjectDescription] = useState<string>('');
  const [projectAvailability, setProjectAvailability] = useState<{
    projectId: string;
    status: ProjectAvailability;
  }>(() => ({ projectId, status: 'checking' }));
  const currentProjectAvailability = projectAvailability.projectId === projectId
    ? projectAvailability.status
    : 'checking';
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [tree, setTree] = useState<Entry[]>([]);
  const [isTreeLoading, setIsTreeLoading] = useState(false);
  const [hasTreeLoaded, setHasTreeLoaded] = useState(false);
  const [treeLoadError, setTreeLoadError] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [editedContent, setEditedContent] = useState<string>('');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isSavingFile, setIsSavingFile] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<'idle' | 'success' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [currentPath, setCurrentPath] = useState<string>('.');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['']));
  const [folderContents, setFolderContents] = useState<Map<string, Entry[]>>(new Map());
  const [prompt, setPrompt] = useState('');

  // Ref to store add/remove message handlers from ChatLog
  const messageHandlersRef = useRef<{
    add: (message: any) => void;
    remove: (messageId: string) => void;
  } | null>(null);

  // Ref to track pending requests for deduplication
  const pendingRequestsRef = useRef<Set<string>>(new Set());

  // Stable message handlers to prevent reassignment issues
  const stableMessageHandlers = useRef<{
    add: (message: any) => void;
    remove: (messageId: string) => void;
  } | null>(null);

  // Track active optimistic messages by requestId
  const optimisticMessagesRef = useRef<Map<string, any>>(new Map());
  const [mode, setMode] = useState<'act' | 'chat'>(() =>
    searchParams?.get('mode') === 'chat' ? 'chat' : 'act'
  );
  const [isRunning, setIsRunning] = useState(false);
  const [isPausingAgent, setIsPausingAgent] = useState(false);
  const [queuedFollowUps, setQueuedFollowUps] = useState<QueuedFollowUp[]>([]);
  const queuedFollowUpsRef = useRef<QueuedFollowUp[]>([]);
  const queueDispatchingRef = useRef(false);
  const runActRef = useRef<((
    messageOverride?: string,
    externalImages?: RunActImage[],
    modeOverride?: 'act' | 'chat',
  ) => Promise<void>) | null>(null);
  const [isSseFallbackActive, setIsSseFallbackActive] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [mobileWorkspaceView, setMobileWorkspaceView] = useState<MobileWorkspaceView>('chat');
  const [chatPaneWidth, setChatPaneWidth] = useState(CHAT_PANE_DEFAULT_WIDTH);
  const [isChatPaneResizing, setIsChatPaneResizing] = useState(false);
  const chatPaneRef = useRef<HTMLDivElement>(null);
  const chatPaneWidthRef = useRef(CHAT_PANE_DEFAULT_WIDTH);
  const chatPanePreferredWidthRef = useRef(CHAT_PANE_DEFAULT_WIDTH);
  const chatPaneResizeRef = useRef({
    startX: 0,
    startWidth: CHAT_PANE_DEFAULT_WIDTH,
  });
  const [deviceMode, setDeviceMode] = useState<'desktop'|'mobile'>('desktop');
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);
  const [uploadedImages, setUploadedImages] = useState<{name: string; url: string; base64?: string; path?: string}[]>([]);
  const [isInitializing, setIsInitializing] = useState(true);
  // Initialize states with default values, will be loaded from localStorage in useEffect
  const [hasInitialPrompt, setHasInitialPrompt] = useState<boolean>(false);
  const [agentWorkComplete, setAgentWorkComplete] = useState<boolean>(false);
  const [projectStatus, setProjectStatus] = useState<ProjectStatus>('initializing');
  const [initializationMessage, setInitializationMessage] = useState('Starting project initialization...');
  const [initialPromptSent, setInitialPromptSent] = useState(false);
  const initialPromptSentRef = useRef(false);
  const [showPublishPanel, setShowPublishPanel] = useState(false);
  const [publishLoading, setPublishLoading] = useState(false);
  const [githubConnected, setGithubConnected] = useState<boolean | null>(null);
  const [vercelConnected, setVercelConnected] = useState<boolean | null>(null);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const [deploymentId, setDeploymentId] = useState<string | null>(null);
  const [deploymentStatus, setDeploymentStatus] = useState<'idle' | 'deploying' | 'ready' | 'error'>('idle');
  const deployPollRef = useRef<NodeJS.Timeout | null>(null);
  const [isStartingPreview, setIsStartingPreview] = useState(false);
  const previewStartInFlightRef = useRef<string | null>(null);
  const previewAutoRecoveryAttemptRef = useRef<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const previewAutoRecoverySuppressedRef = useRef(false);
  const previewTerminalFailureRef = useRef(false);
  const [previewInitializationMessage, setPreviewInitializationMessage] = useState('正在启动预览服务...');
  const [quantValidationState, setQuantValidationState] = useState<QuantValidationState>('unknown');
  const [quantValidationMessage, setQuantValidationMessage] = useState<string | null>(null);
  const [quantRepairPlan, setQuantRepairPlan] = useState<QuantValidationRepairPlan | null>(null);
  const [cliStatuses, setCliStatuses] = useState<Record<string, CliStatusSnapshot>>({});
  const [conversationId, setConversationId] = useState<string>(() => {
    if (typeof window !== 'undefined' && window.crypto?.randomUUID) {
      return window.crypto.randomUUID();
    }
    return '';
  });
  const [preferredCli, setPreferredCli] = useState<ActiveCliId>(DEFAULT_ACTIVE_CLI);
  const [selectedModel, setSelectedModel] = useState<string>(getDefaultModelForCli(DEFAULT_ACTIVE_CLI));
  const [usingGlobalDefaults, setUsingGlobalDefaults] = useState<boolean>(true);
  const [isUpdatingModel, setIsUpdatingModel] = useState<boolean>(false);
  const [currentRoute, setCurrentRoute] = useState<string>('/');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const shouldShowPreviewFrame = Boolean(previewUrl) && !isStartingPreview;
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const lineNumberRef = useRef<HTMLDivElement>(null);
  const editedContentRef = useRef<string>('');
  const [isFileUpdating, setIsFileUpdating] = useState(false);
  const activeBrandColor =
    assistantBrandColors[preferredCli] || assistantBrandColors[DEFAULT_ACTIVE_CLI];
  const modelOptions = useMemo(() => buildModelOptions(cliStatuses), [cliStatuses]);
  const generationBusy = isRunning || hasActiveRequests;
  const cliOptions = useMemo(
    () => CLI_ORDER.map(cli => ({
      id: cli,
      name: CLI_LABELS[cli] || cli,
      available: Boolean(cliStatuses[cli]?.available && cliStatuses[cli]?.configured)
    })),
    [cliStatuses]
  );

  const updatePreferredCli = useCallback((cli: string) => {
    const sanitized = sanitizeCli(cli);
    setPreferredCli(sanitized);
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('selectedAssistant', sanitized);
    }
  }, []);

  const updateSelectedModel = useCallback((model: string, cliOverride?: string) => {
    const effectiveCli = cliOverride ? sanitizeCli(cliOverride) : preferredCli;
    const sanitized = sanitizeModel(effectiveCli, model);
    setSelectedModel(sanitized);
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('selectedModel', sanitized);
    }
  }, [preferredCli]);

  const persistChatPaneWidth = useCallback((width: number) => {
    const nextWidth = clampChatPaneWidth(width, window.innerWidth);
    chatPaneWidthRef.current = nextWidth;
    chatPanePreferredWidthRef.current = nextWidth;
    setChatPaneWidth(nextWidth);
    window.localStorage.setItem(CHAT_PANE_WIDTH_STORAGE_KEY, String(nextWidth));
  }, []);

  const resetChatPaneWidth = useCallback(() => {
    const nextWidth = clampChatPaneWidth(CHAT_PANE_DEFAULT_WIDTH, window.innerWidth);
    chatPaneWidthRef.current = nextWidth;
    chatPanePreferredWidthRef.current = CHAT_PANE_DEFAULT_WIDTH;
    setChatPaneWidth(nextWidth);
    window.localStorage.removeItem(CHAT_PANE_WIDTH_STORAGE_KEY);
  }, []);

  const startChatPaneResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    chatPaneResizeRef.current = {
      startX: event.clientX,
      startWidth: chatPaneRef.current?.getBoundingClientRect().width ?? chatPaneWidthRef.current,
    };
    setIsChatPaneResizing(true);
  }, []);

  useEffect(() => {
    const storedWidth = parseStoredChatPaneWidth(
      window.localStorage.getItem(CHAT_PANE_WIDTH_STORAGE_KEY),
      CHAT_PANE_MAX_WIDTH + PREVIEW_PANE_MIN_WIDTH,
    );
    if (storedWidth !== null) {
      const visibleWidth = clampChatPaneWidth(storedWidth, window.innerWidth);
      chatPanePreferredWidthRef.current = storedWidth;
      chatPaneWidthRef.current = visibleWidth;
      setChatPaneWidth(visibleWidth);
    }

    const clampToViewport = () => {
      const nextWidth = clampChatPaneWidth(
        chatPanePreferredWidthRef.current,
        window.innerWidth,
      );
      chatPaneWidthRef.current = nextWidth;
      setChatPaneWidth(nextWidth);
    };
    window.addEventListener('resize', clampToViewport);
    return () => window.removeEventListener('resize', clampToViewport);
  }, []);

  useEffect(() => {
    if (!isChatPaneResizing) return;

    const move = (event: PointerEvent) => {
      const nextWidth = clampChatPaneWidth(
        chatPaneResizeRef.current.startWidth + event.clientX - chatPaneResizeRef.current.startX,
        window.innerWidth,
      );
      chatPaneWidthRef.current = nextWidth;
      chatPanePreferredWidthRef.current = nextWidth;
      setChatPaneWidth(nextWidth);
    };
    const stop = () => {
      window.localStorage.setItem(
        CHAT_PANE_WIDTH_STORAGE_KEY,
        String(chatPanePreferredWidthRef.current),
      );
      setIsChatPaneResizing(false);
    };
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [isChatPaneResizing]);

  const sendInitialPrompt = useCallback(async (initialPrompt: string) => {
    if (initialPromptSent) {
      return;
    }

    setAgentWorkComplete(false);
    localStorage.setItem(`project_${projectId}_taskComplete`, 'false');

    const requestId = crypto.randomUUID();

    try {
      setIsRunning(true);
      setInitialPromptSent(true);

      const requestBody = {
        instruction: initialPrompt.trim(),
        displayInstruction: initialPrompt.trim(),
        images: [],
        isInitialPrompt: true,
        cliPreference: preferredCli,
        conversationId: conversationId || undefined,
        requestId,
        selectedModel,
      };

      const r = await fetch(`${API_BASE}/api/chat/${projectId}/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!r.ok) {
        const errorText = await r.text();
        console.error('❌ API Error:', errorText);
        setInitialPromptSent(false);
        return;
      }

      const result = await r.json();
      const returnedConversationId =
        typeof result?.conversationId === 'string'
          ? result.conversationId
          : typeof result?.conversation_id === 'string'
          ? result.conversation_id
          : undefined;
      if (returnedConversationId) {
        setConversationId(returnedConversationId);
      }

      const resolvedRequestId =
        typeof result?.requestId === 'string'
          ? result.requestId
          : typeof result?.request_id === 'string'
          ? result.request_id
          : requestId;
      const userMessageId =
        typeof result?.userMessageId === 'string'
          ? result.userMessageId
          : typeof result?.user_message_id === 'string'
          ? result.user_message_id
          : '';

      createRequest(resolvedRequestId, userMessageId, initialPrompt, 'act');
      setPrompt('');

      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete('initial_prompt');
      window.history.replaceState({}, '', newUrl.toString());
    } catch (error) {
      console.error('Error sending initial prompt:', error);
      setInitialPromptSent(false);
    } finally {
      setIsRunning(false);
    }
  }, [initialPromptSent, preferredCli, conversationId, projectId, selectedModel, createRequest]);

  // Guarded trigger that can be called from multiple places safely
  const triggerInitialPromptIfNeeded = useCallback(() => {
    const initialPromptFromUrl = searchParams?.get('initial_prompt');
    if (!initialPromptFromUrl) return;
    if (initialPromptSentRef.current) return;
    // Synchronously guard to prevent double ACT calls
    initialPromptSentRef.current = true;
    setInitialPromptSent(true);

    // Store the selected model and assistant in sessionStorage when returning
    const cliFromUrl = searchParams?.get('cli');
    const modelFromUrl = searchParams?.get('model');
    if (cliFromUrl) {
      const sanitizedCli = sanitizeCli(cliFromUrl);
      sessionStorage.setItem('selectedAssistant', sanitizedCli);
      if (modelFromUrl) {
        sessionStorage.setItem('selectedModel', sanitizeModel(sanitizedCli, modelFromUrl));
      }
    } else if (modelFromUrl) {
      sessionStorage.setItem('selectedModel', sanitizeModel(preferredCli, modelFromUrl));
    }

    // Don't show the initial prompt in the input field
    // setPrompt(initialPromptFromUrl);
    setTimeout(() => {
      sendInitialPrompt(initialPromptFromUrl);
    }, 300);
  }, [searchParams, sendInitialPrompt, preferredCli]);

const loadCliStatuses = useCallback(() => {
  const snapshot: Record<string, CliStatusSnapshot> = {};
  ACTIVE_CLI_IDS.forEach(id => {
    const models = ACTIVE_CLI_MODEL_OPTIONS[id]?.map(model => model.id) ?? [];
    snapshot[id] = {
      available: true,
      configured: true,
      models,
    };
  });
  setCliStatuses(snapshot);
}, []);

const persistProjectPreferences = useCallback(
  async (changes: { preferredCli?: string; selectedModel?: string }) => {
    if (!projectId) return;
    const payload: Record<string, unknown> = {};
    if (changes.preferredCli) {
      const sanitizedPreferredCli = sanitizeCli(changes.preferredCli);
      payload.preferredCli = sanitizedPreferredCli;
      payload.preferred_cli = sanitizedPreferredCli;
    }
    if (changes.selectedModel) {
      const targetCli = sanitizeCli(changes.preferredCli ?? preferredCli);
      const normalized = sanitizeModel(targetCli, changes.selectedModel);
      payload.selectedModel = normalized;
      payload.selected_model = normalized;
    }
    if (Object.keys(payload).length === 0) return;

    const response = await fetch(`${API_BASE}/api/projects/${projectId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || 'Failed to update project preferences');
    }

    const result = await response.json().catch(() => null);
    return result?.data ?? result;
  },
  [projectId, preferredCli]
);

  const handleModelChange = useCallback(
    async (option: ModelOption, opts?: { skipCliUpdate?: boolean; overrideCli?: string }) => {
      if (!projectId || !option) return;

      const { skipCliUpdate = false, overrideCli } = opts || {};
      const targetCli = sanitizeCli(overrideCli ?? option.cli);
      const sanitizedModelId = sanitizeModel(targetCli, option.id);

      const previousCli = preferredCli;
      const previousModel = selectedModel;

      if (targetCli === previousCli && sanitizedModelId === previousModel) {
        return;
      }

      setUsingGlobalDefaults(false);
      updatePreferredCli(targetCli);
      updateSelectedModel(option.id, targetCli);

      setIsUpdatingModel(true);

      try {
        const preferenceChanges: { preferredCli?: string; selectedModel?: string } = {
          selectedModel: sanitizedModelId,
        };
        if (!skipCliUpdate && targetCli !== previousCli) {
          preferenceChanges.preferredCli = targetCli;
        }

        await persistProjectPreferences(preferenceChanges);

        const cliLabel = CLI_LABELS[targetCli] || targetCli;
        const modelLabel = getModelDisplayName(targetCli, sanitizedModelId);
        try {
          await fetch(`${API_BASE}/api/chat/${projectId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: `Switched to ${cliLabel} (${modelLabel})`,
              role: 'system',
              message_type: 'info',
              cli_source: targetCli,
              conversation_id: conversationId || undefined,
            }),
          });
        } catch (messageError) {
          console.warn('Failed to record model switch message:', messageError);
        }

        loadCliStatuses();
      } catch (error) {
        console.error('Failed to update model preference:', error);
        updatePreferredCli(previousCli);
        updateSelectedModel(previousModel, previousCli);
        alert('Failed to update model. Please try again.');
      } finally {
        setIsUpdatingModel(false);
      }
    },
    [projectId, preferredCli, selectedModel, conversationId, loadCliStatuses, persistProjectPreferences, updatePreferredCli, updateSelectedModel]
  );

  useEffect(() => {
    loadCliStatuses();
  }, [loadCliStatuses]);

  const handleCliChange = useCallback(
    async (cliId: string) => {
      if (!projectId) return;
      if (cliId === preferredCli) return;

      setUsingGlobalDefaults(false);

      const candidateModels = modelOptions.filter(option => option.cli === cliId);
      const fallbackOption =
        candidateModels.find(option => option.id === selectedModel && option.available) ||
        candidateModels.find(option => option.available) ||
        candidateModels[0];

      if (fallbackOption) {
        await handleModelChange(fallbackOption, { overrideCli: cliId });
        return;
      }

      const previousCli = preferredCli;
      const previousModel = selectedModel;
      setIsUpdatingModel(true);

      try {
        updatePreferredCli(cliId);
        const defaultModel = getDefaultModelForCli(cliId);
        updateSelectedModel(defaultModel, cliId);
        await persistProjectPreferences({ preferredCli: cliId, selectedModel: defaultModel });
        loadCliStatuses();
      } catch (error) {
        console.error('Failed to update CLI preference:', error);
        updatePreferredCli(previousCli);
        updateSelectedModel(previousModel, previousCli);
        alert('Failed to update CLI. Please try again.');
      } finally {
        setIsUpdatingModel(false);
      }
    },
    [projectId, preferredCli, selectedModel, modelOptions, handleModelChange, loadCliStatuses, persistProjectPreferences, updatePreferredCli, updateSelectedModel]
  );

  useEffect(() => {
    if (!modelOptions.length) return;
    const hasSelected = modelOptions.some(option => option.cli === preferredCli && option.id === selectedModel);
    if (!hasSelected) {
      const fallbackOption = modelOptions.find(option => option.cli === preferredCli && option.available)
        || modelOptions.find(option => option.cli === preferredCli)
        || modelOptions.find(option => option.available)
        || modelOptions[0];
      if (fallbackOption) {
        void handleModelChange(fallbackOption);
      }
    }
  }, [modelOptions, preferredCli, selectedModel, handleModelChange]);

  const loadDeployStatus = useCallback(async () => {
    try {
      // Use the same API as ServiceSettings to check actual project service connections
      const response = await fetch(`${API_BASE}/api/projects/${projectId}/services`);
      if (response.status === 404) {
        setGithubConnected(false);
        setVercelConnected(false);
        setPublishedUrl(null);
        setDeploymentStatus('idle');
        return;
      }

      if (response.ok) {
        const connections = await response.json();
        const githubConnection = connections.find((conn: any) => conn.provider === 'github');
        const vercelConnection = connections.find((conn: any) => conn.provider === 'vercel');

        // Check actual project connections (not just token existence)
        setGithubConnected(!!githubConnection);
        setVercelConnected(!!vercelConnection);

        // Set published URL only if actually deployed
        if (vercelConnection && vercelConnection.service_data) {
          const sd = vercelConnection.service_data;
          // Only use actual deployment URLs, not predicted ones
          const rawUrl = sd.last_deployment_url || null;
          const url = rawUrl ? (String(rawUrl).startsWith('http') ? String(rawUrl) : `https://${rawUrl}`) : null;
          setPublishedUrl(url || null);
          if (url) {
            setDeploymentStatus('ready');
          } else {
            setDeploymentStatus('idle');
          }
        } else {
          setPublishedUrl(null);
          setDeploymentStatus('idle');
        }
      } else {
        setGithubConnected(false);
        setVercelConnected(false);
        setPublishedUrl(null);
        setDeploymentStatus('idle');
      }

    } catch (e) {
      console.warn('Failed to load deploy status', e);
      setGithubConnected(false);
      setVercelConnected(false);
      setPublishedUrl(null);
      setDeploymentStatus('idle');
    }
  }, [projectId]);

  const startDeploymentPolling = useCallback((depId: string) => {
    if (deployPollRef.current) clearInterval(deployPollRef.current);
    setDeploymentStatus('deploying');
    setDeploymentId(depId);

    console.log('🔍 Monitoring deployment:', depId);

    deployPollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`${API_BASE}/api/projects/${projectId}/vercel/deployment/current`);
        if (r.status === 404) {
          setDeploymentStatus('idle');
          setDeploymentId(null);
          setPublishLoading(false);
          if (deployPollRef.current) {
            clearInterval(deployPollRef.current);
            deployPollRef.current = null;
          }
          return;
        }
        if (!r.ok) return;
        const data = await r.json();

        // Stop polling if no active deployment (completed)
        if (!data.has_deployment) {
          console.log('🔍 Deployment completed - no active deployment');

          // Set final deployment URL
          if (data.last_deployment_url) {
            const url = String(data.last_deployment_url).startsWith('http') ? data.last_deployment_url : `https://${data.last_deployment_url}`;
            console.log('🔍 Deployment complete! URL:', url);
            setPublishedUrl(url);
            setDeploymentStatus('ready');
          } else {
            setDeploymentStatus('idle');
          }

          // End publish loading state (important: release loading even if no deployment)
          setPublishLoading(false);

          if (deployPollRef.current) {
            clearInterval(deployPollRef.current);
            deployPollRef.current = null;
          }
          return;
        }

        // If there is an active deployment
        const status = data.status;

        // Log only status changes
        if (status && status !== 'QUEUED') {
          console.log('🔍 Deployment status:', status);
        }

        // Check if deployment is ready or failed
        const isReady = status === 'READY';
        const isBuilding = status === 'BUILDING' || status === 'QUEUED';
        const isError = status === 'ERROR';

        if (isError) {
          console.error('🔍 Deployment failed:', status);
          setDeploymentStatus('error');

          // End publish loading state
          setPublishLoading(false);

          // Close publish panel after error (with delay to show error message)
          setTimeout(() => {
            setShowPublishPanel(false);
          }, 3000); // Show error for 3 seconds before closing

          if (deployPollRef.current) {
            clearInterval(deployPollRef.current);
            deployPollRef.current = null;
          }
          return;
        }

        if (isReady && data.deployment_url) {
          const url = String(data.deployment_url).startsWith('http') ? data.deployment_url : `https://${data.deployment_url}`;
          console.log('🔍 Deployment complete! URL:', url);
          setPublishedUrl(url);
          setDeploymentStatus('ready');

          // End publish loading state
          setPublishLoading(false);

          // Keep panel open to show the published URL

          if (deployPollRef.current) {
            clearInterval(deployPollRef.current);
            deployPollRef.current = null;
          }
        } else if (isBuilding) {
          setDeploymentStatus('deploying');
        }
      } catch (error) {
        console.error('🔍 Polling error:', error);
      }
    }, 1000); // Changed to 1 second interval
  }, [projectId]);

  const checkCurrentDeployment = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/projects/${projectId}/vercel/deployment/current`);
      if (response.status === 404) {
        return;
      }

      if (response.ok) {
        const data = await response.json();
        if (data.has_deployment) {
          setDeploymentId(data.deployment_id);
          setDeploymentStatus('deploying');
          setPublishLoading(false);
          setShowPublishPanel(true);
          startDeploymentPolling(data.deployment_id);
          console.log('🔍 Resuming deployment monitoring:', data.deployment_id);
        }
      }
    } catch (e) {
      console.warn('Failed to check current deployment', e);
    }
  }, [projectId, startDeploymentPolling]);

  const readQuantValidationStatus = useCallback(async (): Promise<QuantValidationState> => {
    try {
      const response = await fetch(`${API_BASE}/api/projects/${projectId}/quant/validation`, {
        method: 'GET',
        cache: 'no-store',
      });
      if (!response.ok) {
        return 'unknown';
      }
      const payload = await response.json();
      let report = payload?.data ?? null;
      const generationState = payload?.generationState ?? null;
      const generationRequestId =
        typeof generationState?.requestId === 'string'
          ? generationState.requestId
          : null;
      const validationRunId =
        typeof report?.runId === 'string' ? report.runId : null;
      const generationIsActive = ['pending', 'running', 'repairing'].includes(
        String(generationState?.status ?? ''),
      );
      const validationMatchesGeneration = !generationRequestId
        ? true
        : validationRunId
          ? validationRunId === generationRequestId
          : ['completed', 'failed'].includes(String(generationState?.status ?? ''));

      if (!validationMatchesGeneration) {
        setQuantValidationState('running');
        setQuantValidationMessage('正在等待当前生成任务的自动验证结果。');
        setQuantRepairPlan(null);
        return 'running';
      }

      const staleReport = Array.isArray(report?.checks)
        ? report.checks.some((check: any) => check?.id === 'validation_report_stale')
        : false;
      if (staleReport && generationIsActive) {
        setQuantValidationState('running');
        setQuantValidationMessage('当前产物仍在更新，正在等待本轮自动验证。');
        setQuantRepairPlan(null);
        return 'running';
      }
      if (staleReport && !isVisualCheck && !generationIsActive) {
        setQuantValidationState('running');
        setQuantValidationMessage('生成产物已更新，正在重新执行自动验证。');
        setQuantRepairPlan(null);
        const rerunResponse = await fetch(`${API_BASE}/api/projects/${projectId}/quant/validation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({}),
        });
        if (rerunResponse.ok) {
          const rerunPayload = await rerunResponse.json().catch(() => null);
          report = rerunPayload?.data ?? report;
          payload.repairPlan = rerunPayload?.repairPlan ?? payload.repairPlan;
        }
      }
      if (report?.passed === true || report?.status === 'passed') {
        setQuantValidationState('passed');
        setQuantValidationMessage('自动验证通过。');
        setQuantRepairPlan(null);
        return 'passed';
      }
      if (report?.passed === false || report?.status === 'failed') {
        const repairPlan =
          payload?.repairPlan && payload.repairPlan.status === 'needed'
            ? (payload.repairPlan as QuantValidationRepairPlan)
            : null;
        const failedChecks = Array.isArray(report?.checks)
          ? report.checks
              .filter((check: any) => check?.status === 'failed')
              .map((check: any) => check?.summary || check?.name || check?.id)
              .filter(Boolean)
          : [];
        setQuantValidationState('failed');
        setQuantRepairPlan(repairPlan);
        setQuantValidationMessage(
          failedChecks.length
            ? `自动验证未通过：${failedChecks.join('；')}`
            : '自动验证未通过，请查看验证摘要。'
        );
        return 'failed';
      }
    } catch (error) {
      console.warn('[Preview] failed to read quant validation report:', error);
    }
    return 'unknown';
  }, [isVisualCheck, projectId]);

  const readGenerationTerminalSnapshot = useCallback(async (): Promise<QuantGenerationTerminalSnapshot | null> => {
    const response = await fetch(
      `${API_BASE}/api/projects/${projectId}/generation/status`,
      { cache: 'no-store' },
    );
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    return (payload?.data ?? null) as QuantGenerationTerminalSnapshot | null;
  }, [projectId]);

  const start = useCallback(async (options: {
    requireValidation?: boolean;
    acceptedSnapshot?: QuantGenerationTerminalSnapshot;
  } = {}) => {
    // A URL already adopted by this page must never trigger another start.
    if (previewUrlRef.current) {
      return true;
    }
    if (previewStartInFlightRef.current) {
      return false;
    }

    previewStartInFlightRef.current = projectId;
    previewTerminalFailureRef.current = false;
    let dependencyProgressTimer: ReturnType<typeof setTimeout> | null = null;
    let buildProgressTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      setIsStartingPreview(true);
      setPreviewInitializationMessage(
        options.requireValidation ? '正在检查自动验证结果...' : '正在启动预览服务...'
      );

      const terminalSnapshot =
        options.acceptedSnapshot ?? await readGenerationTerminalSnapshot();
      if (previewStartInFlightRef.current !== projectId) {
        return false;
      }
      if (!terminalSnapshot) {
        setPreviewInitializationMessage('暂时无法确认生成终态，请稍后重试。');
        return false;
      }
      if (
        terminalSnapshot.missionAcceptanceRequired &&
        !terminalSnapshot.missionAcceptanceSatisfied
      ) {
        previewUrlRef.current = null;
        setPreviewUrl(null);
        setPreviewInitializationMessage('正在等待 MoAgent 证据验收，暂不展示预览。');
        return false;
      }
      if (terminalSnapshot.validationStatus !== 'passed') {
        setPreviewInitializationMessage(
          terminalSnapshot.validationStatus === 'failed'
            ? '自动验证未通过，暂不展示可视化看板。'
            : '自动验证尚未完成，暂不展示可视化看板。'
        );
        return false;
      }
      if (terminalSnapshot.previewUrl) {
        previewUrlRef.current = terminalSnapshot.previewUrl;
        setPreviewUrl(terminalSnapshot.previewUrl);
        setPreviewInitializationMessage('预览已就绪');
        setShowPreview(true);
        setMobileWorkspaceView('preview');
        setCurrentRoute('/');
        return true;
      }
      if (terminalSnapshot.status !== 'preview_pending') {
        setPreviewInitializationMessage('持久看板预览尚未进入可恢复状态。');
        return false;
      }

      dependencyProgressTimer = setTimeout(() => setPreviewInitializationMessage('正在检查依赖...'), 1000);
      buildProgressTimer = setTimeout(() => setPreviewInitializationMessage('正在构建和验证看板...'), 2500);

      const r = await fetch(`${API_BASE}/api/projects/${projectId}/preview/start`, { method: 'POST' });
      if (previewStartInFlightRef.current !== projectId) {
        return false;
      }
      if (!r.ok) {
        let errorMessage = r.statusText || '预览启动失败';
        try {
          const payload = await r.json();
          if (typeof payload?.error === 'string' && payload.error.trim()) {
            errorMessage = payload.error.trim();
          }
        } catch {
          // 响应体不是 JSON 时使用 HTTP 状态文本。
        }
        console.warn('[Preview] start failed:', errorMessage);
        previewTerminalFailureRef.current = true;
        setPreviewInitializationMessage(`预览启动失败：${errorMessage}`);
        return false;
      }
      const payload = await r.json();
      const data = payload?.data ?? payload ?? {};
      const nextPreviewUrl =
        typeof data.url === 'string'
          ? data.url
          : typeof data.previewUrl === 'string'
          ? data.previewUrl
          : typeof payload?.url === 'string'
          ? payload.url
          : typeof payload?.previewUrl === 'string'
          ? payload.previewUrl
          : null;
      if (!nextPreviewUrl) {
        throw new Error('预览服务未返回可用地址');
      }

      setPreviewInitializationMessage('预览已就绪');
      previewAutoRecoverySuppressedRef.current = false;
      previewTerminalFailureRef.current = false;
      previewUrlRef.current = nextPreviewUrl;
      setPreviewUrl(nextPreviewUrl);
      setShowPreview(true);
      setMobileWorkspaceView('preview');
      setCurrentRoute('/');
      return true;
    } catch (error) {
      previewTerminalFailureRef.current = true;
      console.warn('[Preview] start request failed:', error);
      setPreviewInitializationMessage(
        error instanceof Error ? `预览启动异常：${error.message}` : '预览启动异常'
      );
      return false;
    } finally {
      if (dependencyProgressTimer) clearTimeout(dependencyProgressTimer);
      if (buildProgressTimer) clearTimeout(buildProgressTimer);
      if (previewStartInFlightRef.current === projectId) {
        previewStartInFlightRef.current = null;
        setIsStartingPreview(false);
      }
    }
  }, [projectId, readGenerationTerminalSnapshot]);

  const reconcileGenerationTerminal = useCallback(async () => {
    if (!projectId) {
      return;
    }

    try {
      const snapshot = await readGenerationTerminalSnapshot();
      if (!snapshot) {
        return;
      }

      const previewPlan = planPreviewReconciliation({
        projectId,
        snapshot,
        currentPreviewUrl: previewUrlRef.current,
        attemptedRecoveryKey: previewAutoRecoveryAttemptRef.current,
      });

      if (previewPlan.action === 'withhold_until_acceptance') {
        previewUrlRef.current = null;
        setPreviewUrl(null);
        setIsStartingPreview(false);
        setIsRunning(true);
        setAgentWorkComplete(false);
        setQuantValidationState('running');
        setQuantValidationMessage('自动检查已完成，正在等待 MoAgent 证据验收。');
        setPreviewInitializationMessage('证据验收通过后才会展示最终看板。');
        return;
      }

      if (previewPlan.action === 'ready') {
        previewAutoRecoverySuppressedRef.current = false;
        previewTerminalFailureRef.current = false;
        setQuantValidationState('passed');
        setQuantValidationMessage('自动验证通过，看板预览已就绪。');
        setAgentWorkComplete(true);
        localStorage.setItem(`project_${projectId}_taskComplete`, 'true');
        if (previewPlan.shouldAdoptUrl) {
          previewUrlRef.current = previewPlan.previewUrl;
          setPreviewUrl(previewPlan.previewUrl);
        }
        setShowPreview(true);
        setMobileWorkspaceView('preview');
        setIsStartingPreview(false);
        setIsRunning(false);
        setPreviewInitializationMessage('预览已就绪');
        return;
      }

      if (previewPlan.action === 'start_once') {
        // Visual-check mode may inspect an already running accepted preview,
        // but must never mutate process state by starting one itself.
        if (isVisualCheck) {
          setPreviewInitializationMessage('已验收看板当前没有运行中的预览。');
          return;
        }
        setQuantValidationState('passed');
        setQuantValidationMessage('自动验证通过，正在恢复持久看板预览。');
        setShowPreview(true);
        setMobileWorkspaceView('preview');
        if (
          !previewAutoRecoverySuppressedRef.current &&
          !previewTerminalFailureRef.current &&
          !previewStartInFlightRef.current
        ) {
          // Record before launching so overlapping status polls cannot enqueue
          // another POST while React state is still settling.
          previewAutoRecoveryAttemptRef.current = previewPlan.attemptKey;
          void start({
            requireValidation: false,
            acceptedSnapshot: snapshot,
          });
        }
        return;
      }

      if (snapshot.status === 'preview_pending') {
        return;
      }

      if (snapshot.status === 'needs_revalidation') {
        setIsRunning(false);
        setAgentWorkComplete(false);
        setQuantValidationState('failed');
        setQuantValidationMessage('看板文件已在任务完成后更新，需要发起新一轮验收。');
        previewUrlRef.current = null;
        setPreviewUrl(null);
        setIsStartingPreview(false);
        setPreviewInitializationMessage('看板已更新，请重新生成并验收后查看最终预览。');
        return;
      }

      if (snapshot.status === 'running') {
        setIsRunning(true);
        setAgentWorkComplete(false);
        setQuantValidationState('running');
        setQuantValidationMessage('当前生成任务尚未完成，正在等待验证和预览终态。');
        if (snapshot.validationStatus === 'pending') {
          previewUrlRef.current = null;
          setPreviewUrl(null);
          if (!hasActiveRequests) {
            void readQuantValidationStatus();
          }
        }
        if (!previewUrlRef.current) {
          setPreviewInitializationMessage('正在生成、验证并准备最终可视化看板...');
        }
        return;
      }

      if (snapshot.status === 'failed') {
        setIsRunning(false);
        setQuantValidationState('failed');
        setQuantValidationMessage(
          snapshot.errorMessage || '生成或自动验证最终失败，请查看执行摘要。',
        );
        previewUrlRef.current = null;
        setPreviewUrl(null);
        setPreviewInitializationMessage(
          snapshot.errorMessage || '生成终态失败，暂时无法展示看板。',
        );
        return;
      }

      if (
        snapshot.status === 'cancelled' ||
        snapshot.status === 'needs_clarification' ||
        snapshot.status === 'refused'
      ) {
        setIsRunning(false);
      }
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('[Generation] terminal reconciliation failed:', error);
      }
    }
  }, [
    hasActiveRequests,
    isVisualCheck,
    projectId,
    readGenerationTerminalSnapshot,
    readQuantValidationStatus,
    start,
  ]);

  // Navigate to specific route in iframe
  const navigateToRoute = (route: string) => {
    if (previewUrl && iframeRef.current) {
      const baseUrl = previewUrl.split('?')[0]; // Remove any query params
      // Ensure route starts with /
      const normalizedRoute = route.startsWith('/') ? route : `/${route}`;
      const newUrl = `${baseUrl}${normalizedRoute}`;
      iframeRef.current.src = newUrl;
      setCurrentRoute(normalizedRoute);
    }
  };

  const refreshPreview = useCallback(() => {
    if (!previewUrl || !iframeRef.current) {
      return;
    }

    try {
      const normalizedRoute =
        currentRoute && currentRoute.startsWith('/')
          ? currentRoute
          : `/${currentRoute || ''}`;
      const baseUrl = previewUrl.split('?')[0] || previewUrl;
      const url = new URL(baseUrl + normalizedRoute);
      url.searchParams.set('_ts', Date.now().toString());
      iframeRef.current.src = url.toString();
    } catch (error) {
      console.warn('Failed to refresh preview iframe:', error);
    }
  }, [previewUrl, currentRoute]);


  const stop = useCallback(async () => {
    try {
      previewAutoRecoverySuppressedRef.current = true;
      await fetch(`${API_BASE}/api/projects/${projectId}/preview/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: 'explicit-user-stop' }),
      });
      previewUrlRef.current = null;
      setPreviewUrl(null);
    } catch (error) {
      console.error('Error stopping preview:', error);
    }
  }, [projectId]);

  const loadSubdirectory = useCallback(async (dir: string): Promise<Entry[]> => {
    try {
      const r = await fetch(`${API_BASE}/api/repo/${projectId}/tree?dir=${encodeURIComponent(dir)}`);
      const data = await r.json();
      return Array.isArray(data) ? data : [];
    } catch (error) {
      console.error('Failed to load subdirectory:', error);
      return [];
    }
  }, [projectId]);

  const loadTree = useCallback(async (dir = '.') => {
    if (projectAvailability.projectId !== projectId || projectAvailability.status !== 'available') {
      return;
    }

    setIsTreeLoading(true);
    setTreeLoadError(null);
    try {
      const r = await fetch(`${API_BASE}/api/repo/${projectId}/tree?dir=${encodeURIComponent(dir)}`);
      if (!r.ok) {
        if (r.status === 404) {
          return;
        }
        throw new Error(`文件树加载失败（HTTP ${r.status}）`);
      }
      const data = await r.json();

      // Ensure data is an array
      if (Array.isArray(data)) {
        setTree(data);
        setHasTreeLoaded(true);

        // Load contents for all directories in the root
        const newFolderContents = new Map();

        // Process each directory
        for (const entry of data) {
          if (entry.type === 'dir') {
            try {
              const subContents = await loadSubdirectory(entry.path);
              newFolderContents.set(entry.path, subContents);
            } catch (err) {
              console.error(`Failed to load contents for ${entry.path}:`, err);
            }
          }
        }

        setFolderContents(newFolderContents);
      } else {
        console.error('Tree data is not an array:', data);
        setTreeLoadError(typeof data?.error === 'string' ? data.error : '文件树返回格式异常');
        setTree([]);
        setHasTreeLoaded(true);
      }

      setCurrentPath(dir);
    } catch (error) {
      console.error('Failed to load tree:', error);
      setTreeLoadError(error instanceof Error ? error.message : '文件树加载失败');
      setTree([]);
      setHasTreeLoaded(true);
    } finally {
      setIsTreeLoading(false);
    }
  }, [projectAvailability, projectId, loadSubdirectory]);

  // Load subdirectory contents

  // Load folder contents
  const handleLoadFolder = useCallback(async (path: string) => {
    const contents = await loadSubdirectory(path);
    setFolderContents(prev => {
      const newMap = new Map(prev);
      newMap.set(path, contents);

      // Also load nested directories
      for (const entry of contents) {
        if (entry.type === 'dir') {
          const fullPath = `${path}/${entry.path}`;
          // Don't load if already loaded
          if (!newMap.has(fullPath)) {
            loadSubdirectory(fullPath).then(subContents => {
              setFolderContents(prev2 => new Map(prev2).set(fullPath, subContents));
            });
          }
        }
      }

      return newMap;
    });
  }, [loadSubdirectory]);

  // Toggle folder expansion
  function toggleFolder(path: string) {
    setExpandedFolders(prev => {
      const newSet = new Set(prev);
      if (newSet.has(path)) {
        newSet.delete(path);
      } else {
        newSet.add(path);
      }
      return newSet;
    });
  }

  // Build tree structure from flat list
  function buildTreeStructure(entries: Entry[]): Map<string, Entry[]> {
    const structure = new Map<string, Entry[]>();

    // Initialize with root
    structure.set('', []);

    entries.forEach(entry => {
      const parts = entry.path.split('/');
      const parentPath = parts.slice(0, -1).join('/');

      if (!structure.has(parentPath)) {
        structure.set(parentPath, []);
      }
      structure.get(parentPath)?.push(entry);

      // If it's a directory, ensure it exists in the structure
      if (entry.type === 'dir') {
        if (!structure.has(entry.path)) {
          structure.set(entry.path, []);
        }
      }
    });

    return structure;
  }

  const openFile = useCallback(async (path: string) => {
    try {
      if (hasUnsavedChanges && path !== selectedFile) {
        const shouldDiscard =
          typeof window !== 'undefined'
            ? window.confirm('You have unsaved changes. Discard them and open the new file?')
            : true;
        if (!shouldDiscard) {
          return;
        }
      }

      setSaveFeedback('idle');
      setSaveError(null);

      const r = await fetch(`${API_BASE}/api/repo/${projectId}/file?path=${encodeURIComponent(path)}`);

      if (!r.ok) {
        console.error('Failed to load file:', r.status, r.statusText);
        const fallback = '// Failed to load file content';
        setContent(fallback);
        setEditedContent(fallback);
        editedContentRef.current = fallback;
        setHasUnsavedChanges(false);
        setSelectedFile(path);
        return;
      }

      const data = await r.json();
      const fileContent = typeof data?.content === 'string' ? data.content : '';
      setContent(fileContent);
      setEditedContent(fileContent);
      editedContentRef.current = fileContent;
      setHasUnsavedChanges(false);
      setSelectedFile(path);
      setIsFileUpdating(false);

      requestAnimationFrame(() => {
        if (editorRef.current) {
          editorRef.current.scrollTop = 0;
          editorRef.current.scrollLeft = 0;
        }
        if (highlightRef.current) {
          highlightRef.current.scrollTop = 0;
          highlightRef.current.scrollLeft = 0;
        }
        if (lineNumberRef.current) {
          lineNumberRef.current.scrollTop = 0;
        }
      });
    } catch (error) {
      console.error('Error opening file:', error);
      const fallback = '// Error loading file';
      setContent(fallback);
      setEditedContent(fallback);
      editedContentRef.current = fallback;
      setHasUnsavedChanges(false);
      setSelectedFile(path);
    }
  }, [projectId, hasUnsavedChanges, selectedFile]);

  // Reload currently selected file
  const reloadCurrentFile = useCallback(async () => {
    if (selectedFile && !showPreview && !hasUnsavedChanges) {
      try {
        const r = await fetch(`${API_BASE}/api/repo/${projectId}/file?path=${encodeURIComponent(selectedFile)}`);
        if (r.ok) {
          const data = await r.json();
          const newContent = data.content || '';
          if (newContent !== content) {
            setIsFileUpdating(true);
            setContent(newContent);
            setEditedContent(newContent);
            editedContentRef.current = newContent;
            setHasUnsavedChanges(false);
            setSaveFeedback('idle');
            setSaveError(null);
            setTimeout(() => setIsFileUpdating(false), 500);
          }
        }
      } catch (error) {
        // Silently fail - this is a background refresh
      }
    }
  }, [projectId, selectedFile, showPreview, hasUnsavedChanges, content]);

  const highlightedCode = useMemo(() => editedContent || ' ', [editedContent]);

  const onEditorChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setEditedContent(value);
    editedContentRef.current = value;
    setHasUnsavedChanges(value !== content);
    setSaveFeedback('idle');
    setSaveError(null);
    if (isFileUpdating) {
      setIsFileUpdating(false);
    }
  }, [content, isFileUpdating]);

  const handleEditorScroll = useCallback((event: UIEvent<HTMLTextAreaElement>) => {
    const { scrollTop, scrollLeft } = event.currentTarget;
    if (highlightRef.current) {
      highlightRef.current.scrollTop = scrollTop;
      highlightRef.current.scrollLeft = scrollLeft;
    }
    if (lineNumberRef.current) {
      lineNumberRef.current.scrollTop = scrollTop;
    }
  }, []);

  const handleSaveFile = useCallback(async () => {
    if (!selectedFile || isSavingFile || !hasUnsavedChanges) {
      return;
    }

    const contentToSave = editedContentRef.current;
    setIsSavingFile(true);
    setSaveFeedback('idle');
    setSaveError(null);

    try {
      const response = await fetch(`${API_BASE}/api/repo/${projectId}/file`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedFile, content: contentToSave }),
      });

      if (!response.ok) {
        let errorMessage = 'Failed to save file';
        try {
          const data = await response.clone().json();
          errorMessage = data?.error || data?.message || errorMessage;
        } catch {
          const text = await response.text().catch(() => '');
          if (text) {
            errorMessage = text;
          }
        }
        throw new Error(errorMessage);
      }

      setContent(contentToSave);
      setSaveFeedback('success');

      if (editedContentRef.current === contentToSave) {
        setHasUnsavedChanges(false);
        setIsFileUpdating(true);
        setTimeout(() => setIsFileUpdating(false), 800);
      }

      refreshPreview();
    } catch (error) {
      console.error('Failed to save file:', error);
      setSaveFeedback('error');
      setSaveError(error instanceof Error ? error.message : 'Failed to save file');
    } finally {
      setIsSavingFile(false);
    }
  }, [selectedFile, isSavingFile, hasUnsavedChanges, projectId, refreshPreview]);

  const handleEditorKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      handleSaveFile();
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      const el = event.currentTarget;
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      const indent = '  ';
      const value = editedContent;
      const newValue = value.slice(0, start) + indent + value.slice(end);

      setEditedContent(newValue);
      editedContentRef.current = newValue;
      setHasUnsavedChanges(newValue !== content);
      setSaveFeedback('idle');
      setSaveError(null);
      if (isFileUpdating) {
        setIsFileUpdating(false);
      }

      requestAnimationFrame(() => {
        const position = start + indent.length;
        el.selectionStart = position;
        el.selectionEnd = position;
        if (highlightRef.current) {
          highlightRef.current.scrollTop = el.scrollTop;
          highlightRef.current.scrollLeft = el.scrollLeft;
        }
        if (lineNumberRef.current) {
          lineNumberRef.current.scrollTop = el.scrollTop;
        }
      });
    }
  }, [handleSaveFile, editedContent, content, isFileUpdating]);

  useEffect(() => {
    if (saveFeedback === 'success') {
      const timer = setTimeout(() => setSaveFeedback('idle'), 1800);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [saveFeedback]);

  useEffect(() => {
    if (editorRef.current && highlightRef.current && lineNumberRef.current) {
      const { scrollTop, scrollLeft } = editorRef.current;
      highlightRef.current.scrollTop = scrollTop;
      highlightRef.current.scrollLeft = scrollLeft;
      lineNumberRef.current.scrollTop = scrollTop;
    }
  }, [editedContent]);

  // Get file extension for syntax highlighting
  function getFileLanguage(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'tsx':
      case 'ts':
        return 'typescript';
      case 'jsx':
      case 'js':
      case 'mjs':
        return 'javascript';
      case 'css':
        return 'css';
      case 'scss':
      case 'sass':
        return 'scss';
      case 'html':
      case 'htm':
        return 'html';
      case 'json':
        return 'json';
      case 'md':
      case 'markdown':
        return 'markdown';
      case 'py':
        return 'python';
      case 'sh':
      case 'bash':
        return 'bash';
      case 'yaml':
      case 'yml':
        return 'yaml';
      case 'xml':
        return 'xml';
      case 'sql':
        return 'sql';
      case 'php':
        return 'php';
      case 'java':
        return 'java';
      case 'c':
        return 'c';
      case 'cpp':
      case 'cc':
      case 'cxx':
        return 'cpp';
      case 'rs':
        return 'rust';
      case 'go':
        return 'go';
      case 'rb':
        return 'ruby';
      case 'vue':
        return 'vue';
      case 'svelte':
        return 'svelte';
      case 'dockerfile':
        return 'dockerfile';
      case 'toml':
        return 'toml';
      case 'ini':
        return 'ini';
      case 'conf':
      case 'config':
        return 'nginx';
      default:
        return 'plaintext';
    }
  }

  // Get file icon based on type
  function getFileIcon(entry: Entry): React.ReactElement {
    if (entry.type === 'dir') {
      return <span className="text-blue-500"><FaFolder size={16} /></span>;
    }

    const ext = entry.path.split('.').pop()?.toLowerCase();
    const filename = entry.path.split('/').pop()?.toLowerCase();

    // Special files
    if (filename === 'package.json') return <span className="text-green-600"><VscJson size={16} /></span>;
    if (filename === 'dockerfile') return <span className="text-blue-400"><FaDocker size={16} /></span>;
    if (filename?.startsWith('.env')) return <span className="text-yellow-500"><FaLock size={16} /></span>;
    if (filename === 'readme.md') return <span className="text-slate-600"><FaMarkdown size={16} /></span>;
    if (filename?.includes('config')) return <span className="text-slate-500"><FaCog size={16} /></span>;

    switch (ext) {
      case 'tsx':
        return <span className="text-cyan-400"><FaReact size={16} /></span>;
      case 'ts':
        return <span className="text-blue-600"><SiTypescript size={16} /></span>;
      case 'jsx':
        return <span className="text-cyan-400"><FaReact size={16} /></span>;
      case 'js':
      case 'mjs':
        return <span className="text-yellow-400"><FaJs size={16} /></span>;
      case 'css':
        return <span className="text-blue-500"><FaCss3Alt size={16} /></span>;
      case 'scss':
      case 'sass':
        return <span className="text-pink-500"><FaCss3Alt size={16} /></span>;
      case 'html':
      case 'htm':
        return <span className="text-orange-500"><FaHtml5 size={16} /></span>;
      case 'json':
        return <span className="text-yellow-600"><VscJson size={16} /></span>;
      case 'md':
      case 'markdown':
        return <span className="text-slate-600"><FaMarkdown size={16} /></span>;
      case 'py':
        return <span className="text-blue-400"><FaPython size={16} /></span>;
      case 'sh':
      case 'bash':
        return <span className="text-green-500"><FaFileCode size={16} /></span>;
      case 'yaml':
      case 'yml':
        return <span className="text-red-500"><SiYaml size={16} /></span>;
      case 'xml':
        return <span className="text-orange-600"><FaFileCode size={16} /></span>;
      case 'sql':
        return <span className="text-blue-600"><FaDatabase size={16} /></span>;
      case 'php':
        return <span className="text-indigo-500"><FaPhp size={16} /></span>;
      case 'java':
        return <span className="text-red-600"><FaJava size={16} /></span>;
      case 'c':
        return <span className="text-blue-700"><FaFileCode size={16} /></span>;
      case 'cpp':
      case 'cc':
      case 'cxx':
        return <span className="text-blue-600"><SiCplusplus size={16} /></span>;
      case 'rs':
        return <span className="text-orange-700"><FaRust size={16} /></span>;
      case 'go':
        return <span className="text-cyan-500"><SiGo size={16} /></span>;
      case 'rb':
        return <span className="text-red-500"><SiRuby size={16} /></span>;
      case 'vue':
        return <span className="text-green-500"><FaVuejs size={16} /></span>;
      case 'svelte':
        return <span className="text-orange-600"><SiSvelte size={16} /></span>;
      case 'dockerfile':
        return <span className="text-blue-400"><FaDocker size={16} /></span>;
      case 'toml':
      case 'ini':
      case 'conf':
      case 'config':
        return <span className="text-slate-500"><FaCog size={16} /></span>;
      default:
        return <span className="text-slate-400"><FaFile size={16} /></span>;
    }
  }

  // Ensure we only trigger dependency installation once per page lifecycle
  const installTriggeredRef = useRef(false);

  const startDependencyInstallation = useCallback(async () => {
    if (installTriggeredRef.current) {
      return;
    }
    installTriggeredRef.current = true;
    try {
      const response = await fetch(`${API_BASE}/api/projects/${projectId}/install-dependencies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn('⚠️ Failed to start dependency installation:', errorText);
        // allow retry on next attempt if initial trigger failed
        installTriggeredRef.current = false;
      }
    } catch (error) {
      console.error('❌ Error starting dependency installation:', error);
      // allow retry if network error
      installTriggeredRef.current = false;
    }
  }, [projectId]);

  const loadSettings = useCallback(async (projectSettings?: { cli?: string; model?: string }) => {
    try {
      console.log('🔧 loadSettings called with project settings:', projectSettings);

      const hasCliSet = projectSettings?.cli || preferredCli;
      const hasModelSet = projectSettings?.model || selectedModel;

      if (!hasCliSet || !hasModelSet) {
        console.log('⚠️ Missing CLI or model, loading global settings');
        const globalResponse = await fetch(`${API_BASE}/api/settings/global`);
        if (globalResponse.ok) {
          const globalSettings = await globalResponse.json();
          const defaultCli = sanitizeCli(globalSettings.default_cli || globalSettings.defaultCli);
          const cliToUse = sanitizeCli(hasCliSet || defaultCli);

          if (!hasCliSet) {
            console.log('🔄 Setting CLI from global:', cliToUse);
            updatePreferredCli(cliToUse);
          }

          if (!hasModelSet) {
            const cliSettings = globalSettings.cli_settings?.[cliToUse] || globalSettings.cliSettings?.[cliToUse];
            if (cliSettings?.model) {
              updateSelectedModel(cliSettings.model, cliToUse);
            } else {
              updateSelectedModel(getDefaultModelForCli(cliToUse), cliToUse);
            }
          }
        } else {
          const response = await fetch(`${API_BASE}/api/settings`);
          if (response.ok) {
            const settings = await response.json();
            if (!hasCliSet) updatePreferredCli(settings.preferred_cli || settings.default_cli || DEFAULT_ACTIVE_CLI);
            if (!hasModelSet) {
              const cli = sanitizeCli(settings.preferred_cli || settings.default_cli || preferredCli || DEFAULT_ACTIVE_CLI);
              updateSelectedModel(getDefaultModelForCli(cli), cli);
            }
          }
        }
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
      const hasCliSet = projectSettings?.cli || preferredCli;
      const hasModelSet = projectSettings?.model || selectedModel;
      if (!hasCliSet) updatePreferredCli(DEFAULT_ACTIVE_CLI);
      if (!hasModelSet) updateSelectedModel(getDefaultModelForCli(DEFAULT_ACTIVE_CLI), DEFAULT_ACTIVE_CLI);
    }
  }, [preferredCli, selectedModel, updatePreferredCli, updateSelectedModel]);

  const loadProjectInfo = useCallback(async (): Promise<{ cli?: string; model?: string; status?: ProjectStatus; missing?: boolean }> => {
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}`);
      if (!r.ok) {
        if (r.status === 404) {
          setProjectAvailability({ projectId, status: 'missing' });
          router.replace('/');
          return { missing: true };
        }
        throw new Error(`项目加载失败（HTTP ${r.status}）`);
      }

      const payload = await r.json();
      const project = payload?.data ?? payload;
      setProjectAvailability({ projectId, status: 'available' });
      const rawPreferredCli =
        typeof project?.preferredCli === 'string'
          ? project.preferredCli
          : typeof project?.preferred_cli === 'string'
          ? project.preferred_cli
          : undefined;
      const rawSelectedModel =
        typeof project?.selectedModel === 'string'
          ? project.selectedModel
          : typeof project?.selected_model === 'string'
          ? project.selected_model
          : undefined;

      console.log('📋 Loading project info:', {
        preferredCli: rawPreferredCli,
        selectedModel: rawSelectedModel,
      });

      setProjectName(project.name || `Project ${projectId.slice(0, 8)}`);

      const projectCli = sanitizeCli(rawPreferredCli || preferredCli);
      if (rawPreferredCli) {
        updatePreferredCli(projectCli);
      }
      if (rawSelectedModel) {
        updateSelectedModel(rawSelectedModel, projectCli);
      } else {
        updateSelectedModel(getDefaultModelForCli(projectCli), projectCli);
      }

      const followGlobal = !rawPreferredCli && !rawSelectedModel;
      setUsingGlobalDefaults(followGlobal);
      setProjectDescription(project.description || '');
      // Project.previewUrl and a passing validation report may describe a
      // provisional MoAgent preview. Only the Mission-aware generation/status
      // reconciliation below is allowed to expose or recover it.

      if (project.initial_prompt) {
        setHasInitialPrompt(true);
        localStorage.setItem(`project_${projectId}_hasInitialPrompt`, 'true');
      } else {
        setHasInitialPrompt(false);
        localStorage.setItem(`project_${projectId}_hasInitialPrompt`, 'false');
      }

      if (project.status === 'initializing') {
        setProjectStatus('initializing');
        setIsInitializing(true);
      } else {
        setProjectStatus('active');
        setIsInitializing(false);
        if (!isVisualCheck) {
          startDependencyInstallation();
          triggerInitialPromptIfNeeded();
        }
      }

      const normalizedModel = rawSelectedModel
        ? sanitizeModel(projectCli, rawSelectedModel)
        : getDefaultModelForCli(projectCli);

      return {
        cli: rawPreferredCli ? projectCli : undefined,
        model: normalizedModel,
        status: project.status as ProjectStatus | undefined,
      };
    } catch (error) {
      console.error('Failed to load project info:', error);
      setProjectAvailability({ projectId, status: 'error' });
      setIsInitializing(false);
      return {};
    }
  }, [
    projectId,
    isVisualCheck,
    startDependencyInstallation,
    triggerInitialPromptIfNeeded,
    updatePreferredCli,
    updateSelectedModel,
    preferredCli,
    router,
  ]);

  const loadProjectInfoRef = useRef(loadProjectInfo);
  useEffect(() => {
    loadProjectInfoRef.current = loadProjectInfo;
  }, [loadProjectInfo]);

  useEffect(() => {
    if (!searchParams) return;
    const cliParam = searchParams.get('cli');
    const modelParam = searchParams.get('model');
    if (!cliParam && !modelParam) {
      return;
    }
    const sanitizedCli = cliParam ? sanitizeCli(cliParam) : preferredCli;
    if (cliParam) {
      setUsingGlobalDefaults(false);
      updatePreferredCli(sanitizedCli);
    }
    if (modelParam) {
      setUsingGlobalDefaults(false);
      updateSelectedModel(modelParam, sanitizedCli);
    }
  }, [searchParams, preferredCli, updatePreferredCli, updateSelectedModel, setUsingGlobalDefaults]);

  const loadSettingsRef = useRef(loadSettings);
  useEffect(() => {
    loadSettingsRef.current = loadSettings;
  }, [loadSettings]);

  const loadTreeRef = useRef(loadTree);
  useEffect(() => {
    loadTreeRef.current = loadTree;
  }, [loadTree]);

  useEffect(() => {
    previewStartInFlightRef.current = null;
    previewAutoRecoveryAttemptRef.current = null;
    previewUrlRef.current = null;
    previewAutoRecoverySuppressedRef.current = false;
    previewTerminalFailureRef.current = false;
    setIsStartingPreview(false);
    setPreviewUrl(null);
    setProjectAvailability({ projectId, status: 'checking' });
    setTree([]);
    setFolderContents(new Map());
    setExpandedFolders(new Set(['']));
    setSelectedFile('');
    setHasTreeLoaded(false);
    setTreeLoadError(null);
  }, [projectId]);

  const loadDeployStatusRef = useRef(loadDeployStatus);
  useEffect(() => {
    loadDeployStatusRef.current = loadDeployStatus;
  }, [loadDeployStatus]);

  const checkCurrentDeploymentRef = useRef(checkCurrentDeployment);
  useEffect(() => {
    checkCurrentDeploymentRef.current = checkCurrentDeployment;
  }, [checkCurrentDeployment]);

  // Stable message handlers with useCallback to prevent reassignment
  const createStableMessageHandlers = useCallback(() => {
    const addMessage = (message: any) => {
      console.log('🔄 [StableHandler] Adding message via stable handler:', {
        messageId: message.id,
        role: message.role,
        isOptimistic: message.isOptimistic,
        requestId: message.requestId
      });

      // Track optimistic messages by requestId
      if (message.isOptimistic && message.requestId) {
        optimisticMessagesRef.current.set(message.requestId, message);
        console.log('🔄 [StableHandler] Tracking optimistic message:', {
          requestId: message.requestId,
          tempId: message.id
        });
      }

      // Also call the current handlers if they exist
      if (messageHandlersRef.current) {
        messageHandlersRef.current.add(message);
      }
    };

    const removeMessage = (messageId: string) => {
      console.log('🔄 [StableHandler] Removing message via stable handler:', messageId);

      // Remove from optimistic messages tracking if it's an optimistic message
      const optimisticMessage = Array.from(optimisticMessagesRef.current.values())
        .find(msg => msg.id === messageId);
      if (optimisticMessage && optimisticMessage.requestId) {
        optimisticMessagesRef.current.delete(optimisticMessage.requestId);
        console.log('🔄 [StableHandler] Removed optimistic message tracking:', {
          requestId: optimisticMessage.requestId,
          tempId: messageId
        });
      }

      // Also call the current handlers if they exist
      if (messageHandlersRef.current) {
        messageHandlersRef.current.remove(messageId);
      }
    };

    return { add: addMessage, remove: removeMessage };
  }, []);

  // Initialize stable handlers once
  useEffect(() => {
    stableMessageHandlers.current = createStableMessageHandlers();
    const optimisticMessages = optimisticMessagesRef.current;

    return () => {
      stableMessageHandlers.current = null;
      optimisticMessages.clear();
    };
  }, [createStableMessageHandlers]);

  // Handle image upload with base64 conversion
  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files) {
      Array.from(files).forEach(file => {
        if (file.type.startsWith('image/')) {
          const url = URL.createObjectURL(file);

          // Convert to base64
          const reader = new FileReader();
          reader.onload = (e) => {
            const base64 = e.target?.result as string;
            setUploadedImages(prev => [...prev, {
              name: file.name,
              url,
              base64
            }]);
          };
          reader.readAsDataURL(file);
        }
      });
    }
  };

  // Remove uploaded image
  const removeUploadedImage = (index: number) => {
    setUploadedImages(prev => {
      const newImages = [...prev];
      URL.revokeObjectURL(newImages[index].url);
      newImages.splice(index, 1);
      return newImages;
    });
  };

  async function runAct(
    messageOverride?: string,
    externalImages?: RunActImage[],
    modeOverride?: 'act' | 'chat',
  ) {
    const visibleMessage = (messageOverride || prompt).trim();
    let finalMessage = visibleMessage;
    const imagesToUse: RunActImage[] = externalImages || uploadedImages;
    const effectiveMode = modeOverride ?? mode;

    if (!finalMessage.trim() && imagesToUse.length === 0) {
      alert('Please enter a task description or upload an image.');
      return;
    }

    finalMessage = buildQuestionInstruction(finalMessage, effectiveMode);

    // Create request fingerprint for deduplication
    const requestFingerprint = JSON.stringify({
      message: visibleMessage,
      imageCount: imagesToUse.length,
      cliPreference: preferredCli,
      model: selectedModel,
      mode: effectiveMode,
    });

    // Check for duplicate pending requests
    if (pendingRequestsRef.current.has(requestFingerprint)) {
      console.log('🔄 [DEBUG] Duplicate request detected, skipping:', requestFingerprint);
      return;
    }

    setIsRunning(true);
    setAgentWorkComplete(false);
    previewAutoRecoverySuppressedRef.current = false;
    previewAutoRecoveryAttemptRef.current = null;
    previewTerminalFailureRef.current = false;
    previewUrlRef.current = null;
    setPreviewUrl(null);
    setPreviewInitializationMessage('正在准备数据和可视化看板，验证通过后自动展示...');
    const requestId = crypto.randomUUID();
    let tempUserMessageId: string | null = null;
    let requestAccepted = false;

    // Add to pending requests
    pendingRequestsRef.current.add(requestFingerprint);

    try {
      const uploadImageFromBase64 = async (img: { base64: string; name?: string }) => {
        const base64String = img.base64;
        const match = base64String.match(/^data:(.*?);base64,(.*)$/);
        const mimeType = match && match[1] ? match[1] : 'image/png';
        const base64Data = match && match[2] ? match[2] : base64String;

        const byteString = atob(base64Data);
        const buffer = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i += 1) {
          buffer[i] = byteString.charCodeAt(i);
        }

        const extension = (() => {
          if (mimeType.includes('png')) return 'png';
          if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
          if (mimeType.includes('gif')) return 'gif';
          if (mimeType.includes('webp')) return 'webp';
          if (mimeType.includes('svg')) return 'svg';
          return 'png';
        })();

        const inferredName = img.name && img.name.trim().length > 0 ? img.name.trim() : `image-${crypto.randomUUID()}.${extension}`;
        const hasExtension = /\.[a-zA-Z0-9]+$/.test(inferredName);
        const filename = hasExtension ? inferredName : `${inferredName}.${extension}`;

        const file = new File([buffer], filename, { type: mimeType });
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch(`${API_BASE}/api/assets/${projectId}/upload`, {
          method: 'POST',
          body: formData
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(errorText || 'Upload failed');
        }

        const result = await response.json();
        return {
          name: result.filename || filename,
          path: result.path,
          url: `/api/assets/${projectId}/${result.filename}`,
          public_url: typeof result.public_url === 'string' ? result.public_url : undefined,
          publicUrl: typeof result.public_url === 'string' ? result.public_url : undefined,
        };
      };

      console.log('🖼️ Processing images in runAct:', {
          imageCount: imagesToUse.length,
          cli: preferredCli,
          requestId
        });
      const processedImages: { name: string; path: string; url?: string; public_url?: string; publicUrl?: string }[] = [];

      for (let i = 0; i < imagesToUse.length; i += 1) {
        const image = imagesToUse[i];
        console.log(`🖼️ Processing image ${i}:`, {
          id: image.id,
          filename: image.filename,
          hasPath: !!image.path,
          hasPublicUrl: !!image.publicUrl,
          hasAssetUrl: !!image.assetUrl
        });
        if (image?.path) {
          const name = image.filename || image.name || `Image ${i + 1}`;
          const candidateUrl = typeof image.assetUrl === 'string' ? image.assetUrl : undefined;
          const candidatePublicUrl = typeof image.publicUrl === 'string' ? image.publicUrl : undefined;
          const processedImage = {
            name,
            path: image.path,
            url: candidateUrl && candidateUrl.startsWith('/') ? candidateUrl : undefined,
            public_url: candidatePublicUrl,
            publicUrl: candidatePublicUrl,
          };
          console.log(`🖼️ Created processed image ${i}:`, processedImage);
          processedImages.push(processedImage);
          continue;
        }

        if (image?.base64) {
          try {
            const uploaded = await uploadImageFromBase64({ base64: image.base64, name: image.name });
            processedImages.push(uploaded);
          } catch (uploadError) {
            console.error('Image upload failed:', uploadError);
            alert('Failed to upload image. Please try again.');
            setIsRunning(false);
            // Remove from pending requests
            pendingRequestsRef.current.delete(requestFingerprint);
            return;
          }
        }
      }

      const requestBody = {
        instruction: finalMessage,
        displayInstruction: visibleMessage,
        images: processedImages,
        isInitialPrompt: false,
        cliPreference: preferredCli,
        conversationId: conversationId || undefined,
        requestId,
        selectedModel,
      };

      console.log('📸 Sending request to act API:', {
        messageLength: finalMessage.length,
        imageCount: processedImages.length,
        cli: preferredCli,
        requestId,
        images: processedImages.map(img => ({
          name: img.name,
          hasPath: !!img.path,
          hasUrl: !!img.url,
          hasPublicUrl: !!img.publicUrl
        }))
      });

      // Optimistically add user message to UI BEFORE API call for instant feedback
      tempUserMessageId = requestId + '-user-temp';
      if (messageHandlersRef.current) {
        const optimisticUserMessage = {
          id: tempUserMessageId,
          projectId: projectId,
          role: 'user' as const,
          messageType: 'chat' as const,
          content: visibleMessage,
          conversationId: conversationId || null,
          requestId: requestId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          isStreaming: false,
          isFinal: false,
          isOptimistic: true,
          metadata:
            processedImages.length > 0
              ? {
                  attachments: processedImages.map((img) => ({
                    name: img.name,
                    path: img.path,
                    url: img.url,
                    publicUrl: img.publicUrl ?? img.public_url,
                  })),
                }
              : undefined,
        };
        console.log('🔄 [Optimistic] Adding optimistic user message via stable handler:', {
          tempId: tempUserMessageId,
          requestId,
          content: finalMessage.substring(0, 50) + '...'
        });

        // Use stable handlers instead of direct messageHandlersRef to prevent reassignment issues
        if (stableMessageHandlers.current) {
          stableMessageHandlers.current.add(optimisticUserMessage);
        } else if (messageHandlersRef.current) {
          // Fallback to direct handlers if stable handlers aren't ready yet
          messageHandlersRef.current.add(optimisticUserMessage);
        }
      }

      // Add timeout to prevent indefinite waiting
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);

      let r: Response;
      try {
        r = await fetch(`${API_BASE}/api/chat/${projectId}/act`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!r.ok) {
          const errorText = await r.text();
          console.error('API Error:', errorText);

          if (tempUserMessageId) {
            console.log('🔄 [Optimistic] Removing optimistic user message due to API error via stable handler:', tempUserMessageId);
            if (stableMessageHandlers.current) {
              stableMessageHandlers.current.remove(tempUserMessageId);
            } else if (messageHandlersRef.current) {
              messageHandlersRef.current.remove(tempUserMessageId);
            }
          }

          alert(`Failed to send message: ${r.status} ${r.statusText}\n${errorText}`);
          return;
        }
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          if (tempUserMessageId) {
            console.log('🔄 [Optimistic] Removing optimistic user message due to timeout via stable handler:', tempUserMessageId);
            if (stableMessageHandlers.current) {
              stableMessageHandlers.current.remove(tempUserMessageId);
            } else if (messageHandlersRef.current) {
              messageHandlersRef.current.remove(tempUserMessageId);
            }
          }

          alert('Request timed out after 60 seconds. Please check your connection and try again.');
          return;
        }
        throw fetchError;
      }

      const result = await r.json();
      requestAccepted =
        result?.status !== 'intent_clarification_required' &&
        result?.status !== 'intent_refused' &&
        result?.status !== 'cancelled';

      console.log('📸 Act API response received:', {
        success: result.success,
        userMessageId: result.userMessageId,
        conversationId: result.conversationId,
        requestId: result.requestId,
        hasAttachments: processedImages.length > 0
      });

      const returnedConversationId =
        typeof result?.conversationId === 'string'
          ? result.conversationId
          : typeof result?.conversation_id === 'string'
          ? result.conversation_id
          : undefined;
      if (returnedConversationId) {
        setConversationId(returnedConversationId);
      }

      const resolvedRequestId =
        typeof result?.requestId === 'string'
          ? result.requestId
          : typeof result?.request_id === 'string'
          ? result.request_id
          : requestId;
      const userMessageId =
        typeof result?.userMessageId === 'string'
          ? result.userMessageId
          : typeof result?.user_message_id === 'string'
          ? result.user_message_id
          : '';

      createRequest(resolvedRequestId, userMessageId, finalMessage, effectiveMode);

      // Refresh data after completion
      await loadTree('.');

      // Reset prompt and uploaded images
      setPrompt('');
      // Clean up old format images if any
      if (uploadedImages && uploadedImages.length > 0) {
        uploadedImages.forEach(img => {
          if (img.url) URL.revokeObjectURL(img.url);
        });
        setUploadedImages([]);
      }

    } catch (error: any) {
      console.error('Act execution error:', error);

      if (tempUserMessageId) {
        console.log('🔄 [Optimistic] Removing optimistic user message due to execution error via stable handler:', tempUserMessageId);
        if (stableMessageHandlers.current) {
          stableMessageHandlers.current.remove(tempUserMessageId);
        } else if (messageHandlersRef.current) {
          messageHandlersRef.current.remove(tempUserMessageId);
        }
      }

      const errorMessage = error?.message || String(error);
      alert(`Failed to send message: ${errorMessage}\n\nPlease try again. If the problem persists, check the console for details.`);
    } finally {
      if (!requestAccepted) {
        setIsRunning(false);
      }
      // Remove from pending requests
      pendingRequestsRef.current.delete(requestFingerprint);
    }
  }

  useEffect(() => {
    runActRef.current = runAct;
  });

  useEffect(() => {
    queuedFollowUpsRef.current = queuedFollowUps;
  }, [queuedFollowUps]);

  useEffect(() => {
    if (generationBusy || queueDispatchingRef.current || queuedFollowUps.length === 0) return;

    const timer = window.setTimeout(() => {
      const next = queuedFollowUpsRef.current[0];
      if (!next || !runActRef.current) return;
      queueDispatchingRef.current = true;
      setQueuedFollowUps((current) => current.filter((item) => item.id !== next.id));
      void runActRef.current(next.message, next.images, next.mode).finally(() => {
        queueDispatchingRef.current = false;
      });
    }, 250);

    return () => window.clearTimeout(timer);
  }, [generationBusy, queuedFollowUps.length]);

  useEffect(() => {
    setQueuedFollowUps([]);
    queuedFollowUpsRef.current = [];
    queueDispatchingRef.current = false;
  }, [projectId]);

  const pauseAgent = useCallback(async () => {
    if (isPausingAgent) {
      return;
    }

    setIsPausingAgent(true);
    try {
      const response = await fetch(`${API_BASE}/api/chat/${projectId}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: '用户暂停了当前任务' }),
      });

      if (!response.ok) {
        let message = '暂停失败';
        try {
          const payload = await response.json();
          message = payload?.message || payload?.error || message;
        } catch {
          message = response.statusText || message;
        }
        throw new Error(message);
      }

      setIsRunning(false);
      setAgentWorkComplete(false);
      setPreviewInitializationMessage('任务已暂停。');
      pendingRequestsRef.current.clear();
    } catch (error) {
      console.warn('[Chat] failed to pause agent:', error);
      alert(error instanceof Error ? error.message : '暂停失败，请稍后重试。');
    } finally {
      setIsPausingAgent(false);
    }
  }, [isPausingAgent, projectId]);


  // Handle project status updates via callback from ChatLog
  const handleProjectStatusUpdate = (
    status: string,
    message?: string,
    metadata?: Record<string, unknown>,
  ) => {
    const previousStatus = projectStatus;

    if (status === 'validation_running') {
      setIsRunning(true);
      setQuantValidationState('running');
      setQuantValidationMessage(message ?? '正在执行自动验证。');
      setQuantRepairPlan(null);
      setPreviewInitializationMessage(message ?? '正在执行自动验证，验证通过后展示看板。');
      return;
    }

    if (status === 'agent_execution_completed' || status === 'agent_execution_failed') {
      setIsRunning(true);
      setAgentWorkComplete(false);
      setQuantValidationState('running');
      setQuantValidationMessage(
        status === 'agent_execution_failed'
          ? 'Agent 执行异常结束，正在验证已生成产物并尝试自动修复。'
          : 'Agent 代码执行完成，正在进行自动验证。',
      );
      setPreviewInitializationMessage(
        status === 'agent_execution_failed'
          ? 'Agent 执行异常，正在验证现有看板产物...'
          : '代码生成完成，正在验证并准备最终看板...',
      );
      return;
    }

    if (status === 'validation_repairing' || status === 'validation_repair_failed') {
      setIsRunning(true);
      setQuantValidationState('running');
      setQuantValidationMessage(message ?? '自动验证未通过，正在修复看板产物。');
      setPreviewInitializationMessage(message ?? '正在自动修复并重新验证看板...');
      return;
    }

    if (status === 'preview_starting') {
      setIsRunning(true);
      setQuantValidationState('passed');
      setQuantValidationMessage('自动验证通过，正在确认持久看板预览。');
      setPreviewInitializationMessage(message ?? '正在启动并确认持久看板预览...');
      setShowPreview(true);
      setMobileWorkspaceView('preview');
      return;
    }

    if (status === 'agent_paused') {
      setIsRunning(false);
      setIsPausingAgent(false);
      setPreviewInitializationMessage(message ?? '任务已暂停。');
      pendingRequestsRef.current.clear();
      return;
    }

    if (status === 'validation_failed') {
      const terminalFailure = metadata?.terminalFailure === true;
      previewStartInFlightRef.current = null;
      previewUrlRef.current = null;
      setQuantValidationState('failed');
      setQuantValidationMessage(
        message ??
          (terminalFailure
            ? '自动验证最终未通过，请查看验证摘要。'
            : '自动验证未通过，正在等待自动修复。'),
      );
      setPreviewUrl(null);
      setIsStartingPreview(false);
      setIsRunning(!terminalFailure);
      setPreviewInitializationMessage(
        message ??
          (terminalFailure
            ? '自动验证最终未通过，暂不展示可视化看板。'
            : '自动验证未通过，正在自动修复看板。'),
      );
      return;
    }

    if (status === 'preview_failed') {
      previewStartInFlightRef.current = null;
      previewTerminalFailureRef.current = true;
      previewUrlRef.current = null;
      setQuantValidationState('passed');
      setQuantValidationMessage(
        message ?? '自动验证已通过，但持久看板预览启动失败。',
      );
      setPreviewUrl(null);
      setIsStartingPreview(false);
      setIsRunning(false);
      setPreviewInitializationMessage(
        message ?? '看板代码已验证通过，但预览服务启动失败。请点击重试。',
      );
      return;
    }

    if (status === 'validation_passed') {
      const readyPreviewUrl =
        typeof metadata?.previewUrl === 'string' && metadata.previewUrl.trim().length > 0
          ? metadata.previewUrl.trim()
          : null;
      setQuantValidationState('running');
      setQuantValidationMessage(
        message ?? (readyPreviewUrl ? '正在确认看板验收终态。' : '自动检查已通过，正在等待证据验收。'),
      );
      setQuantRepairPlan(null);
      if (readyPreviewUrl) {
        setShowPreview(true);
        setMobileWorkspaceView('preview');
        setPreviewInitializationMessage('正在核对 Mission 验收凭据与最终预览...');
        void reconcileGenerationTerminal();
        return;
      }

      setPreviewInitializationMessage('证据验收通过后才会展示最终看板。');
      return;
    }

    // Ignore if status is the same (prevent duplicates)
    if (previousStatus === status) {
      return;
    }

    setProjectStatus(status as ProjectStatus);
    if (message) {
      setInitializationMessage(message);
    }

    // If project becomes active, stop showing loading UI
    if (status === 'active') {
      setIsInitializing(false);

      // Handle only when transitioning from initializing → active
      if (previousStatus === 'initializing') {

        // Start dependency installation
        if (!isVisualCheck) {
          startDependencyInstallation();
        }
        loadTreeRef.current?.('.');
      }

      // Initial prompt: trigger once with shared guard (handles active-via-WS case)
      if (!isVisualCheck) {
        triggerInitialPromptIfNeeded();
      }
    } else if (status === 'failed') {
      setIsInitializing(false);
    }
  };

  // Function to start dependency installation in background
  const handleRetryInitialization = async () => {
    setProjectStatus('initializing');
    setIsInitializing(true);
    setInitializationMessage('Retrying project initialization...');

    try {
      const response = await fetch(`${API_BASE}/api/projects/${projectId}/retry-initialization`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error('Failed to retry initialization');
      }
    } catch (error) {
      console.error('Failed to retry initialization:', error);
      setProjectStatus('failed');
      setInitializationMessage('Failed to retry initialization. Please try again.');
    }
  };

  // Load states from localStorage when projectId changes
  useEffect(() => {
    if (typeof window !== 'undefined' && projectId) {
      const storedHasInitialPrompt = localStorage.getItem(`project_${projectId}_hasInitialPrompt`);
      const storedTaskComplete = localStorage.getItem(`project_${projectId}_taskComplete`);

      if (storedHasInitialPrompt !== null) {
        setHasInitialPrompt(storedHasInitialPrompt === 'true');
      }
      if (storedTaskComplete !== null) {
        setAgentWorkComplete(storedTaskComplete === 'true');
      }
    }
  }, [projectId]);

  // Load the file tree on demand when the user opens code view.
  useEffect(() => {
    if (!projectId || showPreview || hasTreeLoaded || isTreeLoading) {
      return;
    }

    void loadTree('.');
  }, [projectId, showPreview, hasTreeLoaded, isTreeLoading, loadTree]);

  // Poll for file changes in code view
  useEffect(() => {
    if (!showPreview && selectedFile && !hasUnsavedChanges) {
      const interval = setInterval(() => {
        reloadCurrentFile();
      }, 2000); // Check every 2 seconds

      return () => clearInterval(interval);
    }
  }, [showPreview, selectedFile, hasUnsavedChanges, reloadCurrentFile]);


  useEffect(() => {
    if (!projectId) {
      return;
    }

    let canceled = false;

    const initializeChat = async () => {
      try {
        const projectSettings = await loadProjectInfoRef.current?.();
        if (canceled) return;
        if (projectSettings?.missing) return;

        await loadSettingsRef.current?.(projectSettings);
        if (canceled) return;

        await loadTreeRef.current?.('.');
        if (canceled) return;

        await loadDeployStatusRef.current?.();
        if (canceled) return;

        checkCurrentDeploymentRef.current?.();
      } catch (error) {
        console.error('Failed to initialize chat view:', error);
      }
    };

    initializeChat();

    const handleServicesUpdate = () => {
      loadDeployStatusRef.current?.();
    };

    window.addEventListener('services-updated', handleServicesUpdate);

    return () => {
      canceled = true;
      window.removeEventListener('services-updated', handleServicesUpdate);
    };
  }, [projectId]);

  // Reconcile against durable generation/validation/preview state so a lost
  // realtime event, tab refresh, or platform restart cannot strand the UI on
  // the placeholder after a dashboard is actually ready.
  useEffect(() => {
    if (!projectId) {
      return;
    }

    void reconcileGenerationTerminal();
    const interval = window.setInterval(
      () => void reconcileGenerationTerminal(),
      generationBusy || !previewUrl ? 2_000 : 10_000,
    );

    return () => window.clearInterval(interval);
  }, [
    generationBusy,
    isVisualCheck,
    previewUrl,
    projectId,
    reconcileGenerationTerminal,
  ]);

  // Cleanup pending requests on unmount
  useEffect(() => {
    const pendingRequests = pendingRequestsRef.current;
    return () => {
      pendingRequests.clear();
    };
  }, []);

  // React to global settings changes when using global defaults
  const { settings: globalSettings } = useGlobalSettings();
  useEffect(() => {
    if (!usingGlobalDefaults) return;
    if (!globalSettings) return;

    const cli = sanitizeCli(globalSettings.default_cli);
    updatePreferredCli(cli);

    const modelFromGlobal = globalSettings.cli_settings?.[cli]?.model;
    if (modelFromGlobal) {
      updateSelectedModel(modelFromGlobal, cli);
    } else {
      updateSelectedModel(getDefaultModelForCli(cli), cli);
    }
  }, [globalSettings, usingGlobalDefaults, updatePreferredCli, updateSelectedModel]);


  // Show loading UI if project is initializing

  if (currentProjectAvailability !== 'available') {
    const statusMessage = currentProjectAvailability === 'missing'
      ? '项目不存在，正在返回首页…'
      : currentProjectAvailability === 'error'
        ? '项目暂时无法加载，请返回首页后重试。'
        : '正在载入项目…';
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-center">
        <div>
          {currentProjectAvailability === 'error' ? (
            <button
              type="button"
              onClick={() => router.replace('/')}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              返回首页
            </button>
          ) : (
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" aria-hidden="true" />
          )}
          <p className="mt-4 text-sm font-medium text-foreground">{statusMessage}</p>
        </div>
      </main>
    );
  }

  return (
    <>
      <style jsx global>{`
        .qp-code-preview {
          color: #374151;
        }
      `}</style>

      <div className="chat-workspace workspace-studio relative flex h-dvh flex-col overflow-hidden" role="main">
        {isChatPaneResizing && (
          <div className="fixed inset-0 z-[100] cursor-col-resize" aria-hidden="true" />
        )}

        <header className="workspace-topbar hidden h-14 shrink-0 items-center justify-between px-3 lg:flex">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => router.push('/')}
              aria-label="返回项目首页"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-background/80 text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-primary"
            >
              <FaArrowLeft size={13} />
            </button>
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#ee6b4d] to-[#d84d35] text-sm font-bold text-white shadow-[0_8px_20px_-10px_rgba(224,83,57,0.8)]">
              Q
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="max-w-[28rem] truncate text-sm font-bold text-foreground">
                  {projectName || '正在载入项目...'}
                </h1>
                <span className="hidden rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground xl:inline-flex">
                  QUANT STUDIO
                </span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {projectDescription || '对话、数据、代码与可视化协同工作台'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="mr-1 inline-flex h-8 items-center gap-2 rounded-full border border-border/70 bg-background/75 px-3 text-[11px] font-semibold text-muted-foreground shadow-sm">
              <span className="relative flex h-2 w-2" aria-hidden="true">
                {generationBusy ? (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-50 motion-reduce:animate-none" />
                ) : null}
                <span className={`relative inline-flex h-2 w-2 rounded-full ${generationBusy ? 'bg-amber-500' : previewUrl ? 'bg-emerald-500' : 'bg-slate-400'}`} />
              </span>
              {generationBusy ? '正在生成' : previewUrl ? '看板已就绪' : '等待任务'}
            </div>
            <ThemeToggle compact />
            <button
              type="button"
              onClick={() => setShowGlobalSettings(true)}
              aria-label="打开项目设置"
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/70 bg-background/80 text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-primary"
            >
              <FaCog size={14} />
            </button>
            <a
              href={previewUrl ?? '#'}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="在新窗口打开看板"
              aria-disabled={!previewUrl}
              onClick={(event) => {
                if (!previewUrl) event.preventDefault();
              }}
              className={`flex h-9 items-center gap-2 rounded-xl px-3 text-xs font-semibold transition-colors ${
                previewUrl
                  ? 'bg-foreground text-background shadow-sm hover:opacity-85'
                  : 'cursor-not-allowed bg-muted text-muted-foreground/45'
              }`}
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              打开看板
            </a>
          </div>
        </header>

        <nav
          className="workspace-mobile-nav flex h-12 shrink-0 items-center gap-1 border-b border-border/70 bg-background/95 px-2 backdrop-blur lg:hidden"
          aria-label="移动端工作区视图"
        >
          {([
            { id: 'chat', label: '对话', icon: MessageSquareText },
            { id: 'preview', label: '看板', icon: MonitorPlay },
            { id: 'files', label: '文件', icon: Files },
          ] as const).map((item) => {
            const Icon = item.icon;
            const active = mobileWorkspaceView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setMobileWorkspaceView(item.id);
                  if (item.id === 'preview') setShowPreview(true);
                  if (item.id === 'files') {
                    setShowPreview(false);
                    if (!hasTreeLoaded && !isTreeLoading) void loadTree('.');
                  }
                }}
                className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  active
                    ? 'bg-primary/10 text-primary shadow-sm ring-1 ring-primary/20'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {item.label}
              </button>
            );
          })}
          <a
            href={previewUrl ?? '#'}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="在新窗口全屏打开看板"
            aria-disabled={!previewUrl}
            onClick={(event) => {
              if (!previewUrl) event.preventDefault();
            }}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors ${
              previewUrl
                ? 'border-border bg-card text-foreground hover:border-primary/40 hover:text-primary'
                : 'cursor-not-allowed border-border/60 bg-muted/40 text-muted-foreground/40'
            }`}
            title={previewUrl ? '全屏打开看板' : '看板尚未就绪'}
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </nav>

        <div className="workspace-body flex min-h-0 w-full flex-1">
          {/* Left: Chat window */}
          <div
            ref={chatPaneRef}
            style={{ '--chat-pane-width': `${chatPaneWidth}px` } as CSSProperties}
            className={`chat-pane workspace-panel relative z-10 h-full shrink-0 flex-col bg-background/95 backdrop-blur-xl ${
              mobileWorkspaceView === 'chat' ? 'flex' : 'hidden lg:flex'
            }`}
          >
            {/* Chat header */}
            <div className="platform-header flex h-16 shrink-0 items-center justify-between gap-3 px-3 lg:h-12 sm:px-4">
              <div className="flex min-w-0 items-center gap-3 lg:hidden">
                <button
                  onClick={() => router.push('/')}
                  aria-label="返回项目首页"
                  className="flex items-center justify-center w-8 h-8 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-full transition-colors"
                  title="Back to home"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M19 12H5M12 19L5 12L12 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-sm">Q</div>
                <div className="min-w-0">
                  <h1 className="truncate text-sm font-bold text-foreground">{projectName || '正在载入项目...'}</h1>
                  {projectDescription && (
                    <p className="truncate text-xs text-muted-foreground">
                      {projectDescription}
                    </p>
                  )}
                </div>
              </div>
              <div className="hidden min-w-0 items-center gap-2 lg:flex">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <MessageSquareText className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-xs font-bold text-foreground">研究对话</p>
                  <p className="text-[10px] text-muted-foreground">需求、过程与证据</p>
                </div>
              </div>
              <ThemeToggle className="lg:hidden" compact />
            </div>

            {/* Chat log area */}
            <div className="flex-1 min-h-0">
              <ChatErrorBoundary>
                <ChatLog
                  projectId={projectId}
                  onAddUserMessage={(handlers) => {
                    console.log('🔄 [HandlerSetup] ChatLog provided new handlers, updating references');
                    messageHandlersRef.current = handlers;

                    // Also update stable handlers if they exist
                    if (stableMessageHandlers.current) {
                      console.log('🔄 [HandlerSetup] Updating stable handlers reference');
                      // Note: stableMessageHandlers.current already has its own add/remove logic
                      // We don't replace it completely, just keep the reference to handlers
                    }
                  }}
                onSessionStatusChange={(isRunningValue) => {
                  console.log('🔍 [DEBUG] Session status change:', isRunningValue);
                  setIsRunning(isRunningValue);
                }}
                onSseFallbackActive={(active) => {
                  console.log('🔄 [SSE] Fallback status:', active);
                  setIsSseFallbackActive(active);
                }}
                onProjectStatusUpdate={handleProjectStatusUpdate}
                startRequest={startRequest}
                completeRequest={completeRequest}
              />
              </ChatErrorBoundary>
            </div>

            {/* Simple input area */}
            <div className="shrink-0 border-t border-border/60 bg-background/72 p-2.5 backdrop-blur sm:p-3">
              <ChatInput
                onSendMessage={(message, images) => {
                  if (generationBusy) {
                    const queued: QueuedFollowUp = {
                      id: crypto.randomUUID(),
                      message,
                      images: images ?? [],
                      mode,
                    };
                    queuedFollowUpsRef.current = [...queuedFollowUpsRef.current, queued];
                    setQueuedFollowUps(queuedFollowUpsRef.current);
                    return;
                  }
                  void runAct(message, images, mode);
                }}
                disabled={false}
                placeholder={mode === 'act' ? "向 QuantPilot 描述你的量化需求..." : "和 QuantPilot 讨论项目细节..."}
                mode={mode}
                onModeChange={setMode}
                projectId={projectId}
                projectName={projectName}
                preferredCli={preferredCli}
                selectedModel={selectedModel}
                modelOptions={modelOptions}
                onModelChange={handleModelChange}
                modelChangeDisabled={isUpdatingModel}
                cliOptions={cliOptions}
                onCliChange={handleCliChange}
                cliChangeDisabled={isUpdatingModel}
                isRunning={generationBusy}
                onPause={pauseAgent}
                isPausing={isPausingAgent}
                queuedMessages={queuedFollowUps.map(({ id, message }) => ({ id, message }))}
                onRemoveQueuedMessage={(queuedId) => {
                  setQueuedFollowUps((current) => {
                    const removed = current.find((item) => item.id === queuedId);
                    removed?.images.forEach((image) => {
                      if (image.url.startsWith('blob:')) URL.revokeObjectURL(image.url);
                    });
                    const next = current.filter((item) => item.id !== queuedId);
                    queuedFollowUpsRef.current = next;
                    return next;
                  });
                }}
              />
            </div>

            <div
              role="separator"
              aria-label="调整对话区和看板区宽度"
              aria-orientation="vertical"
              aria-valuemin={CHAT_PANE_MIN_WIDTH}
              aria-valuemax={CHAT_PANE_MAX_WIDTH}
              aria-valuenow={chatPaneWidth}
              tabIndex={0}
              title="左右拖动调整对话区宽度；双击恢复默认"
              onPointerDown={startChatPaneResize}
              onDoubleClick={resetChatPaneWidth}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft') {
                  event.preventDefault();
                  persistChatPaneWidth(chatPaneWidthRef.current - 24);
                }
                if (event.key === 'ArrowRight') {
                  event.preventDefault();
                  persistChatPaneWidth(chatPaneWidthRef.current + 24);
                }
                if (event.key === 'Home') {
                  event.preventDefault();
                  resetChatPaneWidth();
                }
              }}
              className={`absolute -right-2.5 top-0 z-30 hidden h-full w-5 touch-none cursor-col-resize items-center justify-center outline-none lg:flex after:h-14 after:w-1 after:rounded-full after:bg-border/80 after:shadow-sm after:transition-[height,background-color,opacity] hover:after:h-24 hover:after:bg-primary/70 focus-visible:after:h-24 focus-visible:after:bg-primary/70 ${
                isChatPaneResizing ? 'after:h-24 after:bg-primary' : ''
              }`}
            />
          </div>

          {/* Right: Preview/Code area */}
          <div className={`preview-pane workspace-panel h-full flex-col ${mobileWorkspaceView === 'chat' ? 'hidden lg:flex' : 'flex'}`}>
            {/* Content area */}
            <div className="flex-1 min-h-0 flex flex-col">
              {/* Controls Bar */}
              <div className="platform-header flex h-16 shrink-0 items-center justify-between px-3 sm:px-4 lg:h-12">
                <div className="flex items-center gap-3">
                  {/* Toggle switch */}
                  <div className="hidden items-center rounded-xl border border-border/70 bg-muted/55 p-1 lg:flex">
                    <button
                    className={`flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition-colors ${
                      showPreview
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                      onClick={() => {
                        setShowPreview(true);
                        setMobileWorkspaceView('preview');
                      }}
                      aria-label="显示看板预览"
                    >
                      <span className="flex h-4 w-4 items-center justify-center"><FaDesktop size={14} /></span>
                      <span className="hidden xl:inline">看板</span>
                    </button>
                    <button
                      className={`flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition-colors ${
                        !showPreview
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                      onClick={() => {
                        setShowPreview(false);
                        setMobileWorkspaceView('files');
                        if (!hasTreeLoaded && !isTreeLoading) {
                          void loadTree('.');
                        }
                      }}
                      aria-label="显示项目文件"
                    >
                      <span className="flex h-4 w-4 items-center justify-center"><FaCode size={14} /></span>
                      <span className="hidden xl:inline">文件</span>
                    </button>
                  </div>

                  {/* Center Controls */}
                  {showPreview && shouldShowPreviewFrame && (
                    <div className="flex min-w-0 items-center gap-2">
                      {/* Route Navigation */}
                      <div className="hidden h-8 min-w-0 items-center rounded-xl border border-border/70 bg-background/70 px-2.5 shadow-sm min-[1180px]:flex">
                        <span className="mr-2 text-muted-foreground">
                          <FaHome size={12} />
                        </span>
                        <span className="mr-1 text-sm text-muted-foreground">/</span>
                        <input
                          type="text"
                          value={currentRoute.startsWith('/') ? currentRoute.slice(1) : currentRoute}
                          aria-label="看板预览路由"
                          onChange={(e) => {
                            const value = e.target.value;
                            setCurrentRoute(value ? `/${value}` : '/');
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              navigateToRoute(currentRoute);
                            }
                          }}
                          className="w-28 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground xl:w-36"
                          placeholder="页面路径"
                        />
                        <button
                          onClick={() => navigateToRoute(currentRoute)}
                          aria-label="打开预览路由"
                          className="ml-2 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <FaArrowRight size={12} />
                        </button>
                      </div>

                      {/* Action Buttons Group */}
                      <div className="flex items-center gap-1.5">
                        <button
                          className="flex h-8 w-8 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground shadow-sm transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-primary"
                          aria-label="刷新看板预览"
                          onClick={() => {
                            const iframe = document.querySelector('iframe');
                            if (iframe) {
                              iframe.src = iframe.src;
                            }
                          }}
                          title="刷新预览"
                        >
                          <FaRedo size={14} />
                        </button>

                        {/* Device Mode Toggle */}
                        <div className="flex h-8 items-center gap-0.5 rounded-xl border border-border/70 bg-muted/55 p-0.5">
                          <button
                            aria-label="桌面端预览"
                            className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                              deviceMode === 'desktop'
                                ? 'bg-background text-primary shadow-sm'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                            onClick={() => setDeviceMode('desktop')}
                          >
                            <FaDesktop size={14} />
                          </button>
                          <button
                            aria-label="移动端预览"
                            className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                              deviceMode === 'mobile'
                                ? 'bg-background text-primary shadow-sm'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                            onClick={() => setDeviceMode('mobile')}
                          >
                            <FaMobileAlt size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {/* Settings Button */}
                  <button
                    onClick={() => setShowGlobalSettings(true)}
                    aria-label="打开项目设置"
                    className="flex h-8 w-8 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground shadow-sm transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-primary lg:hidden"
                    title="项目设置"
                  >
                    <FaCog size={16} />
                  </button>

                  {/* Stop Button */}
                  {showPreview && shouldShowPreviewFrame && (
                    <button
                      className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-xl border border-red-200 bg-red-50 px-2.5 text-xs font-semibold text-red-600 transition-colors hover:bg-red-100 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950/70"
                      onClick={stop}
                    >
                      <FaStop size={12} />
                      停止
                    </button>
                  )}

                  {/* Publish/Update */}
                  {showPreview && shouldShowPreviewFrame && (
                    <div className="relative">
                    <button
                      className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-xl bg-foreground px-3 text-xs font-semibold text-background shadow-sm transition-opacity hover:opacity-85"
                      onClick={() => setShowPublishPanel(true)}
                    >
                      <FaRocket size={14} />
                      发布
                      {deploymentStatus === 'deploying' && (
                        <span className="ml-2 inline-block w-2 h-2 rounded-full bg-amber-400"></span>
                      )}
                      {deploymentStatus === 'ready' && (
                        <span className="ml-2 inline-block w-2 h-2 rounded-full bg-emerald-400"></span>
                      )}
                    </button>
                    {false && showPublishPanel && (
                      <div className="absolute right-0 mt-2 w-80 bg-white rounded-xl shadow-xl border border-slate-200 z-50 p-5">
                        <h3 className="text-lg font-semibold text-slate-900 mb-4">Publish Project</h3>

                        {/* Deployment Status Display */}
                        {deploymentStatus === 'deploying' && (
                          <div className="mb-4 p-4 bg-blue-50 rounded-lg border border-blue-200 ">
                            <div className="flex items-center gap-2 mb-2">
                              <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                              <p className="text-sm font-medium text-blue-700 ">Deployment in progress...</p>
                            </div>
                            <p className="text-xs text-blue-600 ">Building and deploying your project. This may take a few minutes.</p>
                          </div>
                        )}

                        {deploymentStatus === 'ready' && publishedUrl && (
                          <div className="mb-4 p-4 bg-green-50 rounded-lg border border-green-200 ">
                            <p className="text-sm font-medium text-green-700 mb-2">Currently published at:</p>
                            <a
                              href={publishedUrl ?? undefined}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sm text-green-600 font-mono hover:underline break-all"
                            >
                              {publishedUrl}
                            </a>
                          </div>
                        )}

                        {deploymentStatus === 'error' && (
                          <div className="mb-4 p-4 bg-red-50 rounded-lg border border-red-200 ">
                            <p className="text-sm font-medium text-red-700 mb-2">Deployment failed</p>
                            <p className="text-xs text-red-600 ">There was an error during deployment. Please try again.</p>
                          </div>
                        )}

                        <div className="space-y-4">
                          {!githubConnected || !vercelConnected ? (
                            <div className="p-4 bg-amber-50 rounded-lg border border-amber-200 ">
                              <p className="text-sm font-medium text-slate-900 mb-3">To publish, connect the following services:</p>
                              <div className="space-y-2">
                                {!githubConnected && (
                                  <div className="flex items-center gap-2 text-amber-700 ">
                                    <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                      <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                                    </svg>
                                    <span className="text-sm">GitHub repository not connected</span>
                                  </div>
                                )}
                                {!vercelConnected && (
                                  <div className="flex items-center gap-2 text-amber-700 ">
                                    <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                      <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                                    </svg>
                                    <span className="text-sm">Vercel project not connected</span>
                                  </div>
                                )}
                              </div>
                              <p className="mt-3 text-sm text-slate-600 ">
                                Go to
                                <button
                                  onClick={() => {
                                    setShowPublishPanel(false);
                                    setShowGlobalSettings(true);
                                  }}
                                  className="text-indigo-600 hover:text-indigo-500 underline font-medium mx-1"
                                >
                                  Settings → Service Integrations
                                </button>
                                to connect.
                              </p>
                            </div>
                          ) : null}

                          <button
                            disabled={publishLoading || deploymentStatus === 'deploying' || !githubConnected || !vercelConnected}
                            onClick={async () => {
                              console.log('🚀 Publish started');

                              setPublishLoading(true);
                              try {
                                // Push to GitHub
                                console.log('🚀 Pushing to GitHub...');
                                const pushRes = await fetch(`${API_BASE}/api/projects/${projectId}/github/push`, { method: 'POST' });
                                if (!pushRes.ok) {
                                  const errorText = await pushRes.text();
                                  console.error('🚀 GitHub push failed:', errorText);
                                  throw new Error(errorText);
                                }

                                // Deploy to Vercel
                                console.log('🚀 Deploying to Vercel...');
                                const deployUrl = `${API_BASE}/api/projects/${projectId}/vercel/deploy`;

                                const vercelRes = await fetch(deployUrl, {
                                  method: 'POST'
                                });
                                if (!vercelRes.ok) {
                                  const responseText = await vercelRes.text();
                                  console.error('🚀 Vercel deploy failed:', responseText);
                                }
                                if (vercelRes.ok) {
                                  const data = await vercelRes.json();
                                  console.log('🚀 Deployment started, polling for status...');

                                  // Set deploying status BEFORE ending publishLoading to prevent gap
                                  setDeploymentStatus('deploying');

                                  if (data.deployment_id) {
                                    startDeploymentPolling(data.deployment_id);
                                  }

                                  // Only set URL if deployment is already ready
                                  if (data.status === 'READY' && data.deployment_url) {
                                    const url = data.deployment_url.startsWith('http') ? data.deployment_url : `https://${data.deployment_url}`;
                                    setPublishedUrl(url);
                                    setDeploymentStatus('ready');
                                  }
                                } else {
                                  const errorText = await vercelRes.text();
                                  console.error('🚀 Vercel deploy failed:', vercelRes.status, errorText);
                                  // if Vercel not connected, just close
                                  setDeploymentStatus('idle');
                                  setPublishLoading(false); // Stop loading even on Vercel deployment failure
                                }
                                // Keep panel open to show deployment progress
                              } catch (e) {
                                console.error('🚀 Publish failed:', e);
                                alert('Publish failed. Check Settings and tokens.');
                                setDeploymentStatus('idle');
                                setPublishLoading(false); // Stop loading on error
                                // Close panel after error
                                setTimeout(() => {
                                  setShowPublishPanel(false);
                                }, 1000);
                              } finally {
                                loadDeployStatus();
                              }
                            }}
                            className={`w-full px-4 py-3 rounded-lg font-medium text-white transition-colors ${
                              publishLoading || deploymentStatus === 'deploying' || !githubConnected || !vercelConnected
                                ? 'bg-slate-400 cursor-not-allowed'
                                : 'bg-indigo-600 hover:bg-indigo-700 '
                            }`}
                          >
                            {publishLoading
                              ? 'Publishing...'
                              : deploymentStatus === 'deploying'
                              ? 'Deploying...'
                              : !githubConnected || !vercelConnected
                              ? 'Connect Services First'
                              : deploymentStatus === 'ready' && publishedUrl ? 'Update' : 'Publish'
                            }
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  )}
                </div>
              </div>

              {/* Content Area */}
              <div className="workspace-preview-canvas relative flex-1 overflow-hidden p-2 sm:p-3">
                <AnimatePresence initial={false}>
                  {showPreview ? (
                  <MotionDiv
                    key="preview"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="overflow-hidden rounded-[1.125rem] border border-border/70 bg-background shadow-xl shadow-slate-900/5"
                    style={{ height: '100%' }}
                  >
                {shouldShowPreviewFrame ? (
                  <div className="relative flex h-full w-full items-center justify-center bg-muted/55 p-0 sm:p-2">
                    <div
                      className={`relative bg-white ${
                        deviceMode === 'mobile'
                          ? 'h-[min(667px,calc(100%_-_1rem))] aspect-[375/667] max-w-[calc(100%_-_1rem)] rounded-[28px] border-[7px] border-slate-900 shadow-2xl'
                          : 'h-full w-full rounded-xl border border-border/70 shadow-sm'
                      } overflow-hidden`}
                    >
                      <iframe
                        ref={iframeRef}
                        className="w-full h-full border-none bg-white "
                        src={previewUrl ?? undefined}
                        onError={() => {
                          // Show error overlay
                          const overlay = document.getElementById('iframe-error-overlay');
                          if (overlay) overlay.style.display = 'flex';
                        }}
                        onLoad={() => {
                          // Hide error overlay when loaded successfully
                          const overlay = document.getElementById('iframe-error-overlay');
                          if (overlay) overlay.style.display = 'none';
                        }}
                      />

                      {/* Error overlay */}
                    <div
                      id="iframe-error-overlay"
                      className="absolute inset-0 bg-slate-50 flex items-center justify-center z-10"
                      style={{ display: 'none' }}
                    >
                      <div className="text-center max-w-md mx-auto p-6">
                        <div className="text-4xl mb-4">🔄</div>
                        <h3 className="text-lg font-semibold text-slate-800 mb-2">
                          预览连接异常
                        </h3>
                        <p className="text-slate-600 mb-4">
                          看板暂时未能加载，请刷新预览后重试。
                        </p>
                        <button
                          className="flex items-center gap-2 mx-auto px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
                          onClick={() => {
                            const iframe = document.querySelector('iframe');
                            if (iframe) {
                              iframe.src = iframe.src;
                            }
                            const overlay = document.getElementById('iframe-error-overlay');
                            if (overlay) overlay.style.display = 'none';
                          }}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M1 4v6h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                          立即刷新
                        </button>
                      </div>
                    </div>
                    </div>
                  </div>
                ) : (
                  <div className="relative flex h-full w-full items-center justify-center bg-background">
                    {/* Gradient background similar to main page */}
                    <div className="absolute inset-0">
                      <div className="absolute inset-0 bg-white " />
                      <div
                        className="absolute inset-0 hidden transition-all duration-1000 ease-in-out"
                        style={{
                          background: `radial-gradient(circle at 50% 100%,
                            ${activeBrandColor}66 0%,
                            ${activeBrandColor}4D 25%,
                            ${activeBrandColor}33 50%,
                            transparent 70%)`
                        }}
                      />
                      {/* Light mode gradient - subtle */}
                      <div
                        className="absolute inset-0 block transition-all duration-1000 ease-in-out"
                        style={{
                          background: `radial-gradient(circle at 50% 100%,
                            ${activeBrandColor}40 0%,
                            ${activeBrandColor}26 25%,
                            transparent 50%)`
                        }}
                      />
                    </div>

                    {/* Content with z-index to be above gradient */}
                    <div className="relative z-10 w-full h-full flex items-center justify-center">
                    {isStartingPreview ? (
                      <DashboardGenerationWaiting
                        mode="preview"
                        message={previewInitializationMessage}
                        accentColor={activeBrandColor}
                      />
                    ) : (
                    <div className={generationBusy ? 'h-full w-full text-center' : 'text-center'}>
                      <MotionDiv
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.6, ease: "easeOut" }}
                        className={generationBusy ? 'flex h-full w-full items-center justify-center' : undefined}
                      >
                        {generationBusy ? (
                          <DashboardGenerationWaiting
                            mode="generating"
                            message={previewInitializationMessage}
                            accentColor={activeBrandColor}
                          />
                        ) : (
                          <>
                            <div
                              onClick={!isRunning && !isStartingPreview ? () => start({ requireValidation: true }) : undefined}
                              className={`w-40 h-40 mx-auto mb-6 relative ${!isRunning && !isStartingPreview ? 'cursor-pointer group' : ''}`}
                            >
                              {/* QuantPilot 启动动画图标 */}
                              <MotionDiv
                                className="w-full h-full"
                                animate={isStartingPreview ? { rotate: 360 } : {}}
                                transition={{ duration: 6, repeat: isStartingPreview ? Infinity : 0, ease: "linear" }}
                              >
                                <div
                                  className="w-full h-full"
                                  style={{
                                    backgroundColor: activeBrandColor,
                                    mask: 'url(/Symbol_white.png) no-repeat center/contain',
                                    WebkitMask: 'url(/Symbol_white.png) no-repeat center/contain',
                                    opacity: 0.9
                                  }}
                                />
                              </MotionDiv>

                              {/* Icon in Center - Play or Loading */}
                              <div className="absolute inset-0 flex items-center justify-center">
                                {isStartingPreview ? (
                                  <div
                                    className="w-14 h-14 border-4 rounded-full animate-spin"
                                    style={{
                                      borderTopColor: 'transparent',
                                      borderRightColor: activeBrandColor,
                                      borderBottomColor: activeBrandColor,
                                      borderLeftColor: activeBrandColor,
                                    }}
                                  />
                                ) : (
                                  <MotionDiv
                                    className="flex items-center justify-center"
                                    whileHover={{ scale: 1.2 }}
                                    whileTap={{ scale: 0.9 }}
                                  >
                                    <FaPlay
                                      size={32}
                                    />
                                  </MotionDiv>
                                )}
                              </div>
                            </div>

                            <h3 className="text-2xl font-bold text-slate-900 mb-3">
                              {quantValidationState === 'failed' ? '看板验证未通过' : '看板待生成'}
                            </h3>

                            <p className="text-slate-600 max-w-lg mx-auto">
                              {quantValidationState === 'failed'
                                ? quantValidationMessage ?? '自动验证未通过，暂不展示可视化看板。'
                                : quantValidationState === 'running'
                                ? '正在执行自动验证，验证通过后会自动展示最终可视化结果'
                                : '数据获取、页面生成和验证完成后会自动展示最终可视化结果'}
                            </p>
                            {quantValidationState === 'failed' && quantRepairPlan?.steps?.length ? (
                              <div className="mt-5 w-full max-w-2xl rounded-lg border border-red-100 bg-red-50/70 p-4 text-left shadow-sm">
                                <div className="flex items-center justify-between gap-3">
                                  <p className="text-sm font-semibold text-red-900">自动修复计划</p>
                                  {quantRepairPlan.repairPlanPath ? (
                                    <code className="rounded bg-white/80 px-2 py-1 text-xs text-red-700">
                                      {quantRepairPlan.repairPlanPath}
                                    </code>
                                  ) : null}
                                </div>
                                <div className="mt-3 space-y-3">
                                  {quantRepairPlan.steps.slice(0, 3).map((step, index) => (
                                    <div key={`${step.checkId ?? step.checkName ?? index}-${index}`} className="rounded-md bg-white/80 p-3">
                                      <div className="flex items-start gap-2">
                                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-100 text-xs font-semibold text-red-700">
                                          {index + 1}
                                        </span>
                                        <div className="min-w-0">
                                          <p className="text-sm font-semibold text-slate-900">
                                            {step.checkName || step.checkId || '失败检查项'}
                                          </p>
                                          {step.summary ? (
                                            <p className="mt-1 text-xs leading-5 text-slate-600">{step.summary}</p>
                                          ) : null}
                                          {Array.isArray(step.actions) && step.actions.length > 0 ? (
                                            <ul className="mt-2 space-y-1 text-xs leading-5 text-slate-600">
                                              {step.actions.slice(0, 2).map((action, actionIndex) => (
                                                <li key={`${actionIndex}-${action}`} className="flex gap-2">
                                                  <span className="text-red-400">-</span>
                                                  <span>{action}</span>
                                                </li>
                                              ))}
                                            </ul>
                                          ) : null}
                                        </div>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                          </>
                        )}
                      </MotionDiv>
                    </div>
                    )}
                    </div>
                  </div>
                )}
                  </MotionDiv>
                ) : (
              <MotionDiv
                key="code"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex h-full overflow-hidden rounded-[1.125rem] border border-border/70 bg-white shadow-xl shadow-slate-900/5"
              >
                {/* Left Sidebar - File Explorer (VS Code style) */}
                <div className="w-64 flex-shrink-0 bg-slate-50 border-r border-slate-200 flex flex-col">
                  {/* File Tree */}
                  <div className="flex-1 overflow-y-auto bg-slate-50 custom-scrollbar">
                    {isTreeLoading ? (
                      <div className="px-3 py-8 text-center text-[11px] text-slate-500 select-none">
                        Loading files...
                      </div>
                    ) : treeLoadError ? (
                      <div className="space-y-3 px-3 py-8 text-center text-[11px] text-slate-600 select-none">
                        <p>Failed to load files</p>
                        <p className="break-words text-slate-400">{treeLoadError}</p>
                        <button
                          type="button"
                          onClick={() => void loadTree('.')}
                          className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                        >
                          Retry
                        </button>
                      </div>
                    ) : hasTreeLoaded && (!tree || tree.length === 0) ? (
                      <div className="px-3 py-8 text-center text-[11px] text-slate-600 select-none">
                        No files found
                      </div>
                    ) : !hasTreeLoaded ? (
                      <div className="px-3 py-8 text-center text-[11px] text-slate-500 select-none">
                        Loading files...
                      </div>
                    ) : (
                      <TreeView
                        entries={tree || []}
                        selectedFile={selectedFile}
                        expandedFolders={expandedFolders}
                        folderContents={folderContents}
                        onToggleFolder={toggleFolder}
                        onSelectFile={openFile}
                        onLoadFolder={handleLoadFolder}
                        level={0}
                        parentPath=""
                        getFileIcon={getFileIcon}
                      />
                    )}
                  </div>
                </div>

                {/* Right Editor Area */}
                <div className="flex-1 flex flex-col bg-white min-w-0">
                  {selectedFile ? (
                    <>
                      {/* File Tab */}
                      <div className="flex-shrink-0 bg-slate-100 ">
                        <div className="flex items-center gap-3 bg-white px-3 py-1.5 border-t-2 border-t-blue-500 ">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="w-4 h-4 flex items-center justify-center">
                              {getFileIcon(tree.find(e => e.path === selectedFile) || { path: selectedFile, type: 'file' })}
                            </span>
                            <span className="truncate text-[13px] text-slate-700 " style={{ fontFamily: "'Segoe UI', Tahoma, sans-serif" }}>
                              {selectedFile.split('/').pop()}
                            </span>
                          </div>
                          {hasUnsavedChanges && (
                            <span className="text-[11px] text-amber-600 ">
                              • Unsaved changes
                            </span>
                          )}
                          {!hasUnsavedChanges && saveFeedback === 'success' && (
                            <span className="text-[11px] text-green-600 ">
                              Saved
                            </span>
                          )}
                          {saveFeedback === 'error' && (
                            <span
                              className="text-[11px] text-red-600 truncate max-w-[160px]"
                              title={saveError ?? 'Failed to save file'}
                            >
                              Save error
                            </span>
                          )}
                          {!hasUnsavedChanges && saveFeedback !== 'success' && isFileUpdating && (
                            <span className="text-[11px] text-green-600 ">
                              Updated
                            </span>
                          )}
                          <div className="ml-auto flex items-center gap-2">
                            <button
                              className="px-3 py-1 text-xs font-medium rounded bg-blue-500 text-white hover:bg-blue-600 disabled:bg-slate-300 disabled:text-slate-600 disabled:cursor-not-allowed "
                              onClick={handleSaveFile}
                              disabled={!hasUnsavedChanges || isSavingFile}
                              title="Save (Ctrl+S)"
                            >
                              {isSavingFile ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              className="text-slate-700 hover:bg-slate-200 px-1 rounded"
                              onClick={() => {
                                if (hasUnsavedChanges) {
                                  const confirmClose =
                                    typeof window !== 'undefined'
                                      ? window.confirm('You have unsaved changes. Close without saving?')
                                      : true;
                                  if (!confirmClose) {
                                    return;
                                  }
                                }
                                setSelectedFile('');
                                setContent('');
                                setEditedContent('');
                                editedContentRef.current = '';
                                setHasUnsavedChanges(false);
                                setSaveFeedback('idle');
                                setSaveError(null);
                                setIsFileUpdating(false);
                              }}
                            >
                              ×
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Code Editor */}
                      <div className="flex-1 overflow-hidden">
                        <div className="w-full h-full flex bg-white overflow-hidden">
                          {/* Line Numbers */}
                          <div
                            ref={lineNumberRef}
                            className="bg-slate-50 px-3 py-4 select-none flex-shrink-0 overflow-y-auto overflow-x-hidden custom-scrollbar pointer-events-none"
                            aria-hidden="true"
                          >
                            <div className="text-[13px] font-mono text-slate-500 leading-[19px]">
                              {(editedContent || '').split('\n').map((_, index) => (
                                <div key={index} className="text-right pr-2">
                                  {index + 1}
                                </div>
                              ))}
                            </div>
                          </div>
                          {/* Code Content */}
                          <div className="relative flex-1">
                            <pre
                              ref={highlightRef}
                              aria-hidden="true"
                              className="absolute inset-0 m-0 p-4 overflow-hidden text-[13px] leading-[19px] font-mono text-slate-800 whitespace-pre pointer-events-none"
                              style={{ fontFamily: "'Fira Code', 'Consolas', 'Monaco', monospace" }}
                            >
                              <code className="qp-code-preview language-plaintext">{highlightedCode}</code>
                              <span className="block h-full min-h-[1px]" />
                            </pre>
                            <textarea
                              ref={editorRef}
                              value={editedContent}
                              onChange={onEditorChange}
                              onScroll={handleEditorScroll}
                              onKeyDown={handleEditorKeyDown}
                              spellCheck={false}
                              autoCorrect="off"
                              autoCapitalize="none"
                              autoComplete="off"
                              wrap="off"
                              aria-label="Code editor"
                              className="absolute inset-0 w-full h-full resize-none bg-transparent text-transparent caret-slate-800 outline-none font-mono text-[13px] leading-[19px] p-4 whitespace-pre overflow-auto custom-scrollbar"
                              style={{ fontFamily: "'Fira Code', 'Consolas', 'Monaco', monospace" }}
                            />
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    /* Welcome Screen */
                    <div className="flex-1 flex items-center justify-center bg-white ">
                      <div className="text-center">
                        <span className="w-16 h-16 mb-4 opacity-10 text-slate-400 mx-auto flex items-center justify-center"><FaCode size={64} /></span>
                        <h3 className="text-lg font-medium text-slate-700 mb-2">
                          Welcome to Code Editor
                        </h3>
                        <p className="text-sm text-slate-500 ">
                          Select a file from the explorer to start viewing code
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </MotionDiv>
                )}
                </AnimatePresence>
              </div>
            </div>
          </div>
        </div>
      </div>


      {/* Publish Modal */}
      {showPublishPanel && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowPublishPanel(false)} />
          <div className="relative w-full max-w-lg bg-white border border-slate-200 rounded-2xl shadow-2xl overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/60 ">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white bg-black border border-black/10 ">
                  <FaRocket size={14} />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-slate-900 ">Publish Project</h3>
                  <p className="text-xs text-slate-600 ">Deploy with Vercel, linked to your GitHub repo</p>
                </div>
              </div>
              <button onClick={() => setShowPublishPanel(false)} className="text-slate-400 hover:text-slate-600 ">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              </button>
            </div>

            <div className="p-6 space-y-4">
              {deploymentStatus === 'deploying' && (
                <div className="p-4 rounded-xl border border-blue-200 bg-blue-50 ">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                    <p className="text-sm font-medium text-blue-700 ">Deployment in progress…</p>
                  </div>
                  <p className="text-xs text-blue-700/80 ">Building and deploying your project. This may take a few minutes.</p>
                </div>
              )}

              {deploymentStatus === 'ready' && publishedUrl && (
                <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50 ">
                  <p className="text-sm font-medium text-emerald-700 mb-2">Published successfully</p>
                  <div className="flex items-center gap-2">
                    <a href={publishedUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-mono text-emerald-700 underline break-all flex-1">
                      {publishedUrl}
                    </a>
                    <button
                      onClick={() => navigator.clipboard?.writeText(publishedUrl)}
                      className="px-2 py-1 text-xs rounded-lg border border-emerald-300/80 text-emerald-700 hover:bg-emerald-100 "
                    >
                      Copy
                    </button>
                  </div>
                </div>
              )}

              {deploymentStatus === 'error' && (
                <div className="p-4 rounded-xl border border-red-200 bg-red-50 ">
                  <p className="text-sm font-medium text-red-700 ">Deployment failed. Please try again.</p>
                </div>
              )}

              {!githubConnected || !vercelConnected ? (
                <div className="p-4 rounded-xl border border-amber-200 bg-amber-50 ">
                  <p className="text-sm font-medium text-slate-900 mb-2">Connect the following services:</p>
                  <div className="space-y-1 text-amber-700 text-sm">
                    {!githubConnected && (<div className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-amber-500"/>GitHub repository not connected</div>)}
                    {!vercelConnected && (<div className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-amber-500"/>Vercel project not connected</div>)}
                  </div>
                  <button
                    className="mt-3 w-full px-4 py-2 rounded-xl border border-slate-200 text-slate-800 hover:bg-slate-50 "
                    onClick={() => { setShowPublishPanel(false); setShowGlobalSettings(true); }}
                  >
                    Open Settings → Services
                  </button>
                </div>
              ) : null}

              <button
                disabled={publishLoading || deploymentStatus === 'deploying' || !githubConnected || !vercelConnected}
                onClick={async () => {
                  try {
                    setPublishLoading(true);
                    setDeploymentStatus('deploying');
                    // 1) Push to GitHub to ensure branch/commit exists
                    try {
                      const pushRes = await fetch(`${API_BASE}/api/projects/${projectId}/github/push`, { method: 'POST' });
                      if (!pushRes.ok) {
                        const err = await pushRes.text();
                        console.error('🚀 GitHub push failed:', err);
                        throw new Error(err);
                      }
                    } catch (e) {
                      console.error('🚀 GitHub push step failed', e);
                      throw e;
                    }
                    // Small grace period to let GitHub update default branch
                    await new Promise(r => setTimeout(r, 800));
                    // 2) Deploy to Vercel (branch auto-resolved on server)
                    const deployUrl = `${API_BASE}/api/projects/${projectId}/vercel/deploy`;
                    const vercelRes = await fetch(deployUrl, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ branch: 'main' })
                    });
                    if (vercelRes.ok) {
                      const data = await vercelRes.json();
                      setDeploymentStatus('deploying');
                      if (data.deployment_id) startDeploymentPolling(data.deployment_id);
                      if (data.ready && data.deployment_url) {
                        const url = data.deployment_url.startsWith('http') ? data.deployment_url : `https://${data.deployment_url}`;
                        setPublishedUrl(url);
                        setDeploymentStatus('ready');
                      }
                    } else {
                      const errorText = await vercelRes.text();
                      console.error('🚀 Vercel deploy failed:', vercelRes.status, errorText);
                      setDeploymentStatus('idle');
                      setPublishLoading(false);
                    }
                  } catch (e) {
                    console.error('🚀 Publish failed:', e);
                    alert('Publish failed. Check Settings and tokens.');
                    setDeploymentStatus('idle');
                    setPublishLoading(false);
                    setTimeout(() => setShowPublishPanel(false), 1000);
                  } finally {
                    loadDeployStatus();
                  }
                }}
                className={`w-full px-4 py-3 rounded-xl font-medium text-white transition ${
                  publishLoading || deploymentStatus === 'deploying' || !githubConnected || !vercelConnected
                    ? 'bg-slate-400 cursor-not-allowed'
                    : 'bg-black hover:bg-slate-900'
                }`}
              >
                {publishLoading ? 'Publishing…' : deploymentStatus === 'deploying' ? 'Deploying…' : (!githubConnected || !vercelConnected) ? 'Connect Services First' : (deploymentStatus === 'ready' && publishedUrl ? 'Update' : 'Publish')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Project Settings Modal */}
      <ProjectSettings
        isOpen={showGlobalSettings}
        onClose={() => setShowGlobalSettings(false)}
        projectId={projectId}
        projectName={projectName}
        projectDescription={projectDescription}
        initialTab="services"
        onProjectUpdated={({ name, description }) => {
          setProjectName(name);
          setProjectDescription(description ?? '');
        }}
      />
    </>
  );
}
