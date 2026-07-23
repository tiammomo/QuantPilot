import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@/types";
import {
  expandMessagesList,
  integrateMessages,
  mergeToolResultsIntoUsage,
  shouldDisplayChatMessage,
} from "./chat-message-runtime";

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message-1",
    role: "assistant",
    messageType: "chat",
    content: "",
    createdAt: "2026-07-22T09:00:00.000Z",
    ...overrides,
  } as ChatMessage;
}

describe("chat message runtime", () => {
  it("atomically replaces an optimistic message while preserving its attachments", () => {
    const optimistic = message({
      id: "optimistic-1",
      role: "user",
      requestId: "request-1",
      isOptimistic: true,
      metadata: {
        attachments: [{ publicUrl: "/api/assets/project/image.png" }],
      },
    });
    const durable = message({
      id: "durable-1",
      role: "user",
      requestId: "request-1",
      content: "durable",
      isOptimistic: false,
    });

    const result = integrateMessages([optimistic], [durable]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "durable-1", content: "durable" });
    expect(result[0].metadata).toMatchObject({
      attachments: [{ publicUrl: "/api/assets/project/image.png" }],
    });
  });

  it("projects a structured tool result onto its tool-use activity", () => {
    const usage = message({
      id: "tool-use-1",
      messageType: "tool_use",
      metadata: {
        toolCallId: "call-1",
        toolName: "query_json",
        toolInput: { path: "data_file/final/dashboard-data.json" },
        isTransientToolMessage: true,
      },
    });
    const result = message({
      id: "tool-result-1",
      messageType: "tool_result",
      content: '{"ok":true}',
      metadata: { toolCallId: "call-1", success: true },
    });

    const merged = mergeToolResultsIntoUsage([usage, result]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "tool-use-1",
      messageType: "tool_use",
      isFinal: true,
    });
    expect(merged[0].metadata).toMatchObject({
      toolCallId: "call-1",
      toolName: "query_json",
      toolOutput: '{"ok":true}',
      success: true,
      isTransientToolMessage: false,
    });
  });

  it("does not reinterpret unstructured placeholder text as a tool protocol", () => {
    const input = message({ content: "[Tool: read_file] app/page.tsx" });

    expect(expandMessagesList([input], () => "generated-id")).toEqual([input]);
  });

  it("derives visibility only from the structured message contract", () => {
    const visibleToolMessageIds = new Set<string>();
    const display = (candidate: ChatMessage) =>
      shouldDisplayChatMessage({
        message: candidate,
        ensureStableMessageId: () => "stable-id",
        isToolUsageMessage: (value) => value.messageType === "tool_use",
        visibleToolMessageIds,
      });

    expect(display(message({ content: "Using tool: read_file" }))).toBe(true);
    expect(
      display(
        message({
          content: "internal",
          metadata: { hidden_from_ui: true },
        }),
      ),
    ).toBe(false);
    expect(
      display(
        message({
          id: "result-1",
          messageType: "tool_result",
          metadata: { toolName: "query_json" },
        }),
      ),
    ).toBe(true);
    expect(visibleToolMessageIds).toContain("result-1");
  });
});
