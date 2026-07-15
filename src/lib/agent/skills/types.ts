export type MoAgentSkillStatus = 'stable' | 'planned' | 'deprecated';

export type MoAgentSkillPhase =
  | 'planning'
  | 'data-preparation'
  | 'workspace-generation'
  | 'validation-repair'
  | 'platform-ui';

export type MoAgentSkillResourceSelector = 'template-heading' | 'named-headings';

export interface MoAgentSkillCapsuleResource {
  id: string;
  path: string;
  profiles: MoAgentSkillPhase[];
  selector: MoAgentSkillResourceSelector;
  headings?: string[];
  maxChars: number;
  required: boolean;
}

export interface MoAgentSkillRuntimeCapsule {
  priority: number;
  phases: MoAgentSkillPhase[];
  requiresTools: string[];
  /** At least one complete alternative set must be provider-visible. */
  requiresOneOfToolSets?: string[][];
  objective: string;
  invariants: string[];
  workflow: string[];
  doneWhen: string[];
  resources: MoAgentSkillCapsuleResource[];
}

export interface MoAgentSkillCapsuleRegistry {
  schemaVersion: 1;
  description?: string;
  skills: Record<string, MoAgentSkillRuntimeCapsule>;
}

export interface MoAgentSkillRegistryEntry {
  id: string;
  name: string;
  version: string;
  status: MoAgentSkillStatus;
  scope?: string;
  boundary: string;
  inputs?: string[];
  outputs?: string[];
  scripts?: string[];
  endpoints?: string[];
  legacyAliases?: string[];
  validation?: string[];
}

export interface MoAgentSkillsRegistry {
  schemaVersion: 1;
  policy: {
    targetCoreSkillCount?: number;
    allowLegacyAliases?: boolean;
    installLegacyByDefault?: boolean;
    packageFormat?: 'tgz';
    packageDir?: string;
    description?: string;
  };
  coreSkills: MoAgentSkillRegistryEntry[];
  legacyAliases?: Record<string, string>;
}

export interface MoAgentSkillLockEntry {
  version: string;
  packagePath?: string;
  sourceSha256?: string;
  packageSha256?: string;
  fileCount?: number;
}

export interface MoAgentSkillsLock {
  schemaVersion: 1;
  packageFormat?: 'tgz';
  skills: Record<string, MoAgentSkillLockEntry>;
}

export type MoAgentSkillSource = 'source' | 'package';

export interface CompiledMoAgentSkill {
  id: string;
  requestedIds: string[];
  name: string;
  version: string;
  status: MoAgentSkillStatus;
  source: MoAgentSkillSource;
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

export interface MoAgentSkillsInstallReceipt {
  schemaVersion: 1;
  runtime: 'MoAgent';
  installedAt: string;
  capabilityId: string | null;
  skillsDirectory: string;
  skills: Record<
    string,
    {
      version: string;
      source: MoAgentSkillSource;
      sourceSha256: string | null;
      packageSha256: string | null;
    }
  >;
}

export interface CompileMoAgentSkillsOptions {
  /** QuantPilot repository containing the legacy-compatible registry/lock inputs. */
  repositoryRoot?: string;
  capabilityId?: string | null;
  /** Explicit skill IDs take precedence over capabilityId. Legacy aliases are accepted by policy. */
  requiredSkillIds?: readonly string[];
  additionalSkillIds?: readonly string[];
  /** Runtime phase used to activate only compatible skill capsules. */
  phase?: MoAgentSkillPhase;
  /** Attachments activate image extraction independently of the quant capability. */
  hasAttachments?: boolean;
  /** A resolved run plan makes the planner and symbol resolver redundant in the executor. */
  hasResolvedSymbols?: boolean;
  /** Selects the exact scenario reference fragment for dashboard generation. */
  templateId?: string | null;
  variantId?: string | null;
  /** When provided, every capsule-declared tool must exist in this phase tool surface. */
  availableToolNames?: readonly string[];
  maxSystemContextChars?: number;
  /** When present, verified skills are installed below <workspace>/.moagent/skills. */
  installToWorkspace?: string;
  registryPath?: string;
  lockPath?: string;
  sourceSkillsPath?: string;
  capsuleRegistryPath?: string;
}

export interface CompileMoAgentSkillsResult {
  runtime: 'MoAgent';
  capabilityId: string | null;
  requestedSkillIds: string[];
  resolvedSkillIds: string[];
  aliases: Record<string, string>;
  phase: MoAgentSkillPhase;
  systemContext: string;
  taskContext: string;
  maxSystemContextChars: number;
  systemContextCharacters: number;
  taskContextCharacters: number;
  totalCharacters: number;
  truncated: boolean;
  skills: CompiledMoAgentSkill[];
  installReceipt: MoAgentSkillsInstallReceipt | null;
}
