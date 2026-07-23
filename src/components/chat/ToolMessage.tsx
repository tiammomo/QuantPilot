"use client";

import { useRef } from "react";
import ToolResultItem from "@/components/chat/ToolResultItem";
import { normalizeChatContent } from "@/lib/serializers/client/chat";
import { toRelativePath } from "@/lib/utils/path";
import {
  deriveToolInfoFromMetadata,
  inferActionFromToolName,
  pickFirstString,
  type ToolAction,
} from "@/lib/chat/chat-message-runtime";

// Tool Message Component - Enhanced with new design
export const ToolMessage = ({
  content,
  metadata,
  isExpanded,
  onToggle,
}: {
  content: unknown;
  metadata?: Record<string, unknown> | null;
  isExpanded?: boolean;
  onToggle?: (nextExpanded: boolean) => void;
}) => {
  const metadataInfo = deriveToolInfoFromMetadata(metadata);
  const lastStableValuesRef = useRef<{
    action?: ToolAction;
    label?: string;
    content?: string;
    toolName?: string;
    input?: string;
    output?: string;
    summary?: string;
    status?: "executing" | "done";
  }>({});

  const processToolContent = (rawContent: unknown) => {
    let action: ToolAction = metadataInfo.action ?? "Executed";
    let filePath = metadataInfo.filePath ?? "";
    let cleanContent: string | undefined = metadataInfo.cleanContent;
    let inferredToolName = metadataInfo.toolName;
    let processedContent = "";

    if (!cleanContent && metadata && typeof metadata === "object") {
      const meta = metadata as Record<string, unknown>;
      cleanContent =
        pickFirstString(meta.result) ??
        pickFirstString(meta.output) ??
        pickFirstString(meta.diffSummary) ??
        pickFirstString(meta.diff_summary) ??
        pickFirstString(meta.diffInfo) ??
        pickFirstString(meta.diff_info) ??
        cleanContent;
    }

    processedContent = cleanContent ?? "";

    if (!processedContent) {
      processedContent = normalizeChatContent(rawContent);
    }

    if (
      metadataInfo.output &&
      (!processedContent ||
        processedContent === "Using tool: Skill" ||
        /^Using tool:/i.test(processedContent))
    ) {
      processedContent = metadataInfo.output;
      cleanContent = metadataInfo.output;
    }

    if (!processedContent && rawContent && typeof rawContent === "object") {
      const obj = rawContent as Record<string, unknown>;
      processedContent =
        pickFirstString(obj.summary) ??
        pickFirstString(obj.description) ??
        processedContent;
    }

    processedContent = processedContent
      .replace(/\[object Object\]/g, "")
      .replace(/[🔧⚡🔍📖✏️📁🌐🔎🤖📝🎯✅📓⚙️🧠]/g, "")
      .trim();

    const bracketMatch = processedContent.match(
      /^\[Tool:\s*([^\]\n]+)\s*\](.*)$/i,
    );
    if (bracketMatch) {
      const toolLabel = bracketMatch[1]?.trim();
      const trailing = bracketMatch[2]?.trim();
      if (toolLabel) {
        inferredToolName = inferredToolName ?? toolLabel;
        const inferred = inferActionFromToolName(toolLabel);
        if (inferred) {
          action = inferred;
        }
      }
      if (!filePath && trailing) {
        filePath = trailing;
      }
    }

    const usingToolMatch = processedContent.match(
      /^Using tool:\s*([^\n]+?)(?:\s+on\s+(.+))?$/i,
    );
    if (usingToolMatch) {
      const toolLabel = usingToolMatch[1]?.trim();
      const target = usingToolMatch[2]?.trim();
      if (toolLabel) {
        inferredToolName = inferredToolName ?? toolLabel;
        const inferred = inferActionFromToolName(toolLabel);
        if (inferred) {
          action = inferred;
        }
      }
      if (!filePath && target) {
        filePath = target;
      }
    }

    const toolResultMatch = processedContent.match(/^Tool result:\s*(.+)$/i);
    if (toolResultMatch && !cleanContent) {
      cleanContent = toolResultMatch[1]?.trim() || undefined;
    }

    if (!filePath) {
      const toolMatch = processedContent.match(
        /\*\*(Read|LS|Glob|Grep|Edit|Write|Bash|MultiEdit|TodoWrite)\*\*\s*`?([^`\n]+)`?/,
      );
      if (toolMatch) {
        const toolName = toolMatch[1];
        const toolArg = toolMatch[2].trim();

        switch (toolName) {
          case "Read":
            action = "Read";
            filePath = toolArg;
            cleanContent = undefined;
            break;
          case "Edit":
          case "MultiEdit":
            action = "Edited";
            filePath = toolArg;
            cleanContent = undefined;
            break;
          case "Write":
            action = "Created";
            filePath = toolArg;
            cleanContent = undefined;
            break;
          case "LS":
            action = "Searched";
            filePath = toolArg;
            cleanContent = undefined;
            break;
          case "Glob":
          case "Grep":
            action = "Searched";
            filePath = toolArg;
            cleanContent = undefined;
            break;
          case "Bash":
            action = "Executed";
            filePath = toolArg.split("\n")[0];
            cleanContent = undefined;
            break;
          case "TodoWrite":
            action = "Generated";
            filePath = "Todo List";
            cleanContent = undefined;
            break;
        }
      }
    }

    return {
      action,
      filePath,
      cleanContent:
        cleanContent ??
        (processedContent && processedContent !== filePath
          ? processedContent
          : undefined),
      toolName: inferredToolName,
    };
  };

  const { action, filePath, cleanContent, toolName } =
    processToolContent(content);

  const fallbackLabel =
    filePath ||
    metadataInfo.filePath ||
    (metadataInfo.toolName ? `Tool: ${metadataInfo.toolName}` : undefined) ||
    metadataInfo.command ||
    "Tool action";

  const cleanedContent =
    cleanContent &&
    cleanContent !== fallbackLabel &&
    !/^Using tool:/i.test(cleanContent)
      ? cleanContent
      : metadataInfo.cleanContent && metadataInfo.cleanContent !== fallbackLabel
        ? metadataInfo.cleanContent
        : undefined;

  const finalAction = action ?? metadataInfo.action ?? "Executed";
  const finalLabel =
    fallbackLabel === "Tool action" && (toolName ?? metadataInfo.toolName)
      ? `Tool: ${toolName ?? metadataInfo.toolName}`
      : fallbackLabel;
  const metadataContentCandidate =
    metadataInfo.cleanContent &&
    metadataInfo.cleanContent !== finalLabel &&
    metadataInfo.cleanContent.trim().length > 0
      ? metadataInfo.cleanContent
      : undefined;

  if (finalAction) {
    lastStableValuesRef.current.action = finalAction;
  }
  if (
    finalLabel &&
    finalLabel !== "Tool action" &&
    finalLabel.trim().length > 0
  ) {
    lastStableValuesRef.current.label = finalLabel;
  }
  if (cleanedContent && cleanedContent.trim().length > 0) {
    lastStableValuesRef.current.content = cleanedContent;
  } else if (metadataContentCandidate) {
    lastStableValuesRef.current.content = metadataContentCandidate;
  }
  if (toolName ?? metadataInfo.toolName) {
    lastStableValuesRef.current.toolName = toolName ?? metadataInfo.toolName;
  }
  if (metadataInfo.input) {
    lastStableValuesRef.current.input = metadataInfo.input;
  }
  if (metadataInfo.output ?? cleanedContent ?? metadataContentCandidate) {
    lastStableValuesRef.current.output =
      metadataInfo.output ?? cleanedContent ?? metadataContentCandidate;
  }
  if (metadataInfo.summary) {
    lastStableValuesRef.current.summary = metadataInfo.summary;
  }
  if (metadataInfo.status) {
    lastStableValuesRef.current.status = metadataInfo.status;
  }

  const persistedAction =
    lastStableValuesRef.current.action ?? finalAction ?? "Executed";
  const persistedLabel =
    finalLabel && finalLabel !== "Tool action"
      ? finalLabel
      : (lastStableValuesRef.current.label ?? finalLabel ?? "Tool action");
  const persistedContent =
    (cleanedContent && cleanedContent.trim().length > 0
      ? cleanedContent
      : metadataContentCandidate) ?? lastStableValuesRef.current.content;
  const persistedToolName =
    toolName ?? metadataInfo.toolName ?? lastStableValuesRef.current.toolName;
  const persistedInput =
    metadataInfo.input ?? lastStableValuesRef.current.input;
  const persistedOutput =
    metadataInfo.output ??
    (cleanedContent && cleanedContent.trim().length > 0
      ? cleanedContent
      : undefined) ??
    metadataContentCandidate ??
    lastStableValuesRef.current.output;
  const persistedSummary =
    metadataInfo.summary ?? lastStableValuesRef.current.summary;
  const persistedStatus =
    metadataInfo.status ?? lastStableValuesRef.current.status ?? "done";

  return (
    <ToolResultItem
      action={persistedAction}
      filePath={persistedLabel}
      content={persistedContent}
      toolName={persistedToolName}
      input={persistedInput}
      output={persistedOutput}
      outputOriginalChars={metadataInfo.outputOriginalChars}
      outputTruncated={metadataInfo.outputTruncated}
      summary={persistedSummary}
      status={persistedStatus}
      success={metadataInfo.success}
      errorCode={metadataInfo.errorCode}
      attemptCount={metadataInfo.attemptCount}
      recoveredFailureCount={metadataInfo.recoveredFailureCount}
      pathCorrected={metadataInfo.pathCorrected}
      requestedPath={metadataInfo.requestedPath}
      isExpanded={isExpanded}
      onToggle={onToggle}
    />
  );
};
