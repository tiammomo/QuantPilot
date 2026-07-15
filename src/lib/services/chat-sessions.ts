import { prisma } from '@/lib/db/client';

const MOAGENT_RUNTIME_ID = 'moagent';

/**
 * Compatibility query for old API consumers. MoAgent does not create Session
 * rows; filtering by cliType guarantees historical Claude rows can never be
 * mistaken for a current MoAgent run.
 */
export async function getActiveSession(projectId: string) {
  const session = await prisma.session.findFirst({
    where: {
      projectId,
      cliType: MOAGENT_RUNTIME_ID,
      status: { in: ['active', 'running'] },
    },
    orderBy: { createdAt: 'desc' },
  });

  return session;
}

export async function getSessionById(projectId: string, sessionId: string) {
  return prisma.session.findFirst({
    where: {
      projectId,
      id: sessionId,
      cliType: MOAGENT_RUNTIME_ID,
    },
  });
}
