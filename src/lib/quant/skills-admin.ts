import fs from "node:fs/promises";
import path from "node:path";
import {
  commitSkillCatalogState,
  readSkillCatalogState,
  recordSkillEvent,
  SkillConflictError,
  withSkillCatalogLock,
  type SkillCatalogState,
} from "@/lib/agent/skills/catalog-store";
import {
  resolveSkillCatalogImage,
  sealSkillCatalog,
  stageSkillCatalog,
  skillCatalogRevision,
  initializeSkillCatalog,
} from "@/lib/agent/skills/catalog-images";
import { isCanonicalSkillId } from "@/lib/agent/skills/workspace-integrity";
import { validateSkillCatalogMetadata } from "@/lib/agent/skills";
import { createSkillSourceEditor } from "./skills-source-editor";
import {
  getSkillsDashboardData,
  type SkillSourceFile,
} from "./skills-dashboard";
import {
  assertNewSkillVersion,
  readSkillMetadata,
  replaceSkillInCatalog,
  skillMetadataPaths,
  skillReleaseIdentity,
  validateSkillPublication,
  writeSkillJson,
} from "./skills-publication";
import type {
  SaveSkillSourceParams,
  PublishSkillVersionParams,
  SkillFolderParams,
  DeleteSkillFileParams,
} from "./skills-source-editor";

export type SkillMutation = { expectedRevision: string; actor: string };
const DEFINITION_FILE = "skill.definition.json";
const RUNTIME_FILE = "skill.runtime.json";
const virtualFiles = [DEFINITION_FILE, RUNTIME_FILE];

/** Every mutation happens in a private staging image; only state.json activates it. */
export function createSkillsAdministration(
  root = process.cwd(),
  codeRoot = process.cwd(),
) {
  async function current(state: SkillCatalogState, skillId: string) {
    if (!isCanonicalSkillId(skillId)) throw new Error("skillId 不合法。");
    const activeRoot = state.active
      ? await resolveSkillCatalogImage(root, state.active)
      : root;
    const meta = await readSkillMetadata(activeRoot);
    if (!meta.registry.coreSkills.some((skill) => skill.id === skillId))
      throw new Error("技能未登记。");
    const draft = state.drafts[skillId];
    return {
      state,
      activeRoot,
      draft,
      editorRoot: draft
        ? await resolveSkillCatalogImage(root, draft.revision, true)
        : activeRoot,
      revision:
        draft?.revision ??
        state.active ??
        (await skillCatalogRevision(activeRoot)),
    };
  }
  function checkExpected(actual: string, expected: string) {
    if (!expected || actual !== expected)
      throw new SkillConflictError(
        "技能已被其他操作修改，请刷新并重新确认差异；你的编辑内容仍保留在编辑器中。",
      );
  }
  async function virtualContent(
    editorRoot: string,
    skillId: string,
    filePath: string,
  ) {
    const meta = await readSkillMetadata(editorRoot);
    return `${JSON.stringify(
      filePath === DEFINITION_FILE
        ? meta.registry.coreSkills.find((skill) => skill.id === skillId)
        : meta.capsules.skills[skillId],
      null,
      2,
    )}\n`;
  }
  async function readSkillFile(skillId: string, filePath = "SKILL.md") {
    const selected = await current(await readSkillCatalogState(root), skillId);
    if (virtualFiles.includes(filePath)) {
      const content = await virtualContent(
        selected.editorRoot,
        skillId,
        filePath,
      );
      return {
        skillId,
        filePath,
        content,
        relativePath: filePath,
        size: Buffer.byteLength(content),
        updatedAt: selected.draft?.updatedAt ?? null,
        editable: true,
        revision: selected.revision,
        draft: Boolean(selected.draft),
      };
    }
    return {
      ...(await createSkillSourceEditor(selected.editorRoot).readSkillFile(
        skillId,
        filePath,
      )),
      revision: selected.revision,
      draft: Boolean(selected.draft),
    };
  }
  async function editDraft(
    skillId: string,
    params: SkillMutation,
    action: string,
    edit: (stage: string) => Promise<unknown>,
  ) {
    await withSkillCatalogLock(root, async () => {
      const state = await readSkillCatalogState(root);
      const selected = await current(state, skillId);
      checkExpected(selected.revision, params.expectedRevision);
      await initializeSkillCatalog(root, state);
      const stage = await stageSkillCatalog(root, selected.editorRoot);
      try {
        await edit(stage);
        const revision = await sealSkillCatalog(root, stage);
        state.drafts[skillId] = {
          revision,
          base: selected.draft?.base ?? state.active!,
          actor: params.actor,
          updatedAt: new Date().toISOString(),
        };
        recordSkillEvent(state, { action, actor: params.actor, skillId });
        await commitSkillCatalogState(root, state);
      } finally {
        await fs.rm(stage, { recursive: true, force: true });
      }
    });
  }
  async function saveSkillFile(params: SaveSkillSourceParams & SkillMutation) {
    const filePath = params.filePath ?? "SKILL.md";
    await editDraft(params.skillId, params, "draft.save", async (stage) => {
      if (!virtualFiles.includes(filePath))
        return createSkillSourceEditor(stage).saveSkillFile(params);
      const content = params.content ?? params.skillMd ?? "";
      if (Buffer.byteLength(content) > 512 * 1024)
        throw new Error("文件超过 512KB。");
      const value = JSON.parse(content);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("技能配置必须为 JSON 对象。");
      const meta = await readSkillMetadata(stage);
      if (filePath === DEFINITION_FILE) {
        const previous = meta.registry.coreSkills.find(
          (item) => item.id === params.skillId,
        )!;
        if (value.id !== params.skillId || value.version !== previous.version)
          throw new Error("技能 ID 不可更改；版本号请在发布时设置。");
        meta.registry.coreSkills = meta.registry.coreSkills.map((item) =>
          item.id === params.skillId ? value : item,
        );
        validateSkillCatalogMetadata(meta.registry, meta.capsules);
        await writeSkillJson(
          path.join(stage, skillMetadataPaths.registry),
          meta.registry,
        );
      } else {
        meta.capsules.skills[params.skillId] = value;
        validateSkillCatalogMetadata(meta.registry, meta.capsules);
        await writeSkillJson(
          path.join(stage, skillMetadataPaths.capsules),
          meta.capsules,
        );
      }
    });
    return readSkillFile(params.skillId, filePath);
  }
  async function getStudioData() {
    const state = await readSkillCatalogState(root);
    const activeRoot = state.active
      ? await resolveSkillCatalogImage(root, state.active)
      : root;
    const dashboard = await getSkillsDashboardData(activeRoot);
    const activeRevision =
      state.active ?? (await skillCatalogRevision(activeRoot));
    for (const skill of dashboard.skills) {
      const draft = state.drafts[skill.id];
      const editorRoot = draft
        ? await resolveSkillCatalogImage(root, draft.revision)
        : activeRoot;
      if (draft) {
        const inspected = await getSkillsDashboardData(editorRoot);
        skill.source = inspected.skills.find(
          (item) => item.id === skill.id,
        )!.source;
      }
      for (const filePath of virtualFiles) {
        const content = await virtualContent(editorRoot, skill.id, filePath);
        skill.source.files.push({
          path: filePath,
          name: filePath,
          kind: "other",
          editable: true,
          size: Buffer.byteLength(content),
          updatedAt: draft?.updatedAt ?? null,
          sha256: "",
          sha256Short: null,
        } satisfies SkillSourceFile);
      }
      skill.editing = {
        revision: draft?.revision ?? activeRevision,
        hasDraft: Boolean(draft),
        updatedBy: draft?.actor ?? null,
      };
      for (const release of skill.changelog.releases) {
        const complete = state.releases.find(
          (item) =>
            item.skillId === skill.id && item.version === release.version,
        );
        release.completeSnapshot =
          Boolean(complete) ||
          (!state.active && release.version === skill.version);
        release.actor = complete?.actor ?? release.actor ?? null;
      }
    }
    return {
      ...dashboard,
      catalogRevision: activeRevision,
      activity: state.events.slice(-100).reverse(),
    };
  }
  async function diffSkillVersion(skillId: string) {
    const selected = await current(await readSkillCatalogState(root), skillId);
    const diff = await createSkillSourceEditor(
      selected.editorRoot,
    ).diffSkillVersion(skillId);
    for (const filePath of virtualFiles) {
      const previous = await virtualContent(
        selected.activeRoot,
        skillId,
        filePath,
      );
      const next = await virtualContent(selected.editorRoot, skillId, filePath);
      if (previous !== next) {
        diff.files.push({
          path: filePath,
          status: "modified",
          previousSize: Buffer.byteLength(previous),
          currentSize: Buffer.byteLength(next),
          previousUpdatedAt: null,
          currentUpdatedAt: null,
          addedLines: next.split("\n").length,
          removedLines: previous.split("\n").length,
          preview: [`- ${previous}`, `+ ${next}`],
        });
        diff.totals.modified += 1;
      }
    }
    return {
      ...diff,
      changed: diff.files.length > 0,
      revision: selected.revision,
    };
  }
  async function publishSkillVersion(
    params: PublishSkillVersionParams & SkillMutation,
  ) {
    await withSkillCatalogLock(root, async () => {
      const state = await readSkillCatalogState(root);
      const selected = await current(state, params.skillId);
      checkExpected(selected.revision, params.expectedRevision);
      if (!selected.draft) throw new Error("请先保存草稿并确认差异。");
      const baseRoot = await resolveSkillCatalogImage(
        root,
        selected.draft.base,
      );
      if (
        (await skillReleaseIdentity(baseRoot, params.skillId)) !==
        (await skillReleaseIdentity(selected.activeRoot, params.skillId))
      ) {
        throw new SkillConflictError(
          "草稿基于旧的已发布版本；请保留修改后放弃旧草稿，再基于当前版编辑。",
        );
      }
      if (
        !params.summary.trim() ||
        params.changes.length === 0 ||
        params.changes.some((item) => !item.trim())
      )
        throw new Error("发布摘要和变更点不能为空。");
      const dashboard = await getSkillsDashboardData(selected.activeRoot);
      const history = dashboard.skills.find(
        (skill) => skill.id === params.skillId,
      )!.changelog.releases;
      assertNewSkillVersion(params.version, [
        ...history.map((item) => item.version),
        ...state.releases
          .filter((item) => item.skillId === params.skillId)
          .map((item) => item.version),
      ]);
      const stage = await stageSkillCatalog(root, selected.activeRoot);
      try {
        await replaceSkillInCatalog(stage, selected.editorRoot, params.skillId);
        const meta = await readSkillMetadata(stage);
        const skill = meta.registry.coreSkills.find(
          (item) => item.id === params.skillId,
        )!;
        skill.version = params.version;
        await writeSkillJson(
          path.join(stage, skillMetadataPaths.registry),
          meta.registry,
        );
        const changelogPath = path.join(stage, skillMetadataPaths.changelog);
        const changelog = JSON.parse(await fs.readFile(changelogPath, "utf8"));
        changelog.skills[params.skillId].releases.unshift({
          version: params.version,
          date: new Date().toISOString(),
          summary: params.summary.trim(),
          changes: params.changes,
          actor: params.actor,
        });
        await writeSkillJson(changelogPath, changelog);
        await validateSkillPublication(codeRoot, stage, params.skillId, true);
        state.active = await sealSkillCatalog(root, stage);
        state.releases.push({
          skillId: params.skillId,
          version: params.version,
          revision: state.active,
          actor: params.actor,
          date: new Date().toISOString(),
        });
        delete state.drafts[params.skillId];
        recordSkillEvent(state, {
          action: "release.publish",
          actor: params.actor,
          skillId: params.skillId,
          version: params.version,
        });
        await commitSkillCatalogState(root, state);
      } finally {
        await fs.rm(stage, { recursive: true, force: true });
      }
    });
    return getStudioData();
  }
  async function rollbackSkillVersion(
    params: { skillId: string; version: string } & SkillMutation,
  ) {
    await withSkillCatalogLock(root, async () => {
      const state = await readSkillCatalogState(root);
      const selected = await current(state, params.skillId);
      checkExpected(selected.revision, params.expectedRevision);
      if (selected.draft)
        throw new SkillConflictError("请先发布或放弃草稿，再回退已发布版本。");
      await initializeSkillCatalog(root, state);
      const release = state.releases.find(
        (item) =>
          item.skillId === params.skillId && item.version === params.version,
      );
      if (!release)
        throw new Error(
          "此历史版本仅有源码包，缺少完整运行规则快照，不能安全回退。",
        );
      const previousRoot = await resolveSkillCatalogImage(
        root,
        release.revision,
        true,
      );
      const stage = await stageSkillCatalog(root, selected.activeRoot);
      try {
        await replaceSkillInCatalog(stage, previousRoot, params.skillId);
        await validateSkillPublication(codeRoot, stage, params.skillId, false);
        state.active = await sealSkillCatalog(root, stage);
        recordSkillEvent(state, {
          action: "release.rollback",
          actor: params.actor,
          skillId: params.skillId,
          version: params.version,
        });
        await commitSkillCatalogState(root, state);
      } finally {
        await fs.rm(stage, { recursive: true, force: true });
      }
    });
    return getStudioData();
  }
  async function discardDraft(params: { skillId: string } & SkillMutation) {
    await withSkillCatalogLock(root, async () => {
      const state = await readSkillCatalogState(root);
      const selected = await current(state, params.skillId);
      checkExpected(selected.revision, params.expectedRevision);
      delete state.drafts[params.skillId];
      recordSkillEvent(state, {
        action: "draft.discard",
        actor: params.actor,
        skillId: params.skillId,
      });
      await commitSkillCatalogState(root, state);
    });
    return getStudioData();
  }
  async function fileMutation(
    params: (DeleteSkillFileParams | SkillFolderParams) & SkillMutation,
    action: "deleteSkillFile" | "createSkillFolder" | "deleteSkillFolder",
  ) {
    if ("filePath" in params && virtualFiles.includes(params.filePath))
      throw new Error("不能删除技能配置。");
    await editDraft(params.skillId, params, `draft.${action}`, (stage) => {
      const editor = createSkillSourceEditor(stage);
      return action === "deleteSkillFile"
        ? editor.deleteSkillFile(params as DeleteSkillFileParams)
        : editor[action](params as SkillFolderParams);
    });
    return getStudioData();
  }
  async function uploadSkillPackage(
    params: { skillId: string; file: File } & SkillMutation,
  ) {
    await editDraft(params.skillId, params, "draft.upload", (stage) =>
      createSkillSourceEditor(stage).uploadSkillPackage(params),
    );
    return getStudioData();
  }
  return {
    readSkillFile,
    readSkillSource: (id: string) => readSkillFile(id),
    saveSkillFile,
    saveSkillSource: saveSkillFile,
    getStudioData,
    diffSkillVersion,
    publishSkillVersion,
    rollbackSkillVersion,
    discardDraft,
    uploadSkillPackage,
    deleteSkillFile: (params: DeleteSkillFileParams & SkillMutation) =>
      fileMutation(params, "deleteSkillFile"),
    createSkillFolder: (params: SkillFolderParams & SkillMutation) =>
      fileMutation(params, "createSkillFolder"),
    deleteSkillFolder: (params: SkillFolderParams & SkillMutation) =>
      fileMutation(params, "deleteSkillFolder"),
  };
}
