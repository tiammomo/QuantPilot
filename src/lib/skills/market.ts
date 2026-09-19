import { deploymentKey, readSkillCatalogState, type SkillAgentTarget } from '@/lib/agent/skills/catalog-store';
import { resolveActiveSkillCatalog, resolveSkillCatalogImage } from '@/lib/agent/skills/catalog-images';
import { SKILL_AGENT_TARGETS } from '@/lib/agent/skills/workspace-install';
import { readSkillMetadata } from './publication';
import {
  readWorkspaceJsonBounded,
  readWorkspaceFileBounded,
} from "@/lib/data-agent/workspace-read";
import { assessSkillCompatibility } from "@/lib/agent/skills/compatibility";
import type { PiAgentSkillRuntimeCapsule } from "@/lib/agent/skills";
import { createFinancePiAgentTools } from "@/lib/domains/finance/agent-tools/factory";
import { QUANT_CAPABILITIES } from "@/lib/domains/finance/capabilities";
import { getSkillsDashboardData } from "./dashboard";
import { inspectSkillInstallation } from "./installation-status";

export async function getSkillsMarketData(project?: {
  id: string;
  workspace: string;
  target?: SkillAgentTarget;
}) {
  const state = await readSkillCatalogState(process.cwd());
  const root = state.active ? await resolveSkillCatalogImage(process.cwd(), state.active) : process.cwd();
  const dashboard = await getSkillsDashboardData(root);
  const target = project?.target ?? 'pi-agent';
  const deployment = project ? state.deployments[deploymentKey(project.workspace, target)] : undefined;
  const pinned = deployment ? await readSkillMetadata(await resolveSkillCatalogImage(process.cwd(), deployment.revision)) : null;
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
        ({ version, date, summary, changes, actor }) => ({
          actor,
          installable: state.releases.some((release) => release.skillId === skill.id && release.version === version) || (!state.active && version === skill.version),
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
    targets: Object.entries(SKILL_AGENT_TARGETS).map(([id, adapter]) => ({ id, ...adapter })),
    skills,
    capabilities: QUANT_CAPABILITIES.map(({ id, name, status }) => ({
      id,
      name,
      status,
    })),
    project: project
      ? {
          id: project.id,
          target,
          deployment: deployment ? { id: deployment.id, revision: deployment.revision, skillIds: deployment.skillIds,
            updatedAt: deployment.updatedAt, actor: deployment.actor, canRollback: Boolean(deployment.previous) } : null,
          execution: target === 'pi-agent' ? deployment ? 'pinned' as const : 'platform-current' as const : 'external-unverified' as const,
          ...(await inspectSkillInstallation(
            project.workspace,
            dashboard.skills, target,
            pinned && deployment ? { skillIds: deployment.skillIds, lock: pinned.lock } : undefined,
          )),
        }
      : null,
  };
}

export type SkillsMarketData = Awaited<ReturnType<typeof getSkillsMarketData>>;
export type SkillsMarketSkill = SkillsMarketData["skills"][number];
export async function readVerifiedSkillPackage(skillId: string) {
  const root = await resolveActiveSkillCatalog(process.cwd());
  const data = await getSkillsDashboardData(root);
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
    root,
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
