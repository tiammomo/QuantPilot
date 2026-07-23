import { describe, expect, it } from "vitest";

import {
  assertFinanceGenerationComposition,
  createFinanceGenerationEnvelope,
  parseFinanceGenerationEnvelope,
} from "./finance-generation-executor";
import type { QuantRunPlan } from "@/lib/domains/finance/workspace";
import type { MoAgentMissionSpec } from "@/lib/agent/mission";

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
  }, {
    projectId: "project-1",
    requestId: "request-1",
    capabilityId: "stock_diagnosis",
  });
}

function validExecutionBindings() {
  const envelope = validEnvelope();
  const runPlan = {
    runId: "run-1",
    status: "planned",
    capabilityId: envelope.composition.capability.id,
    composition: envelope.composition,
  } as QuantRunPlan;
  const missionSpec = {
    schemaVersion: 1,
    framework: "MoAgent",
    projectId: envelope.scope.projectId,
    requestId: envelope.scope.requestId,
    runPlanId: runPlan.runId,
    capabilityId: envelope.composition.capability.id,
    composition: {
      profileId: envelope.composition.profile.id,
      profileVersion: envelope.composition.profile.version,
      domainPacks: envelope.composition.domainPacks,
      deliveryPackId: envelope.composition.deliveryPack.id,
      deliveryPackVersion: envelope.composition.deliveryPack.version,
      compositionSha256: envelope.composition.sha256,
    },
  } as MoAgentMissionSpec;
  return { envelope, runPlan, missionSpec };
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

  it("fails closed when a registered composition is tampered", () => {
    const envelope = validEnvelope();
    expect(() => parseFinanceGenerationEnvelope({
      ...envelope,
      composition: {
        ...envelope.composition,
        sha256: `sha256:${"f".repeat(64)}`,
      },
    })).toThrow("does not match the registered profile");
  });

  it("accepts a single immutable composition across plan, mission and envelope", () => {
    expect(() =>
      assertFinanceGenerationComposition(validExecutionBindings()),
    ).not.toThrow();
  });

  it("fails closed when the run plan was replaced after dispatch", () => {
    const bindings = validExecutionBindings();
    bindings.runPlan.composition = {
      ...bindings.runPlan.composition,
      sha256: `sha256:${"e".repeat(64)}`,
    };
    expect(() => assertFinanceGenerationComposition(bindings)).toThrow(
      "run plan composition does not match",
    );
  });

  it("fails closed when the durable Mission belongs to another plan", () => {
    const bindings = validExecutionBindings();
    bindings.missionSpec.runPlanId = "run-replaced";
    expect(() => assertFinanceGenerationComposition(bindings)).toThrow(
      "Mission composition does not match",
    );
  });
});
