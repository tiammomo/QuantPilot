import fs from "node:fs/promises";
import path from "node:path";
import {
  hashSkillDirectory,
} from "@/lib/agent/skills/workspace-integrity";
import { readSkillAssetsReceipt, SKILL_AGENT_TARGETS } from '@/lib/agent/skills/workspace-install';
import type { SkillAgentTarget } from '@/lib/agent/skills/catalog-store';
import type { PiAgentSkillsLock } from '@/lib/agent/skills';
import type { SkillItem } from "./skills-dashboard";

export type SkillInstallationState =
  | "current"
  | "outdated"
  | "modified"
  | "missing"
  | "unverified";
export interface SkillInstallationStatus {
  skillId: string;
  state: SkillInstallationState;
  installedVersion: string | null;
  expectedVersion: string;
}

/** Receipts are claims; the installed tree must match them before its version is trusted. */
export async function inspectSkillInstallation(
  workspace: string,
  skills: SkillItem[],
  target: SkillAgentTarget = 'pi-agent',
  trusted?: { skillIds: string[]; lock: PiAgentSkillsLock },
) {
  const runtime = path.join(workspace, SKILL_AGENT_TARGETS[target].directory);
  let receipt: Awaited<ReturnType<typeof readSkillAssetsReceipt>>;
  try {
    receipt = await readSkillAssetsReceipt(workspace, target);
  } catch {
    return {
      receiptStatus: "invalid" as const,
      installedAt: null,
      skills: skills.map((skill) => ({
        skillId: skill.id,
        state: "unverified" as const,
        installedVersion: null,
        expectedVersion: skill.version,
      })),
    };
  }
  const claims = (receipt?.skills ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const directory = path.join(runtime, "skills");
  const stat = await fs
    .lstat(directory)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  const safeDirectory = stat?.isDirectory() && !stat.isSymbolicLink();
  const statuses: SkillInstallationStatus[] = [];
  for (const skill of skills) {
    const claim = claims[skill.id];
    const result: SkillInstallationStatus = {
      skillId: skill.id,
      state: "missing",
      installedVersion: null,
      expectedVersion: skill.version,
    };
    if (stat && !safeDirectory) result.state = "unverified";
    else if (safeDirectory) {
      try {
        const actual = await hashSkillDirectory(path.join(directory, skill.id));
        if (
          !claim ||
          typeof claim.version !== "string" ||
          !/^\d+\.\d+\.\d+$/.test(claim.version) ||
          typeof claim.sourceSha256 !== "string"
        )
          result.state = "unverified";
        else if (trusted && (!trusted.skillIds.includes(skill.id) ||
          trusted.lock.skills[skill.id]?.version !== claim.version ||
          trusted.lock.skills[skill.id]?.sourceSha256 !== actual.hash ||
          trusted.lock.skills[skill.id]?.packageSha256 !== claim.packageSha256)) result.state = "modified";
        else if (actual.hash !== claim.sourceSha256) result.state = "modified";
        else {
          result.installedVersion = claim.version;
          result.state =
            claim.version !== skill.version
              ? "outdated"
              : actual.hash !== skill.lock.sourceSha256 ||
                  claim.packageSha256 !== skill.lock.packageSha256
                ? "modified"
                : "current";
        }
      } catch (error) {
        result.state =
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "missing"
            : "unverified";
      }
    }
    statuses.push(result);
  }
  return {
    receiptStatus: receipt ? ("present" as const) : ("missing" as const),
    installedAt:
      typeof receipt?.installedAt === "string" ? receipt.installedAt : null,
    skills: statuses,
  };
}
