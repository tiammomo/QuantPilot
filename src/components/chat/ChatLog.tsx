"use client";
import React, {
  useEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { useWebSocket } from "@/hooks/useWebSocket";
import type { ChatMessage, RealtimeEvent, RealtimeStatus } from "@/types";
import {
  toChatMessage,
  normalizeChatContent,
} from "@/lib/serializers/client/chat";
import { collapseToolReadActivities } from "@/lib/chat/tool-activity";
import {
  classifyRealtimeGenerationStatus,
  shouldRealtimeAssistantUpdateStopWaiting,
} from "@/lib/quant/realtime-generation-status";

import {
  expandMessagesList,
  deriveToolInfoFromMetadata,
  extractToolCallId,
  integrateMessages,
  mergeToolResultsIntoUsage,
  pickFirstString,
  randomMessageId,
  shouldDisplayChatMessage,
  type ToolExpansionState,
} from "@/lib/chat/chat-message-runtime";
import ChatLogView, { type LogEntry } from "./ChatLogView";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

interface MessageCursor {
  id: string;
  createdAt: string;
}

interface ChatLogProps {
  projectId: string;
  onSessionStatusChange?: (isRunning: boolean) => void;
  onProjectStatusUpdate?: (
    status: string,
    message?: string,
    metadata?: Record<string, unknown>,
  ) => void;
  onSseFallbackActive?: (active: boolean) => void;
  startRequest?: (requestId: string) => void;
  completeRequest?: (
    requestId: string,
    isSuccessful: boolean,
    errorMessage?: string,
  ) => void;
  onAddUserMessage?: (handlers: {
    add: (message: ChatMessage) => void;
    remove: (messageId: string) => void;
  }) => void;
}

export default function ChatLog({
  projectId,
  onSessionStatusChange,
  onProjectStatusUpdate,
  onSseFallbackActive,
  startRequest,
  completeRequest,
  onAddUserMessage,
}: ChatLogProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false);
  const [needsHistoryRefresh, setNeedsHistoryRefresh] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const historyPollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const latestMessageCursorRef = useRef<MessageCursor | null>(null);
  const isHistorySyncingRef = useRef(false);
  const hasLoadedInitialDataRef = useRef(false);
  const sseFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const hasLoggedSseFallbackRef = useRef(false);
  const [enableSseFallback, setEnableSseFallback] = useState(false);
  const [isSseConnected, setIsSseConnected] = useState(false);
  const realtimeTransportMode =
    process.env.NEXT_PUBLIC_REALTIME_TRANSPORT === "websocket"
      ? "websocket"
      : "sse";
  const useWebSocketTransport = realtimeTransportMode === "websocket";
  const preparedPersonalizationRequests = useMemo(() => {
    const requestIds = new Set<string>();
    for (const message of messages) {
      if (message.role !== "user" || !message.requestId) continue;
      const metadata =
        message.metadata && typeof message.metadata === "object"
          ? (message.metadata as Record<string, unknown>)
          : null;
      const personalization = metadata?.personalization;
      if (!personalization || typeof personalization !== "object") continue;
      const detail = personalization as Record<string, unknown>;
      if (
        detail.status === "prepared" &&
        typeof detail.exposedMemoryCount === "number" &&
        detail.exposedMemoryCount > 0
      ) {
        requestIds.add(message.requestId);
      }
    }
    return requestIds;
  }, [messages]);
  const [failedImageUrls, setFailedImageUrls] = useState<Set<string>>(
    new Set(),
  );
  const [expandedToolMessages, setExpandedToolMessages] = useState<
    Record<string, ToolExpansionState>
  >({});
  const fallbackMessageIdRef = useRef<Map<string, string>>(new Map());
  const visibleToolMessageIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    messagesRef.current = messages;

    let latestCursor: MessageCursor | null = null;
    let latestTime = Number.NEGATIVE_INFINITY;

    messages.forEach((message) => {
      if (!message.id || !message.createdAt || message.isOptimistic) {
        return;
      }

      // 游标只落在已完成消息上，避免流式消息断开后跳过数据库里的最终版本。
      if (message.isStreaming && !message.isFinal) {
        return;
      }

      const timestamp = new Date(message.createdAt).getTime();
      if (!Number.isFinite(timestamp)) {
        return;
      }

      if (
        !latestCursor ||
        timestamp > latestTime ||
        (timestamp === latestTime && message.id > latestCursor.id)
      ) {
        latestTime = timestamp;
        latestCursor = {
          id: message.id,
          createdAt: message.createdAt,
        };
      }
    });

    latestMessageCursorRef.current = latestCursor;
  }, [messages]);

  const displayMessages = useMemo(
    () => collapseToolReadActivities(mergeToolResultsIntoUsage(messages)),
    [messages],
  );

  const ensureStableMessageId = useCallback((message: ChatMessage): string => {
    if (message.id) {
      return message.id;
    }

    const parts: string[] = [];
    const addPart = (label: string, value: unknown) => {
      const candidate = pickFirstString(value);
      if (candidate) {
        parts.push(`${label}:${candidate}`);
      }
    };

    addPart("request", message.requestId);
    addPart("parent", message.parentMessageId);
    addPart("type", message.messageType);
    addPart("role", message.role);
    addPart("cli", message.cliSource);
    addPart("created", message.createdAt);

    const metadata =
      message.metadata && typeof message.metadata === "object"
        ? (message.metadata as Record<string, unknown>)
        : null;
    if (metadata) {
      const toolCallId = extractToolCallId(metadata);
      if (toolCallId) {
        addPart("tool_call", toolCallId);
      }
    }

    const fingerprint =
      parts.length > 0
        ? parts.join("|")
        : `fallback:${message.role}:${message.messageType}:${message.createdAt}`;

    const existing = fallbackMessageIdRef.current.get(fingerprint);
    if (existing) {
      return existing;
    }

    const newId = randomMessageId();
    fallbackMessageIdRef.current.set(fingerprint, newId);
    return newId;
  }, []);

  const handleToolMessageToggle = useCallback(
    (message: ChatMessage, key: string, nextExpanded?: boolean) => {
      if (!key) return;

      const metadata =
        message.metadata && typeof message.metadata === "object"
          ? (message.metadata as Record<string, unknown>)
          : null;
      const requestId = message.requestId ?? null;
      const toolCallId = extractToolCallId(metadata);

      setExpandedToolMessages((prev) => {
        const currentState = prev[key];
        const current = currentState?.expanded ?? false;
        const desired =
          typeof nextExpanded === "boolean" ? nextExpanded : !current;

        if (
          desired === current &&
          currentState?.requestId === requestId &&
          currentState?.toolCallId === toolCallId
        ) {
          return prev;
        }

        return {
          ...prev,
          [key]: {
            expanded: desired,
            requestId,
            toolCallId,
          },
        };
      });
    },
    [],
  );

  // Error handling helper
  const handleError = useCallback((error: Error | string, context?: string) => {
    const message = typeof error === "string" ? error : error.message;
    console.error(`[ChatLog] Error${context ? ` in ${context}` : ""}:`, error);
    setErrorMessage(message);
    setHasError(true);
    setIsLoading(false);

    // Automatically clear the error state after 5 seconds
    setTimeout(() => {
      setHasError(false);
      setErrorMessage(null);
    }, 5000);
  }, []);

  // Reset the error state
  const clearError = useCallback(() => {
    setHasError(false);
    setErrorMessage(null);
  }, []);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessageCount, setTotalMessageCount] = useState(0);

  // Enhanced deduplication system to prevent duplicate messages
  const processedMessageIds = useRef(new Set<string>());
  const processedRequestIds = useRef(new Map<string, string>());
  const pendingMessageIds = useRef(new Set<string>());

  // Transport layer coordination - track message sources
  const messageSources = useRef<
    Map<string, "websocket" | "sse" | "optimistic" | "unknown">
  >(new Map());
  const activeTransport = useRef<"websocket" | "sse" | null>(null);

  const isMessageProcessed = useCallback((message: ChatMessage): boolean => {
    // Check by message ID first
    if (message.id && processedMessageIds.current.has(message.id)) {
      return true;
    }

    // Check by request ID for optimistic message replacement
    if (
      message.requestId &&
      processedRequestIds.current.has(message.requestId)
    ) {
      const existingMessageId = processedRequestIds.current.get(
        message.requestId,
      );
      if (existingMessageId === message.id) {
        return true;
      }
    }

    return false;
  }, []);

  const markMessageAsProcessed = useCallback(
    (
      message: ChatMessage,
      transport?: "websocket" | "sse" | "optimistic" | "unknown",
    ) => {
      const source = transport || activeTransport.current || "unknown";
      const shouldFinalize = !message.isStreaming || message.isFinal;

      if (message.id) {
        if (shouldFinalize) {
          processedMessageIds.current.add(message.id);
        }
        messageSources.current.set(message.id, source);
      }
      if (shouldFinalize && message.requestId) {
        processedRequestIds.current.set(message.requestId, message.id || "");
      }
    },
    [],
  );

  // Cleanup processed IDs when project changes to prevent memory leaks
  useEffect(() => {
    const processedIds = processedMessageIds.current;
    const processedRequests = processedRequestIds.current;
    const sources = messageSources.current;
    const pendingIds = pendingMessageIds.current;

    return () => {
      processedIds.clear();
      processedRequests.clear();
      sources.clear();
      pendingIds.clear();
      activeTransport.current = null;
    };
  }, [projectId]);

  // Message recovery mechanism for network interruptions
  const recoverMissingMessages = useCallback(() => {
    if (!projectId || !hasLoadedInitialDataRef.current) return;

    console.log(
      "[ChatLog] Recovering possible missing messages after realtime transport change...",
    );
    setNeedsHistoryRefresh(true);
  }, [projectId]);

  const handleRealtimeMessage = useCallback(
    (message: unknown) => {
      const chatMessage = toChatMessage(message);
      const transportSource = activeTransport.current || "unknown";
      const messageId = chatMessage.id ?? null;

      const isFinalUpdate = !chatMessage.isStreaming || chatMessage.isFinal;

      if (
        messageId &&
        pendingMessageIds.current.has(messageId) &&
        !isFinalUpdate
      ) {
        return;
      }

      if (isMessageProcessed(chatMessage) && !isFinalUpdate) return;

      // Enhanced transport-based duplicate detection
      if (chatMessage.id) {
        const existingSource = messageSources.current.get(chatMessage.id);
        if (existingSource && existingSource !== transportSource) {
          if (!isFinalUpdate) {
            console.warn(
              `[ChatLog] Duplicate streaming message from different transport: ID=${chatMessage.id}, existing=${existingSource}, new=${transportSource}. Skipping interim duplicate.`,
            );
            return;
          }
        }
      }

      if (messageId) {
        pendingMessageIds.current.add(messageId);
      }

      const expandedMessages = [chatMessage];

      const assistantUpdates = expandedMessages.filter(
        (msg) => msg.role === "assistant",
      );
      if (assistantUpdates.length > 0) {
        const shouldStopWaiting = assistantUpdates.some((msg) => {
          const normalizedContent = normalizeChatContent(msg.content);
          return shouldRealtimeAssistantUpdateStopWaiting({
            hasContent: normalizedContent.trim().length > 0,
            isFinal: msg.isFinal,
            metadata: msg.metadata,
          });
        });
        if (shouldStopWaiting) {
          setIsWaitingForResponse(false);
        }
      }

      const expandedWithIds = expandedMessages.map((incoming) =>
        incoming.id
          ? incoming
          : { ...incoming, id: ensureStableMessageId(incoming) },
      );

      const filteredMessages = expandedWithIds.filter((msg) => {
        if (isMessageProcessed(msg)) {
          return false;
        }
        return true;
      });

      if (filteredMessages.length > 0) {
        setMessages((prev) => {
          return integrateMessages(prev, filteredMessages);
        });

        filteredMessages.forEach((messageWithId) => {
          markMessageAsProcessed(messageWithId, transportSource);
        });
      }

      if (messageId) {
        pendingMessageIds.current.delete(messageId);
      }

      if (!chatMessage.isOptimistic && chatMessage.role === "user") {
        setNeedsHistoryRefresh(true);
      } else if (
        !chatMessage.isOptimistic &&
        chatMessage.role === "assistant" &&
        chatMessage.isFinal
      ) {
        setNeedsHistoryRefresh(true);
      }
    },
    [
      setIsWaitingForResponse,
      isMessageProcessed,
      markMessageAsProcessed,
      ensureStableMessageId,
    ],
  );

  const handleRealtimeStatus = useCallback(
    (
      status: string,
      payload?: RealtimeStatus | Record<string, unknown>,
      requestId?: string,
    ) => {
      const statusData = (payload as RealtimeStatus | undefined) ?? undefined;
      const resolvedStatus = statusData?.status ?? status;
      const hasReadyPreview =
        typeof statusData?.metadata?.previewUrl === "string" &&
        statusData.metadata.previewUrl.length > 0;
      const lifecycle = classifyRealtimeGenerationStatus(
        resolvedStatus,
        statusData?.metadata,
      );
      const isWorkspaceLifecycleStatus =
        lifecycle.workspaceLifecycle &&
        (resolvedStatus !== "validation_passed" || hasReadyPreview);
      if (
        statusData?.status &&
        statusData.message &&
        (status === "project_status" || isWorkspaceLifecycleStatus)
      ) {
        onProjectStatusUpdate?.(
          lifecycle.workspaceStatus,
          statusData.message,
          statusData.metadata,
        );
      }

      if (lifecycle.terminal) {
        onSessionStatusChange?.(false);
        setIsWaitingForResponse(false);
      }

      if (
        resolvedStatus === "starting" ||
        resolvedStatus === "running" ||
        lifecycle.keepsRequestActive
      ) {
        setIsWaitingForResponse(true);
        onSessionStatusChange?.(true);
      }

      const requestKey = statusData?.requestId ?? requestId;

      if (
        requestKey &&
        (resolvedStatus === "starting" || resolvedStatus === "running")
      ) {
        startRequest?.(requestKey);
      }

      if (requestKey && lifecycle.terminal === "success") {
        completeRequest?.(requestKey, true);
      }

      if (
        requestKey &&
        (lifecycle.terminal === "failure" || lifecycle.terminal === "cancelled")
      ) {
        completeRequest?.(requestKey, false, statusData?.message);
      }
    },
    [
      onProjectStatusUpdate,
      onSessionStatusChange,
      startRequest,
      completeRequest,
    ],
  );

  const handleRealtimeError = useCallback((error: Error | string) => {
    const message = typeof error === "string" ? error : error.message;
    console.warn("🔌 [Realtime] Non-blocking error:", message);
  }, []);

  const handleRealtimeEnvelope = useCallback(
    (envelope: RealtimeEvent) => {
      switch (envelope.type) {
        case "message":
          if (envelope.data) {
            handleRealtimeMessage(envelope.data);
          }
          break;
        case "status": {
          const data = envelope.data ?? { status: envelope.type };
          handleRealtimeStatus(
            data.status ?? envelope.type,
            data,
            data.requestId,
          );
          break;
        }
        case "error": {
          const message = envelope.error ?? "Realtime bridge error";
          const rawData =
            (envelope.data as Record<string, unknown> | undefined) ?? undefined;
          const requestId = (() => {
            if (!rawData) return undefined;
            const direct = rawData.requestId;
            return typeof direct === "string" ? direct : undefined;
          })();
          const payload: RealtimeStatus = {
            status: "error",
            message,
            ...(requestId ? { requestId } : {}),
          };
          handleRealtimeStatus("error", payload, requestId);
          handleRealtimeError(new Error(message));
          break;
        }
        case "connected": {
          const payload: RealtimeStatus = {
            status: "connected",
            message: "Realtime channel connected",
            requestId: envelope.data?.runId,
          };
          handleRealtimeStatus("connected", payload, envelope.data?.runId);
          break;
        }
        case "preview_error": {
          const data = (
            envelope as { data?: { message?: string; severity?: string } }
          ).data;
          const payload: RealtimeStatus = {
            status: "preview_error",
            message: data?.message,
            metadata: data?.severity ? { severity: data.severity } : undefined,
          };
          handleRealtimeStatus("preview_error", payload);
          break;
        }
        case "preview_success": {
          const data = (
            envelope as { data?: { message?: string; severity?: string } }
          ).data;
          const payload: RealtimeStatus = {
            status: "preview_success",
            message: data?.message,
            metadata: data?.severity ? { severity: data.severity } : undefined,
          };
          handleRealtimeStatus("preview_success", payload);
          break;
        }
        case "heartbeat":
          break;
        default: {
          const unknownEnvelope = envelope as { type?: string };
          handleRealtimeStatus(
            unknownEnvelope.type ?? "unknown",
            envelope as unknown as Record<string, unknown>,
          );
          break;
        }
      }
    },
    [handleRealtimeMessage, handleRealtimeStatus, handleRealtimeError],
  );
  const handleRealtimeEnvelopeRef = useRef(handleRealtimeEnvelope);
  const recoverMissingMessagesRef = useRef(recoverMissingMessages);
  const onSseFallbackActiveRef = useRef(onSseFallbackActive);

  useEffect(() => {
    handleRealtimeEnvelopeRef.current = handleRealtimeEnvelope;
  }, [handleRealtimeEnvelope]);

  useEffect(() => {
    recoverMissingMessagesRef.current = recoverMissingMessages;
  }, [recoverMissingMessages]);

  useEffect(() => {
    onSseFallbackActiveRef.current = onSseFallbackActive;
  }, [onSseFallbackActive]);

  // Use the centralized WebSocket hook (with SSE fallback defined below)
  const { isConnected, isConnecting } = useWebSocket({
    projectId,
    enabled: useWebSocketTransport,
    onMessage: handleRealtimeMessage,
    onStatus: handleRealtimeStatus,
    onConnect: () => {
      console.log(
        "🔌 [Transport] WebSocket connected, switching to WebSocket transport",
      );
      setEnableSseFallback(false);
      hasLoggedSseFallbackRef.current = false;
      onSseFallbackActive?.(false);
      activeTransport.current = "websocket";
      if (sseFallbackTimerRef.current) {
        clearTimeout(sseFallbackTimerRef.current);
        sseFallbackTimerRef.current = null;
      }
      // Recover any missing messages that might have been lost during disconnection
      recoverMissingMessages();
    },
    onDisconnect: () => {
      console.log(
        "🔌 [Transport] WebSocket disconnected, waiting before SSE fallback",
      );
      activeTransport.current = null;
    },
    onError: handleRealtimeError,
  });

  useEffect(() => {
    if (!useWebSocketTransport) {
      setEnableSseFallback(true);
      return;
    }

    if (isConnected) {
      setEnableSseFallback(false);
      hasLoggedSseFallbackRef.current = false;
      onSseFallbackActive?.(false);
      if (sseFallbackTimerRef.current) {
        clearTimeout(sseFallbackTimerRef.current);
        sseFallbackTimerRef.current = null;
      }
      return;
    }

    if (isConnecting) {
      if (sseFallbackTimerRef.current) {
        clearTimeout(sseFallbackTimerRef.current);
        sseFallbackTimerRef.current = null;
      }
      return () => {
        if (sseFallbackTimerRef.current) {
          clearTimeout(sseFallbackTimerRef.current);
          sseFallbackTimerRef.current = null;
        }
      };
    }

    if (sseFallbackTimerRef.current) {
      clearTimeout(sseFallbackTimerRef.current);
    }

    sseFallbackTimerRef.current = setTimeout(() => {
      setEnableSseFallback((previous) => previous || true);
    }, 2500);

    return () => {
      if (sseFallbackTimerRef.current) {
        clearTimeout(sseFallbackTimerRef.current);
        sseFallbackTimerRef.current = null;
      }
    };
  }, [isConnected, isConnecting, onSseFallbackActive, useWebSocketTransport]);

  useEffect(() => {
    if (!projectId) return;
    if (!enableSseFallback) return;
    if (typeof window === "undefined") {
      return;
    }

    if (!("EventSource" in window)) {
      return;
    }

    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const resolveStreamUrl = () => {
      const rawBase = process.env.NEXT_PUBLIC_API_BASE?.trim() ?? "";
      const endpoint = `/api/chat/${projectId}/stream`;
      if (rawBase.length > 0) {
        const normalizedBase = rawBase.replace(/\/+$/, "");
        return `${normalizedBase}${endpoint}`;
      }
      return endpoint;
    };

    const connectSse = () => {
      if (disposed) return;

      try {
        if (!hasLoggedSseFallbackRef.current) {
          console.warn(
            "🔄 [Transport] WebSocket unavailable, switching to SSE transport",
          );
          hasLoggedSseFallbackRef.current = true;
        }

        // Only activate SSE if WebSocket is not connected
        if (activeTransport.current === "websocket") {
          console.log(
            "🔄 [Transport] WebSocket is active, skipping SSE connection",
          );
          return;
        }

        activeTransport.current = "sse";

        const streamUrl = resolveStreamUrl();
        let source: EventSource;
        try {
          const parsed = new URL(streamUrl, window.location.href);
          if (parsed.origin !== window.location.origin) {
            source = new EventSource(parsed.toString(), {
              withCredentials: true,
            });
          } else {
            source = new EventSource(parsed.toString());
          }
        } catch {
          source = new EventSource(streamUrl);
        }
        eventSource = source;

        source.onopen = () => {
          console.debug("🔄 [Transport] SSE connection established");
          setIsSseConnected(true);
          onSseFallbackActiveRef.current?.(true);
          // Recover any missing messages that might have been lost during SSE disconnection
          recoverMissingMessagesRef.current();
        };

        source.onmessage = (event) => {
          if (!event.data) {
            return;
          }
          try {
            const envelope = JSON.parse(event.data) as RealtimeEvent;
            handleRealtimeEnvelopeRef.current(envelope);
          } catch (error) {
            console.error("🔄 [Realtime] Failed to parse SSE message:", error);
          }
        };

        source.onerror = () => {
          setIsSseConnected(false);
          if (disposed) {
            return;
          }
          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
          }
          console.warn("🔄 [Realtime] SSE connection lost, retrying...");
          source.close();
          reconnectTimer = setTimeout(connectSse, 2000);
        };
      } catch (error) {
        setIsSseConnected(false);
        console.error(
          "🔄 [Realtime] Failed to establish SSE connection:",
          error,
        );
      }
    };

    connectSse();

    return () => {
      disposed = true;
      setIsSseConnected(false);
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
    };
  }, [projectId, enableSseFallback]);

  useEffect(() => {
    return () => {
      if (sseFallbackTimerRef.current) {
        clearTimeout(sseFallbackTimerRef.current);
        sseFallbackTimerRef.current = null;
      }
    };
  }, []);

  const scrollToBottom = () => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  // Function to detect tool usage messages based on patterns
  const isToolUsageMessage = useCallback((message: ChatMessage) => {
    const metadata = message.metadata as
      | Record<string, unknown>
      | null
      | undefined;
    if (message.messageType === "tool_use") {
      return true;
    }

    if (metadata) {
      if (
        metadata.toolName ||
        metadata.tool_name ||
        metadata.toolInput ||
        metadata.tool_input ||
        metadata.filePath ||
        metadata.file_path ||
        metadata.action ||
        metadata.operation
      ) {
        return true;
      }

      const derived = deriveToolInfoFromMetadata(metadata);
      if (derived.filePath) {
        return true;
      }
    }

    return false;
  }, []);

  useEffect(scrollToBottom, [messages, logs]);

  useEffect(() => {
    setExpandedToolMessages((prev) => {
      const prevKeys = Object.keys(prev);

      const validKeys = new Set<string>();
      const requestToKey = new Map<string, string>();
      const toolCallToKey = new Map<string, string>();
      const keyToMessage = new Map<string, ChatMessage>();

      displayMessages.forEach((msg) => {
        if (msg.messageType === "tool_result" || isToolUsageMessage(msg)) {
          const key = ensureStableMessageId(msg);
          validKeys.add(key);
          keyToMessage.set(key, msg);

          if (msg.requestId) {
            requestToKey.set(msg.requestId, key);
          }

          const metadata =
            msg.metadata && typeof msg.metadata === "object"
              ? (msg.metadata as Record<string, unknown>)
              : null;
          const toolCallId = extractToolCallId(metadata);
          if (toolCallId) {
            toolCallToKey.set(toolCallId, key);
          }
        }
      });

      if (validKeys.size === 0) {
        return prev;
      }

      let changed = false;
      const next: Record<string, ToolExpansionState> = {};

      validKeys.forEach((key) => {
        const messageForKey = keyToMessage.get(key);
        if (!messageForKey) {
          return;
        }

        const metadata =
          messageForKey.metadata && typeof messageForKey.metadata === "object"
            ? (messageForKey.metadata as Record<string, unknown>)
            : null;
        const updatedRequestId = messageForKey.requestId ?? null;
        const updatedToolCallId = extractToolCallId(metadata);

        const prevState = prev[key];
        const expanded = prevState?.expanded ?? false;

        if (
          prevState?.requestId !== updatedRequestId ||
          prevState?.toolCallId !== updatedToolCallId
        ) {
          changed = true;
        }

        next[key] = {
          expanded,
          requestId: updatedRequestId,
          toolCallId: updatedToolCallId,
        };
      });

      prevKeys.forEach((oldKey) => {
        if (validKeys.has(oldKey)) {
          return;
        }

        const previousState = prev[oldKey];
        if (!previousState) {
          return;
        }

        const transferKey =
          (previousState.toolCallId
            ? toolCallToKey.get(previousState.toolCallId)
            : undefined) ??
          (previousState.requestId
            ? requestToKey.get(previousState.requestId)
            : undefined);

        if (transferKey && !next[transferKey]) {
          const targetMessage = keyToMessage.get(transferKey);
          const targetMetadata =
            targetMessage &&
            targetMessage.metadata &&
            typeof targetMessage.metadata === "object"
              ? (targetMessage.metadata as Record<string, unknown>)
              : null;
          const targetRequestId =
            targetMessage?.requestId ?? previousState.requestId ?? null;
          const targetToolCallId =
            extractToolCallId(targetMetadata) ??
            previousState.toolCallId ??
            null;

          next[transferKey] = {
            expanded: previousState.expanded,
            requestId: targetRequestId,
            toolCallId: targetToolCallId,
          };
          changed = true;
        } else if (!transferKey) {
          changed = true;
        }
      });

      if (!changed && Object.keys(next).length === prevKeys.length) {
        return prev;
      }

      return next;
    });
  }, [displayMessages, ensureStableMessageId, isToolUsageMessage]);

  useEffect(() => {
    const validIds = new Set<string>();

    displayMessages.forEach((msg) => {
      if (msg.messageType === "tool_result") {
        const id = msg.id ?? ensureStableMessageId(msg);
        if (id) {
          validIds.add(id);
        }
      }
    });

    const visibleSet = visibleToolMessageIdsRef.current;
    Array.from(visibleSet).forEach((id) => {
      if (!validIds.has(id)) {
        visibleSet.delete(id);
      }
    });
  }, [displayMessages, ensureStableMessageId]);

  // Load chat history
  const loadChatHistory = useCallback(
    async ({ showLoading }: { showLoading?: boolean } = {}) => {
      const shouldShowLoading = showLoading ?? !hasLoadedInitialDataRef.current;
      if (shouldShowLoading) {
        setIsLoading(true);
      }

      try {
        // Load more messages per request to reduce pagination needs
        const response = await fetch(
          `${API_BASE}/api/chat/${projectId}/messages?limit=200&offset=0`,
        );
        if (response.ok) {
          const payload = await response.json();
          const chatMessages = Array.isArray(payload)
            ? payload
            : (payload?.data ?? payload?.messages ?? []);
          const normalized = Array.isArray(chatMessages)
            ? expandMessagesList(
                chatMessages.map(toChatMessage),
                ensureStableMessageId,
              )
            : [];

          // Update pagination state
          if (payload.pagination) {
            setHasMoreMessages(payload.pagination.hasMore || false);
            setTotalMessageCount(payload.totalCount || 0);
          } else {
            setHasMoreMessages(false);
            setTotalMessageCount(normalized.length);
          }

          setMessages((prev) => integrateMessages(prev, normalized));
        }
      } catch (error) {
        if (process.env.NODE_ENV === "development") {
          console.warn("Failed to load chat history (network issue):", error);
        }
      } finally {
        if (shouldShowLoading) {
          setIsLoading(false);
        }
        hasLoadedInitialDataRef.current = true;
        setHasLoadedOnce(true);
      }
    },
    [projectId, ensureStableMessageId],
  );

  const syncNewMessages = useCallback(async () => {
    if (!projectId || isHistorySyncingRef.current) {
      return;
    }

    isHistorySyncingRef.current = true;

    try {
      const cursor = latestMessageCursorRef.current;
      if (!cursor) {
        await loadChatHistory({ showLoading: false });
        return;
      }

      const params = new URLSearchParams({
        limit: "100",
        after: cursor.createdAt,
        afterId: cursor.id,
      });
      const response = await fetch(
        `${API_BASE}/api/chat/${projectId}/messages?${params.toString()}`,
      );
      if (!response.ok) {
        return;
      }

      const payload = await response.json();
      const chatMessages = Array.isArray(payload)
        ? payload
        : (payload?.data ?? payload?.messages ?? []);
      const normalized = Array.isArray(chatMessages)
        ? expandMessagesList(
            chatMessages.map(toChatMessage),
            ensureStableMessageId,
          )
        : [];

      if (payload.pagination) {
        setTotalMessageCount(payload.totalCount || 0);
      }

      if (normalized.length > 0) {
        setMessages((prev) => integrateMessages(prev, normalized));
      }
    } catch (error) {
      if (process.env.NODE_ENV === "development") {
        console.warn("[ChatLog] Incremental history sync failed:", error);
      }
    } finally {
      isHistorySyncingRef.current = false;
    }
  }, [projectId, ensureStableMessageId, loadChatHistory]);

  useEffect(() => {
    if (!needsHistoryRefresh) {
      return;
    }
    const timer = setTimeout(() => {
      setNeedsHistoryRefresh(false);
      void syncNewMessages();
    }, 250);
    return () => clearTimeout(timer);
  }, [needsHistoryRefresh, syncNewMessages]);

  // Load older messages (pagination)
  const loadOlderMessages = useCallback(async () => {
    if (!projectId || !hasMoreMessages) return;

    try {
      const currentOffset = messages.length;
      const response = await fetch(
        `${API_BASE}/api/chat/${projectId}/messages?limit=100&offset=${currentOffset}`,
      );

      if (response.ok) {
        const payload = await response.json();
        const chatMessages = Array.isArray(payload)
          ? payload
          : (payload?.data ?? payload?.messages ?? []);
        const normalized = Array.isArray(chatMessages)
          ? expandMessagesList(
              chatMessages.map(toChatMessage),
              ensureStableMessageId,
            )
          : [];

        // Update pagination state
        if (payload.pagination) {
          setHasMoreMessages(payload.pagination.hasMore || false);
          setTotalMessageCount(payload.totalCount || 0);
          console.log(
            `[ChatLog] Loaded ${payload.pagination.count} older messages (${messages.length + normalized.length}/${payload.totalCount} total)`,
          );
        }

        // Prepend older messages to the existing list
        if (normalized.length > 0) {
          setMessages((prev) => integrateMessages(prev, normalized));
        }
      }
    } catch (error) {
      console.error("[ChatLog] Failed to load older messages:", error);
    }
  }, [projectId, hasMoreMessages, messages.length, ensureStableMessageId]);

  // 兜底轮询只做增量补漏，避免断线时反复重载整段聊天历史。
  useEffect(() => {
    if (!projectId) return;

    if (isConnected || isSseConnected) {
      if (historyPollIntervalRef.current) {
        clearInterval(historyPollIntervalRef.current);
        historyPollIntervalRef.current = null;
      }
      return;
    }

    const isStreamingMessagePending = messagesRef.current.some(
      (message) =>
        message.role === "assistant" && message.isStreaming && !message.isFinal,
    );

    if (isStreamingMessagePending) {
      return;
    }

    // Only poll when both WebSocket and SSE are disconnected
    const shouldPoll = !isConnected && !isSseConnected && enableSseFallback;

    if (!shouldPoll) {
      if (historyPollIntervalRef.current) {
        clearInterval(historyPollIntervalRef.current);
        historyPollIntervalRef.current = null;
      }
      return;
    }

    if (historyPollIntervalRef.current) {
      clearInterval(historyPollIntervalRef.current);
    }

    const intervalMs = isWaitingForResponse ? 2000 : 5000;

    historyPollIntervalRef.current = setInterval(() => {
      if (isConnected || isSseConnected) {
        console.debug(
          `[ChatLog] Stopping polling due to active connection: WebSocket=${isConnected}, SSE=${isSseConnected}`,
        );
        if (historyPollIntervalRef.current) {
          clearInterval(historyPollIntervalRef.current);
          historyPollIntervalRef.current = null;
        }
        return;
      }

      console.debug(`[ChatLog] Polling for incremental chat updates...`);
      syncNewMessages().catch(() => {
        // Suppress polling errors; realtime channels may still recover.
        console.debug(`[ChatLog] Polling completed with errors (suppressed)`);
      });
    }, intervalMs);

    return () => {
      if (historyPollIntervalRef.current) {
        clearInterval(historyPollIntervalRef.current);
        historyPollIntervalRef.current = null;
      }
    };
  }, [
    projectId,
    isConnected,
    isSseConnected,
    enableSseFallback,
    isWaitingForResponse,
    syncNewMessages,
  ]);

  // Initial load
  useEffect(() => {
    if (!projectId) return;

    let mounted = true;

    const loadData = async () => {
      if (mounted) {
        await loadChatHistory({ showLoading: true });
      }
    };

    loadData();

    return () => {
      mounted = false;
      if (historyPollIntervalRef.current) {
        clearInterval(historyPollIntervalRef.current);
        historyPollIntervalRef.current = null;
      }
    };
  }, [projectId, loadChatHistory]);

  useEffect(() => {
    hasLoadedInitialDataRef.current = false;
    setHasLoadedOnce(false);
    setIsLoading(true);
    setMessages([]);
    setLogs([]);
    setExpandedToolMessages({});
    latestMessageCursorRef.current = null;
    isHistorySyncingRef.current = false;
    fallbackMessageIdRef.current.clear();
    visibleToolMessageIdsRef.current.clear();
  }, [projectId]);

  const shouldDisplayMessage = useCallback(
    (message: ChatMessage) =>
      shouldDisplayChatMessage({
        message,
        ensureStableMessageId,
        isToolUsageMessage,
        visibleToolMessageIds: visibleToolMessageIdsRef.current,
      }),
    [ensureStableMessageId, isToolUsageMessage],
  );

  // Expose add/remove message functions to parent
  useEffect(() => {
    if (onAddUserMessage) {
      const addMessage = (message: ChatMessage) => {
        setMessages((prev) => {
          const exists = prev.some((m) => m.id === message.id);
          if (exists) {
            return prev;
          }

          // Enhanced optimistic message replacement with atomic operation
          if (message.requestId && !message.isOptimistic) {
            const optimisticMessages = prev.filter(
              (m) => m.isOptimistic && m.requestId === message.requestId,
            );

            if (optimisticMessages.length > 0) {
              // Atomic operation: remove ALL optimistic messages for this requestId
              let newMessages = [...prev];
              optimisticMessages.forEach((optimisticMessage) => {
                const index = newMessages.findIndex(
                  (m) => m.id === optimisticMessage.id,
                );
                if (index !== -1) {
                  newMessages.splice(index, 1);
                }
              });

              return [...newMessages, message];
            }
          }

          return [...prev, message];
        });
      };

      const removeMessage = (messageId: string) => {
        setMessages((prev) => prev.filter((m) => m.id !== messageId));
      };

      onAddUserMessage({ add: addMessage, remove: removeMessage });
    }
  }, [onAddUserMessage]);

  return (
    <ChatLogView
      projectId={projectId}
      hasError={hasError}
      errorMessage={errorMessage}
      clearError={clearError}
      isLoading={isLoading}
      hasLoadedOnce={hasLoadedOnce}
      messages={messages}
      logs={logs}
      hasMoreMessages={hasMoreMessages}
      totalMessageCount={totalMessageCount}
      loadOlderMessages={loadOlderMessages}
      displayMessages={displayMessages}
      shouldDisplayMessage={shouldDisplayMessage}
      isToolUsageMessage={isToolUsageMessage}
      ensureStableMessageId={ensureStableMessageId}
      expandedToolMessages={expandedToolMessages}
      handleToolMessageToggle={handleToolMessageToggle}
      preparedPersonalizationRequests={preparedPersonalizationRequests}
      failedImageUrls={failedImageUrls}
      setFailedImageUrls={setFailedImageUrls}
      isWaitingForResponse={isWaitingForResponse}
      logsEndRef={logsEndRef}
      selectedLog={selectedLog}
      setSelectedLog={setSelectedLog}
    />
  );
}
