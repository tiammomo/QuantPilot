import os from "node:os";
import {
  listFiles,
  isInside,
  copyDir,
  unpackSkillPackage,
  withExtractedSkillArchive,
} from "./archives";
import fs from "fs/promises";
import path from "path";
import { JSON_SCHEMA, load as loadYaml } from "js-yaml";
import {
  getSkillsDashboardData,
  type SkillsDashboardData,
} from "@/lib/skills/dashboard";

type JsonRecord = Record<string, unknown>;

export interface SkillSourceData {
  skillId: string;
  filePath: string;
  content: string;
  relativePath: string;
  size: number;
  updatedAt: string | null;
  editable: boolean;
  skillMd?: string;
}

export interface SaveSkillSourceParams {
  skillId: string;
  filePath?: string;
  content?: string;
  skillMd?: string;
}

export interface DeleteSkillFileParams {
  skillId: string;
  filePath: string;
}

export interface SkillFolderParams {
  skillId: string;
  folderPath: string;
}

export interface PublishSkillVersionParams {
  skillId: string;
  version: string;
  summary: string;
  changes: string[];
}

export interface SkillDiffFile {
  path: string;
  status: "added" | "modified" | "deleted";
  previousSize: number | null;
  currentSize: number | null;
  previousUpdatedAt: string | null;
  currentUpdatedAt: string | null;
  addedLines: number;
  removedLines: number;
  preview: string[];
}

export interface SkillDiffData {
  skillId: string;
  baseVersion: string | null;
  basePackagePath: string | null;
  changed: boolean;
  files: SkillDiffFile[];
  totals: {
    added: number;
    modified: number;
    deleted: number;
    addedLines: number;
    removedLines: number;
  };
}

export function createSkillSourceEditor(ROOT: string) {
  const SKILLS_DIR = path.join(ROOT, ".pi", "skills");
  const REGISTRY_PATH = path.join(ROOT, ".pi", "skills.registry.json");
  const MAX_EDITABLE_FILE_BYTES = 512 * 1024;
  const REQUIRED_SKILL_DIRECTORIES = [
    "references",
    "scripts",
    "agents",
  ] as const;
  const FORBIDDEN_SKILL_FILENAMES = new Set([
    "README.md",
    "CHANGELOG.md",
    "INSTALLATION_GUIDE.md",
    "QUICK_REFERENCE.md",
  ]);
  const EDITABLE_SOURCE_EXTENSIONS = new Set([
    ".css",
    ".html",
    ".js",
    ".json",
    ".md",
    ".mjs",
    ".py",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
  ]);

  function isRecord(value: unknown): value is JsonRecord {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  async function readJson(filePath: string): Promise<JsonRecord> {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    if (!isRecord(parsed)) {
      throw new Error(`${path.relative(ROOT, filePath)} 必须是 JSON 对象。`);
    }
    return parsed;
  }

  function assertSafeSkillId(skillId: string) {
    if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(skillId)) {
      throw new Error("skillId 不合法。");
    }
  }

  async function resolveCoreSkill(skillId: string) {
    assertSafeSkillId(skillId);
    const registry = await readJson(REGISTRY_PATH);
    const coreSkills = Array.isArray(registry.coreSkills)
      ? registry.coreSkills
      : [];
    const index = coreSkills.findIndex(
      (skill) => isRecord(skill) && skill.id === skillId,
    );
    if (index < 0) {
      throw new Error(`未找到核心 skill：${skillId}`);
    }

    return {
      registry,
      coreSkills: coreSkills as JsonRecord[],
      index,
      skill: coreSkills[index] as JsonRecord,
    };
  }

  async function getPackageDir() {
    const registry = await readJson(REGISTRY_PATH);
    const policy = isRecord(registry.policy) ? registry.policy : {};
    const configured =
      typeof policy.packageDir === "string"
        ? policy.packageDir.replaceAll("\\", "/")
        : ".pi/skill-packages";
    if (
      !configured ||
      path.isAbsolute(configured) ||
      configured.split("/").includes("..")
    ) {
      throw new Error("registry.policy.packageDir 必须是仓库内安全相对路径。");
    }
    return path.resolve(ROOT, configured);
  }

  async function getSkillVersion(skillId: string) {
    const resolved = await resolveCoreSkill(skillId);
    return typeof resolved.skill.version === "string"
      ? resolved.skill.version
      : null;
  }

  async function getCurrentPackagePath(skillId: string) {
    return path.join(await getPackageDir(), `${skillId}.tgz`);
  }

  async function getVersionPackagePath(skillId: string, version: string) {
    return path.join(
      await getPackageDir(),
      "versions",
      skillId,
      `${version}.tgz`,
    );
  }

  function normalizeSkillFilePath(filePath: string | undefined | null): string {
    const normalized = String(filePath || "SKILL.md")
      .replaceAll("\\", "/")
      .replace(/^\/+/, "")
      .trim();
    if (!normalized || normalized.endsWith("/")) {
      throw new Error("文件路径不能为空。");
    }
    if (
      normalized.includes("\0") ||
      normalized
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      path.isAbsolute(normalized)
    ) {
      throw new Error("文件路径不安全。");
    }
    return normalized;
  }

  function normalizeSkillFolderPath(
    folderPath: string | undefined | null,
  ): string {
    const normalized = String(folderPath || "")
      .replaceAll("\\", "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .trim();
    if (!normalized) {
      throw new Error("文件夹路径不能为空。");
    }
    if (
      normalized.includes("\0") ||
      normalized
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      path.isAbsolute(normalized)
    ) {
      throw new Error("文件夹路径不安全。");
    }
    return normalized;
  }

  async function resolveSkillFilePath(
    skillId: string,
    filePath?: string | null,
  ) {
    await resolveCoreSkill(skillId);
    const relativePath = normalizeSkillFilePath(filePath);
    const sourceDir = path.join(SKILLS_DIR, skillId);
    const absolutePath = path.resolve(sourceDir, relativePath);
    if (!isInside(sourceDir, absolutePath)) {
      throw new Error("文件路径必须位于当前 skill 目录内。");
    }
    await assertSafeSkillTree(sourceDir, sourceDir, skillId);
    return {
      sourceDir,
      relativePath,
      absolutePath,
    };
  }

  async function resolveSkillFolderPath(
    skillId: string,
    folderPath?: string | null,
  ) {
    await resolveCoreSkill(skillId);
    const relativePath = normalizeSkillFolderPath(folderPath);
    const sourceDir = path.join(SKILLS_DIR, skillId);
    const absolutePath = path.resolve(sourceDir, relativePath);
    if (absolutePath === sourceDir || !isInside(sourceDir, absolutePath)) {
      throw new Error("文件夹路径必须位于当前 skill 目录内。");
    }
    await assertSafeSkillTree(sourceDir, sourceDir, skillId);
    return {
      sourceDir,
      relativePath,
      absolutePath,
    };
  }

  function isEditableSkillFile(relativePath: string): boolean {
    if (relativePath === "SKILL.md") return true;
    return EDITABLE_SOURCE_EXTENSIONS.has(
      path.extname(relativePath).toLowerCase(),
    );
  }

  function validateTextFileContent(relativePath: string, content: string) {
    if (!isEditableSkillFile(relativePath)) {
      throw new Error(`不支持在线编辑该文件类型：${relativePath}`);
    }
    if (FORBIDDEN_SKILL_FILENAMES.has(path.basename(relativePath))) {
      throw new Error(`Skill 包中不允许创建 ${path.basename(relativePath)}。`);
    }
    if (Buffer.byteLength(content, "utf8") > MAX_EDITABLE_FILE_BYTES) {
      throw new Error("文件超过 512KB，不适合在线编辑。");
    }
    if (relativePath === "SKILL.md") {
      const trimmed = content.trim();
      if (!trimmed.includes("#")) {
        throw new Error("SKILL.md 内容过短或缺少标题。");
      }
      if (!/^---\n[\s\S]*?\n---\n/.test(trimmed)) {
        throw new Error("SKILL.md 必须包含 YAML frontmatter。");
      }
    }
    if (relativePath.endsWith(".json")) {
      try {
        JSON.parse(content);
      } catch {
        throw new Error(`${relativePath} 不是合法 JSON。`);
      }
    }
  }

  async function assertSafeSkillTree(
    dir: string,
    sourceDir: string,
    skillId: string,
  ): Promise<void> {
    if (dir === sourceDir) {
      const rootStat = await fs.lstat(sourceDir).catch(() => null);
      if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error(`${skillId} 的源码根目录必须是普通目录。`);
      }
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".DS_Store") continue;
      const absolutePath = path.join(dir, entry.name);
      const relativePath = path
        .relative(sourceDir, absolutePath)
        .replaceAll(path.sep, "/");
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`${skillId} 不允许包含软链接：${relativePath}。`);
      }
      if (stat.isDirectory()) {
        await assertSafeSkillTree(absolutePath, sourceDir, skillId);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(
          `${skillId} 包含不支持的文件系统条目：${relativePath}。`,
        );
      }
    }
  }

  function isReferenceResource(relativePath: string) {
    return (
      relativePath.startsWith("references/") && relativePath.endsWith(".md")
    );
  }

  function isScriptResource(relativePath: string) {
    return (
      relativePath.startsWith("scripts/") &&
      /\.(?:py|js|mjs|sh)$/.test(relativePath)
    );
  }

  async function ensureSkillScriptsExecutable(sourceDir: string) {
    for (const filePath of await listFiles(path.join(sourceDir, "scripts"))) {
      const relativePath = path
        .relative(sourceDir, filePath)
        .replaceAll(path.sep, "/");
      if (isScriptResource(relativePath)) await fs.chmod(filePath, 0o755);
    }
  }

  function validateAgentMetadata(agentSource: string, skillId: string) {
    let document: unknown;
    try {
      document = loadYaml(agentSource, { schema: JSON_SCHEMA });
    } catch (error) {
      throw new Error(
        `${skillId} 的 agents/openai.yaml 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isRecord(document) || !isRecord(document.interface)) {
      throw new Error(
        `${skillId} 的 agents/openai.yaml 必须包含根级 interface 对象。`,
      );
    }
    const interfaceBlock =
      agentSource.match(
        /^interface:\s*(?:#.*)?\r?\n((?:^[ \t]+.*(?:\r?\n|$))*)/m,
      )?.[1] ?? "";
    for (const field of [
      "display_name",
      "short_description",
      "default_prompt",
    ]) {
      const value = document.interface[field];
      if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${skillId} 的 interface.${field} 必须是非空字符串。`);
      }
      if (!new RegExp(`^  ${field}:\\s*".+"\\s*$`, "m").test(interfaceBlock)) {
        throw new Error(`${skillId} 的 interface.${field} 必须使用双引号。`);
      }
    }
    const shortDescription = String(document.interface.short_description);
    const shortLength = Array.from(shortDescription).length;
    if (shortLength < 25 || shortLength > 64) {
      throw new Error(
        `${skillId} 的 interface.short_description 必须为 25–64 个字符。`,
      );
    }
    if (!String(document.interface.default_prompt).includes(`$${skillId}`)) {
      throw new Error(
        `${skillId} 的 interface.default_prompt 必须显式引用 $${skillId}。`,
      );
    }
  }

  async function assertRequiredResourcesSurviveRemoval(
    sourceDir: string,
    removalPath: string,
  ) {
    const files = await listFiles(sourceDir);
    const remaining = files
      .filter((filePath) => !isInside(removalPath, filePath))
      .map((filePath) =>
        path.relative(sourceDir, filePath).replaceAll(path.sep, "/"),
      );
    if (!remaining.some(isReferenceResource)) {
      throw new Error(
        "不能删除最后一个 reference；每个 Skill 必须保留 references/*.md。",
      );
    }
    if (!remaining.some(isScriptResource)) {
      throw new Error(
        "不能删除最后一个 script；每个 Skill 必须保留确定性脚本。",
      );
    }
  }

  async function validateCompleteSkillDirectory(skillId: string) {
    const sourceDir = path.join(SKILLS_DIR, skillId);
    const skillFile = path.join(sourceDir, "SKILL.md");
    const agentFile = path.join(sourceDir, "agents", "openai.yaml");
    const skillStat = await fs.lstat(skillFile).catch(() => null);
    if (!skillStat?.isFile() || skillStat.isSymbolicLink()) {
      throw new Error(`${skillId} 必须包含普通文件 SKILL.md。`);
    }
    const skillSource = await fs.readFile(skillFile, "utf8").catch(() => null);
    if (!skillSource) throw new Error(`${skillId} 缺少 SKILL.md。`);
    await assertSafeSkillTree(sourceDir, sourceDir, skillId);

    for (const directory of REQUIRED_SKILL_DIRECTORIES) {
      const stat = await fs
        .lstat(path.join(sourceDir, directory))
        .catch(() => null);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`${skillId} 必须包含普通目录 ${directory}/。`);
      }
    }
    const agentStat = await fs.lstat(agentFile).catch(() => null);
    if (!agentStat?.isFile() || agentStat.isSymbolicLink()) {
      throw new Error(`${skillId} 必须包含 agents/openai.yaml。`);
    }

    const sourceFiles = await listFiles(sourceDir);
    const relativeFiles = sourceFiles.map((filePath) =>
      path.relative(sourceDir, filePath).replaceAll(path.sep, "/"),
    );
    const allReferences = relativeFiles.filter((relativePath) =>
      relativePath.startsWith("references/"),
    );
    const allScripts = relativeFiles.filter((relativePath) =>
      relativePath.startsWith("scripts/"),
    );
    const references = allReferences.filter(isReferenceResource).sort();
    const scripts = allScripts.filter(isScriptResource).sort();
    if (references.length === 0)
      throw new Error(`${skillId} 至少需要一个 references/*.md。`);
    if (scripts.length === 0)
      throw new Error(`${skillId} 至少需要一个确定性 script。`);
    if (references.length !== allReferences.length) {
      throw new Error(
        `${skillId} 的 references/ 只能包含 Markdown reference。`,
      );
    }
    if (scripts.length !== allScripts.length) {
      throw new Error(`${skillId} 的 scripts/ 包含不支持的脚本类型。`);
    }
    for (const script of scripts) {
      const stat = await fs.lstat(path.join(sourceDir, script));
      if ((stat.mode & 0o111) === 0) {
        throw new Error(`${skillId} 的脚本必须可执行：${script}。`);
      }
    }
    const { skill: registrySkill } = await resolveCoreSkill(skillId);
    const registeredReferences = Array.isArray(registrySkill.references)
      ? registrySkill.references.map(String).sort()
      : [];
    const registeredScripts = Array.isArray(registrySkill.scripts)
      ? registrySkill.scripts.map(String).sort()
      : [];
    if (JSON.stringify(registeredReferences) !== JSON.stringify(references)) {
      throw new Error(
        `${skillId} 的 registry.references 必须完整登记所有 reference。`,
      );
    }
    if (JSON.stringify(registeredScripts) !== JSON.stringify(scripts)) {
      throw new Error(
        `${skillId} 的 registry.scripts 必须完整登记所有 script。`,
      );
    }

    for (const filePath of sourceFiles) {
      if (FORBIDDEN_SKILL_FILENAMES.has(path.basename(filePath))) {
        throw new Error(`${skillId} 不应包含 ${path.basename(filePath)}。`);
      }
    }
    for (const reference of references) {
      if (!skillSource.includes(`](${reference})`)) {
        throw new Error(`${skillId} 的 SKILL.md 必须直接链接 ${reference}。`);
      }
    }
    for (const script of scripts) {
      if (!skillSource.includes(script)) {
        throw new Error(
          `${skillId} 的 SKILL.md 必须说明 ${script} 的使用方式。`,
        );
      }
    }

    const frontmatter = skillSource.match(
      /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/,
    )?.[1];
    if (!frontmatter)
      throw new Error(`${skillId} 的 SKILL.md 缺少 YAML frontmatter。`);
    const entries = frontmatter
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        const separator = line.indexOf(":");
        return [
          line.slice(0, separator).trim(),
          line.slice(separator + 1).trim(),
        ] as const;
      });
    const keys = new Set(entries.map(([key]) => key));
    if (
      entries.length !== 2 ||
      keys.size !== 2 ||
      !keys.has("name") ||
      !keys.has("description")
    ) {
      throw new Error(
        `${skillId} 的 frontmatter 只能包含 name 和 description。`,
      );
    }
    const name = entries
      .find(([key]) => key === "name")?.[1]
      .replace(/^["']|["']$/g, "");
    if (name !== skillId)
      throw new Error(`${skillId} 的 frontmatter name 必须与目录一致。`);
    const description = entries
      .find(([key]) => key === "description")?.[1]
      .replace(/^["']|["']$/g, "");
    if (!description)
      throw new Error(`${skillId} 的 frontmatter description 不能为空。`);

    validateAgentMetadata(await fs.readFile(agentFile, "utf8"), skillId);
  }

  async function readSkillSource(skillId: string): Promise<SkillSourceData> {
    return readSkillFile(skillId, "SKILL.md");
  }

  async function readSkillFile(
    skillId: string,
    filePath?: string | null,
  ): Promise<SkillSourceData> {
    const resolved = await resolveSkillFilePath(skillId, filePath);
    const stat = await fs.stat(resolved.absolutePath).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(`文件不存在：${resolved.relativePath}`);
    }
    if (!isEditableSkillFile(resolved.relativePath)) {
      throw new Error(
        `该文件不是可在线编辑的文本文件：${resolved.relativePath}`,
      );
    }
    if (stat.size > MAX_EDITABLE_FILE_BYTES) {
      throw new Error("文件超过 512KB，不适合在线编辑。");
    }
    const content = await fs.readFile(resolved.absolutePath, "utf8");
    return {
      skillId,
      filePath: resolved.relativePath,
      content,
      skillMd: resolved.relativePath === "SKILL.md" ? content : undefined,
      relativePath: path
        .relative(ROOT, resolved.absolutePath)
        .replaceAll(path.sep, "/"),
      size: stat.size,
      updatedAt: stat?.mtime.toISOString() ?? null,
      editable: true,
    };
  }

  async function saveSkillSource(
    params: SaveSkillSourceParams,
  ): Promise<SkillSourceData> {
    return saveSkillFile({
      skillId: params.skillId,
      filePath: params.filePath ?? "SKILL.md",
      content: params.content ?? params.skillMd ?? "",
    });
  }

  async function saveSkillFile(
    params: SaveSkillSourceParams,
  ): Promise<SkillSourceData> {
    const resolved = await resolveSkillFilePath(
      params.skillId,
      params.filePath,
    );
    const content = (params.content ?? params.skillMd ?? "").trimEnd();
    validateTextFileContent(resolved.relativePath, content);
    await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
    await fs.writeFile(resolved.absolutePath, `${content}\n`, "utf8");
    if (isScriptResource(resolved.relativePath))
      await fs.chmod(resolved.absolutePath, 0o755);
    return readSkillFile(params.skillId, resolved.relativePath);
  }

  async function deleteSkillFile(
    params: DeleteSkillFileParams,
  ): Promise<SkillsDashboardData> {
    const resolved = await resolveSkillFilePath(
      params.skillId,
      params.filePath,
    );
    if (
      resolved.relativePath === "SKILL.md" ||
      resolved.relativePath === "agents/openai.yaml"
    ) {
      throw new Error("不能删除 Skill 的必需入口或 Agent 元数据。");
    }
    const stat = await fs.stat(resolved.absolutePath).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(`文件不存在：${resolved.relativePath}`);
    }
    await assertRequiredResourcesSurviveRemoval(
      resolved.sourceDir,
      resolved.absolutePath,
    );
    await fs.rm(resolved.absolutePath, { force: true });
    return getSkillsDashboardData(ROOT);
  }

  async function createSkillFolder(
    params: SkillFolderParams,
  ): Promise<SkillsDashboardData> {
    const resolved = await resolveSkillFolderPath(
      params.skillId,
      params.folderPath,
    );
    const existing = await fs.lstat(resolved.absolutePath).catch(() => null);
    if (existing?.isFile()) {
      throw new Error(`同名文件已存在：${resolved.relativePath}`);
    }
    if (existing?.isSymbolicLink()) {
      throw new Error("不能操作软链接目录。");
    }
    await fs.mkdir(resolved.absolutePath, { recursive: true });
    return getSkillsDashboardData(ROOT);
  }

  async function deleteSkillFolder(
    params: SkillFolderParams,
  ): Promise<SkillsDashboardData> {
    const resolved = await resolveSkillFolderPath(
      params.skillId,
      params.folderPath,
    );
    if (
      REQUIRED_SKILL_DIRECTORIES.includes(
        resolved.relativePath as (typeof REQUIRED_SKILL_DIRECTORIES)[number],
      )
    ) {
      throw new Error("不能删除 references、scripts 或 agents 必需目录。");
    }
    const stat = await fs.lstat(resolved.absolutePath).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`文件夹不存在：${resolved.relativePath}`);
    }
    await assertRequiredResourcesSurviveRemoval(
      resolved.sourceDir,
      resolved.absolutePath,
    );
    await fs.rm(resolved.absolutePath, { recursive: true, force: true });
    return getSkillsDashboardData(ROOT);
  }

  async function readTextIfSmall(filePath: string) {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_EDITABLE_FILE_BYTES) {
      return {
        content: null,
        size: stat?.size ?? null,
        updatedAt: stat?.mtime.toISOString() ?? null,
      };
    }
    return {
      content: await fs.readFile(filePath, "utf8").catch(() => null),
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  }

  function countLineChanges(
    previousContent: string | null,
    currentContent: string | null,
  ) {
    const previousLines =
      previousContent === null ? [] : previousContent.split("\n");
    const currentLines =
      currentContent === null ? [] : currentContent.split("\n");
    const previousCounts = new Map<string, number>();
    const currentCounts = new Map<string, number>();
    previousLines.forEach((line) =>
      previousCounts.set(line, (previousCounts.get(line) ?? 0) + 1),
    );
    currentLines.forEach((line) =>
      currentCounts.set(line, (currentCounts.get(line) ?? 0) + 1),
    );
    const allLines = new Set([
      ...previousCounts.keys(),
      ...currentCounts.keys(),
    ]);
    let addedLines = 0;
    let removedLines = 0;
    allLines.forEach((line) => {
      const previous = previousCounts.get(line) ?? 0;
      const current = currentCounts.get(line) ?? 0;
      if (current > previous) addedLines += current - previous;
      if (previous > current) removedLines += previous - current;
    });
    return { addedLines, removedLines };
  }

  function buildDiffPreview(
    previousContent: string | null,
    currentContent: string | null,
  ) {
    if (previousContent === null && currentContent === null) {
      return ["二进制文件或文件过大，跳过文本预览。"];
    }
    const previousLines =
      previousContent === null ? [] : previousContent.split("\n");
    const currentLines =
      currentContent === null ? [] : currentContent.split("\n");
    const preview: string[] = [];
    const maxLines = Math.max(previousLines.length, currentLines.length);
    for (let index = 0; index < maxLines && preview.length < 14; index += 1) {
      const previous = previousLines[index];
      const current = currentLines[index];
      if (previous === current) continue;
      if (previous !== undefined) preview.push(`- ${previous}`);
      if (current !== undefined) preview.push(`+ ${current}`);
    }
    return preview.length > 0 ? preview : ["文件内容有变化。"];
  }

  async function collectRelativeFiles(dir: string) {
    const files = await listFiles(dir);
    return files
      .map((filePath) => path.relative(dir, filePath).replaceAll(path.sep, "/"))
      .sort();
  }

  async function diffSkillVersion(skillId: string): Promise<SkillDiffData> {
    await resolveCoreSkill(skillId);
    const baseVersion = await getSkillVersion(skillId);
    const snapshotPath = baseVersion
      ? await getVersionPackagePath(skillId, baseVersion)
      : null;
    const currentPackagePath = await getCurrentPackagePath(skillId);
    const basePackagePath =
      snapshotPath &&
      (await fs
        .stat(snapshotPath)
        .then((stat) => stat.isFile())
        .catch(() => false))
        ? snapshotPath
        : (await fs
              .stat(currentPackagePath)
              .then((stat) => stat.isFile())
              .catch(() => false))
          ? currentPackagePath
          : null;
    const workDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "quantpilot-skill-diff-"),
    );
    const sourceDir = path.join(SKILLS_DIR, skillId);

    try {
      let baseRoot: string | null = null;
      if (basePackagePath) {
        baseRoot = await unpackSkillPackage(
          skillId,
          basePackagePath,
          path.join(workDir, "base"),
        );
      }
      const previousFiles = baseRoot
        ? await collectRelativeFiles(baseRoot)
        : [];
      const currentFiles = await collectRelativeFiles(sourceDir);
      const allFiles = [...new Set([...previousFiles, ...currentFiles])].sort();
      const files: SkillDiffFile[] = [];

      for (const relativePath of allFiles) {
        const previousPath = baseRoot
          ? path.join(baseRoot, relativePath)
          : null;
        const currentPath = path.join(sourceDir, relativePath);
        const previousExists = previousPath
          ? await fs
              .stat(previousPath)
              .then((stat) => stat.isFile())
              .catch(() => false)
          : false;
        const currentExists = await fs
          .stat(currentPath)
          .then((stat) => stat.isFile())
          .catch(() => false);
        if (!previousExists && !currentExists) continue;
        const previous =
          previousExists && previousPath
            ? await readTextIfSmall(previousPath)
            : { content: null, size: null, updatedAt: null };
        const current = currentExists
          ? await readTextIfSmall(currentPath)
          : { content: null, size: null, updatedAt: null };
        if (
          previousExists &&
          currentExists &&
          previous.content !== null &&
          previous.content === current.content
        )
          continue;
        if (
          previousExists &&
          currentExists &&
          previousPath &&
          previous.content === null &&
          current.content === null &&
          (await fs.readFile(previousPath)).equals(
            await fs.readFile(currentPath),
          )
        )
          continue;
        const lineChanges = countLineChanges(previous.content, current.content);
        files.push({
          path: relativePath,
          status: previousExists
            ? currentExists
              ? "modified"
              : "deleted"
            : "added",
          previousSize: previous.size,
          currentSize: current.size,
          previousUpdatedAt: previous.updatedAt,
          currentUpdatedAt: current.updatedAt,
          addedLines: lineChanges.addedLines,
          removedLines: lineChanges.removedLines,
          preview: buildDiffPreview(previous.content, current.content),
        });
      }

      return {
        skillId,
        baseVersion,
        basePackagePath: basePackagePath
          ? path.relative(ROOT, basePackagePath).replaceAll(path.sep, "/")
          : null,
        changed: files.length > 0,
        files,
        totals: {
          added: files.filter((file) => file.status === "added").length,
          modified: files.filter((file) => file.status === "modified").length,
          deleted: files.filter((file) => file.status === "deleted").length,
          addedLines: files.reduce((total, file) => total + file.addedLines, 0),
          removedLines: files.reduce(
            (total, file) => total + file.removedLines,
            0,
          ),
        },
      };
    } finally {
      await fs
        .rm(workDir, { recursive: true, force: true })
        .catch(() => undefined);
    }
  }

  async function uploadSkillPackage(params: {
    skillId: string;
    file: File;
  }): Promise<void> {
    await resolveCoreSkill(params.skillId);
    await withExtractedSkillArchive(params, async (sourceRoot) => {
      const targetDir = path.join(SKILLS_DIR, params.skillId);
      await fs.rm(targetDir, { recursive: true, force: true });
      await copyDir(sourceRoot, targetDir);
      await ensureSkillScriptsExecutable(targetDir);
      await validateCompleteSkillDirectory(params.skillId);
    });
  }

  return {
    readSkillSource,
    readSkillFile,
    saveSkillSource,
    saveSkillFile,
    deleteSkillFile,
    createSkillFolder,
    deleteSkillFolder,
    diffSkillVersion,
    uploadSkillPackage,
    validateCompleteSkillDirectory,
  };
}
