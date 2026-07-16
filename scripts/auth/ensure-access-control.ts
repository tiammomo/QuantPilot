import path from 'node:path';

import { Prisma, PrismaClient } from '@prisma/client';
import { config as loadEnv } from 'dotenv';

import { ACCESS_CONTROL_CATALOG } from '../../src/lib/auth/permissions';
import {
  DEFAULT_QUOTA_PROFILE,
  DEFAULT_QUOTA_RULES,
} from '../../src/lib/quota/defaults';
import { reconcileAllProjectsOwnedAllocationsInTransaction } from '../../src/lib/quota/allocation-reconciliation';

const root = process.cwd();
loadEnv({ path: path.join(root, '.env'), quiet: true });
loadEnv({ path: path.join(root, '.env.local'), override: true, quiet: true });

const prisma = new PrismaClient();

const MANAGED_PERMISSION_PROFILES = [
  {
    key: 'member-default',
    name: '标准研究员',
    description: '普通成员的标准研究能力。项目内的最终权限仍受 owner/editor/viewer 角色约束。',
    isDefault: true,
    rules: ACCESS_CONTROL_CATALOG.profiles['member-default'],
  },
  {
    key: 'readonly-default',
    name: '只读研究员',
    description: '只能读取已授权项目、源码、量化数据和研究报告。',
    isDefault: false,
    rules: ACCESS_CONTROL_CATALOG.profiles['readonly-default'],
  },
] as const;

async function synchronizePermissionProfile(
  transaction: Prisma.TransactionClient,
  definition: (typeof MANAGED_PERMISSION_PROFILES)[number],
): Promise<string> {
  const profile = await transaction.permissionProfile.upsert({
    where: { key: definition.key },
    create: {
      key: definition.key,
      name: definition.name,
      description: definition.description,
      isDefault: definition.isDefault,
    },
    update: {
      name: definition.name,
      description: definition.description,
      isDefault: definition.isDefault,
    },
    select: { id: true },
  });

  const desiredGrants = [
    ...definition.rules.allow.map((permissionKey) => ({ permissionKey, effect: 'allow' })),
    ...definition.rules.deny.map((permissionKey) => ({ permissionKey, effect: 'deny' })),
  ];
  const desiredKeys = desiredGrants.map((grant) => grant.permissionKey);

  await transaction.permissionProfileGrant.deleteMany({
    where: {
      profileId: profile.id,
      permissionKey: { notIn: desiredKeys },
    },
  });
  for (const grant of desiredGrants) {
    await transaction.permissionProfileGrant.upsert({
      where: {
        profileId_permissionKey: {
          profileId: profile.id,
          permissionKey: grant.permissionKey,
        },
      },
      create: {
        profileId: profile.id,
        permissionKey: grant.permissionKey,
        effect: grant.effect,
      },
      update: { effect: grant.effect },
    });
  }

  return profile.id;
}

async function ensureAccessControl(): Promise<{
  permissionProfiles: number;
  permissionGrants: number;
  quotaProfiles: number;
  quotaRules: number;
  membersAssignedPermissionProfile: number;
  membersAssignedQuotaProfile: number;
  administratorsUnbound: number;
  projectAllocations: {
    actors: number;
    reconciled: number;
    unchanged: number;
    skippedActiveReservations: number;
    expiredReservations: number;
  };
}> {
  return prisma.$transaction(async (transaction) => {
    // The database enforces at most one default profile. Clear an obsolete
    // default before promoting the built-in member profile.
    await transaction.permissionProfile.updateMany({
      where: {
        isDefault: true,
        key: { not: 'member-default' },
      },
      data: { isDefault: false },
    });

    const permissionProfileIds = new Map<string, string>();
    for (const definition of MANAGED_PERMISSION_PROFILES) {
      permissionProfileIds.set(
        definition.key,
        await synchronizePermissionProfile(transaction, definition),
      );
    }

    await transaction.quotaProfile.updateMany({
      where: {
        isDefault: true,
        key: { not: DEFAULT_QUOTA_PROFILE.key },
      },
      data: { isDefault: false },
    });
    const quotaProfile = await transaction.quotaProfile.upsert({
      where: { key: DEFAULT_QUOTA_PROFILE.key },
      create: {
        ...DEFAULT_QUOTA_PROFILE,
        isDefault: true,
      },
      update: {
        name: DEFAULT_QUOTA_PROFILE.name,
        description: DEFAULT_QUOTA_PROFILE.description,
        isDefault: true,
      },
      select: { id: true },
    });

    await transaction.quotaRule.deleteMany({
      where: {
        profileId: quotaProfile.id,
        metric: { notIn: DEFAULT_QUOTA_RULES.map((rule) => rule.metric) },
      },
    });
    for (const rule of DEFAULT_QUOTA_RULES) {
      await transaction.quotaRule.upsert({
        where: {
          profileId_metric: {
            profileId: quotaProfile.id,
            metric: rule.metric,
          },
        },
        create: {
          profileId: quotaProfile.id,
          ...rule,
        },
        update: {
          limit: rule.limit,
          enforcement: rule.enforcement,
          windowType: rule.windowType,
          windowSeconds: rule.windowSeconds,
          reservationTtlSeconds: rule.reservationTtlSeconds,
        },
      });
    }

    const memberPermissionAssignment = await transaction.authUser.updateMany({
      where: {
        role: 'member',
        permissionProfileId: null,
      },
      data: { permissionProfileId: permissionProfileIds.get('member-default')! },
    });
    const memberQuotaAssignment = await transaction.authUser.updateMany({
      where: {
        role: 'member',
        quotaProfileId: null,
      },
      data: { quotaProfileId: quotaProfile.id },
    });
    const administratorUnbinding = await transaction.authUser.updateMany({
      where: {
        role: 'admin',
        OR: [
          { permissionProfileId: { not: null } },
          { quotaProfileId: { not: null } },
        ],
      },
      data: {
        permissionProfileId: null,
        quotaProfileId: null,
      },
    });
    const projectAllocations = await reconcileAllProjectsOwnedAllocationsInTransaction(
      transaction,
      { trigger: 'ensure-access-control' },
    );

    return {
      permissionProfiles: MANAGED_PERMISSION_PROFILES.length,
      permissionGrants: MANAGED_PERMISSION_PROFILES.reduce(
        (total, profile) => total + profile.rules.allow.length + profile.rules.deny.length,
        0,
      ),
      quotaProfiles: 1,
      quotaRules: DEFAULT_QUOTA_RULES.length,
      membersAssignedPermissionProfile: memberPermissionAssignment.count,
      membersAssignedQuotaProfile: memberQuotaAssignment.count,
      administratorsUnbound: administratorUnbinding.count,
      projectAllocations,
    };
  }, {
    maxWait: 10_000,
    timeout: 30_000,
  });
}

ensureAccessControl()
  .then((result) => {
    console.log(`[access-control] ready ${JSON.stringify(result)}`);
  })
  .catch((error) => {
    console.error(
      '[access-control] bootstrap failed:',
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
