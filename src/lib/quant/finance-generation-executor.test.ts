import { describe, expect, it } from "vitest";

import {
  createFinanceGenerationEnvelope,
  parseFinanceGenerationEnvelope,
} from "./finance-generation-executor";

function validEnvelope() {
  return createFinanceGenerationEnvelope({
    effectiveInstruction: "分析测试标的并生成工作区。",
    userVisibleInstructionForRepair: "分析测试标的。",
    selectedModel: "local_qwen:qwen3.5-9b-q5km",
    cliPreference: "moagent",
    isInitialPrompt: true,
    conversationId: null,
    actorUserId: "user-1",
    memorySubjectId: "subject-1",
    processedImages: [],
    usePrefetchedSelectionDashboard: false,
    missionId: "mission-1",
    generationId: "generation-1",
    governedKnowledgeTaskCategory: "single-stock-diagnosis",
    personalizationRecall: {
      status: "empty",
      capsule: null,
      exposedMemoryCount: 0,
      preparedUse: null,
    },
    governedKnowledgePreparation: {
      status: "empty",
      capsule: null,
      passageCount: 0,
      citationCount: 0,
    },
    concurrencyReservationId: null,
  });
}

describe("finance generation envelope", () => {
  it("keeps the prepared memory and knowledge snapshot in the durable input", () => {
    const parsed = parseFinanceGenerationEnvelope(validEnvelope());
    expect(parsed.personalizationRecall.status).toBe("empty");
    expect(parsed.governedKnowledgePreparation.status).toBe("empty");
  });

  it("fails closed when a persisted context snapshot is malformed", () => {
    const envelope = validEnvelope();
    expect(() =>
      parseFinanceGenerationEnvelope({
        ...envelope,
        payload: {
          ...envelope.payload,
          governedKnowledgePreparation: {
            status: "prepared",
            capsule: null,
            passageCount: -1,
            citationCount: 0,
          },
        },
      }),
    ).toThrow("passageCount must be a non-negative integer");
  });
});
