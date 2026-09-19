import { z } from "zod";
import type { ProcessedDataAgentImageAttachment } from "@/lib/data-agent";
import { createMessage } from "@/lib/services/message";
import { updateProjectActivity } from "@/lib/services/project";
import { streamManager } from "@/lib/services/stream";
import { serializeMessage } from "@/lib/serializers/chat";
import { detectPersonalMemoryCandidate } from "@/lib/platform/memory/candidate";
import { DEFAULT_QUANT_CAPABILITY_ID } from "@/lib/domains/finance/capabilities";
import { createFinanceGenerationEnvelope } from "./finance-generation-executor";
import { enqueueQuantGeneration } from "./generation-queue";

const text = (max: number) => z.string().min(1).max(max);
export const financeResearchRequestSchema = z
  .object({
    phase: z.literal("preparation"),
    schemaVersion: z.literal(1),
    finalInstruction: text(220_000),
    displayInstruction: text(200_000),
    imageAttachmentInstruction: z.string().max(20_000),
    selectedModel: text(512),
    cliPreference: z.literal("pi"),
    isInitialPrompt: z.boolean(),
    conversationId: text(256).nullable(),
    actorUserId: text(512).nullable(),
    memorySubjectId: text(512),
    userMessageId: text(512),
    capabilityId: text(128).nullable(),
    capabilitySelectionSource: z
      .enum(["manual", "default", "inferred"])
      .nullable(),
    processedImages: z
      .array(
        z
          .object({
            name: text(512),
            path: text(4096),
            url: text(4096),
            publicUrl: text(4096),
            mimeType: text(128),
            size: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

export type FinanceResearchRequest = z.infer<
  typeof financeResearchRequestSchema
>;

/** Ingress performs only local attachment checks and persistence, never model or data calls. */
export async function enqueueFinanceResearchRequest(input: {
  projectId: string;
  projectPath: string;
  requestId: string;
  finalInstruction: string;
  displayInstruction: string;
  imageAttachmentInstruction: string;
  attachmentContextPath: string | null;
  selectedModel: string;
  isInitialPrompt: boolean;
  conversationId: string | null;
  actorUserId: string | null;
  memorySubjectId: string;
  capabilityId?: string;
  capabilitySelectionSource?: "manual" | "default" | "inferred";
  processedImages: ProcessedDataAgentImageAttachment[];
}): Promise<{ userMessageId: string }> {
  const personalizationCandidate = detectPersonalMemoryCandidate(
    input.displayInstruction,
  );
  const message = await createMessage({
    projectId: input.projectId,
    requestId: input.requestId,
    role: "user",
    messageType: "chat",
    content: input.displayInstruction,
    conversationId: input.conversationId ?? undefined,
    cliSource: "pi",
    metadata: {
      ...(input.processedImages.length
        ? {
            attachments: input.processedImages.map(
              ({ name, url, publicUrl, path }) => ({
                name,
                url,
                publicUrl,
                path,
              }),
            ),
            attachmentContextPath: input.attachmentContextPath,
          }
        : {}),
      ...(personalizationCandidate ? { personalizationCandidate } : {}),
    },
  });
  const payload = financeResearchRequestSchema.parse({
    phase: "preparation",
    schemaVersion: 1,
    finalInstruction: input.finalInstruction,
    displayInstruction: input.displayInstruction,
    imageAttachmentInstruction: input.imageAttachmentInstruction,
    selectedModel: input.selectedModel,
    cliPreference: "pi",
    isInitialPrompt: input.isInitialPrompt,
    conversationId: input.conversationId,
    actorUserId: input.actorUserId,
    memorySubjectId: input.memorySubjectId,
    userMessageId: message.id,
    capabilityId: input.capabilityId ?? null,
    capabilitySelectionSource: input.capabilitySelectionSource ?? null,
    processedImages: input.processedImages,
  });
  const executionEnvelope = createFinanceGenerationEnvelope(payload, {
    projectId: input.projectId,
    requestId: input.requestId,
    // This is a routing composition, not the accepted research capability.
    // Planning determines and checkpoints the final composition in the Worker.
    capabilityId: input.capabilityId ?? DEFAULT_QUANT_CAPABILITY_ID,
  });
  await enqueueQuantGeneration({
    projectPath: input.projectPath,
    projectId: input.projectId,
    requestId: input.requestId,
    instruction: input.finalInstruction,
    selectedModel: input.selectedModel,
    cliPreference: "pi",
    executionEnvelope,
    stage: "planning_data_prefetch",
    maxAttempts: 1,
  });
  // These projections cannot revoke an acknowledgement committed to PostgreSQL.
  await updateProjectActivity(input.projectId).catch((error) =>
    console.warn("[ResearchQueue] Activity projection failed:", error),
  );
  try {
    streamManager.publish(input.projectId, {
      type: "message",
      data: serializeMessage(message, { requestId: input.requestId }),
    });
  } catch (error) {
    console.warn("[ResearchQueue] Message projection failed:", error);
  }
  return { userMessageId: message.id };
}
