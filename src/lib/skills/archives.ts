import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import * as tar from "tar";
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 250;
const MAX_EXTRACTED_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_TOTAL_BYTES = 50 * 1024 * 1024;

async function runCommand(command: string, args: string[], cwd: string) {
  const result = await new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output = `${output}${chunk}`.slice(-24000);
      });
      child.stderr.on("data", (chunk) => {
        output = `${output}${chunk}`.slice(-24000);
      });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => resolve({ code, output }));
    },
  );

  if (result.code !== 0) {
    throw new Error(
      result.output.trim() || `${command} ${args.join(" ")} 执行失败。`,
    );
  }
  return result.output;
}

export function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function assertNoUnsafeExtractedPath(
  dir: string,
  root = dir,
  state = { entries: 0, totalBytes: 0 },
) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (!isInside(root, fullPath)) {
      throw new Error("压缩包包含不安全路径。");
    }
    state.entries += 1;
    if (state.entries > MAX_ARCHIVE_ENTRIES) {
      throw new Error(`压缩包展开条目不得超过 ${MAX_ARCHIVE_ENTRIES} 个。`);
    }
    const stat = await fs.lstat(fullPath);
    if (stat.isSymbolicLink()) {
      throw new Error("压缩包不得包含软链接。");
    }
    if (stat.isDirectory()) {
      await assertNoUnsafeExtractedPath(fullPath, root, state);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error("压缩包只能包含普通文件和目录。");
    }
    if (stat.size > MAX_EXTRACTED_FILE_BYTES) {
      throw new Error("压缩包包含超过 10MB 的单个文件。");
    }
    state.totalBytes += stat.size;
    if (state.totalBytes > MAX_EXTRACTED_TOTAL_BYTES) {
      throw new Error("压缩包展开后的文件总量不得超过 50MB。");
    }
  }
  return state;
}

async function validateTarArchive(archivePath: string, extractDir: string) {
  const entries = new Set<string>();
  let totalBytes = 0;
  let validationError: Error | null = null;
  await tar.t({
    file: archivePath,
    onentry: (entry) => {
      if (validationError) return;
      const normalized = entry.path
        .replace(/^(?:\.\/)+/, "")
        .replace(/\/$/, "");
      const destination = path.resolve(extractDir, normalized);
      if (
        !normalized ||
        normalized.includes("\\") ||
        path.isAbsolute(normalized) ||
        normalized
          .split("/")
          .some((segment) => !segment || segment === "." || segment === "..") ||
        !isInside(extractDir, destination)
      ) {
        validationError = new Error("压缩包包含不安全路径。");
        return;
      }
      if (entries.has(normalized)) {
        validationError = new Error("压缩包不得包含重复条目。");
        return;
      }
      entries.add(normalized);
      if (entries.size > MAX_ARCHIVE_ENTRIES) {
        validationError = new Error(
          `压缩包条目不得超过 ${MAX_ARCHIVE_ENTRIES} 个。`,
        );
        return;
      }
      if (!["File", "Directory"].includes(entry.type)) {
        validationError = new Error("压缩包只能包含普通文件和目录。");
        return;
      }
      if (entry.type === "File") {
        if (
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0 ||
          entry.size > MAX_EXTRACTED_FILE_BYTES
        ) {
          validationError = new Error("压缩包包含尺寸无效或超过 10MB 的文件。");
          return;
        }
        totalBytes += entry.size;
        if (totalBytes > MAX_EXTRACTED_TOTAL_BYTES) {
          validationError = new Error("压缩包展开后的文件总量不得超过 50MB。");
        }
      }
    },
  });
  if (validationError !== null) throw validationError;
  if (entries.size === 0) throw new Error("压缩包不能为空。");
}

export async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);
  const nested = await Promise.all(
    entries.flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.name === ".DS_Store") return [];
      if (entry.isDirectory()) return [listFiles(fullPath)];
      if (entry.isFile()) return [Promise.resolve([fullPath])];
      return [];
    }),
  );
  return nested.flat().sort();
}

async function findExtractedSkillRoot(extractDir: string, skillId: string) {
  const direct = path.join(extractDir, skillId);
  const directSkillFile = path.join(direct, "SKILL.md");
  if (
    await fs
      .stat(directSkillFile)
      .then((stat) => stat.isFile())
      .catch(() => false)
  ) {
    return direct;
  }
  const rootSkillFile = path.join(extractDir, "SKILL.md");
  if (
    await fs
      .stat(rootSkillFile)
      .then((stat) => stat.isFile())
      .catch(() => false)
  ) {
    return extractDir;
  }
  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(extractDir, entry.name);
    const skillFile = path.join(candidate, "SKILL.md");
    if (
      await fs
        .stat(skillFile)
        .then((stat) => stat.isFile())
        .catch(() => false)
    ) {
      return candidate;
    }
  }
  throw new Error("压缩包中未找到 SKILL.md。");
}

export async function copyDir(source: string, target: string) {
  await fs.mkdir(target, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDir(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

export async function unpackSkillPackage(
  skillId: string,
  packagePath: string,
  targetDir: string,
) {
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });
  await validateTarArchive(packagePath, targetDir);
  await tar.x({
    file: packagePath,
    cwd: targetDir,
    preserveOwner: false,
    preservePaths: false,
    strict: true,
    filter: (_entryPath, entry) =>
      "type" in entry && ["File", "Directory"].includes(String(entry.type)),
  });
  await assertNoUnsafeExtractedPath(targetDir);
  return findExtractedSkillRoot(targetDir, skillId);
}

export async function withExtractedSkillArchive(
  params: { skillId: string; file: File },
  consume: (root: string) => Promise<void>,
): Promise<void> {
  if (params.file.size <= 0 || params.file.size > MAX_UPLOAD_BYTES) {
    throw new Error("上传包大小必须在 1B 到 5MB 之间。");
  }
  const fileName = params.file.name.toLowerCase();
  if (
    !fileName.endsWith(".zip") &&
    !fileName.endsWith(".tgz") &&
    !fileName.endsWith(".tar.gz")
  ) {
    throw new Error("仅支持 .zip、.tgz 或 .tar.gz。");
  }

  const workDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "quantpilot-skill-upload-"),
  );
  const archivePath = path.join(
    workDir,
    params.file.name.replace(/[^a-zA-Z0-9._-]/g, "_"),
  );
  const extractDir = path.join(workDir, "extract");
  await fs.mkdir(extractDir, { recursive: true });
  await fs.writeFile(archivePath, Buffer.from(await params.file.arrayBuffer()));

  try {
    if (fileName.endsWith(".zip")) {
      await runCommand(
        "python3",
        [
          "-c",
          [
            "import stat, sys, zipfile",
            "from pathlib import Path",
            "archive=Path(sys.argv[1])",
            "target=Path(sys.argv[2]).resolve()",
            "max_entries=int(sys.argv[3])",
            "max_file=int(sys.argv[4])",
            "max_total=int(sys.argv[5])",
            "with zipfile.ZipFile(archive) as z:",
            "    items=z.infolist()",
            "    if not items or len(items) > max_entries:",
            '        raise SystemExit("zip entry count is invalid")',
            "    names=set()",
            "    total=0",
            "    for item in items:",
            '        normalized=item.filename.rstrip("/")',
            '        parts=normalized.split("/")',
            '        if not normalized or item.filename.startswith("/") or any(p in ("", ".", "..") for p in parts) or ":" in parts[0]:',
            '            raise SystemExit("unsafe zip path segments")',
            "        if item.filename in names:",
            '            raise SystemExit("duplicate zip entry")',
            "        names.add(item.filename)",
            '        if "\\\\" in item.filename or item.flag_bits & 1:',
            '            raise SystemExit("unsafe or encrypted zip entry")',
            "        destination=(target / item.filename).resolve()",
            "        mode=item.external_attr >> 16",
            "        if mode and not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):",
            '            raise SystemExit("zip may contain only regular files and directories")',
            "        if item.file_size > max_file:",
            '            raise SystemExit("zip member exceeds size limit")',
            "        total += item.file_size",
            "        if total > max_total:",
            '            raise SystemExit("zip expanded size exceeds limit")',
            "        try:",
            "            destination.relative_to(target)",
            "        except ValueError:",
            '            raise SystemExit("unsafe zip path")',
            "    z.extractall(target)",
          ].join("\n"),
          archivePath,
          extractDir,
          String(MAX_ARCHIVE_ENTRIES),
          String(MAX_EXTRACTED_FILE_BYTES),
          String(MAX_EXTRACTED_TOTAL_BYTES),
        ],
        workDir,
      );
    } else {
      await validateTarArchive(archivePath, extractDir);
      await tar.x({
        file: archivePath,
        cwd: extractDir,
        preserveOwner: false,
        preservePaths: false,
        strict: true,
        filter: (_entryPath, entry) =>
          "type" in entry && ["File", "Directory"].includes(String(entry.type)),
      });
    }
    await assertNoUnsafeExtractedPath(extractDir);
    const sourceRoot = await findExtractedSkillRoot(extractDir, params.skillId);
    const files = await listFiles(sourceRoot);
    if (files.length === 0 || files.length > 200) {
      throw new Error("压缩包文件数量不合理。");
    }

    await consume(sourceRoot);
  } finally {
    await fs
      .rm(workDir, { recursive: true, force: true })
      .catch(() => undefined);
  }
}
