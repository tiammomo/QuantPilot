import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type {
  PiAgentSkillsRegistry,
  PiAgentSkillsLock,
  PiAgentSkillCapsuleRegistry,
} from "@/lib/agent/skills";
import { compilePiAgentSkills } from "@/lib/agent/skills";
import { readRegularSkillFile } from "@/lib/agent/skills/workspace-integrity";
import { skillDigest } from "@/lib/agent/skills/catalog-store";

export const skillMetadataPaths = {
  registry: ".pi/skills.registry.json",
  lock: ".pi/skills.lock.json",
  capsules: "config/pi-agent-skill-capsules.json",
  changelog: ".pi/skills.changelog.json",
};
export async function readSkillMetadata(root: string) {
  const read = async (relative: string) =>
    JSON.parse(
      (
        await readRegularSkillFile(path.join(root, relative), 2 * 1024 * 1024)
      ).toString("utf8"),
    );
  return {
    registry: (await read(
      skillMetadataPaths.registry,
    )) as PiAgentSkillsRegistry,
    lock: (await read(skillMetadataPaths.lock)) as PiAgentSkillsLock,
    capsules: (await read(
      skillMetadataPaths.capsules,
    )) as PiAgentSkillCapsuleRegistry,
  };
}
export const writeSkillJson = (file: string, value: unknown) =>
  fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

export async function skillReleaseIdentity(root: string, skillId: string) {
  const meta = await readSkillMetadata(root);
  const definition = meta.registry.coreSkills.find(
    (item) => item.id === skillId,
  );
  if (!definition) throw new Error("技能未登记。");
  return skillDigest(
    JSON.stringify({
      definition,
      capsule: meta.capsules.skills[skillId],
      lock: meta.lock.skills[skillId],
    }),
  );
}

export async function replaceSkillInCatalog(
  targetRoot: string,
  sourceRoot: string,
  skillId: string,
) {
  const [target, source] = await Promise.all([
    readSkillMetadata(targetRoot),
    readSkillMetadata(sourceRoot),
  ]);
  const definition = source.registry.coreSkills.find(
    (entry) => entry.id === skillId,
  );
  if (
    !definition ||
    !target.registry.coreSkills.some((entry) => entry.id === skillId)
  )
    throw new Error("技能未登记。");
  target.registry.coreSkills = target.registry.coreSkills.map((entry) =>
    entry.id === skillId ? definition : entry,
  );
  target.capsules.skills[skillId] = source.capsules.skills[skillId];
  target.lock.skills[skillId] = source.lock.skills[skillId];
  const destination = path.join(targetRoot, ".pi/skills", skillId);
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(path.join(sourceRoot, ".pi/skills", skillId), destination, {
    recursive: true,
  });
  await fs.copyFile(
    path.join(sourceRoot, ".pi/skill-packages", `${skillId}.tgz`),
    path.join(targetRoot, ".pi/skill-packages", `${skillId}.tgz`),
  );
  await Promise.all([
    writeSkillJson(
      path.join(targetRoot, skillMetadataPaths.registry),
      target.registry,
    ),
    writeSkillJson(path.join(targetRoot, skillMetadataPaths.lock), target.lock),
    writeSkillJson(
      path.join(targetRoot, skillMetadataPaths.capsules),
      target.capsules,
    ),
  ]);
}

export function assertNewSkillVersion(version: string, released: string[]) {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
    version.length > 32
  )
    throw new Error("版本号必须为规范的 major.minor.patch。");
  const next = version.split(".").map(BigInt);
  for (const previous of released) {
    const parts = previous.split(".").map(BigInt);
    const different = next.findIndex((value, index) => value !== parts[index]);
    if (different < 0 || next[different] < parts[different])
      throw new Error("新版本必须高于所有已发布版本；恢复旧版请使用回退。");
  }
}

async function runCheck(
  codeRoot: string,
  stage: string,
  script: string,
  args: string[] = [],
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(codeRoot, script), ...args],
      {
        cwd: stage,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      },
    );
    let output = "";
    const collect = (chunk: Buffer) => {
      output = `${output}${chunk}`.slice(-24_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 150_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`技能发布检查失败：${output.trim()}`));
      else resolve();
    });
  });
}

export async function validateSkillPublication(
  codeRoot: string,
  stage: string,
  skillId: string,
  packageSource: boolean,
) {
  // The package command invokes the behavior runner relative to its working directory.
  // Supply only trusted platform-owned validation code to the isolated candidate.
  const tests = path.join(stage, "tests/skills");
  const checks = path.join(stage, "scripts/checks");
  await fs.mkdir(tests, { recursive: true });
  await fs.mkdir(checks, { recursive: true });
  await fs.copyFile(
    path.join(codeRoot, "tests/skills/test_contracts.py"),
    path.join(tests, "test_contracts.py"),
  );
  await fs.copyFile(
    path.join(codeRoot, "scripts/checks/check-skill-scripts.js"),
    path.join(checks, "check-skill-scripts.js"),
  );
  try {
    if (packageSource) {
      await runCheck(codeRoot, stage, "scripts/skills/package-skills.js", [
        skillId,
      ]);
      const { registry } = await readSkillMetadata(stage);
      const version = registry.coreSkills.find(
        (entry) => entry.id === skillId,
      )!.version;
      const directory = path.join(
        stage,
        ".pi/skill-packages/versions",
        skillId,
      );
      await fs.mkdir(directory, { recursive: true });
      const source = await fs.readFile(
        path.join(stage, ".pi/skill-packages", `${skillId}.tgz`),
      );
      const snapshot = path.join(directory, `${version}.tgz`);
      try {
        await fs.writeFile(snapshot, source, { flag: "wx" });
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          !source.equals(await readRegularSkillFile(snapshot, 5 * 1024 * 1024))
        )
          throw error;
      }
    }
    await runCheck(codeRoot, stage, "scripts/checks/check-skills-registry.js", [
      "--check-lock",
    ]);
    if (!packageSource)
      await runCheck(codeRoot, stage, "scripts/checks/check-skill-scripts.js");
    const { capsules } = await readSkillMetadata(stage);
    for (const phase of capsules.skills[skillId].phases) {
      await compilePiAgentSkills({
        repositoryRoot: stage,
        requiredSkillIds: [skillId],
        phase,
        maxSystemContextChars: 32_000,
      });
    }
  } finally {
    await fs.rm(path.join(stage, "tests"), { recursive: true, force: true });
    await fs.rm(path.join(stage, "scripts"), { recursive: true, force: true });
  }
}
