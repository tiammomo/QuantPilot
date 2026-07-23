"use client";

import React, {
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { motion, AnimatePresence } from "framer-motion";

import type { ChatMessage } from "@/types";
import { parseMoAgentTurnMetrics } from "@/lib/chat/turn-metrics";
import { normalizeChatContent } from "@/lib/serializers/client/chat";
import { toRelativePath } from "@/lib/utils/path";
import type { ToolExpansionState } from "@/lib/chat/chat-message-runtime";
import GovernedKnowledgeFeedback from "./GovernedKnowledgeFeedback";
import { renderLightMarkdown } from "./LightMarkdown";
import PersonalMemoryCandidateCard from "./PersonalMemoryCandidateCard";
import PersonalMemoryFeedback from "./PersonalMemoryFeedback";
import { ToolMessage } from "./ToolMessage";
import ToolApprovalPanel from "./ToolApprovalPanel";
import TurnMetricsFooter from "./TurnMetricsFooter";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

export interface LogEntry {
  id: string;
  type: string;
  data: any;
  timestamp: string;
}

export interface ChatLogViewProps {
  projectId: string;
  hasError: boolean;
  errorMessage: string | null;
  clearError: () => void;
  isLoading: boolean;
  hasLoadedOnce: boolean;
  messages: ChatMessage[];
  logs: LogEntry[];
  hasMoreMessages: boolean;
  totalMessageCount: number;
  loadOlderMessages: () => void | Promise<void>;
  displayMessages: ChatMessage[];
  shouldDisplayMessage: (message: ChatMessage) => boolean;
  isToolUsageMessage: (message: ChatMessage) => boolean;
  ensureStableMessageId: (message: ChatMessage) => string;
  expandedToolMessages: Record<string, ToolExpansionState>;
  handleToolMessageToggle: (
    message: ChatMessage,
    key: string,
    nextExpanded?: boolean,
  ) => void;
  preparedPersonalizationRequests: ReadonlySet<string>;
  failedImageUrls: Set<string>;
  setFailedImageUrls: Dispatch<SetStateAction<Set<string>>>;
  isWaitingForResponse: boolean;
  approvalRefreshVersion: number;
  logsEndRef: RefObject<HTMLDivElement | null>;
  selectedLog: LogEntry | null;
  setSelectedLog: Dispatch<SetStateAction<LogEntry | null>>;
}

const formatTime = (timestamp: string) => {
  return new Date(timestamp).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
};

// Function to convert file paths to relative paths
const shortenPath = (text: string) => {
  if (!text) return text;
  return toRelativePath(text);
};

const ToolResultMessage = ({
  message,
  metadata,
  isExpanded,
  onToggle,
}: {
  message: ChatMessage;
  metadata?: Record<string, unknown> | null;
  isExpanded?: boolean;
  onToggle?: (nextExpanded: boolean) => void;
}) => {
  return (
    <ToolMessage
      content={normalizeChatContent(message.content)}
      metadata={metadata ?? undefined}
      isExpanded={isExpanded}
      onToggle={onToggle}
    />
  );
};

const renderLogEntry = (log: LogEntry) => {
  switch (log.type) {
    case "system":
      return <div>系统已连接（模型：{log.data.model || "未知"}）</div>;

    case "act_start":
      return <div>开始执行任务：{shortenPath(log.data.instruction)}</div>;

    case "text":
      return (
        <div>
          {renderLightMarkdown(shortenPath(log.data.content), {
            codeBreakAll: true,
          })}
        </div>
      );

    case "thinking":
      return (
        <div>
          {renderLightMarkdown(shortenPath(log.data.content), {
            codeBreakAll: true,
          })}
        </div>
      );

    case "tool_start":
      return (
        <div>
          正在使用工具：{shortenPath(log.data.summary || log.data.tool_name)}
        </div>
      );

    case "tool_result":
      const isError = log.data.is_error;
      return (
        <div>
          {shortenPath(log.data.summary)} {isError ? "失败" : "已完成"}
        </div>
      );

    case "result":
      return (
        <div>
          Task completed ({log.data.duration_ms}ms, {log.data.turns} turns
          {log.data.total_cost_usd &&
            `, $${log.data.total_cost_usd.toFixed(4)}`}
          )
        </div>
      );

    case "act_complete":
      return (
        <div className="font-medium">
          Task completed:{" "}
          {shortenPath(log.data.commit_message || log.data.changes_summary)}
        </div>
      );

    case "error":
      return <div>Error occurred: {shortenPath(log.data.message)}</div>;

    default:
      return (
        <div>
          {log.type}:{" "}
          {typeof log.data === "object"
            ? JSON.stringify(log.data).substring(0, 100)
            : String(log.data).substring(0, 100)}
          ...
        </div>
      );
  }
};

export default function ChatLogView({
  projectId,
  hasError,
  errorMessage,
  clearError,
  isLoading,
  hasLoadedOnce,
  messages,
  logs,
  hasMoreMessages,
  totalMessageCount,
  loadOlderMessages,
  displayMessages,
  shouldDisplayMessage,
  isToolUsageMessage,
  ensureStableMessageId,
  expandedToolMessages,
  handleToolMessageToggle,
  preparedPersonalizationRequests,
  failedImageUrls,
  setFailedImageUrls,
  isWaitingForResponse,
  approvalRefreshVersion,
  logsEndRef,
  selectedLog,
  setSelectedLog,
}: ChatLogViewProps) {
  const openDetailModal = (log: LogEntry) => setSelectedLog(log);
  const closeDetailModal = () => setSelectedLog(null);

  const renderDetailModal = () => {
    if (!selectedLog) return null;

    const { type, data } = selectedLog;

    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
        >
          <div className="bg-white rounded-lg p-6 max-w-4xl max-h-[80vh] overflow-auto border border-slate-200 ">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-slate-900 ">
                Log Details
              </h3>
              <button
                onClick={closeDetailModal}
                className="text-slate-500 hover:text-slate-700 text-xl"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              <div className="text-slate-900 ">
                <strong className="text-slate-700 ">Type:</strong> {type}
              </div>
              <div className="text-slate-900 ">
                <strong className="text-slate-700 ">Time:</strong>{" "}
                {formatTime(selectedLog.timestamp)}
              </div>

              {type === "tool_result" && data.diff_info && (
                <div>
                  <strong className="text-slate-700 ">Changes:</strong>
                  <pre className="bg-slate-100 p-3 rounded-lg overflow-x-auto text-xs font-mono">
                    {data.diff_info}
                  </pre>
                </div>
              )}

              <div>
                <strong className="text-slate-700 ">Detailed Data:</strong>
                <pre className="bg-slate-100 p-3 rounded-lg overflow-x-auto text-xs font-mono">
                  {JSON.stringify(data, null, 2)}
                </pre>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full bg-white ">
      {/* Error Display */}
      {hasError && (
        <div className="mx-8 mt-3 p-4 bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-800 rounded-lg">
          <div className="flex items-start justify-between">
            <div className="flex items-start">
              <div className="flex-shrink-0">
                <svg
                  className="h-5 w-5 text-red-400"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                    clipRule="evenodd"
                  />
                </svg>
              </div>
              <div className="ml-3">
                <h3 className="text-sm font-medium text-red-800 dark:text-red-200">
                  Connection error
                </h3>
                <div className="mt-2 text-sm text-red-700 dark:text-red-300">
                  <p>{errorMessage}</p>
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                    Retrying automatically in a few seconds...
                  </p>
                </div>
              </div>
            </div>
            <div className="ml-auto pl-3">
              <button
                onClick={clearError}
                className="inline-flex text-red-400 hover:text-red-600 focus:outline-none focus:text-red-600 transition-colors"
              >
                <svg
                  className="h-5 w-5"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      <ToolApprovalPanel
        projectId={projectId}
        refreshVersion={approvalRefreshVersion}
      />

      {/* Display messages and logs together */}
      <div className="flex-1 overflow-y-auto px-8 py-3 space-y-2 custom-scrollbar ">
        {isLoading && !hasLoadedOnce && !hasError && (
          <div className="flex items-center justify-center h-32 text-slate-400 text-sm">
            <div className="flex flex-col items-center">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-slate-900 mb-2 mx-auto"></div>
              <p>Loading chat history...</p>
            </div>
          </div>
        )}

        {!isLoading && messages.length === 0 && logs.length === 0 && (
          <div className="flex items-center justify-center h-32 text-slate-400 text-sm">
            <div className="text-center">
              <div className="text-2xl mb-2">💬</div>
              <p>Start a conversation with your agent</p>
            </div>
          </div>
        )}

        {/* Load older messages button */}
        {hasMoreMessages && (
          <div className="mb-4 flex justify-center">
            <button
              onClick={loadOlderMessages}
              className="px-4 py-2 text-sm text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors"
              disabled={isLoading}
            >
              {isLoading
                ? "Loading..."
                : `Load older messages (${totalMessageCount - messages.length} remaining)`}
            </button>
          </div>
        )}

        {/* Render chat messages */}
        {displayMessages.filter(shouldDisplayMessage).map((message, index) => {
          const messageMetadata = message.metadata as Record<
            string,
            unknown
          > | null;
          const messageText = normalizeChatContent(message.content);
          const turnMetrics =
            messageMetadata?.isMissionFinal === true
              ? parseMoAgentTurnMetrics(messageMetadata.turnMetrics)
              : null;
          const canRatePersonalMemory =
            message.role === "assistant" &&
            message.messageType === "chat" &&
            messageMetadata?.isMoAgentFinal === true &&
            messageMetadata?.validationPassed === true &&
            Boolean(message.requestId) &&
            preparedPersonalizationRequests.has(message.requestId ?? "");
          const canRateGovernedKnowledge =
            message.role === "assistant" &&
            message.messageType === "chat" &&
            messageMetadata?.isMoAgentFinal === true &&
            messageMetadata?.validationPassed === true &&
            Boolean(message.requestId);
          const isToolMessage =
            message.messageType === "tool_result" ||
            isToolUsageMessage(message);
          const toolMessageKey = isToolMessage
            ? ensureStableMessageId(message)
            : null;
          const reactKey = message.id ?? toolMessageKey ?? `message-${index}`;
          const toolExpanded =
            toolMessageKey != null
              ? expandedToolMessages[toolMessageKey]?.expanded
              : undefined;
          const onToggleTool =
            toolMessageKey != null
              ? (nextExpanded: boolean) =>
                  handleToolMessageToggle(message, toolMessageKey, nextExpanded)
              : undefined;

          return (
            <div className="mb-4" key={reactKey}>
              {message.role === "user" ? (
                // User message - boxed on the right
                <div className="flex justify-end">
                  <div className="max-w-[80%]">
                    <div className="bg-slate-100 rounded-lg px-4 py-3">
                      <div className="text-sm text-slate-900 break-words">
                        {(() => {
                          const cleanedMessage = messageText;

                          return (
                            <>
                              {cleanedMessage && (
                                <div>{shortenPath(cleanedMessage)}</div>
                              )}
                              {(() => {
                                const attachments = Array.isArray(
                                  (messageMetadata as Record<string, any>)
                                    ?.attachments,
                                )
                                  ? ((messageMetadata as Record<string, any>)
                                      .attachments as any[])
                                  : [];
                                if (attachments.length > 0) {
                                  return (
                                    <div className="mt-2 flex flex-wrap gap-2">
                                      {attachments.map(
                                        (attachment: any, idx: number) => {
                                          const candidateRawUrls: string[] = [];
                                          const pushCandidate = (
                                            value: unknown,
                                          ) => {
                                            if (typeof value === "string") {
                                              const trimmed = value.trim();
                                              if (trimmed.length > 0) {
                                                candidateRawUrls.push(trimmed);
                                              }
                                            }
                                          };

                                          pushCandidate(
                                            (
                                              attachment as Record<
                                                string,
                                                unknown
                                              >
                                            )?.publicUrl,
                                          );
                                          pushCandidate(
                                            (
                                              attachment as Record<
                                                string,
                                                unknown
                                              >
                                            )?.url,
                                          );
                                          pushCandidate(
                                            (
                                              attachment as Record<
                                                string,
                                                unknown
                                              >
                                            )?.assetUrl,
                                          );

                                          const uniqueCandidates = Array.from(
                                            new Set(candidateRawUrls),
                                          );
                                          if (uniqueCandidates.length === 0) {
                                            return null;
                                          }
                                          const resolveUrl = (
                                            value: string,
                                          ) => {
                                            if (/^https?:\/\//i.test(value)) {
                                              return value;
                                            }
                                            // Handle correctly even when API_BASE is empty
                                            if (value.startsWith("/")) {
                                              return API_BASE
                                                ? `${API_BASE}${value}`
                                                : value;
                                            }
                                            return API_BASE
                                              ? `${API_BASE}/${value}`
                                              : `/${value}`;
                                          };
                                          const resolvedCandidates =
                                            uniqueCandidates.map(resolveUrl);
                                          const imageUrl =
                                            resolvedCandidates.find(
                                              (url) =>
                                                !failedImageUrls.has(url),
                                            ) ?? resolvedCandidates[0];
                                          if (!imageUrl) {
                                            return null;
                                          }
                                          const allCandidatesFailed =
                                            resolvedCandidates.every((url) =>
                                              failedImageUrls.has(url),
                                            );

                                          const handleImageError = () => {
                                            console.error(
                                              "❌ Image failed to load:",
                                              imageUrl,
                                            );
                                            setFailedImageUrls((prev) => {
                                              const next = new Set(prev);
                                              next.add(imageUrl);
                                              return next;
                                            });
                                          };

                                          return (
                                            <div
                                              key={idx}
                                              className="relative group"
                                            >
                                              <div className="w-40 h-40 bg-slate-200 rounded-lg overflow-hidden border border-slate-300 ">
                                                {allCandidatesFailed ? (
                                                  // Show an icon when loading fails
                                                  <div className="w-full h-full flex items-center justify-center">
                                                    <svg
                                                      className="w-16 h-16 text-slate-400"
                                                      fill="none"
                                                      viewBox="0 0 24 24"
                                                      stroke="currentColor"
                                                    >
                                                      <path
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        strokeWidth={1.5}
                                                        d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                                                      />
                                                    </svg>
                                                  </div>
                                                ) : (
                                                  // Display the image when it loads successfully
                                                  /* eslint-disable-next-line @next/next/no-img-element */
                                                  <img
                                                    src={imageUrl}
                                                    alt={`Image ${idx + 1}`}
                                                    className="w-full h-full object-cover"
                                                    onError={handleImageError}
                                                  />
                                                )}
                                              </div>
                                              <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 rounded-lg transition-opacity flex items-center justify-center">
                                                <span className="text-white text-sm font-medium opacity-0 group-hover:opacity-100 transition-opacity bg-black bg-opacity-60 px-2 py-1 rounded">
                                                  #{idx + 1}
                                                </span>
                                              </div>
                                              {/* Tooltip with filename */}
                                              <div className="absolute bottom-full mb-1 left-1/2 transform -translate-x-1/2 bg-slate-900 text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-10">
                                                {toRelativePath(
                                                  attachment.name,
                                                )}
                                              </div>
                                            </div>
                                          );
                                        },
                                      )}
                                    </div>
                                  );
                                }
                                return null;
                              })()}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                    {message.requestId &&
                    messageMetadata?.personalizationCandidate ? (
                      <PersonalMemoryCandidateCard
                        projectId={projectId}
                        requestId={message.requestId}
                        candidate={messageMetadata.personalizationCandidate}
                      />
                    ) : null}
                  </div>
                </div>
              ) : (
                // Agent message - full width, no box
                <div className="w-full">
                  {message.messageType === "tool_result" ? (
                    <ToolResultMessage
                      message={message}
                      metadata={messageMetadata}
                      isExpanded={toolExpanded}
                      onToggle={onToggleTool}
                    />
                  ) : isToolUsageMessage(message) ? (
                    // Tool usage - clean display with expand functionality
                    <ToolMessage
                      content={messageText}
                      metadata={messageMetadata}
                      isExpanded={toolExpanded}
                      onToggle={onToggleTool}
                    />
                  ) : (
                    // Regular agent message - plain text
                    <div className="text-sm text-slate-900 leading-relaxed">
                      {renderLightMarkdown(shortenPath(messageText))}
                      {turnMetrics ? (
                        <TurnMetricsFooter metrics={turnMetrics} />
                      ) : null}
                      {canRatePersonalMemory && message.requestId ? (
                        <PersonalMemoryFeedback
                          projectId={projectId}
                          requestId={message.requestId}
                        />
                      ) : null}
                      {canRateGovernedKnowledge && message.requestId ? (
                        <GovernedKnowledgeFeedback
                          projectId={projectId}
                          requestId={message.requestId}
                        />
                      ) : null}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Render filtered agent logs as plain text */}
        {logs
          .filter((log) => {
            // Hide internal tool results and system logs
            const hideTypes = ["tool_result", "tool_start", "system"];
            return !hideTypes.includes(log.type);
          })
          .map((log, index) => (
            <div
              key={log.id ?? `log-${index}`}
              className="mb-4 w-full cursor-pointer"
              onClick={() => openDetailModal(log)}
            >
              <div className="text-sm text-slate-900 leading-relaxed">
                {renderLogEntry(log)}
              </div>
            </div>
          ))}

        {/* Loading indicator for waiting response */}
        {isWaitingForResponse && (
          <div className="mb-4 w-full">
            <div className="text-xl text-slate-900 leading-relaxed font-bold">
              <span className="animate-pulse">...</span>
            </div>
          </div>
        )}

        <div ref={logsEndRef} />
      </div>

      {/* Detail modal */}
      <AnimatePresence initial={false}>
        {selectedLog && renderDetailModal()}
      </AnimatePresence>
    </div>
  );
}
