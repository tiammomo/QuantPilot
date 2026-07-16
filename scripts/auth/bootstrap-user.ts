import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { config as loadEnv } from 'dotenv';

import { hashAuthPassword, validateAuthPassword } from '../../src/lib/auth/password';
import {
  getDevelopmentAdminDefaults,
  getProjectAuthConfig,
  getProjectAuthSecret,
} from '../../src/lib/config/auth';
import { reconcileProjectsOwnedAllocation } from '../../src/lib/quota/allocation-reconciliation';

const root = process.cwd();
loadEnv({ path: path.join(root, '.env'), quiet: true });
loadEnv({ path: path.join(root, '.env.local'), override: true, quiet: true });

const prisma = new PrismaClient();

async function main() {
  const config = getProjectAuthConfig();
  if (!config.enabled) {
    throw new Error('请先设置 QUANTPILOT_AUTH_MODE=local，再初始化管理员。');
  }
  getProjectAuthSecret(config);

  const configuredEmail = process.env[config.bootstrap.emailEnv]?.trim().toLowerCase() || '';
  const configuredPassword = process.env[config.bootstrap.passwordEnv] ?? '';
  const defaults = getDevelopmentAdminDefaults(config);
  const hasPartialCredentials = Boolean(configuredEmail) !== Boolean(configuredPassword);
  if (hasPartialCredentials) {
    throw new Error(
      `${config.bootstrap.emailEnv} 与 ${config.bootstrap.passwordEnv} 必须同时配置。`,
    );
  }
  const usesDevelopmentDefaults = !configuredEmail && !configuredPassword && Boolean(defaults);
  const email = configuredEmail || defaults?.email || '';
  const password = configuredPassword || defaults?.password || '';
  const name = process.env[config.bootstrap.nameEnv]?.trim() || defaults?.name || 'QuantPilot 管理员';

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    throw new Error(
      `生产/strict 或非本机环境必须显式配置 ${config.bootstrap.emailEnv} 与 ${config.bootstrap.passwordEnv}。`,
    );
  }
  const passwordError = validateAuthPassword(password);
  if (passwordError && !usesDevelopmentDefaults) throw new Error(passwordError);

  const existing = await prisma.authUser.findUnique({ where: { email } });
  const userId = existing?.id ?? randomUUID();
  const passwordHash = await hashAuthPassword(
    password,
    usesDevelopmentDefaults ? { allowDevelopmentDefault: true } : undefined,
  );
  const now = new Date();

  const projectAllocation = await prisma.$transaction(async (transaction) => {
    await transaction.authUser.upsert({
      where: { email },
      create: {
        id: userId,
        email,
        name,
        role: 'admin',
        emailVerified: true,
        banned: false,
        mustChangePassword: false,
        passwordChangedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        name,
        role: 'admin',
        emailVerified: true,
        banned: false,
        banReason: null,
        banExpires: null,
        mustChangePassword: false,
        passwordChangedAt: now,
        permissionProfileId: null,
        quotaProfileId: null,
        accessVersion: { increment: 1 },
        updatedAt: now,
      },
    });
    await transaction.authAccount.upsert({
      where: {
        providerId_accountId: {
          providerId: 'credential',
          accountId: userId,
        },
      },
      create: {
        id: randomUUID(),
        providerId: 'credential',
        accountId: userId,
        userId,
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        password: passwordHash,
        updatedAt: now,
      },
    });
    await transaction.authSession.deleteMany({ where: { userId } });
    await transaction.userPermissionOverride.deleteMany({ where: { userId } });
    await transaction.userQuotaOverride.deleteMany({ where: { userId } });

    await transaction.project.updateMany({
      where: { ownerId: null },
      data: { ownerId: userId },
    });
    const ownedProjects = await transaction.project.findMany({
      where: { ownerId: userId },
      select: { id: true },
    });
    if (ownedProjects.length > 0) {
      await transaction.projectMembership.createMany({
        data: ownedProjects.map((project) => ({
          id: randomUUID(),
          projectId: project.id,
          userId,
          role: 'owner',
          updatedAt: now,
        })),
        skipDuplicates: true,
      });
    }
    const allocation = await reconcileProjectsOwnedAllocation(transaction, userId, {
      now,
      trigger: 'administrator-bootstrap',
    });
    await transaction.authAuditEvent.create({
      data: {
        actorUserId: userId,
        eventType: 'user.bootstrap',
        targetType: 'user',
        targetId: userId,
        outcome: 'success',
        metadata: {
          usedDevelopmentDefaults: usesDevelopmentDefaults,
          passwordChanged: true,
          claimedProjects: ownedProjects.length,
          projectAllocation: {
            status: allocation.status,
            authoritativeUsed: allocation.authoritativeUsed.toString(),
            currentUsed: allocation.currentUsed.toString(),
            activeReservations: allocation.activeReservations,
          },
        },
      },
    });
    return allocation;
  });

  console.log(
    usesDevelopmentDefaults
      ? `本地默认管理员已就绪：${defaults?.login} / ${defaults?.password}（无需首次改密）`
      : `管理员已初始化：${email}（旧会话已撤销）`,
  );
  console.log(
    `[auth-bootstrap] projects.owned ${projectAllocation.status} `
      + `(used=${projectAllocation.currentUsed}, authoritative=${projectAllocation.authoritativeUsed})`,
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
