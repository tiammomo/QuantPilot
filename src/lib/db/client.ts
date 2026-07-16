import { PrismaClient } from '@prisma/client';
import { MOAGENT_SCHEMA_CONTRACT_VERSION } from '@/lib/db/moagent-schema-readiness';

// Prisma Client singleton pattern for Next.js
// Prevents multiple instances in development (hot reload)

const PRISMA_CLIENT_CONTRACT = `${MOAGENT_SCHEMA_CONTRACT_VERSION}:access-quota-management-v3`;
const globalForPrisma = global as unknown as {
  prisma?: PrismaClient;
  prismaClientContract?: string;
};
const reusableClient =
  globalForPrisma.prisma &&
  globalForPrisma.prismaClientContract === PRISMA_CLIENT_CONTRACT
    ? globalForPrisma.prisma
    : null;

export const prisma =
  reusableClient ||
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development' && process.env.PRISMA_QUERY_LOG === '1'
        ? ['query', 'error', 'warn']
        : ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') {
  if (globalForPrisma.prisma && globalForPrisma.prisma !== prisma) {
    void globalForPrisma.prisma.$disconnect().catch(() => undefined);
  }
  globalForPrisma.prisma = prisma;
  globalForPrisma.prismaClientContract = PRISMA_CLIENT_CONTRACT;
}
