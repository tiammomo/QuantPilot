import type { PrismaClient } from '@prisma/client';

import { getAuthSession } from '@/lib/auth/access';
import {
  AuthorizationError,
  isActiveBan,
  isPlatformAdmin,
  projectRoleForUser,
  type ProjectRole,
} from '@/lib/auth/authorization';
import {
  ACCESS_CONTROL_CATALOG,
  evaluatePermission,
  type PermissionAction,
  type PermissionDecision,
  type PermissionPolicyRepository,
  type ResolvedPermissionPolicy,
} from '@/lib/auth/permissions';
import type { ProjectAuthSession } from '@/lib/auth/server';
import { getProjectAuthConfig } from '@/lib/config/auth';
import { prisma } from '@/lib/db/client';

const LOCAL_SYSTEM_ADMIN_ID = 'local-system-admin';

type PermissionPrismaClient = Pick<PrismaClient, 'authUser' | 'permissionProfile'>;

/**
 * Loads the effective account capability policy from Prisma. Project roles are
 * deliberately resolved separately by requireAction so a capability grant can
 * never be mistaken for project membership.
 */
export class PrismaPermissionPolicyRepository implements PermissionPolicyRepository {
  constructor(private readonly client: PermissionPrismaClient = prisma) {}

  async resolvePolicy(input: {
    readonly userId: string;
    readonly projectId?: string;
  }): Promise<ResolvedPermissionPolicy> {
    const user = await this.client.authUser.findUnique({
      where: { id: input.userId },
      select: {
        permissionProfile: {
          select: {
            key: true,
            name: true,
            isDefault: true,
            grants: {
              select: { permissionKey: true, effect: true },
            },
          },
        },
        permissionOverrides: {
          select: {
            permissionKey: true,
            effect: true,
            expiresAt: true,
            reason: true,
          },
        },
      },
    });
    if (!user) throw new Error('Permission actor does not exist.');

    const profile = user.permissionProfile ?? await this.client.permissionProfile.findFirst({
      where: { isDefault: true },
      select: {
        key: true,
        name: true,
        isDefault: true,
        grants: {
          select: { permissionKey: true, effect: true },
        },
      },
    });

    return {
      profile,
      userOverrides: user.permissionOverrides,
      // Membership overrides do not exist in the current schema. Keeping this
      // plane empty makes the evaluator's project-role intersection explicit.
      membershipOverrides: [],
    };
  }
}

export interface RequireActionInput {
  readonly headers: Headers;
  readonly action: PermissionAction;
  readonly projectId?: string;
}

export interface RequiredActionContext {
  readonly actorUserId: string;
  readonly session: ProjectAuthSession | null;
  readonly projectRole: ProjectRole | null;
  readonly decision: PermissionDecision;
  readonly localSystemAdmin: boolean;
}

interface RequireActionDependencies {
  readonly authEnabled: boolean;
  readonly getSession: (headers: Headers) => Promise<ProjectAuthSession | null>;
  readonly getProjectRole: (userId: string, projectId: string) => Promise<ProjectRole | null>;
  readonly repository: PermissionPolicyRepository;
}

function defaultDependencies(): RequireActionDependencies {
  return {
    authEnabled: getProjectAuthConfig().enabled,
    getSession: getAuthSession,
    getProjectRole: projectRoleForUser,
    repository: new PrismaPermissionPolicyRepository(),
  };
}

function denied(
  code: string,
  status: 403 | 404 | 428,
  message: string,
): never {
  throw new AuthorizationError(code, status, message);
}

/**
 * Authenticates an actor and enforces both account capabilities and project
 * membership/role. This is the service/DAL boundary; proxy checks remain only
 * an early rejection optimization.
 */
export async function requireAction(
  input: RequireActionInput,
  dependencyOverrides: Partial<RequireActionDependencies> = {},
): Promise<RequiredActionContext> {
  const dependencies = { ...defaultDependencies(), ...dependencyOverrides };
  const definition = ACCESS_CONTROL_CATALOG.actions[input.action];

  if (definition.scope === 'project' && !input.projectId) {
    return denied('PROJECT_CONTEXT_REQUIRED', 403, '此操作需要项目上下文。');
  }

  if (!dependencies.authEnabled) {
    const decision = evaluatePermission({
      action: input.action,
      actor: { id: LOCAL_SYSTEM_ADMIN_ID, platformRole: 'admin' },
      ...(input.projectId ? { project: { id: input.projectId } } : {}),
    });
    if (!decision.allowed) {
      return denied('CAPABILITY_DENIED', 403, '当前本地系统身份无权执行此操作。');
    }
    return {
      actorUserId: LOCAL_SYSTEM_ADMIN_ID,
      session: null,
      projectRole: input.projectId ? 'owner' : null,
      decision,
      localSystemAdmin: true,
    };
  }

  const session = await dependencies.getSession(input.headers);
  if (!session) {
    throw new AuthorizationError('AUTHENTICATION_REQUIRED', 401, '请先登录。');
  }
  if (isActiveBan(session.user)) {
    return denied('ACCOUNT_DISABLED', 403, '账号已被停用。');
  }
  if (session.user.mustChangePassword === true) {
    return denied('PASSWORD_CHANGE_REQUIRED', 428, '请先修改初始密码。');
  }

  const actor = {
    id: session.user.id,
    platformRole: isPlatformAdmin(session.user) ? 'admin' : 'member',
  } as const;

  // Administrators have every catalogued capability. They still need a
  // project id for project-scoped calls, but do not depend on member policy or
  // membership records.
  if (actor.platformRole === 'admin') {
    const decision = evaluatePermission({
      action: input.action,
      actor,
      ...(input.projectId ? { project: { id: input.projectId } } : {}),
    });
    if (!decision.allowed) {
      return denied('CAPABILITY_DENIED', 403, '管理员权限判定失败。');
    }
    return {
      actorUserId: actor.id,
      session,
      projectRole: input.projectId ? 'owner' : null,
      decision,
      localSystemAdmin: false,
    };
  }

  const projectRole = definition.scope === 'project'
    ? await dependencies.getProjectRole(actor.id, input.projectId!)
    : null;
  if (definition.scope === 'project' && !projectRole) {
    return denied('PROJECT_NOT_FOUND', 404, '项目不存在或当前用户无权访问。');
  }

  let policy: ResolvedPermissionPolicy;
  try {
    policy = await dependencies.repository.resolvePolicy({
      userId: actor.id,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    });
  } catch {
    return denied('PERMISSION_POLICY_UNAVAILABLE', 403, '无法确认当前用户的能力权限。');
  }

  const decision = evaluatePermission({
    action: input.action,
    actor,
    policy,
    ...(input.projectId ? { project: { id: input.projectId, role: projectRole } } : {}),
  });
  if (!decision.allowed) {
    return denied('CAPABILITY_DENIED', 403, '当前用户缺少执行此操作所需的能力权限。');
  }

  return {
    actorUserId: actor.id,
    session,
    projectRole,
    decision,
    localSystemAdmin: false,
  };
}
