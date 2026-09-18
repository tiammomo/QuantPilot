export type PiAgentSkillStatus = 'stable' | 'planned' | 'deprecated';

export type PiAgentSkillPhase =
  | 'planning'
  | 'data-preparation'
  | 'workspace-generation'
  | 'validation-repair'
  | 'platform-ui';

export type PiAgentSkillResourceSelector = 'template-heading' | 'named-headings';

export interface PiAgentSkillCapsuleResource {
  id: string;
  path: string;
  profiles: PiAgentSkillPhase[];
  selector: PiAgentSkillResourceSelector;
  headings?: string[];
  maxChars: number;
  required: boolean;
}

export interface PiAgentSkillRuntimeCapsule {
  priority: number;
  phases: PiAgentSkillPhase[];
  requiresTools: string[];
  /** At least one complete alternative set must be provider-visible. */
  requiresOneOfToolSets?: string[][];
  objective: string;
  invariants: string[];
  workflow: string[];
  doneWhen: string[];
  resources: PiAgentSkillCapsuleResource[];
}

export interface PiAgentSkillCapsuleRegistry {
  schemaVersion: 1;
  description?: string;
  workspaceResponseContract: {
    schemaVersion: 1;
    owner: 'platform';
    stageLabels: string[];
    rules: string[];
  };
  skills: Record<string, PiAgentSkillRuntimeCapsule>;
}

export interface PiAgentSkillRegistryEntry {
  id: string;
  name: string;
  version: string;
  status: PiAgentSkillStatus;
  scope?: string;
  boundary: string;
  inputs?: string[];
  outputs?: string[];
  scripts?: string[];
  references?: string[];
  endpoints?: string[];
  validation?: string[];
}

export interface PiAgentSkillsRegistry {
  schemaVersion: 1;
  policy: {
    targetCoreSkillCount?: number;
    packageFormat?: 'tgz';
    packageDir?: string;
    description?: string;
  };
  coreSkills: PiAgentSkillRegistryEntry[];
}

export interface PiAgentSkillLockEntry {
  version: string;
  packagePath?: string;
  sourceSha256?: string;
  packageSha256?: string;
  fileCount?: number;
}

export interface PiAgentSkillsLock {
  schemaVersion: 1;
  packageFormat?: 'tgz';
  skills: Record<string, PiAgentSkillLockEntry>;
}

export type PiAgentSkillSource = 'source' | 'package';

export interface CompiledPiAgentSkill {
  id: string;
  name: string;
  version: string;
  status: PiAgentSkillStatus;
  source: PiAgentSkillSource;
  sourceSha256: string | null;
  packageSha256: string | null;
  originalCharacters: number;
  compiledCharacters: number;
  truncated: boolean;
  capsuleSha256: string;
  includedResources: Array<{
    id: string;
    path: string;
    sha256: string;
    characters: number;
  }>;
}

export interface PiAgentSkillsInstallReceipt {
  schemaVersion: 1;
  runtime: 'PI Agent';
  installedAt: string;
  capabilityId: string | null;
  skillsDirectory: string;
  skills: Record<
    string,
    {
      version: string;
      source: PiAgentSkillSource;
      sourceSha256: string | null;
      packageSha256: string | null;
    }
  >;
}

/**
 * Product-neutral capability projection consumed by the Skill compiler.
 * Domain packages own the source capability model and project only the fields
 * required for deterministic Skill selection.
 */
export interface PiAgentSkillCapabilityDescriptor {
  id: string;
  status: 'ready' | 'planned' | 'deprecated';
  requiredSkillIds: readonly string[];
}

export interface CompilePiAgentSkillsOptions {
  /** Repository containing the configured registry/lock inputs. */
  repositoryRoot?: string;
  /** Resolve executable versions from the platform-owned deployment, never workspace receipts. */
  runtimeWorkspace?: string;
  /** Domain-owned, product-neutral capability projection. */
  capability?: PiAgentSkillCapabilityDescriptor | null;
  /** Stable label retained in receipts when explicit skill IDs are supplied. */
  capabilityId?: string | null;
  /** Explicit canonical Skill IDs take precedence over capability selection. */
  requiredSkillIds?: readonly string[];
  additionalSkillIds?: readonly string[];
  /** Runtime phase used to activate only compatible skill capsules. */
  phase?: PiAgentSkillPhase;
  /** Domain-owned skills activated by the current task context. */
  activatedSkillIds?: readonly string[];
  /** Domain-owned skills made redundant or invalid by the current task context. */
  excludedSkillIds?: readonly string[];
  /** Selects the exact scenario reference fragment for dashboard generation. */
  templateId?: string | null;
  variantId?: string | null;
  /** When provided, every capsule-declared tool must exist in this phase tool surface. */
  availableToolNames?: readonly string[];
  maxSystemContextChars?: number;
  /** When present, verified skills are installed below <workspace>/.pi/skills. */
  installToWorkspace?: string;
  registryPath?: string;
  lockPath?: string;
  sourceSkillsPath?: string;
  capsuleRegistryPath?: string;
}

export interface CompilePiAgentSkillsResult {
  runtime: 'PI Agent';
  capabilityId: string | null;
  selectedSkillIds: string[];
  phase: PiAgentSkillPhase;
  systemContext: string;
  taskContext: string;
  maxSystemContextChars: number;
  systemContextCharacters: number;
  taskContextCharacters: number;
  totalCharacters: number;
  truncated: boolean;
  skills: CompiledPiAgentSkill[];
  installReceipt: PiAgentSkillsInstallReceipt | null;
}
