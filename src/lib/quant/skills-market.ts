import {
  readWorkspaceJsonBounded,
  readWorkspaceFileBounded,
} from "@/lib/data-agent/workspace-read";
import { assessSkillCompatibility } from "@/lib/agent/skills/compatibility";
import type { PiAgentSkillRuntimeCapsule } from "@/lib/agent/skills";
import { createFinancePiAgentTools } from "@/lib/domains/finance/agent-tools/factory";
import { QUANT_CAPABILITIES } from "@/lib/domains/finance/capabilities";
import { getSkillsDashboardData } from "./skills-dashboard";
import { inspectSkillInstallation } from "./skills-installation-status";

export async function getSkillsMarketData(project?: {
  id: string;
  workspace: string;
}) {
  const dashboard = await getSkillsDashboardData();
  const root = process.cwd();
  const { value } = await readWorkspaceJsonBounded(
    root,
    "config/pi-agent-skill-capsules.json",
  );
  const capsules = (
    value as { skills: Record<string, PiAgentSkillRuntimeCapsule> }
  ).skills;
  const tools = createFinancePiAgentTools({
    workspaceRoot: root,
    includeDashboardSpec: true,
  }).map((tool) => tool.name);
  const skills = dashboard.skills.map((skill) => {
    const capsule = capsules[skill.id];
    return {
      id: skill.id,
      name: skill.name,
      scope: skill.scope,
      version: skill.version,
      status: skill.status,
      boundary: skill.boundary,
      inputs: skill.inputs,
      outputs: skill.outputs,
      validation: skill.validation,
      health: skill.health.status,
      integrityProblems: skill.health.missing,
      packageVerified:
        skill.health.status === "ok" &&
        skill.package.exists &&
        skill.status === "stable",
      packageSha256: skill.lock.packageSha256,
      releases: skill.changelog.releases.map(
        ({ version, date, summary, changes }) => ({
          version,
          date,
          summary,
          changes,
        }),
      ),
      capabilities: QUANT_CAPABILITIES.filter((capability) =>
        capability.requiredSkills.includes(skill.id),
      ).map((capability) => capability.id),
      phases: (capsule?.phases ?? []).map((phase) => ({
        phase,
        ...assessSkillCompatibility(
          capsule,
          phase,
          phase === "platform-ui" ? [] : tools,
        ),
      })),
      requiredTools: capsule?.requiresTools ?? [],
      toolAlternatives: capsule?.requiresOneOfToolSets ?? [],
      activation:
        skill.scope === "platform"
          ? ("platform-only" as const)
          : ("task-selected" as const),
    };
  });
  return {
    generatedAt: dashboard.generatedAt,
    skills,
    capabilities: QUANT_CAPABILITIES.map(({ id, name, status }) => ({
      id,
      name,
      status,
    })),
    project: project
      ? {
          id: project.id,
          ...(await inspectSkillInstallation(
            project.workspace,
            dashboard.skills,
          )),
        }
      : null,
  };
}

export type SkillsMarketData = Awaited<ReturnType<typeof getSkillsMarketData>>;
export type SkillsMarketSkill = SkillsMarketData["skills"][number];
export async function readVerifiedSkillPackage(skillId: string) {
  const data = await getSkillsDashboardData();
  const skill = data.skills.find((item) => item.id === skillId);
  if (
    !skill ||
    skill.health.status !== "ok" ||
    !skill.package.exists ||
    skill.status !== "stable"
  ) {
    throw new Error("技能未发布或完整性校验失败，暂不可下载。");
  }
  const artifact = await readWorkspaceFileBounded(
    process.cwd(),
    skill.package.path,
    5 * 1024 * 1024,
  );
  if (artifact.sha256 !== `sha256:${skill.lock.packageSha256}`)
    throw new Error("技能包已变更，请刷新后重试。");
  return {
    content: artifact.content,
    sha256: artifact.sha256,
    version: skill.version,
  };
}
