import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const isCanonicalSkillId = (value: string) =>
  /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);

export async function readRegularSkillFile(
  filePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error("Skill file is not regular or exceeds its byte limit.");
    const data = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(
        data,
        offset,
        data.length - offset,
        null,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maxBytes)
      throw new Error("Skill file exceeds its byte limit.");
    return data.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function hashSkillDirectory(directory: string) {
  const files: string[] = [];
  let entries = 0;
  let bytes = 0;
  async function visit(current: string, depth: number) {
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || depth > 16)
      throw new Error("Unsafe Skill directory.");
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.name === ".DS_Store") continue;
      if (++entries > 250)
        throw new Error("Skill tree exceeds its entry limit.");
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target, depth + 1);
      else if (entry.isFile()) files.push(target);
      else throw new Error("Skill tree contains a link or special file.");
    }
  }
  await visit(directory, 0);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    const content = await readRegularSkillFile(file, 4 * 1024 * 1024);
    bytes += content.length;
    if (bytes > 50 * 1024 * 1024)
      throw new Error("Skill tree exceeds its byte limit.");
    hash.update(path.relative(directory, file).split(path.sep).join("/"));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return { hash: hash.digest("hex"), fileCount: files.length };
}

export async function readSkillsInstallReceipt(
  runtimeDirectory: string,
): Promise<Record<string, unknown> | null> {
  try {
    const directory = await fs.lstat(runtimeDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error("Unsafe Skill runtime directory.");
    const buffer = await readRegularSkillFile(
      path.join(runtimeDirectory, "installed-skills.json"),
      1024 * 1024,
    );
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(buffer),
    );
    if (
      !value ||
      value.schemaVersion !== 1 ||
      value.runtime !== "PI Agent" ||
      value.skillsDirectory !== ".pi/skills" ||
      !value.skills ||
      typeof value.skills !== "object" ||
      Array.isArray(value.skills) ||
      Object.keys(value.skills).some((id) => !isCanonicalSkillId(id))
    ) {
      throw new Error("Invalid Skill installation receipt.");
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
