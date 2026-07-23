import type { ChatMessage } from "@/types";
import { normalizeChatContent } from "@/lib/serializers/client/chat";
import { collapseToolReadActivities } from "@/lib/chat/tool-activity";

export type ToolAction =
  | "Edited"
  | "Created"
  | "Read"
  | "Deleted"
  | "Generated"
  | "Searched"
  | "Executed";

export type ToolExpansionState = {
  expanded: boolean;
  requestId?: string | null;
  toolCallId?: string | null;
};

export function shouldDisplayChatMessage(params: {
  message: ChatMessage;
  ensureStableMessageId: (message: ChatMessage) => string;
  isToolUsageMessage: (message: ChatMessage) => boolean;
  visibleToolMessageIds: Set<string>;
}): boolean {
  const { message } = params;
  const metadata = getMessageMetadataRecord(message);
  const contentText = normalizeChatContent(message.content);

  if (metadata?.hidden_from_ui === true) return false;
  if (
    metadata?.isTransientToolMessage === true &&
    message.messageType !== "tool_use" &&
    message.messageType !== "tool_result" &&
    message.role !== "tool"
  ) {
    return false;
  }
  if (Array.isArray(metadata?.attachments) && metadata.attachments.length > 0) {
    return true;
  }

  if (message.messageType === "tool_result") {
    const messageId = message.id ?? params.ensureStableMessageId(message);
    const summary = metadata
      ? (pickFirstString(metadata.summary) ??
        pickFirstString(metadata.result) ??
        pickFirstString(metadata.resultSummary) ??
        pickFirstString(metadata.result_summary) ??
        pickFirstString(metadata.command) ??
        pickFirstString(metadata.content) ??
        pickFirstString(metadata.output))
      : undefined;
    const diff = metadata
      ? (pickFirstString(metadata.diff) ??
        pickFirstString(metadata.diff_info) ??
        pickFirstString(metadata.toolOutput) ??
        pickFirstString(metadata.tool_output))
      : undefined;
    const toolName = metadata
      ? (pickFirstString(metadata.tool_name) ??
        pickFirstString(metadata.toolName) ??
        pickFirstString(metadata.action))
      : undefined;
    const shouldShow = Boolean(
      contentText.trim() || summary || diff || toolName,
    );
    if (shouldShow && messageId) params.visibleToolMessageIds.add(messageId);
    return (
      shouldShow ||
      Boolean(messageId && params.visibleToolMessageIds.has(messageId))
    );
  }

  if (
    message.messageType === "tool_use" ||
    params.isToolUsageMessage(message)
  ) {
    return true;
  }
  if (!contentText.trim()) return false;
  if (
    message.role === "system" &&
    message.messageType === "system" &&
    (contentText.includes("initialized") || contentText.includes("Agent"))
  ) {
    return false;
  }
  return true;
}

const TOOL_NAME_ACTION_MAP: Record<string, ToolAction> = {
  read: "Read",
  read_file: "Read",
  "read-file": "Read",
  write: "Created",
  write_file: "Created",
  "write-file": "Created",
  create_file: "Created",
  edit: "Edited",
  edit_file: "Edited",
  "edit-file": "Edited",
  update_file: "Edited",
  apply_patch: "Edited",
  patch_file: "Edited",
  remove_file: "Deleted",
  delete_file: "Deleted",
  delete: "Deleted",
  remove: "Deleted",
  list_files: "Searched",
  list: "Searched",
  ls: "Searched",
  glob: "Searched",
  glob_files: "Searched",
  search_files: "Searched",
  grep: "Searched",
  bash: "Executed",
  run: "Executed",
  run_bash: "Executed",
  shell: "Executed",
  todo_write: "Generated",
  todo: "Generated",
  plan_write: "Generated",
  "run-planner": "Generated",
  query_json: "Read",
  query_text_file: "Read",
  inspect_dashboard_contract: "Read",
  "quant-data-registry": "Read",
  "quant-market-data": "Read",
  "dashboard-visualization": "Created",
  submit_result: "Generated",
};

const normalizeAction = (value: unknown): ToolAction | undefined => {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim().toLowerCase();
  if (!candidate) return undefined;
  if (
    candidate.includes("edit") ||
    candidate.includes("modify") ||
    candidate.includes("update") ||
    candidate.includes("patch")
  ) {
    return "Edited";
  }
  if (
    candidate.includes("write") ||
    candidate.includes("create") ||
    candidate.includes("add") ||
    candidate.includes("append")
  ) {
    return "Created";
  }
  if (
    candidate.includes("read") ||
    candidate.includes("open") ||
    candidate.includes("view")
  ) {
    return "Read";
  }
  if (candidate.includes("delete") || candidate.includes("remove")) {
    return "Deleted";
  }
  if (
    candidate.includes("search") ||
    candidate.includes("find") ||
    candidate.includes("list") ||
    candidate.includes("glob") ||
    candidate.includes("ls") ||
    candidate.includes("grep")
  ) {
    return "Searched";
  }
  if (
    candidate.includes("generate") ||
    candidate.includes("todo") ||
    candidate.includes("plan")
  ) {
    return "Generated";
  }
  if (
    candidate.includes("execute") ||
    candidate.includes("exec") ||
    candidate.includes("run") ||
    candidate.includes("bash") ||
    candidate.includes("shell") ||
    candidate.includes("command")
  ) {
    return "Executed";
  }
  return undefined;
};

export const inferActionFromToolName = (
  toolName: unknown,
): ToolAction | undefined => {
  if (typeof toolName !== "string") return undefined;
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) return undefined;
  if (TOOL_NAME_ACTION_MAP[normalized]) {
    return TOOL_NAME_ACTION_MAP[normalized];
  }
  const suffix = normalized.split(":").pop() ?? normalized;
  if (suffix && TOOL_NAME_ACTION_MAP[suffix]) {
    return TOOL_NAME_ACTION_MAP[suffix];
  }
  return normalizeAction(normalized);
};

export const pickFirstString = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const candidate = pickFirstString(entry);
      if (candidate) return candidate;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const nestedKeys = [
      "path",
      "filepath",
      "filePath",
      "file_path",
      "target",
      "value",
    ];
    for (const key of nestedKeys) {
      if (key in obj) {
        const candidate = pickFirstString(obj[key]);
        if (candidate) return candidate;
      }
    }
  }
  return undefined;
};

const stringifyToolDetail = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    const fallback = String(value).trim();
    return fallback.length > 0 && fallback !== "[object Object]"
      ? fallback
      : undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const parseJsonRecord = (value: string): Record<string, unknown> | null => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const extractSkillNameFromValue = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const jsonRecord = parseJsonRecord(value);
    if (jsonRecord) {
      return extractSkillNameFromValue(jsonRecord);
    }
    const launchMatch = value.match(/Launching skill:\s*([A-Za-z0-9_.-]+)/i);
    if (launchMatch?.[1]) {
      return launchMatch[1];
    }
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const directKeys = [
    "skill",
    "skillName",
    "skill_name",
    "skillId",
    "skill_id",
  ];
  for (const key of directKeys) {
    const candidate = pickFirstString(value[key]);
    if (candidate) {
      return candidate;
    }
  }

  const nestedKeys = ["args", "input", "toolInput", "tool_input"];
  for (const key of nestedKeys) {
    const candidate = extractSkillNameFromValue(value[key]);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
};

const isGenericSkillToolName = (toolName?: string): boolean => {
  if (!toolName) {
    return false;
  }
  const normalized = toolName.trim().toLowerCase();
  return (
    normalized === "skill" ||
    normalized === "skills" ||
    normalized === "tool" ||
    normalized === "tool_use"
  );
};

const extractSkillTargetFromInput = (input: unknown): string | undefined => {
  if (!isRecord(input)) {
    return undefined;
  }

  const directArgs = input.args;
  if (typeof directArgs === "string" && directArgs.trim()) {
    return directArgs.trim();
  }

  if (isRecord(directArgs)) {
    const query =
      pickFirstString(directArgs.query) ??
      pickFirstString(directArgs.symbol) ??
      pickFirstString(directArgs.name) ??
      pickFirstString(directArgs.prompt) ??
      pickFirstString(directArgs.task);
    if (query) {
      return query;
    }
  }

  return undefined;
};

const extractPathFromInput = (
  input: unknown,
  action?: ToolAction,
): string | undefined => {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const candidateKeys = [
    "filePath",
    "file_path",
    "filepath",
    "path",
    "targetPath",
    "target_path",
    "target",
    "targets",
    "fullPath",
    "full_path",
    "destination",
    "destinationPath",
    "outputPath",
    "output_path",
    "glob",
    "pattern",
    "directory",
    "dir",
    "filename",
    "name",
  ];

  for (const key of candidateKeys) {
    if (key in record) {
      const candidate = record[key];
      const result = pickFirstString(candidate);
      if (result) {
        return result;
      }
    }
  }

  if (Array.isArray(record.targets)) {
    for (const target of record.targets as unknown[]) {
      const candidate = pickFirstString(target);
      if (candidate) {
        return candidate;
      }
    }
  }

  if (!action || action === "Executed") {
    const commandKeys = ["command", "cmd", "shellCommand", "shell_command"];
    for (const key of commandKeys) {
      if (key in record) {
        const candidate = pickFirstString(record[key]);
        if (candidate) {
          return candidate;
        }
      }
    }
  }

  return undefined;
};

const extractPathFromToolText = (value: unknown): string | undefined => {
  const text = stringifyToolDetail(value);
  if (!text) return undefined;

  const patterns = [
    /File created successfully at:\s*([^\n(]+)/i,
    /The file\s+(.+?)\s+has been updated successfully/i,
    /File (?:updated|written|created) successfully at:\s*([^\n(]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
};

export const extractToolCallId = (
  metadata?: Record<string, unknown> | null,
): string | null => {
  if (!metadata) return null;

  const directCandidates = [
    metadata.toolCallId,
    metadata.tool_call_id,
    metadata.toolCallID,
    metadata.tool_callID,
    metadata.toolUseId,
    metadata.tool_use_id,
    metadata.toolUseID,
    metadata.tool_useID,
  ];

  for (const candidate of directCandidates) {
    const value = pickFirstString(candidate);
    if (value) {
      return value;
    }
  }

  const nested = (metadata.tool_call ??
    metadata.toolCall ??
    metadata.tool ??
    null) as Record<string, unknown> | undefined;
  if (nested && typeof nested === "object") {
    const nestedCandidates = [
      nested.id,
      nested.toolCallId,
      nested.tool_call_id,
      nested.tool_callID,
      nested.toolUseId,
      nested.tool_use_id,
    ];
    for (const candidate of nestedCandidates) {
      const value = pickFirstString(candidate);
      if (value) {
        return value;
      }
    }
  }

  return null;
};

export const deriveToolInfoFromMetadata = (
  metadata?: Record<string, unknown> | null,
): {
  action?: ToolAction;
  filePath?: string;
  cleanContent?: string;
  toolName?: string;
  command?: string;
  input?: string;
  output?: string;
  outputOriginalChars?: number;
  outputTruncated?: boolean;
  summary?: string;
  status?: "executing" | "done";
  success?: boolean;
  errorCode?: string;
  attemptCount?: number;
  recoveredFailureCount?: number;
  pathCorrected?: boolean;
  requestedPath?: string;
} => {
  if (!metadata) {
    return {};
  }

  const meta = metadata as Record<string, unknown>;
  const rawToolName =
    pickFirstString(meta.toolName) ?? pickFirstString(meta.tool_name);
  const toolInput = meta.toolInput ?? meta.tool_input ?? meta.input;
  const skillName =
    extractSkillNameFromValue(toolInput) ??
    extractSkillNameFromValue(meta.args) ??
    extractSkillNameFromValue(meta);
  const toolName =
    isGenericSkillToolName(rawToolName) && skillName ? skillName : rawToolName;
  const action =
    normalizeAction(meta.action) ??
    normalizeAction(meta.operation) ??
    inferActionFromToolName(rawToolName) ??
    inferActionFromToolName(toolName);

  const directPath =
    pickFirstString(meta.filePath) ??
    pickFirstString(meta.file_path) ??
    pickFirstString(meta.targetPath) ??
    pickFirstString(meta.target_path) ??
    pickFirstString(meta.path) ??
    pickFirstString(meta.target);

  const toolOutput =
    meta.toolOutput ??
    meta.tool_output ??
    meta.output ??
    meta.result ??
    meta.diff ??
    meta.diffInfo ??
    meta.diff_info;
  const outputSkillName = extractSkillNameFromValue(toolOutput);
  const finalToolName =
    isGenericSkillToolName(toolName) && outputSkillName
      ? outputSkillName
      : toolName;
  let filePath =
    directPath ??
    (skillName ? extractSkillTargetFromInput(toolInput) : undefined) ??
    extractPathFromInput(toolInput, action) ??
    extractPathFromToolText(toolOutput);

  if (!filePath) {
    const command =
      pickFirstString(meta.command) ??
      (toolInput && typeof toolInput === "object"
        ? pickFirstString((toolInput as Record<string, unknown>).command)
        : undefined);
    if (command) {
      filePath = command;
    }
  }

  const cleanContent =
    pickFirstString(meta.summary) ??
    pickFirstString(meta.description) ??
    pickFirstString(meta.resultSummary) ??
    pickFirstString(meta.result_summary) ??
    pickFirstString(meta.diff) ??
    pickFirstString(meta.diffInfo) ??
    pickFirstString(meta.diff_info) ??
    pickFirstString(meta.message) ??
    pickFirstString(meta.content);
  const summary =
    pickFirstString(meta.summary) ??
    pickFirstString(meta.description) ??
    pickFirstString(meta.resultSummary) ??
    pickFirstString(meta.result_summary);

  return {
    action: action ?? inferActionFromToolName(finalToolName),
    filePath,
    cleanContent,
    toolName: finalToolName,
    command:
      pickFirstString(meta.command) ??
      (toolInput && typeof toolInput === "object"
        ? pickFirstString((toolInput as Record<string, unknown>).command)
        : undefined),
    input: stringifyToolDetail(toolInput),
    output: stringifyToolDetail(toolOutput),
    outputOriginalChars:
      typeof meta.toolOutputOriginalChars === "number" &&
      Number.isFinite(meta.toolOutputOriginalChars)
        ? meta.toolOutputOriginalChars
        : undefined,
    outputTruncated: meta.toolOutputTruncated === true,
    summary,
    status: meta.isTransientToolMessage ? "executing" : "done",
    success: typeof meta.success === "boolean" ? meta.success : undefined,
    errorCode:
      pickFirstString(meta.errorCode) ?? pickFirstString(meta.error_code),
    attemptCount:
      typeof meta.activityAttemptCount === "number"
        ? meta.activityAttemptCount
        : undefined,
    recoveredFailureCount:
      typeof meta.recoveredFailureCount === "number"
        ? meta.recoveredFailureCount
        : undefined,
    pathCorrected: meta.pathCorrected === true,
    requestedPath: pickFirstString(meta.requestedPath),
  };
};

export const randomMessageId = () => {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `msg_${Math.random().toString(36).slice(2, 11)}`;
};

const hashString = (value: string): string => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
};

const buildToolMessageKey = (
  message: ChatMessage,
  metadata?: Record<string, unknown> | null,
): string => {
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

  const record =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>)
      : {};
  const metadataKeys = [
    "toolCallId",
    "tool_call_id",
    "toolName",
    "tool_name",
    "filePath",
    "file_path",
    "path",
    "target",
    "targetPath",
    "target_path",
    "action",
    "operation",
  ];

  metadataKeys.forEach((key) => {
    addPart(key, record[key]);
  });

  const nestedToolCall = (record.tool_call ?? record.toolCall) as
    | Record<string, unknown>
    | undefined;
  if (nestedToolCall && typeof nestedToolCall === "object") {
    addPart("tool_call.id", nestedToolCall.id);
    addPart(
      "tool_call.name",
      nestedToolCall.name ??
        nestedToolCall.tool_name ??
        nestedToolCall.toolName,
    );
  }

  if (parts.length === 0) {
    addPart("created", message.createdAt);
    addPart("cli", message.cliSource);
  }

  if (parts.length === 0 && message.id) {
    addPart("id", message.id);
  }

  return parts.join("|");
};

export const expandMessagesList = (
  messages: ChatMessage[],
  ensureMessageId: (message: ChatMessage) => string,
): ChatMessage[] => {
  const result: ChatMessage[] = [];
  const seen = new Set<string>();
  const seenByContent = new Map<string, string>(); // Track by content to detect near-duplicates

  messages.forEach((message) => {
    const expanded = [message];
    expanded.forEach((entry) => {
      if (!entry.id) {
        entry.id = ensureMessageId(entry);
      }

      // Enhanced duplicate detection
      if (seen.has(entry.id)) {
        return; // Skip exact ID duplicates
      }

      // Check for content-based duplicates (for tool messages that might have different IDs)
      if (entry.role === "tool" && entry.content) {
        const contentHash = hashString(entry.content).substring(0, 16);
        if (seenByContent.has(contentHash)) {
          const existingId = seenByContent.get(contentHash);
          if (existingId !== entry.id) {
            return; // Skip content duplicates
          }
        }
        seenByContent.set(contentHash, entry.id);
      }

      result.push(entry);
      seen.add(entry.id);
    });
  });

  return result;
};

const metadataEquals = (a: any, b: any): boolean => {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

const areMessagesEqual = (prev: ChatMessage[], next: ChatMessage[]) => {
  if (prev === next) {
    return true;
  }
  if (prev.length !== next.length) {
    return false;
  }
  for (let i = 0; i < prev.length; i += 1) {
    const a = prev[i];
    const b = next[i];
    if (a.id !== b.id) return false;
    if (a.role !== b.role) return false;
    if (a.messageType !== b.messageType) return false;
    if (a.content !== b.content) return false;
    if (a.updatedAt !== b.updatedAt) return false;
    if (a.requestId !== b.requestId) return false;
    if (a.isStreaming !== b.isStreaming) return false;
    if (a.isFinal !== b.isFinal) return false;
    if (a.isOptimistic !== b.isOptimistic) return false;
    if (!metadataEquals(a.metadata, b.metadata)) return false;
  }
  return true;
};

const mergeMetadataObjects = (
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null => {
  if (!existing && !incoming) {
    return null;
  }
  if (!existing) {
    return incoming ? { ...incoming } : null;
  }
  if (!incoming) {
    return { ...existing };
  }

  const existingAttachments = Array.isArray((existing as any)?.attachments)
    ? (existing as any).attachments
    : undefined;
  const incomingAttachments = Array.isArray((incoming as any)?.attachments)
    ? (incoming as any).attachments
    : undefined;

  const merged: Record<string, unknown> = { ...existing };

  Object.entries(incoming).forEach(([key, value]) => {
    const existingValue = merged[key];

    if (value === undefined) {
      return;
    }

    if (value === null) {
      if (existingValue !== undefined) {
        return;
      }
      merged[key] = value;
      return;
    }

    if (typeof value === "string") {
      if (
        value.trim().length === 0 &&
        typeof existingValue === "string" &&
        existingValue.trim().length > 0
      ) {
        return;
      }
      merged[key] = value;
      return;
    }

    if (
      Array.isArray(value) &&
      value.length === 0 &&
      Array.isArray(existingValue) &&
      existingValue.length > 0
    ) {
      return;
    }

    merged[key] = value;
  });

  if (incomingAttachments && incomingAttachments.length > 0) {
    (merged as any).attachments = incomingAttachments;
  } else if (existingAttachments && existingAttachments.length > 0) {
    (merged as any).attachments = existingAttachments;
  }

  return merged;
};

const mergeMessageRecord = (
  existing: ChatMessage,
  incoming: ChatMessage,
): ChatMessage => {
  const incomingContent = normalizeChatContent(incoming.content);
  const existingContent = normalizeChatContent(existing.content);
  const shouldKeepExistingContent =
    incomingContent.trim().length === 0 && existingContent.trim().length > 0;

  const resolvedCreatedAt = (() => {
    if (!existing.createdAt) return incoming.createdAt ?? existing.createdAt;
    if (!incoming.createdAt) return existing.createdAt;

    const incomingIsDurable =
      !incoming.isOptimistic && (!incoming.isStreaming || incoming.isFinal);
    const replacesTransient =
      existing.isOptimistic || (existing.isStreaming && !existing.isFinal);

    if (incomingIsDurable && replacesTransient) {
      return incoming.createdAt;
    }

    return new Date(incoming.createdAt).getTime() <
      new Date(existing.createdAt).getTime()
      ? incoming.createdAt
      : existing.createdAt;
  })();

  const resolvedUpdatedAt = (() => {
    const existingTime = existing.updatedAt ?? existing.createdAt;
    const incomingTime = incoming.updatedAt ?? incoming.createdAt;
    if (!existingTime) return incomingTime ?? existingTime;
    if (!incomingTime) return existingTime;
    return new Date(incomingTime).getTime() >= new Date(existingTime).getTime()
      ? incomingTime
      : existingTime;
  })();

  const mergedMetadata = mergeMetadataObjects(
    existing.metadata as Record<string, unknown> | null | undefined,
    incoming.metadata as Record<string, unknown> | null | undefined,
  );

  const merged: ChatMessage = {
    ...existing,
    ...incoming,
    content: shouldKeepExistingContent ? existing.content : incoming.content,
    metadata: mergedMetadata,
    createdAt: resolvedCreatedAt ?? existing.createdAt,
    updatedAt: resolvedUpdatedAt,
    requestId: incoming.requestId ?? existing.requestId,
    isOptimistic: incoming.isOptimistic ?? existing.isOptimistic,
    isStreaming: incoming.isStreaming ?? existing.isStreaming,
    isFinal: incoming.isFinal ?? existing.isFinal,
  };

  const unchanged =
    merged.content === existing.content &&
    merged.createdAt === existing.createdAt &&
    merged.updatedAt === existing.updatedAt &&
    merged.isStreaming === existing.isStreaming &&
    merged.isFinal === existing.isFinal &&
    merged.isOptimistic === existing.isOptimistic &&
    merged.requestId === existing.requestId &&
    metadataEquals(merged.metadata, existing.metadata);

  return unchanged ? existing : merged;
};

const ensureMessageIdentity = (message: ChatMessage): ChatMessage => {
  if (message.id) {
    return message;
  }
  return { ...message, id: randomMessageId() };
};

export const integrateMessages = (
  previous: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] => {
  if (incoming.length === 0) {
    return previous;
  }

  const map = new Map<string, ChatMessage>();

  previous.forEach((original) => {
    const message = ensureMessageIdentity(original);
    map.set(message.id, message);
  });

  incoming.forEach((rawMessage) => {
    let message = ensureMessageIdentity(rawMessage);

    if (!message.isOptimistic && message.requestId) {
      let preservedAttachments: any[] | undefined;

      Array.from(map.entries()).forEach(([key, existing]) => {
        if (existing.requestId === message.requestId && existing.isOptimistic) {
          const existingAttachments = Array.isArray(
            (existing.metadata as any)?.attachments,
          )
            ? (existing.metadata as any).attachments
            : undefined;
          if (
            existingAttachments &&
            existingAttachments.length > 0 &&
            (!preservedAttachments || preservedAttachments.length === 0)
          ) {
            preservedAttachments = [...existingAttachments];
            console.log("🖼️ Preserving optimistic attachments for request:", {
              requestId: message.requestId,
              attachments: preservedAttachments,
            });
          }
          map.delete(key);
        }
      });

      if (
        preservedAttachments &&
        preservedAttachments.length > 0 &&
        (!Array.isArray((message.metadata as any)?.attachments) ||
          ((message.metadata as any)?.attachments?.length ?? 0) === 0)
      ) {
        message = {
          ...message,
          metadata: {
            ...(message.metadata ?? {}),
            attachments: preservedAttachments,
          },
        };
      }
    }

    const existing = map.get(message.id);
    if (existing) {
      const merged = mergeMessageRecord(existing, message);
      map.set(merged.id ?? message.id, merged);
    } else {
      map.set(message.id, message);
    }
  });

  const sorted = Array.from(map.values()).sort((a, b) => {
    const timeDiff =
      new Date(a.createdAt ?? 0).getTime() -
      new Date(b.createdAt ?? 0).getTime();
    if (timeDiff !== 0) {
      return timeDiff;
    }
    return (a.id ?? "").localeCompare(b.id ?? "");
  });

  return areMessagesEqual(previous, sorted) ? previous : sorted;
};

const getMessageMetadataRecord = (
  message: ChatMessage,
): Record<string, unknown> | null =>
  message.metadata && typeof message.metadata === "object"
    ? (message.metadata as Record<string, unknown>)
    : null;

const getToolOutputText = (message: ChatMessage): string | undefined => {
  const metadata = getMessageMetadataRecord(message);
  if (metadata) {
    const output =
      metadata.toolOutput ??
      metadata.tool_output ??
      metadata.output ??
      metadata.result ??
      metadata.content ??
      metadata.summary;
    const serialized = stringifyToolDetail(output);
    if (serialized) {
      return serialized;
    }
  }

  const content = normalizeChatContent(message.content).trim();
  return content.length > 0 ? content : undefined;
};

const mergeToolResultIntoUsage = (
  usage: ChatMessage,
  result: ChatMessage,
): ChatMessage => {
  const usageMetadata = getMessageMetadataRecord(usage) ?? {};
  const resultMetadata = getMessageMetadataRecord(result) ?? {};
  const outputText = getToolOutputText(result);

  const mergedMetadata: Record<string, unknown> = {
    ...usageMetadata,
    ...Object.fromEntries(
      Object.entries(resultMetadata).filter(
        ([key, value]) =>
          value !== undefined &&
          value !== null &&
          ![
            "toolInput",
            "tool_input",
            "input",
            "toolName",
            "tool_name",
          ].includes(key),
      ),
    ),
    toolName: usageMetadata.toolName ?? usageMetadata.tool_name,
    tool_name: usageMetadata.tool_name ?? usageMetadata.toolName,
    toolInput:
      usageMetadata.toolInput ??
      usageMetadata.tool_input ??
      usageMetadata.input,
    tool_input:
      usageMetadata.tool_input ??
      usageMetadata.toolInput ??
      usageMetadata.input,
    isTransientToolMessage: false,
  };

  if (outputText) {
    mergedMetadata.toolOutput = outputText;
    mergedMetadata.tool_output = outputText;
    mergedMetadata.output = outputText;
  }

  return {
    ...usage,
    metadata: mergedMetadata,
    updatedAt: result.updatedAt ?? result.createdAt ?? usage.updatedAt,
    isStreaming: false,
    isFinal: true,
  };
};

export const mergeToolResultsIntoUsage = (
  messages: ChatMessage[],
): ChatMessage[] => {
  if (messages.length === 0) {
    return messages;
  }

  const resultByCallId = new Map<string, ChatMessage>();
  const usageCallIds = new Set<string>();

  messages.forEach((message) => {
    const metadata = getMessageMetadataRecord(message);
    const toolCallId = extractToolCallId(metadata);
    if (!toolCallId) {
      return;
    }

    if (message.messageType === "tool_result") {
      resultByCallId.set(toolCallId, message);
    } else if (message.messageType === "tool_use") {
      usageCallIds.add(toolCallId);
    }
  });

  if (resultByCallId.size === 0) {
    return messages;
  }

  const mergedMessages: ChatMessage[] = [];
  const usageIndexByCallId = new Map<string, number>();
  let changed = false;

  messages.forEach((message) => {
    const metadata = getMessageMetadataRecord(message);
    const toolCallId = extractToolCallId(metadata);

    if (
      message.messageType === "tool_result" &&
      toolCallId &&
      usageCallIds.has(toolCallId)
    ) {
      changed = true;
      return;
    }

    if (message.messageType === "tool_use" && toolCallId) {
      const mergedWithResult = resultByCallId.has(toolCallId)
        ? mergeToolResultIntoUsage(message, resultByCallId.get(toolCallId)!)
        : message;

      if (resultByCallId.has(toolCallId)) {
        changed = true;
      }

      const existingIndex = usageIndexByCallId.get(toolCallId);
      if (existingIndex !== undefined) {
        mergedMessages[existingIndex] = mergeMessageRecord(
          mergedMessages[existingIndex],
          mergedWithResult,
        );
        changed = true;
        return;
      }

      usageIndexByCallId.set(toolCallId, mergedMessages.length);
      mergedMessages.push(mergedWithResult);
      return;
    }

    mergedMessages.push(message);
  });

  return changed ? mergedMessages : messages;
};
