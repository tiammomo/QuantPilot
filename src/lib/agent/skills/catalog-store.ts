import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  PiAgentWorkspaceResourceLockError,
  withPiAgentWorkspaceResourceLock,
} from "../runtime/workspace-resource-lock";
import { readRegularSkillFile } from "./workspace-integrity";

export type SkillAgentTarget = "pi-agent" | "claude-code" | "codex";
export interface SkillDeployment {
  id: string;
  revision: string;
  skillIds: string[];
  target: SkillAgentTarget;
  updatedAt: string;
  actor: string;
  previous?: Pick<SkillDeployment, "revision" | "skillIds">;
}
export interface SkillCatalogState {
  schemaVersion: 1;
  generation: number;
  active: string | null;
  drafts: Record<
    string,
    { revision: string; base: string; actor: string; updatedAt: string }
  >;
  releases: Array<{
    skillId: string;
    version: string;
    revision: string;
    actor: string;
    date: string;
  }>;
  deployments: Record<string, SkillDeployment>;
  events: Array<{
    id: string;
    action: string;
    actor: string;
    at: string;
    skillId?: string;
    version?: string;
    target?: string;
  }>;
}

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const skillId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const actor = z.string().min(1).max(256);
const skillIds = z
  .array(skillId)
  .max(200)
  .refine((ids) => new Set(ids).size === ids.length);
const deploymentSchema = z
  .object({
    id: z.string().uuid(),
    revision: digest,
    skillIds,
    target: z.enum(["pi-agent", "claude-code", "codex"]),
    updatedAt: z.iso.datetime(),
    actor,
    previous: z.object({ revision: digest, skillIds }).strict().optional(),
  })
  .strict();
const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    generation: z.number().int().nonnegative(),
    active: digest.nullable(),
    drafts: z.record(
      skillId,
      z
        .object({
          revision: digest,
          base: digest,
          actor,
          updatedAt: z.iso.datetime(),
        })
        .strict(),
    ),
    releases: z.array(
      z
        .object({
          skillId,
          version: z.string().regex(/^\d+\.\d+\.\d+$/),
          revision: digest,
          actor,
          date: z.iso.datetime(),
        })
        .strict(),
    ),
    deployments: z.record(
      z.string().regex(/^(pi-agent|claude-code|codex):[a-f0-9]{64}$/),
      deploymentSchema,
    ),
    events: z.array(
      z
        .object({
          id: z.string().uuid(),
          action: z.string().min(1).max(80),
          actor,
          at: z.iso.datetime(),
          skillId: skillId.optional(),
          version: z.string().max(32).optional(),
          target: z.string().max(128).optional(),
        })
        .strict(),
    ),
  })
  .strict();

export class SkillConflictError extends Error {
  readonly status = 409;
}

export const skillDigest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
// Explicit candidate/fixture roots never inherit the live service's durable store.
export const skillsStateDirectory = (root: string) =>
  path.resolve(
    root,
    path.resolve(root) === path.resolve(process.cwd()) &&
      process.env.QUANTPILOT_SKILLS_STATE_DIR?.trim()
      ? process.env.QUANTPILOT_SKILLS_STATE_DIR.trim()
      : "data/skill-catalog",
  );
export const deploymentKey = (workspace: string, target: SkillAgentTarget) =>
  `${target}:${skillDigest(path.resolve(workspace))}`;

export async function ensureSkillStateDirectory(root: string) {
  for (const directory of [
    path.dirname(skillsStateDirectory(root)),
    skillsStateDirectory(root),
  ]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Unsafe skill state directory.");
  }
  return skillsStateDirectory(root);
}

export async function readSkillCatalogState(
  root: string,
): Promise<SkillCatalogState> {
  try {
    for (const directory of [
      path.dirname(skillsStateDirectory(root)),
      skillsStateDirectory(root),
    ]) {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Unsafe skill state directory.");
    }
    const value = JSON.parse(
      (
        await readRegularSkillFile(
          path.join(skillsStateDirectory(root), "state.json"),
          8 * 1024 * 1024,
        )
      ).toString("utf8"),
    );
    const parsed = stateSchema.safeParse(value);
    if (!parsed.success) throw new Error("Invalid skill catalog state.");
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      schemaVersion: 1,
      generation: 0,
      active: null,
      drafts: {},
      releases: [],
      deployments: {},
      events: [],
    };
  }
}

/** The state file is the only commit point. Unreferenced images are never executed. */
export async function commitSkillCatalogState(
  root: string,
  state: SkillCatalogState,
) {
  const directory = await ensureSkillStateDirectory(root);
  const temporary = path.join(directory, `.state-${randomUUID()}.tmp`);
  const next = stateSchema.parse({
    ...state,
    generation: state.generation + 1,
  });
  const content = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(content) > 8 * 1024 * 1024)
    throw new Error("Skill catalog state exceeds its size limit.");
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, path.join(directory, "state.json"));
    const dir = await fs.open(directory, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function withSkillCatalogLock<T>(
  root: string,
  operation: () => Promise<T>,
) {
  return withPiAgentWorkspaceResourceLock(
    await ensureSkillStateDirectory(root),
    async () => {
      const result = await operation();
      try {
        const { pruneUnusedSkillImages } = await import("./catalog-images");
        await pruneUnusedSkillImages(root, await readSkillCatalogState(root));
      } catch {
        console.warn("[Skills] Unreferenced snapshot cleanup deferred.");
      }
      return result;
    },
    {
      recoverDeadLocalOwner: true,
      waitTimeoutMs: 5_000,
      metadata: { purpose: "other", operationId: "skill-catalog" },
    },
  ).catch((error) => {
    if (
      error instanceof PiAgentWorkspaceResourceLockError &&
      error.code === "WORKSPACE_RESOURCE_LOCKED"
    ) {
      throw new SkillConflictError(
        "另一个技能维护操作正在执行，或维护锁需要核查；请稍后刷新并重试。你的编辑内容已保留。",
      );
    }
    throw error;
  });
}

export function recordSkillEvent(
  state: SkillCatalogState,
  event: Omit<SkillCatalogState["events"][number], "id" | "at">,
) {
  state.events.push({
    ...event,
    id: randomUUID(),
    at: new Date().toISOString(),
  });
}
