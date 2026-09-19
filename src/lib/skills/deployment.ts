import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { compilePiAgentSkills } from "@/lib/agent/skills";
import {
  commitSkillCatalogState,
  deploymentKey,
  readSkillCatalogState,
  recordSkillEvent,
  SkillConflictError,
  withSkillCatalogLock,
  type SkillAgentTarget,
} from "@/lib/agent/skills/catalog-store";
import {
  initializeSkillCatalog,
  resolveSkillCatalogImage,
  sealSkillCatalog,
  stageSkillCatalog,
} from "@/lib/agent/skills/catalog-images";
import {
  installSkillAssets,
  readSkillAssetsReceipt,
  SKILL_AGENT_TARGETS,
  type SkillAssetsReceipt,
} from "@/lib/agent/skills/workspace-install";
import {
  hashSkillDirectory,
  isCanonicalSkillId,
} from "@/lib/agent/skills/workspace-integrity";
import { readSkillMetadata, replaceSkillInCatalog } from "./publication";

export interface SkillDeploymentRequest {
  workspace: string;
  target: SkillAgentTarget;
  action: "install" | "uninstall" | "rollback" | "initialize";
  skillId?: string;
  version?: string;
  skillIds?: string[];
  expectedRevision: string | null;
  actor: string;
  overwriteModified?: boolean;
}

async function verifiedLegacyClaims(
  workspace: string,
  target: SkillAgentTarget,
  metadata: Awaited<ReturnType<typeof readSkillMetadata>>,
) {
  const claims: SkillAssetsReceipt["skills"] = {};
  const receipt = await readSkillAssetsReceipt(workspace, target).catch(
    () => null,
  );
  for (const [id, claim] of Object.entries(receipt?.skills ?? {})) {
    const trusted = metadata.lock.skills[id];
    if (
      !trusted ||
      trusted.version !== claim.version ||
      trusted.sourceSha256 !== claim.sourceSha256 ||
      trusted.packageSha256 !== claim.packageSha256
    )
      continue;
    const actual = await hashSkillDirectory(
      path.join(workspace, SKILL_AGENT_TARGETS[target].directory, "skills", id),
    ).catch(() => null);
    if (actual?.hash === trusted.sourceSha256) claims[id] = claim;
  }
  return claims;
}

export async function deployProjectSkills(
  params: SkillDeploymentRequest,
  root = process.cwd(),
) {
  if (!Object.hasOwn(SKILL_AGENT_TARGETS, params.target))
    throw new Error("不支持的 Agent。");
  if (params.skillId && !isCanonicalSkillId(params.skillId))
    throw new Error("技能 ID 无效。");
  const workspace = await fs.realpath(params.workspace);
  return withSkillCatalogLock(root, async () => {
    const state = await readSkillCatalogState(root);
    const key = deploymentKey(workspace, params.target);
    const previous = state.deployments[key];
    if (params.action === "initialize" && previous) return previous;
    if ((previous?.id ?? null) !== params.expectedRevision)
      throw new SkillConflictError("项目技能版本已变更，请重新核验。");
    await initializeSkillCatalog(root, state);
    const activeRoot = await resolveSkillCatalogImage(
      root,
      state.active!,
      true,
    );
    const active = await readSkillMetadata(activeRoot);
    let skillIds =
      previous?.skillIds ??
      (params.target === "pi-agent"
        ? active.registry.coreSkills
            .filter((skill) => skill.status === "stable")
            .map((skill) => skill.id)
        : []);
    let imageRoot = previous
      ? await resolveSkillCatalogImage(root, previous.revision, true)
      : activeRoot;
    const previousMetadata = previous
      ? await readSkillMetadata(imageRoot)
      : null;
    const trustedManaged =
      previous && previousMetadata
        ? Object.fromEntries(
            previous.skillIds.map((id) => [
              id,
              {
                version: previousMetadata.lock.skills[id].version,
                source: "source",
                sourceSha256:
                  previousMetadata.lock.skills[id].sourceSha256 ?? null,
                packageSha256:
                  previousMetadata.lock.skills[id].packageSha256 ?? null,
              },
            ]),
          )
        : // A legacy receipt can only adopt content independently verified against
          // the trusted catalog. It cannot claim ownership of personal skills.
          await verifiedLegacyClaims(workspace, params.target, active);
    let revision = previous?.revision ?? state.active!;
    if (params.action === "rollback") {
      if (!previous?.previous) throw new Error("项目没有可回退的安装记录。");
      revision = previous.previous.revision;
      skillIds = previous.previous.skillIds;
      imageRoot = await resolveSkillCatalogImage(root, revision, true);
    } else if (params.action === "initialize") {
      if (previous)
        throw new SkillConflictError("项目已固定技能版本，请使用升级或回退。");
      skillIds = params.skillIds ?? skillIds;
    } else {
      if (
        !params.skillId ||
        !active.registry.coreSkills.some((skill) => skill.id === params.skillId)
      )
        throw new Error("技能未登记。");
      if (params.action === "uninstall") {
        if (!previous || !skillIds.includes(params.skillId))
          throw new Error("该技能未安装。");
        skillIds = skillIds.filter((id) => id !== params.skillId);
      } else {
        const version =
          params.version ??
          active.registry.coreSkills.find(
            (skill) => skill.id === params.skillId,
          )!.version;
        const release = state.releases.find(
          (item) => item.skillId === params.skillId && item.version === version,
        );
        if (!release) throw new Error("此版本缺少完整快照，不能安装。");
        const source = await resolveSkillCatalogImage(
          root,
          release.revision,
          true,
        );
        const stage = await stageSkillCatalog(root, imageRoot);
        try {
          await replaceSkillInCatalog(stage, source, params.skillId);
          revision = await sealSkillCatalog(root, stage);
        } finally {
          await fs.rm(stage, { recursive: true, force: true });
        }
        imageRoot = await resolveSkillCatalogImage(root, revision, true);
        skillIds = [...new Set([...skillIds, params.skillId])];
      }
    }
    const meta = await readSkillMetadata(imageRoot);
    for (const id of skillIds) {
      if (!isCanonicalSkillId(id)) throw new Error("技能 ID 无效。");
      const definition = meta.registry.coreSkills.find(
        (item) => item.id === id,
      );
      if (!definition || definition.status !== "stable")
        throw new Error(`技能 ${id} 不是稳定版本。`);
      const capsule = meta.capsules.skills[id];
      if (!capsule) throw new Error(`技能 ${id} 缺少运行规则。`);
      await compilePiAgentSkills({
        repositoryRoot: imageRoot,
        requiredSkillIds: [id],
        phase: capsule.phases[0],
        maxSystemContextChars: 32_000,
      });
    }
    state.deployments[key] = {
      id: randomUUID(),
      revision,
      skillIds: [...skillIds].sort(),
      target: params.target,
      updatedAt: new Date().toISOString(),
      actor: params.actor,
      ...(previous
        ? {
            previous: {
              revision: previous.revision,
              skillIds: previous.skillIds,
            },
          }
        : {}),
    };
    recordSkillEvent(state, {
      action: `deployment.${params.action}`,
      actor: params.actor,
      target: params.target,
      skillId: params.skillId,
      version: params.version,
    });
    await installSkillAssets({
      workspace,
      target: params.target,
      overwriteModified: params.overwriteModified,
      trustedManaged,
      activation: {
        id: state.deployments[key].id,
        commit: () => commitSkillCatalogState(root, state),
        isCommitted: async (id) =>
          (await readSkillCatalogState(root)).deployments[key]?.id === id,
      },
      assets: skillIds.map((id) => ({
        id,
        claim: {
          version: meta.lock.skills[id].version,
          source: "source",
          sourceSha256: meta.lock.skills[id].sourceSha256 ?? null,
          packageSha256: meta.lock.skills[id].packageSha256 ?? null,
        },
        prepare: (destination) =>
          fs.cp(path.join(imageRoot, ".pi/skills", id), destination, {
            recursive: true,
            errorOnExist: true,
          }),
      })),
    });
    return state.deployments[key];
  });
}
