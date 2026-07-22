/**
 * Project-related types
 */

export type ProjectStatus =
  | 'idle'
  | 'running'
  | 'stopped'
  | 'error'
  | 'initializing'
  | 'active'
  | 'failed';

export type TemplateType = 'nextjs' | 'react' | 'vue' | 'custom';

export interface Project {
  id: string;
  /** Server-only ownership identity; serializers intentionally omit it. */
  ownerId?: string | null;
  name: string;
  description?: string;
  status: ProjectStatus;
  /**
   * Preview metadata (nullable when no dev server is running).
   */
  previewUrl?: string | null;
  previewPort?: number | null;
  repoPath?: string;
  initialPrompt?: string;
  templateType?: TemplateType;
  preferredCli?: string;
  selectedModel?: string;
  fallbackEnabled: boolean;
  settings?: string; // JSON string
  createdAt: Date;
  updatedAt: Date;
  lastActiveAt: Date;
}

export interface CreateProjectInput {
  project_id: string;
  name: string;
  initialPrompt: string;
  preferredCli?: string;
  selectedModel?: string;
  description?: string;
  quantCapabilityId?: string;
  quantCapabilitySource?: 'manual' | 'default' | 'inferred';
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  status?: ProjectStatus;
  /** Preview runtime metadata. */
  previewUrl?: string | null;
  previewPort?: number | null;
  preferredCli?: string;
  selectedModel?: string;
  settings?: string;
  repoPath?: string | null;
}

export interface ProjectSettings {
  theme?: 'light' | 'dark' | 'system';
  autoSave?: boolean;
  [key: string]: any;
}
