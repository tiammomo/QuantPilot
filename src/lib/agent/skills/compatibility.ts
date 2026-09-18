import type { PiAgentSkillPhase, PiAgentSkillRuntimeCapsule } from "./types";

/** Shared by discovery and execution; a compatible tool surface is not proof of task success. */
export function assessSkillCompatibility(
  capsule: PiAgentSkillRuntimeCapsule,
  phase: PiAgentSkillPhase,
  availableToolNames: readonly string[],
) {
  const available = new Set(availableToolNames);
  const missingTools = capsule.requiresTools.filter(
    (name) => !available.has(name),
  );
  const alternatives = capsule.requiresOneOfToolSets ?? [];
  const missingAlternative =
    alternatives.length > 0 &&
    !alternatives.some((group) => group.every((name) => available.has(name)));
  const phaseAllowed = capsule.phases.includes(phase);
  return {
    compatible: phaseAllowed && !missingTools.length && !missingAlternative,
    phaseAllowed,
    missingTools,
    missingAlternative,
  };
}
