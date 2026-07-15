export type MoAgentSkillStatus = 'stable' | 'planned' | 'deprecated';

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
  maxSystemContextChars?: number;
  /** When present, verified skills are installed below <workspace>/.moagent/skills. */
  installToWorkspace?: string;
  registryPath?: string;
  lockPath?: string;
  sourceSkillsPath?: string;
}

export interface CompileMoAgentSkillsResult {
  runtime: 'MoAgent';
  capabilityId: string | null;
  requestedSkillIds: string[];
  resolvedSkillIds: string[];
  aliases: Record<string, string>;
  systemContext: string;
  maxSystemContextChars: number;
  totalCharacters: number;
  truncated: boolean;
  skills: CompiledMoAgentSkill[];
  installReceipt: MoAgentSkillsInstallReceipt | null;
}
