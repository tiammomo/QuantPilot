import accessControlConfig from '../../../config/access-control.json';

/**
 * Keep this tuple explicit so route and service code gets a closed, strongly
 * typed action union. The catalog validator below prevents this tuple and the
 * deploy-time JSON policy from drifting apart.
 */
export const PERMISSION_ACTIONS = [
  'project.create',
  'project.read',
  'project.update',
  'project.delete',
  'project.members.manage',
  'project.source.read',
  'project.source.write',
  'project.secrets.read',
  'project.secrets.write',
  'project.services.read',
  'project.services.manage',
  'project.deploy',
  'agent.run',
  'agent.cancel',
  'quant.data.read',
  'quant.query.rewrite.llm',
  'quant.strategy.run',
  'quant.strategy.manage',
  'research.report.read',
  'research.report.run',
  'research.report.send',
  'platform.users.manage',
  'platform.quotas.manage',
  'platform.audit.read',
  'platform.observability.read',
  'platform.settings.manage',
  'platform.tokens.manage',
] as const;

export const PROJECT_PERMISSION_ROLES = ['owner', 'editor', 'viewer'] as const;
export const BUILTIN_PERMISSION_PROFILES = [
  'member-default',
  'standard-researcher',
  'readonly-default',
  'read-only',
] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];
export type PermissionScope = 'account' | 'project' | 'platform';
export type PermissionEffect = 'allow' | 'deny';
export type PermissionProjectRole = (typeof PROJECT_PERMISSION_ROLES)[number];
export type BuiltinPermissionProfile = (typeof BUILTIN_PERMISSION_PROFILES)[number];

export interface PermissionActionDefinition {
  scope: PermissionScope;
  description: string;
}

export interface PermissionRuleSet {
  readonly allow: readonly PermissionAction[];
  readonly deny: readonly PermissionAction[];
}

export interface PermissionProfileDefinition extends PermissionRuleSet {
  readonly name: string;
}

export interface AccessControlCatalog {
  readonly version: number;
  readonly defaultMemberProfile: BuiltinPermissionProfile;
  readonly actions: Readonly<Record<PermissionAction, PermissionActionDefinition>>;
  readonly profiles: Readonly<Record<BuiltinPermissionProfile, PermissionProfileDefinition>>;
  readonly projectRoles: Readonly<Record<PermissionProjectRole, PermissionRuleSet>>;
}

const ACTION_SET: ReadonlySet<string> = new Set(PERMISSION_ACTIONS);
const SCOPE_SET: ReadonlySet<string> = new Set(['account', 'project', 'platform']);
const EFFECT_SET: ReadonlySet<string> = new Set(['allow', 'deny']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPermissionAction(value: unknown): value is PermissionAction {
  return typeof value === 'string' && ACTION_SET.has(value);
}

function assertExactKeys(label: string, actual: readonly string[], expected: readonly string[]): void {
  const actualSet = new Set(actual);
  const missing = expected.filter((key) => !actualSet.has(key));
  const unexpected = actual.filter((key) => !expected.includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `${label} is out of sync (missing: ${missing.join(', ') || 'none'}; ` +
      `unexpected: ${unexpected.join(', ') || 'none'}).`,
    );
  }
}

function parseActions(value: unknown): Record<PermissionAction, PermissionActionDefinition> {
  if (!isObject(value)) throw new Error('access-control actions must be an object.');
  assertExactKeys('access-control actions', Object.keys(value), PERMISSION_ACTIONS);

  return Object.fromEntries(PERMISSION_ACTIONS.map((action) => {
    const definition = value[action];
    if (!isObject(definition)) throw new Error(`Definition for ${action} must be an object.`);
    const scope = definition.scope;
    const description = definition.description;
    if (typeof scope !== 'string' || !SCOPE_SET.has(scope)) {
      throw new Error(`Definition for ${action} has an invalid scope.`);
    }
    if (typeof description !== 'string' || description.trim().length === 0) {
      throw new Error(`Definition for ${action} must have a description.`);
    }
    return [action, Object.freeze({ scope: scope as PermissionScope, description })];
  })) as Record<PermissionAction, PermissionActionDefinition>;
}

function parseActionList(value: unknown, label: string): readonly PermissionAction[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const result: PermissionAction[] = [];
  for (const action of value) {
    if (!isPermissionAction(action)) throw new Error(`${label} contains unknown action ${String(action)}.`);
    if (result.includes(action)) throw new Error(`${label} contains duplicate action ${action}.`);
    result.push(action);
  }
  return Object.freeze(result);
}

function parseRuleSet(value: unknown, label: string): PermissionRuleSet {
  if (!isObject(value)) throw new Error(`${label} must be an object.`);
  const allow = parseActionList(value.allow, `${label}.allow`);
  const deny = parseActionList(value.deny, `${label}.deny`);
  const conflict = allow.find((action) => deny.includes(action));
  if (conflict) throw new Error(`${label} both allows and denies ${conflict}.`);
  return Object.freeze({ allow, deny });
}

function parseCatalog(value: unknown): AccessControlCatalog {
  if (!isObject(value)) throw new Error('access-control catalog must be an object.');
  if (!Number.isInteger(value.version) || Number(value.version) < 1) {
    throw new Error('access-control catalog version must be a positive integer.');
  }
  if (!BUILTIN_PERMISSION_PROFILES.includes(value.defaultMemberProfile as BuiltinPermissionProfile)) {
    throw new Error('access-control defaultMemberProfile is unknown.');
  }

  const actions = parseActions(value.actions);
  const rawProfiles = value.profiles;
  if (!isObject(rawProfiles)) throw new Error('access-control profiles must be an object.');
  assertExactKeys(
    'access-control profiles',
    Object.keys(rawProfiles),
    BUILTIN_PERMISSION_PROFILES,
  );
  const profiles = Object.fromEntries(BUILTIN_PERMISSION_PROFILES.map((profileKey) => {
    const rawProfile = rawProfiles[profileKey];
    if (!isObject(rawProfile) || typeof rawProfile.name !== 'string' || !rawProfile.name.trim()) {
      throw new Error(`Profile ${profileKey} must have a name.`);
    }
    return [profileKey, Object.freeze({
      name: rawProfile.name,
      ...parseRuleSet(rawProfile, `profiles.${profileKey}`),
    })];
  })) as Record<BuiltinPermissionProfile, PermissionProfileDefinition>;

  const rawProjectRoles = value.projectRoles;
  if (!isObject(rawProjectRoles)) throw new Error('access-control projectRoles must be an object.');
  assertExactKeys(
    'access-control projectRoles',
    Object.keys(rawProjectRoles),
    PROJECT_PERMISSION_ROLES,
  );
  const projectRoles = Object.fromEntries(PROJECT_PERMISSION_ROLES.map((role) => [
    role,
    parseRuleSet(rawProjectRoles[role], `projectRoles.${role}`),
  ])) as Record<PermissionProjectRole, PermissionRuleSet>;

  return Object.freeze({
    version: Number(value.version),
    defaultMemberProfile: value.defaultMemberProfile as BuiltinPermissionProfile,
    actions: Object.freeze(actions),
    profiles: Object.freeze(profiles),
    projectRoles: Object.freeze(projectRoles),
  });
}

export const ACCESS_CONTROL_CATALOG = parseCatalog(accessControlConfig);

/** Shape shared by PermissionProfileGrant and the override tables. */
export interface PermissionGrantRecord {
  readonly permissionKey: string;
  readonly effect: PermissionEffect | string;
  readonly expiresAt?: Date | string | null;
  readonly reason?: string | null;
}

/**
 * Compatible with Prisma's PermissionProfile plus an included `grants`
 * relation. A repository can return additional profile keys without changing
 * this evaluator.
 */
export interface ResolvedPermissionProfile {
  readonly key: string;
  readonly name?: string;
  readonly isDefault?: boolean;
  readonly grants: readonly PermissionGrantRecord[];
}

export interface ResolvedPermissionPolicy {
  readonly profile?: ResolvedPermissionProfile | null;
  readonly userOverrides?: readonly PermissionGrantRecord[];
  readonly membershipOverrides?: readonly PermissionGrantRecord[];
}

export interface PermissionPolicyRepository {
  resolvePolicy(input: {
    readonly userId: string;
    readonly projectId?: string;
  }): Promise<ResolvedPermissionPolicy>;
}

export interface PermissionActor {
  readonly id: string;
  readonly platformRole?: string | null;
  readonly permissionProfileKey?: string | null;
}

export interface PermissionProjectContext {
  readonly id: string;
  readonly role?: PermissionProjectRole | string | null;
}

export interface PermissionEvaluationInput {
  /** Unknown is intentional: untrusted/runtime action names fail closed. */
  readonly action: unknown;
  readonly actor: PermissionActor;
  readonly project?: PermissionProjectContext | null;
  readonly policy?: ResolvedPermissionPolicy;
  readonly now?: Date;
}

export type PermissionDecisionReason =
  | 'ADMIN_ALL'
  | 'GRANTED'
  | 'UNKNOWN_ACTION'
  | 'PROJECT_CONTEXT_REQUIRED'
  | 'PROJECT_MEMBERSHIP_REQUIRED'
  | 'EXPLICIT_DENY'
  | 'PROFILE_NOT_GRANTED'
  | 'PROJECT_ROLE_NOT_GRANTED'
  | 'POLICY_LOOKUP_FAILED';

export interface PermissionDecision {
  readonly allowed: boolean;
  readonly action: string;
  readonly reason: PermissionDecisionReason;
  readonly scope?: PermissionScope;
  readonly profileKey?: string;
  readonly matchedSources: readonly string[];
}

function isActiveGrant(grant: PermissionGrantRecord, now: Date): boolean {
  if (!isPermissionAction(grant.permissionKey) || !EFFECT_SET.has(grant.effect)) return false;
  if (!grant.expiresAt) return true;
  const expiresAt = new Date(grant.expiresAt);
  if (!Number.isFinite(expiresAt.valueOf())) {
    // A malformed allow must not grant access; a malformed deny must not open it.
    return grant.effect === 'deny';
  }
  return expiresAt.getTime() > now.getTime();
}

function matchingEffects(
  grants: readonly PermissionGrantRecord[] | undefined,
  action: PermissionAction,
  now: Date,
): PermissionEffect[] {
  if (!grants) return [];
  return grants
    .filter((grant) => grant.permissionKey === action && isActiveGrant(grant, now))
    .map((grant) => grant.effect as PermissionEffect);
}

function builtinProfileRules(profileKey: string): PermissionRuleSet | null {
  return BUILTIN_PERMISSION_PROFILES.includes(profileKey as BuiltinPermissionProfile)
    ? ACCESS_CONTROL_CATALOG.profiles[profileKey as BuiltinPermissionProfile]
    : null;
}

function profileEffects(
  input: PermissionEvaluationInput,
  action: PermissionAction,
  profileKey: string,
  now: Date,
): PermissionEffect[] {
  if (input.policy?.profile) {
    return matchingEffects(input.policy.profile.grants, action, now);
  }
  const profile = builtinProfileRules(profileKey);
  if (!profile) return [];
  return [
    ...(profile.allow.includes(action) ? ['allow' as const] : []),
    ...(profile.deny.includes(action) ? ['deny' as const] : []),
  ];
}

function denyDecision(
  action: PermissionAction,
  scope: PermissionScope,
  profileKey: string,
  matchedSources: readonly string[],
): PermissionDecision {
  return {
    allowed: false,
    action,
    scope,
    profileKey,
    reason: 'EXPLICIT_DENY',
    matchedSources,
  };
}

export function evaluatePermission(input: PermissionEvaluationInput): PermissionDecision {
  const rawAction = typeof input.action === 'string' ? input.action : String(input.action ?? '');
  if (!isPermissionAction(input.action)) {
    return {
      allowed: false,
      action: rawAction,
      reason: 'UNKNOWN_ACTION',
      matchedSources: [],
    };
  }

  const action = input.action;
  const definition = ACCESS_CONTROL_CATALOG.actions[action];
  const now = input.now ?? new Date();
  const profileKey = input.policy?.profile?.key
    ?? input.actor.permissionProfileKey
    ?? ACCESS_CONTROL_CATALOG.defaultMemberProfile;
  const userEffects = matchingEffects(input.policy?.userOverrides, action, now);
  const membershipEffects = matchingEffects(input.policy?.membershipOverrides, action, now);
  const profileRuleEffects = profileEffects(input, action, profileKey, now);

  if (definition.scope === 'project' && !input.project?.id) {
    return {
      allowed: false,
      action,
      scope: definition.scope,
      profileKey,
      reason: 'PROJECT_CONTEXT_REQUIRED',
      matchedSources: [],
    };
  }

  if (input.actor.platformRole === 'admin') {
    return {
      allowed: true,
      action,
      scope: definition.scope,
      profileKey,
      reason: 'ADMIN_ALL',
      matchedSources: ['platform-role:admin'],
    };
  }

  const explicitDenySources = [
    ...(profileRuleEffects.includes('deny') ? [`profile:${profileKey}:deny`] : []),
    ...(userEffects.includes('deny') ? ['user-override:deny'] : []),
    ...(membershipEffects.includes('deny') ? ['membership-override:deny'] : []),
  ];
  if (explicitDenySources.length > 0) {
    return denyDecision(action, definition.scope, profileKey, explicitDenySources);
  }

  const globalSources = [
    ...(profileRuleEffects.includes('allow') ? [`profile:${profileKey}:allow`] : []),
    ...(userEffects.includes('allow') ? ['user-override:allow'] : []),
  ];
  if (globalSources.length === 0) {
    return {
      allowed: false,
      action,
      scope: definition.scope,
      profileKey,
      reason: 'PROFILE_NOT_GRANTED',
      matchedSources: [],
    };
  }

  if (definition.scope !== 'project') {
    return {
      allowed: true,
      action,
      scope: definition.scope,
      profileKey,
      reason: 'GRANTED',
      matchedSources: globalSources,
    };
  }

  const role = input.project?.role;
  const knownRole = PROJECT_PERMISSION_ROLES.includes(role as PermissionProjectRole)
    ? role as PermissionProjectRole
    : null;
  if (!knownRole) {
    return {
      allowed: false,
      action,
      scope: definition.scope,
      profileKey,
      reason: 'PROJECT_MEMBERSHIP_REQUIRED',
      matchedSources: globalSources,
    };
  }

  const roleRules = ACCESS_CONTROL_CATALOG.projectRoles[knownRole];
  const roleDenied = roleRules.deny.includes(action);
  if (roleDenied) {
    return denyDecision(action, definition.scope, profileKey, [`project-role:${knownRole}:deny`]);
  }
  const projectSources = [
    ...(roleRules.allow.includes(action) ? [`project-role:${knownRole}:allow`] : []),
    ...(membershipEffects.includes('allow') ? ['membership-override:allow'] : []),
  ];
  if (projectSources.length === 0) {
    return {
      allowed: false,
      action,
      scope: definition.scope,
      profileKey,
      reason: 'PROJECT_ROLE_NOT_GRANTED',
      matchedSources: globalSources,
    };
  }

  return {
    allowed: true,
    action,
    scope: definition.scope,
    profileKey,
    reason: 'GRANTED',
    matchedSources: [...globalSources, ...projectSources],
  };
}

export async function evaluatePermissionWithRepository(
  input: Omit<PermissionEvaluationInput, 'policy'>,
  repository: PermissionPolicyRepository,
): Promise<PermissionDecision> {
  try {
    const policy = await repository.resolvePolicy({
      userId: input.actor.id,
      ...(input.project?.id ? { projectId: input.project.id } : {}),
    });
    return evaluatePermission({ ...input, policy });
  } catch {
    return {
      allowed: false,
      action: typeof input.action === 'string' ? input.action : String(input.action ?? ''),
      reason: 'POLICY_LOOKUP_FAILED',
      matchedSources: [],
    };
  }
}

export class PermissionDeniedError extends Error {
  constructor(public readonly decision: PermissionDecision) {
    super(`Permission ${decision.action || '<unknown>'} denied: ${decision.reason}.`);
    this.name = 'PermissionDeniedError';
  }
}

/** Strongly typed service/DAL boundary for already-resolved policy data. */
export function requirePermission(
  input: Omit<PermissionEvaluationInput, 'action'> & { readonly action: PermissionAction },
): PermissionDecision {
  const decision = evaluatePermission(input);
  if (!decision.allowed) throw new PermissionDeniedError(decision);
  return decision;
}

/** Strongly typed service/DAL boundary backed by a future Prisma repository. */
export async function requirePermissionWithRepository(
  input: Omit<PermissionEvaluationInput, 'action' | 'policy'> & {
    readonly action: PermissionAction;
  },
  repository: PermissionPolicyRepository,
): Promise<PermissionDecision> {
  const decision = await evaluatePermissionWithRepository(input, repository);
  if (!decision.allowed) throw new PermissionDeniedError(decision);
  return decision;
}
