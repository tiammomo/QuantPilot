import type { ProjectAuthSession } from '@/lib/auth/server';

import { getAuthSession } from '@/lib/auth/access';
import { getProjectAuthConfig } from '@/lib/config/auth';
import { prisma } from '@/lib/db/client';

export type PlatformRole = 'admin' | 'member';
export type ProjectRole = 'owner' | 'editor' | 'viewer';

const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

const ADMIN_ONLY_API_PREFIXES = [
  '/api/admin',
];

const PASSWORD_CHANGE_PATHS = new Set([
  '/account/security',
  '/api/account/password',
  '/api/account/sessions',
  '/api/health',
]);

export class AuthorizationError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 401 | 403 | 404 | 428,
    message: string,
  ) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export interface AuthorizationDecision {
  allowed: boolean;
  status?: 403 | 404 | 428;
  code?: string;
  message?: string;
  projectId?: string;
  requiredProjectRole?: ProjectRole;
}

export function platformRole(value: unknown): PlatformRole {
  return value === 'admin' ? 'admin' : 'member';
}

export function isPlatformAdmin(user: { role?: unknown }): boolean {
  return platformRole(user.role) === 'admin';
}

export function isActiveBan(user: {
  banned?: unknown;
  banExpires?: unknown;
}): boolean {
  if (user.banned !== true) return false;
  if (!user.banExpires) return true;
  const expires = new Date(user.banExpires as string | number | Date);
  return Number.isNaN(expires.valueOf()) || expires.getTime() > Date.now();
}

function decoded(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function projectIdFromPath(pathname: string): string | null {
  const apiMatch = pathname.match(/^\/api\/(?:assets|chat|env|projects|repo|ws)\/([^/]+)/);
  if (apiMatch) return decoded(apiMatch[1]);
  const chatPageMatch = pathname.match(/^\/([^/]+)\/chat(?:\/|$)/);
  return decoded(chatPageMatch?.[1]);
}

export function requiredProjectRole(pathname: string, method: string): ProjectRole {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD' || normalizedMethod === 'OPTIONS') {
    return 'viewer';
  }
  if (
    normalizedMethod === 'DELETE' ||
    /\/api\/projects\/[^/]+\/(?:github|services|supabase|vercel)(?:\/|$)/.test(pathname)
  ) {
    return 'owner';
  }
  return 'editor';
}

export async function projectRoleForUser(
  userId: string,
  projectId: string,
): Promise<ProjectRole | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      ownerId: true,
      memberships: {
        where: { userId },
        select: { role: true },
        take: 1,
      },
    },
  });
  if (!project) return null;
  if (project.ownerId === userId) return 'owner';
  const role = project.memberships[0]?.role;
  return role === 'owner' || role === 'editor' || role === 'viewer' ? role : null;
}

export async function authorizeProject(
  session: ProjectAuthSession,
  projectId: string,
  requiredRole: ProjectRole,
): Promise<AuthorizationDecision> {
  if (isPlatformAdmin(session.user)) return { allowed: true, projectId, requiredProjectRole: requiredRole };
  const actualRole = await projectRoleForUser(session.user.id, projectId);
  if (!actualRole || PROJECT_ROLE_RANK[actualRole] < PROJECT_ROLE_RANK[requiredRole]) {
    return {
      allowed: false,
      status: 404,
      code: 'PROJECT_NOT_FOUND',
      message: '项目不存在或当前用户无权访问。',
      projectId,
      requiredProjectRole: requiredRole,
    };
  }
  return { allowed: true, projectId, requiredProjectRole: requiredRole };
}

export async function authorizeApplicationRequest(
  session: ProjectAuthSession,
  pathname: string,
  method: string,
): Promise<AuthorizationDecision> {
  if (isActiveBan(session.user)) {
    return { allowed: false, status: 403, code: 'ACCOUNT_DISABLED', message: '账号已被停用。' };
  }

  if (
    session.user.mustChangePassword === true &&
    !PASSWORD_CHANGE_PATHS.has(pathname) &&
    !pathname.startsWith('/api/auth/')
  ) {
    return {
      allowed: false,
      status: 428,
      code: 'PASSWORD_CHANGE_REQUIRED',
      message: '首次登录必须先修改密码。',
    };
  }

  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    return isPlatformAdmin(session.user)
      ? { allowed: true }
      : { allowed: false, status: 403, code: 'ADMIN_REQUIRED', message: '需要管理员权限。' };
  }

  const projectId = projectIdFromPath(pathname);
  // API handlers enforce the typed capability + project-role intersection at
  // their service boundary. A method-only proxy guess (for example treating
  // every DELETE as owner-only) would incorrectly block editor operations
  // such as deleting a source file. Page navigation still gets an early
  // membership check before rendering project data.
  if (projectId && !pathname.startsWith('/api/')) {
    return authorizeProject(session, projectId, requiredProjectRole(pathname, method));
  }

  const adminOnly = ADMIN_ONLY_API_PREFIXES.some((prefix) =>
    pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  if (adminOnly && !isPlatformAdmin(session.user)) {
    return { allowed: false, status: 403, code: 'ADMIN_REQUIRED', message: '需要管理员权限。' };
  }
  return { allowed: true };
}

export async function requireAuthSession(headers: Headers): Promise<ProjectAuthSession> {
  if (!getProjectAuthConfig().enabled) {
    throw new AuthorizationError('AUTH_DISABLED', 401, '登录能力当前未启用。');
  }
  const session = await getAuthSession(headers);
  if (!session) throw new AuthorizationError('AUTHENTICATION_REQUIRED', 401, '请先登录。');
  if (isActiveBan(session.user)) throw new AuthorizationError('ACCOUNT_DISABLED', 403, '账号已被停用。');
  return session;
}

export async function requireAdminSession(
  headers: Headers,
  options: { fresh?: boolean } = {},
): Promise<ProjectAuthSession> {
  const session = await requireAuthSession(headers);
  if (!isPlatformAdmin(session.user)) {
    throw new AuthorizationError('ADMIN_REQUIRED', 403, '需要管理员权限。');
  }
  if (session.user.mustChangePassword === true) {
    throw new AuthorizationError('PASSWORD_CHANGE_REQUIRED', 428, '请先修改初始密码。');
  }
  if (options.fresh) {
    const freshAge = getProjectAuthConfig().session.freshAgeSeconds * 1_000;
    const createdAt = new Date(session.session.createdAt).getTime();
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > freshAge) {
      throw new AuthorizationError('FRESH_SESSION_REQUIRED', 403, '敏感操作需要重新登录。');
    }
  }
  return session;
}
