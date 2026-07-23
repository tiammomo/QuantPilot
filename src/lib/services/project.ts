/**
 * Project Service - Project management logic
 */

import { prisma } from '@/lib/db/client';
import type { Project, CreateProjectInput, UpdateProjectInput } from '@/types/backend';
import fs from 'fs/promises';
import path from 'path';
import {
  MOAGENT_DEFAULT_MODEL,
  normalizeMoAgentModelId,
} from '@/lib/constants/models';
import {
  DATA_AGENT_ROOT_RELATIVE_PATH,
  DATA_AGENT_WORKSPACE_RELATIVE_PATH,
  assertManagedWorkspaceAvailable,
  assertManagedWorkspaceExists,
  managedProjectsRoot,
  resolveManagedWorkspacePath,
  writeWorkspaceFileAtomic,
} from '@/lib/data-agent';
import type { DataAgentCompositionLock } from '@/lib/data-agent';
import { getProjectLlmConfig } from '@/lib/config/llm';
import { DEFAULT_DATA_AGENT_PROFILE_ID } from '@/lib/config/data-agent';
import { deleteProjectWithOwnedQuota } from '@/lib/quota/allocation-reconciliation';
import { getApplicationDataAgentCatalog } from '@/lib/quant/data-agent-application';

function parseProjectSettings(existing: string | null | undefined): Record<string, unknown> {
  let parsed: Record<string, unknown> = {};

  if (existing) {
    try {
      const value = JSON.parse(existing);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }
  }

  return parsed;
}

function mergeLlmSettings(
  existing: string | null | undefined,
  selectedModel?: string | null,
): string {
  return JSON.stringify({
    ...parseProjectSettings(existing),
    llm: getProjectLlmConfig(selectedModel),
  });
}

function normalizeCapabilitySource(value?: string | null): 'manual' | 'default' | 'inferred' {
  return value === 'manual' || value === 'default' || value === 'inferred' ? value : 'default';
}

export async function ensureProjectLlmConfiguration(params: {
  projectId: string;
  projectName: string;
  projectPath: string;
  preferredCli?: string | null;
  selectedModel?: string | null;
  settings?: string | null;
  agentProfileId?: string | null;
}): Promise<void> {
  const settings = parseProjectSettings(params.settings);
  const dataAgentSettings = settings.dataAgent &&
    typeof settings.dataAgent === 'object' &&
    !Array.isArray(settings.dataAgent)
    ? settings.dataAgent as Record<string, unknown>
    : {};
  const quantSettings = settings.quant &&
    typeof settings.quant === 'object' &&
    !Array.isArray(settings.quant)
    ? settings.quant as Record<string, unknown>
    : {};
  const capabilityId = typeof dataAgentSettings.capabilityId === 'string'
    ? dataAgentSettings.capabilityId
    : typeof quantSettings.capabilityId === 'string'
      ? quantSettings.capabilityId
      : undefined;
  const application = getApplicationDataAgentCatalog().resolve(
    params.agentProfileId ?? DEFAULT_DATA_AGENT_PROFILE_ID,
    capabilityId,
  );
  const selectedModel = normalizeMoAgentModelId(params.selectedModel);
  const llm = getProjectLlmConfig(selectedModel);
  const managedProjectPath = await assertManagedWorkspaceExists(
    params.projectId,
    params.projectPath,
  );
  const dataAgentDir = path.join(managedProjectPath, DATA_AGENT_ROOT_RELATIVE_PATH);
  const workspacePath = path.join(managedProjectPath, DATA_AGENT_WORKSPACE_RELATIVE_PATH);
  await fs.mkdir(dataAgentDir, { recursive: true });
  const existingWorkspace = await fs.readFile(workspacePath, 'utf8')
    .then((content) => {
      const parsed = JSON.parse(content) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    })
    .catch(() => ({} as Record<string, unknown>));
  const existingRuntime = existingWorkspace.runtime &&
    typeof existingWorkspace.runtime === 'object' &&
    !Array.isArray(existingWorkspace.runtime)
    ? existingWorkspace.runtime as Record<string, unknown>
    : {};
  const now = new Date().toISOString();
  const nextWorkspace = {
    ...existingWorkspace,
    schemaVersion: 1,
    workspaceId: params.projectId,
    projectId: params.projectId,
    projectName: params.projectName,
    platform: 'QuantPilot',
    composition: application.composition,
    runtime: {
      ...existingRuntime,
      framework: 'MoAgent',
      executorId: params.preferredCli ?? 'moagent',
      modelId: selectedModel,
      modelProfileId: llm.profileId,
    },
    createdAt: typeof existingWorkspace.createdAt === 'string'
      ? existingWorkspace.createdAt
      : now,
    updatedAt: now,
  };
  const nextWorkspaceContent = `${JSON.stringify(nextWorkspace, null, 2)}\n`;
  const currentWorkspaceContent = await fs.readFile(workspacePath, 'utf8').catch(() => null);
  if (currentWorkspaceContent !== nextWorkspaceContent) {
    await writeWorkspaceFileAtomic(
      managedProjectPath,
      DATA_AGENT_WORKSPACE_RELATIVE_PATH,
      nextWorkspaceContent,
    );
  }

  const nextSettings = JSON.stringify({
    ...settings,
    llm,
    dataAgent: {
      ...dataAgentSettings,
      profileId: application.profile.id,
      profileVersion: application.profile.version,
      capabilityId: application.capability.id,
      compositionSha256: application.composition.sha256,
    },
  });
  if (nextSettings !== (params.settings ?? '')) {
    await prisma.project.update({
      where: { id: params.projectId },
      data: {
        settings: nextSettings,
        agentProfileId: application.profile.id,
        agentProfileVersion: application.profile.version,
        dataAgentCompositionSha256: application.composition.sha256,
      },
    });
  }
}

export async function lockProjectDataAgentComposition(params: {
  projectId: string;
  projectPath: string;
  composition: DataAgentCompositionLock;
}): Promise<void> {
  const application = getApplicationDataAgentCatalog().resolve(
    params.composition.profile.id,
    params.composition.capability.id,
  );
  if (application.composition.sha256 !== params.composition.sha256) {
    throw new Error('Data Agent composition lock does not match the application catalog.');
  }
  const current = await prisma.project.findUnique({
    where: { id: params.projectId },
    select: { settings: true },
  });
  if (!current) throw new Error('Project does not exist while locking Data Agent composition.');
  const managedProjectPath = await assertManagedWorkspaceExists(
    params.projectId,
    params.projectPath,
  );
  const workspacePath = path.join(
    managedProjectPath,
    DATA_AGENT_WORKSPACE_RELATIVE_PATH,
  );
  const parsedWorkspace: unknown = JSON.parse(
    await fs.readFile(workspacePath, 'utf8'),
  );
  if (
    !parsedWorkspace ||
    typeof parsedWorkspace !== 'object' ||
    Array.isArray(parsedWorkspace)
  ) {
    throw new Error('Data Agent workspace descriptor must be a JSON object.');
  }
  const existingWorkspace = parsedWorkspace as Record<string, unknown>;
  await writeWorkspaceFileAtomic(
    managedProjectPath,
    DATA_AGENT_WORKSPACE_RELATIVE_PATH,
    `${JSON.stringify({
      ...existingWorkspace,
      composition: application.composition,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
  );

  const settings = parseProjectSettings(current.settings);
  const currentDataAgent = settings.dataAgent &&
    typeof settings.dataAgent === 'object' &&
    !Array.isArray(settings.dataAgent)
    ? settings.dataAgent as Record<string, unknown>
    : {};
  await prisma.project.update({
    where: { id: params.projectId },
    data: {
      agentProfileId: application.profile.id,
      agentProfileVersion: application.profile.version,
      dataAgentCompositionSha256: application.composition.sha256,
      settings: JSON.stringify({
        ...settings,
        dataAgent: {
          ...currentDataAgent,
          profileId: application.profile.id,
          profileVersion: application.profile.version,
          capabilityId: application.capability.id,
          compositionSha256: application.composition.sha256,
        },
      }),
    },
  });
}

/**
 * Retrieve all projects
 */
export async function getAllProjects(access?: {
  userId: string;
  isAdmin: boolean;
}): Promise<Project[]> {
  const projects = await prisma.project.findMany({
    ...(access && !access.isAdmin
      ? {
          where: {
            OR: [
              { ownerId: access.userId },
              { memberships: { some: { userId: access.userId } } },
            ],
          },
        }
      : {}),
    orderBy: {
      lastActiveAt: 'desc',
    },
  });
  return projects.map(project => ({
    ...project,
    preferredCli: 'moagent',
    selectedModel: normalizeMoAgentModelId(project.selectedModel),
  })) as Project[];
}

/**
 * Retrieve project by ID
 */
export async function getProjectById(id: string): Promise<Project | null> {
  const project = await prisma.project.findUnique({
    where: { id },
  });
  if (!project) return null;
  return {
    ...project,
    preferredCli: 'moagent',
    selectedModel: normalizeMoAgentModelId(project.selectedModel),
  } as Project;
}

/**
 * Create new project
 */
export async function createProject(
  input: CreateProjectInput,
  access?: { ownerId: string },
): Promise<Project> {
  const application = getApplicationDataAgentCatalog().resolve(
    input.agentProfileId ?? DEFAULT_DATA_AGENT_PROFILE_ID,
    input.capabilityId,
  );
  const projectPath = await assertManagedWorkspaceAvailable(input.project_id);
  const preferredCli = 'moagent';
  const selectedModel = normalizeMoAgentModelId(input.selectedModel);
  let project = await prisma.project.create({
    data: {
      id: input.project_id,
      ownerId: access?.ownerId,
      name: input.name,
      description: input.description,
      initialPrompt: input.initialPrompt,
      repoPath: projectPath,
      preferredCli,
      selectedModel,
      agentProfileId: application.profile.id,
      agentProfileVersion: application.profile.version,
      dataAgentCompositionSha256: application.composition.sha256,
      settings: JSON.stringify({
        llm: getProjectLlmConfig(selectedModel),
        dataAgent: {
          profileId: application.profile.id,
          profileVersion: application.profile.version,
          capabilityId: application.capability.id,
          compositionSha256: application.composition.sha256,
        },
      }),
      status: 'initializing',
      templateType: 'nextjs',
      lastActiveAt: new Date(),
      previewUrl: null,
      previewPort: null,
      ...(access?.ownerId
        ? {
            memberships: {
              create: {
                userId: access.ownerId,
                role: 'owner',
              },
            },
          }
        : {}),
    },
  });
  const projectsRoot = managedProjectsRoot();
  let stagedPath: string | null = null;
  let committedWorkspace = false;
  try {
    stagedPath = await fs.mkdtemp(path.join(
      projectsRoot,
      `.${input.project_id}.provision-`,
    ));
    const provisioned = await application.adapter.provisionProject({
      projectPath: stagedPath,
      projectId: input.project_id,
      projectName: input.name,
      preferredCli,
      selectedModel,
      capabilitySelectionSource: normalizeCapabilitySource(input.capabilitySelectionSource),
    }, application);
    const targetExists = await fs.lstat(projectPath).then(() => true).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    );
    if (targetExists) {
      throw new Error(`Managed workspace already exists for project ${input.project_id}.`);
    }
    await fs.rename(stagedPath, projectPath);
    stagedPath = null;
    committedWorkspace = true;
    project = await prisma.project.update({
      where: { id: input.project_id },
      data: {
        status: 'idle',
        settings: JSON.stringify(provisioned.settings),
      },
    });
  } catch (error) {
    if (stagedPath) {
      await fs.rm(stagedPath, { recursive: true, force: true }).catch(() => undefined);
    }
    if (committedWorkspace) {
      await fs.rm(projectPath, { recursive: true, force: true }).catch(() => undefined);
    }
    await prisma.project.delete({ where: { id: input.project_id } }).catch((cleanupError) => {
      console.error('[ProjectService] Failed to roll back project provisioning:', cleanupError);
    });
    throw error;
  }

  console.log(`[ProjectService] Created project: ${project.id}`);
  return {
    ...project,
    preferredCli: 'moagent',
    selectedModel,
  } as Project;
}

/**
 * Update project
 */
export async function updateProject(
  id: string,
  input: UpdateProjectInput
): Promise<Project> {
  const current = await prisma.project.findUnique({
    where: { id },
    select: { selectedModel: true, settings: true },
  });
  const selectedModel = normalizeMoAgentModelId(
    input.selectedModel ?? current?.selectedModel ?? MOAGENT_DEFAULT_MODEL,
  );
  const project = await prisma.project.update({
    where: { id },
    data: {
      ...input,
      ...(input.settings !== undefined || input.selectedModel !== undefined
        ? { settings: mergeLlmSettings(input.settings ?? current?.settings, selectedModel) }
        : {}),
      preferredCli: 'moagent',
      selectedModel,
      updatedAt: new Date(),
    },
  });

  console.log(`[ProjectService] Updated project: ${id}`);
  return {
    ...project,
    preferredCli: 'moagent',
    selectedModel,
  } as Project;
}

/**
 * Delete project
 */
export async function deleteProject(
  id: string,
  options: { deletedByUserId?: string | null } = {},
): Promise<boolean> {
  const existing = await prisma.project.findUnique({
    where: { id },
    select: { repoPath: true },
  });
  if (!existing) return false;
  const managedPath = resolveManagedWorkspacePath(id, existing.repoPath);
  const workspaceExists = await fs.lstat(managedPath).then(() => true).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
  if (workspaceExists) {
    await assertManagedWorkspaceExists(id, existing.repoPath);
  }
  // Commit the authoritative database deletion first. If filesystem cleanup
  // fails, it leaves a removable orphan instead of a live project whose files
  // were irreversibly removed before the database operation could commit. The
  // ownership allocation decrement shares that same database transaction.
  const project = await deleteProjectWithOwnedQuota(prisma, id, options);
  if (!project) return false;

  if (workspaceExists) {
    try {
      await fs.rm(managedPath, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[ProjectService] Failed to delete project directory:`, error);
    }
  }

  console.log(`[ProjectService] Deleted project: ${id}`);
  return true;
}

/**
 * Update project activity time
 */
export async function updateProjectActivity(id: string): Promise<void> {
  await prisma.project.update({
    where: { id },
    data: {
      lastActiveAt: new Date(),
    },
  });
}

/**
 * Update project status
 */
export async function updateProjectStatus(
  id: string,
  status: 'idle' | 'running' | 'stopped' | 'error'
): Promise<void> {
  await prisma.project.update({
    where: { id },
    data: {
      status,
      updatedAt: new Date(),
    },
  });
  console.log(`[ProjectService] Updated project status: ${id} -> ${status}`);
}
