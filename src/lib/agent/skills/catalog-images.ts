import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readRegularSkillFile } from "./workspace-integrity";
import {
  deploymentKey,
  ensureSkillStateDirectory,
  readSkillCatalogState,
  skillDigest,
  skillsStateDirectory,
  type SkillAgentTarget,
  type SkillCatalogState,
} from "./catalog-store";

const CONTENT = [
  ".pi/skills",
  ".pi/skill-packages",
  ".pi/skills.registry.json",
  ".pi/skills.lock.json",
  ".pi/skills.changelog.json",
  "config/pi-agent-skill-capsules.json",
];
const METADATA = CONTENT.filter((file) => file.endsWith(".json"));

async function inventory(root: string) {
  const files: Record<string, string> = {};
  let bytes = 0;
  let entries = 0;
  async function visit(relative: string, depth: number): Promise<void> {
    if (++entries > 10_000 || depth > 18)
      throw new Error("Skill catalog exceeds its entry limit.");
    const file = path.join(root, relative);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink())
      throw new Error("Skill catalog must not contain symlinks.");
    if (stat.isDirectory()) {
      files[`${relative}/`] = skillDigest("directory");
      for (const name of (await fs.readdir(file)).sort()) {
        if (name !== ".DS_Store") await visit(`${relative}/${name}`, depth + 1);
      }
    } else {
      const content = await readRegularSkillFile(file, 10 * 1024 * 1024);
      bytes += content.length;
      if (bytes > 100 * 1024 * 1024)
        throw new Error("Skill catalog exceeds its byte limit.");
      files[relative] = skillDigest(content);
    }
  }
  for (const relative of CONTENT) await visit(relative, 0);
  return files;
}

export async function skillCatalogRevision(root: string) {
  return skillDigest(
    JSON.stringify({ schemaVersion: 1, files: await inventory(root) }),
  );
}

export async function initializeSkillCatalog(
  root: string,
  state: SkillCatalogState,
) {
  if (state.active) return;
  const stage = await stageSkillCatalog(root, root);
  try {
    state.active = await sealSkillCatalog(root, stage);
    const registry = JSON.parse(
      (
        await readRegularSkillFile(
          path.join(root, ".pi/skills.registry.json"),
          2 * 1024 * 1024,
        )
      ).toString("utf8"),
    );
    state.releases.push(
      ...registry.coreSkills.map((skill: { id: string; version: string }) => ({
        skillId: skill.id,
        version: skill.version,
        revision: state.active!,
        actor: "repository",
        date: new Date().toISOString(),
      })),
    );
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

export async function stageSkillCatalog(
  repositoryRoot: string,
  sourceRoot: string,
) {
  const directory = await ensureSkillStateDirectory(repositoryRoot);
  const stage = path.join(directory, `.stage-${randomUUID()}`);
  await inventory(sourceRoot); // reject links and oversized input before copying
  try {
    for (const relative of CONTENT) {
      const destination = path.join(stage, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.cp(path.join(sourceRoot, relative), destination, {
        recursive: true,
        errorOnExist: true,
      });
    }
    return stage;
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    throw error;
  }
}

/** Captures instructions, scripts, metadata, tool requirements and workflow as one identity. */
export async function sealSkillCatalog(repositoryRoot: string, stage: string) {
  const files = await inventory(stage);
  const manifest = JSON.stringify({ schemaVersion: 1, files });
  const revision = skillDigest(manifest);
  const parent = path.join(
    await ensureSkillStateDirectory(repositoryRoot),
    "images",
  );
  await fs.mkdir(parent, { recursive: true });
  if ((await fs.lstat(parent)).isSymbolicLink())
    throw new Error("Unsafe catalog image directory.");
  const destination = path.join(parent, revision);
  const handle = await fs.open(path.join(stage, "manifest.json"), "wx", 0o600);
  try {
    await handle.writeFile(manifest);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(stage, destination);
  } catch (error) {
    if (
      !["EEXIST", "ENOTEMPTY"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
    await resolveSkillCatalogImage(repositoryRoot, revision, true);
    await fs.rm(stage, { recursive: true, force: true });
  }
  return revision;
}

export async function resolveSkillCatalogImage(
  root: string,
  revision: string,
  verifyAll = false,
) {
  if (!/^[a-f0-9]{64}$/.test(revision))
    throw new Error("Invalid skill catalog revision.");
  const directory = path.join(skillsStateDirectory(root), "images", revision);
  for (const candidate of [
    skillsStateDirectory(root),
    path.dirname(directory),
    directory,
  ]) {
    const stat = await fs.lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Unsafe catalog image.");
  }
  const raw = await readRegularSkillFile(
    path.join(directory, "manifest.json"),
    2 * 1024 * 1024,
  );
  if (skillDigest(raw) !== revision)
    throw new Error("Skill catalog manifest integrity check failed.");
  const manifest = JSON.parse(raw.toString("utf8")) as {
    schemaVersion: number;
    files: Record<string, string>;
  };
  if (manifest.schemaVersion !== 1 || !manifest.files)
    throw new Error("Invalid skill catalog manifest.");
  for (const relative of METADATA) {
    if (
      skillDigest(
        await readRegularSkillFile(
          path.join(directory, relative),
          2 * 1024 * 1024,
        ),
      ) !== manifest.files[relative]
    ) {
      throw new Error("Skill catalog metadata integrity check failed.");
    }
  }
  if (
    verifyAll &&
    JSON.stringify(await inventory(directory)) !==
      JSON.stringify(manifest.files)
  ) {
    throw new Error("Skill catalog content integrity check failed.");
  }
  return directory;
}

export async function resolveActiveSkillCatalog(root: string) {
  const state = await readSkillCatalogState(root);
  return state.active ? resolveSkillCatalogImage(root, state.active) : root;
}

/** Workspace files cannot authorize executable Skill content or choose a release. */
export async function resolveRuntimeSkillCatalog(
  root: string,
  workspace?: string,
  target: SkillAgentTarget = "pi-agent",
) {
  const state = await readSkillCatalogState(root);
  const deployment = workspace
    ? state.deployments[deploymentKey(workspace, target)]
    : undefined;
  return {
    root: deployment
      ? await resolveSkillCatalogImage(root, deployment.revision)
      : state.active
        ? await resolveSkillCatalogImage(root, state.active)
        : root,
    deployment,
    revision: deployment?.revision ?? state.active,
  };
}

/** Called while holding the catalog lock; published and installed history is never pruned. */
export async function pruneUnusedSkillImages(
  root: string,
  state: SkillCatalogState,
  now = Date.now(),
) {
  const retained = new Set([
    state.active,
    ...Object.values(state.drafts).flatMap((draft) => [
      draft.revision,
      draft.base,
    ]),
    ...state.releases.map((release) => release.revision),
    ...Object.values(state.deployments).flatMap((deployment) => [
      deployment.revision,
      deployment.previous?.revision,
    ]),
  ]);
  const directory = path.join(skillsStateDirectory(root), "images");
  const stat = await fs
    .lstat(directory)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Unsafe catalog image directory.");
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !/^[a-f0-9]{64}$/.test(entry.name) ||
      retained.has(entry.name)
    )
      continue;
    const candidate = path.join(directory, entry.name);
    if ((await fs.lstat(candidate)).mtimeMs < now - 7 * 24 * 60 * 60 * 1000) {
      await fs.rm(candidate, { recursive: true, force: true });
    }
  }
}
