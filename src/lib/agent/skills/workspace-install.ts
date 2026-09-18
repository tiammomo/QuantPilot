import fs from "node:fs/promises";
import path from "node:path";
import { withPiAgentWorkspaceResourceLock } from "../runtime/workspace-resource-lock";
import {
  isCanonicalSkillId,
  hashSkillDirectory,
  readRegularSkillFile,
} from "./workspace-integrity";
import type { SkillAgentTarget } from "./catalog-store";

export const SKILL_AGENT_TARGETS = {
  "pi-agent": {
    label: "PI Agent",
    directory: ".pi",
    receipt: "installed-skills.json",
    runtimeVerified: true,
  },
  "claude-code": {
    label: "Claude Code",
    directory: ".claude",
    receipt: "quantpilot-installed-skills.json",
    runtimeVerified: false,
  },
  codex: {
    label: "Codex",
    directory: ".agents",
    receipt: "quantpilot-installed-skills.json",
    runtimeVerified: false,
  },
} as const;

type InstalledClaim = {
  version: string;
  sourceSha256: string | null;
  packageSha256: string | null;
  source: string;
};
export interface SkillAssetsReceipt {
  schemaVersion: 1;
  runtime: string;
  installedAt: string;
  skillsDirectory: string;
  capabilityId: string | null;
  skills: Record<string, InstalledClaim>;
}
export interface SkillInstallAsset {
  id: string;
  claim: InstalledClaim;
  prepare: (destination: string) => Promise<void>;
}

async function exists(file: string) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function ensureDirectory(directory: string) {
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Skill 安装目录必须是真实目录。");
}

export async function readSkillAssetsReceipt(
  workspace: string,
  target: SkillAgentTarget,
) {
  const adapter = SKILL_AGENT_TARGETS[target];
  const runtime = path.join(workspace, adapter.directory);
  const stat = await exists(runtime);
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Unsafe Skill runtime directory.");
  let data: Buffer;
  try {
    data = await readRegularSkillFile(
      path.join(runtime, adapter.receipt),
      1024 * 1024,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value = JSON.parse(data.toString("utf8")) as SkillAssetsReceipt;
  if (
    value.schemaVersion !== 1 ||
    value.runtime !== adapter.label ||
    value.skillsDirectory !== `${adapter.directory}/skills` ||
    !value.skills ||
    typeof value.skills !== "object" ||
    Array.isArray(value.skills) ||
    Object.entries(value.skills).some(
      ([id, claim]) =>
        !isCanonicalSkillId(id) ||
        !claim ||
        typeof claim.version !== "string" ||
        !/^\d+\.\d+\.\d+$/.test(claim.version) ||
        typeof claim.sourceSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(claim.sourceSha256),
    )
  ) {
    throw new Error("Invalid Skill installation receipt.");
  }
  return value;
}

/** Recovery is idempotent: journals record intent before any visible rename. */
async function recover(
  runtime: string,
  receiptName: string,
  isActivated?: (id: string) => Promise<boolean>,
) {
  const journal = path.join(runtime, ".skill-install-transaction");
  if (!(await exists(journal))) return;
  if ((await fs.lstat(journal)).isSymbolicLink())
    throw new Error("Unsafe Skill install journal.");
  const intentPath = path.join(journal, "intent.json");
  if (!(await exists(intentPath))) {
    await fs.rm(journal, { recursive: true, force: true });
    return;
  }
  const intent = JSON.parse(
    (await readRegularSkillFile(intentPath, 4096)).toString("utf8"),
  );
  if (
    typeof intent.hadSkills !== "boolean" ||
    typeof intent.hadReceipt !== "boolean"
  )
    throw new Error("Invalid Skill install journal.");
  let committed = Boolean(await exists(path.join(journal, "committed")));
  if (intent.activationId !== undefined) {
    if (typeof intent.activationId !== "string" || !isActivated)
      throw new Error("安装恢复需要平台版本记录。");
    // A platform-owned commit is authoritative even if the process stopped
    // before it could write the workspace completion marker.
    committed = await isActivated(intent.activationId);
  }
  if (!committed) {
    for (const [name, backup, had] of [
      ["skills", "previous-skills", intent.hadSkills],
      [receiptName, "previous-receipt", intent.hadReceipt],
    ] as const) {
      const saved = path.join(journal, backup);
      const destination = path.join(runtime, name);
      if (await exists(saved)) {
        await fs.rm(destination, { recursive: true, force: true });
        await fs.rename(saved, destination);
      } else if (!had)
        await fs.rm(destination, { recursive: true, force: true });
    }
  }
  await fs.rm(journal, { recursive: true, force: true });
}

/** Builds the entire batch before changing any managed file; unmanaged names are preserved. */
export async function installSkillAssets(params: {
  workspace: string;
  target: SkillAgentTarget;
  assets: SkillInstallAsset[];
  capabilityId?: string | null;
  overwriteModified?: boolean;
  /** Platform-owned ownership and hashes take precedence over an editable workspace receipt. */
  trustedManaged?: Record<string, InstalledClaim>;
  activation?: {
    id: string;
    commit: () => Promise<void>;
    isCommitted: (id: string) => Promise<boolean>;
  };
}) {
  if (
    !params.assets.every((asset) => isCanonicalSkillId(asset.id)) ||
    new Set(params.assets.map((asset) => asset.id)).size !==
      params.assets.length
  )
    throw new Error("Invalid Skill installation IDs.");
  const workspace = await fs.realpath(params.workspace);
  const adapter = SKILL_AGENT_TARGETS[params.target];
  const runtime = path.join(workspace, adapter.directory);
  await ensureDirectory(runtime);
  return withPiAgentWorkspaceResourceLock(
    runtime,
    async () => {
      await recover(runtime, adapter.receipt, params.activation?.isCommitted);
      const receipt = await readSkillAssetsReceipt(
        workspace,
        params.target,
      ).catch((error) => {
        if (params.trustedManaged && params.overwriteModified) return null;
        throw error;
      });
      const destination = path.join(runtime, "skills");
      const previous = await exists(destination);
      if (previous && (!previous.isDirectory() || previous.isSymbolicLink()))
        throw new Error("Skill skills 目录不安全。");
      const managedClaims = params.trustedManaged ?? receipt?.skills ?? {};
      const managed = new Set(Object.keys(managedClaims));
      const names = previous ? await fs.readdir(destination) : [];
      for (const asset of params.assets) {
        if (names.includes(asset.id) && !managed.has(asset.id))
          throw new Error(`目标已有非受管技能 ${asset.id}，拒绝覆盖。`);
      }
      for (const id of managed) {
        if (!names.includes(id)) continue;
        const actual = await hashSkillDirectory(path.join(destination, id));
        if (
          actual.hash !== managedClaims[id].sourceSha256 &&
          !params.overwriteModified
        )
          throw new Error(`技能 ${id} 已被本地修改，请确认覆盖后重新安装。`);
      }
      const journal = path.join(runtime, ".skill-install-transaction");
      await fs.mkdir(journal, { mode: 0o700 });
      try {
        const staged = path.join(journal, "next-skills");
        await fs.mkdir(staged);
        for (const name of names.filter((name) => !managed.has(name))) {
          await fs.cp(path.join(destination, name), path.join(staged, name), {
            recursive: true,
            dereference: false,
            verbatimSymlinks: true,
          });
        }
        for (const asset of params.assets) {
          const target = path.join(staged, asset.id);
          await asset.prepare(target);
          if (
            (await hashSkillDirectory(target)).hash !== asset.claim.sourceSha256
          )
            throw new Error(`技能 ${asset.id} 安装内容校验失败。`);
        }
        const next: SkillAssetsReceipt = {
          schemaVersion: 1,
          runtime: adapter.label,
          installedAt: new Date().toISOString(),
          capabilityId: params.capabilityId ?? null,
          skillsDirectory: `${adapter.directory}/skills`,
          skills: Object.fromEntries(
            params.assets.map((asset) => [asset.id, asset.claim]),
          ),
        };
        await fs.writeFile(
          path.join(journal, "next-receipt"),
          `${JSON.stringify(next, null, 2)}\n`,
          { mode: 0o600 },
        );
        const hadReceipt = Boolean(
          await exists(path.join(runtime, adapter.receipt)),
        );
        await fs.writeFile(
          path.join(journal, "intent.json"),
          JSON.stringify({
            hadSkills: Boolean(previous),
            hadReceipt,
            activationId: params.activation?.id,
          }),
          { flag: "wx" },
        );
        if (previous)
          await fs.rename(destination, path.join(journal, "previous-skills"));
        await fs.rename(staged, destination);
        if (hadReceipt)
          await fs.rename(
            path.join(runtime, adapter.receipt),
            path.join(journal, "previous-receipt"),
          );
        await fs.rename(
          path.join(journal, "next-receipt"),
          path.join(runtime, adapter.receipt),
        );
        await params.activation?.commit();
        await fs.writeFile(path.join(journal, "committed"), "1", {
          flag: "wx",
        });
        await recover(runtime, adapter.receipt, params.activation?.isCommitted);
        return next;
      } catch (error) {
        try {
          await recover(
            runtime,
            adapter.receipt,
            params.activation?.isCommitted,
          );
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            "安装失败且恢复未完成；恢复记录已保留。",
          );
        }
        throw error;
      }
    },
    {
      recoverDeadLocalOwner: true,
      metadata: { purpose: "other", operationId: "skill-install" },
    },
  );
}
