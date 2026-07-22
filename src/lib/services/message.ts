/**
 * Message Service - Message processing logic
 */

import { prisma } from '@/lib/db/client';
import type { Message, CreateMessageInput } from '@/types/backend';
import type { Message as PrismaMessage } from '@prisma/client';

function mapPrismaMessage(message: PrismaMessage): Message {
  const updatedAt =
    (message as unknown as { updatedAt?: Date }).updatedAt ?? message.createdAt;

  // Access requestId directly from message (Prisma Client should include it after regeneration)
  const requestId = (message as any).requestId ?? null;

  return {
    id: message.id,
    projectId: message.projectId,
    conversationId: message.conversationId ?? null,
    role: message.role as Message['role'],
    content: message.content,
    messageType: message.messageType as Message['messageType'],
    metadataJson: message.metadataJson ?? null,
    parentMessageId: message.parentMessageId ?? null,
    cliSource: message.cliSource ?? null,
    createdAt: message.createdAt,
    updatedAt,
    requestId,
  };
}

export function isRuntimeOnlyChatProjection(
  message: Pick<Message, 'role' | 'metadataJson'>,
): boolean {
  if (message.role !== 'assistant' || !message.metadataJson) return false;
  try {
    const metadata = JSON.parse(message.metadataJson) as Record<string, unknown>;
    if (
      metadata.hidden_from_ui === true ||
      metadata.isMissionIntermediate === true ||
      metadata.isMoAgentIntermediateTurn === true
    ) return true;
    return metadata.isWorkspaceProgress === true && metadata.isMoAgentFinal !== true;
  } catch {
    return false;
  }
}

/**
 * Retrieve project messages (with pagination)
 */
export async function getMessagesByProjectId(
  projectId: string,
  limit: number = 50,
  offset: number = 0
): Promise<Message[]> {
  const messages = await prisma.message.findMany({
    where: { projectId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    skip: offset,
    take: limit,
  });

  return messages.map(mapPrismaMessage);
}

/**
 * Return a bounded, chronological chat window for MoAgent context rebuilds.
 * Tool payloads and internal reasoning are deliberately excluded here; exact
 * tool-call state only lives inside the active run.
 */
export async function getRecentChatMessagesByProjectId(
  projectId: string,
  limit: number = 16,
): Promise<Message[]> {
  const safeLimit = Math.min(50, Math.max(1, Math.floor(limit)));
  const messages = await prisma.message.findMany({
    where: {
      projectId,
      messageType: 'chat',
      role: { in: ['user', 'assistant'] },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    // Progress/tool narration can outnumber real conversation turns. Scan a
    // bounded wider window, remove runtime-only projections, then apply the
    // requested conversation limit so progress never evicts user context.
    take: Math.min(250, safeLimit * 8),
  });

  return messages
    .map(mapPrismaMessage)
    .filter((message) => !isRuntimeOnlyChatProjection(message))
    .slice(0, safeLimit)
    .reverse();
}

/**
 * 按游标增量获取项目消息，用于实时通道断线后的轻量补漏。
 */
export async function getMessagesByProjectIdAfter(
  projectId: string,
  afterCreatedAt: Date,
  afterId?: string,
  limit: number = 100
): Promise<Message[]> {
  const messages = await prisma.message.findMany({
    where: {
      projectId,
      OR: [
        { createdAt: { gt: afterCreatedAt } },
        ...(afterId
          ? [
              {
                createdAt: afterCreatedAt,
                id: { gt: afterId },
              },
            ]
          : []),
      ],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
  });

  return messages.map(mapPrismaMessage);
}

/**
 * Create new message
 */
export async function createMessage(input: CreateMessageInput): Promise<Message> {
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : undefined;
  const metadataLength = metadataJson ? metadataJson.length : 0;
  let lastError: Error | null = null;

  console.log('[MessageService] Creating message with metadata:', {
    messageId: input.id,
    projectId: input.projectId,
    role: input.role,
    hasMetadata: !!input.metadata,
    metadataKeys: input.metadata ? Object.keys(input.metadata) : [],
    metadataJsonLength: metadataLength,
  });

  // Retry logic with exponential backoff for database operations
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const message = await prisma.message.create({
        data: {
          ...(input.id ? { id: input.id } : {}),
          projectId: input.projectId,
          role: input.role,
          messageType: input.messageType,
          content: input.content,
          metadataJson,
          conversationId: input.conversationId,
          cliSource: input.cliSource,
          requestId: input.requestId,
        },
      });

      console.log(`[MessageService] Created message: ${message.id} (${input.role})${input.requestId ? ` [requestId: ${input.requestId}]` : ''} on attempt ${attempt}`);
      console.log('[MessageService] Stored metadataJson length:', metadataLength);

      const mappedMessage = mapPrismaMessage(message);
      const mappedMetadataLength = mappedMessage.metadataJson ? mappedMessage.metadataJson.length : 0;
      console.log('[MessageService] Mapped message metadata:', {
        hasMetadataJson: mappedMetadataLength > 0,
        metadataJsonLength: mappedMetadataLength,
      });

      return mappedMessage;
    } catch (error) {
      lastError = error as Error;
      console.error(`[MessageService] Attempt ${attempt} failed to create message:`, error);

      if (attempt < 3) {
        // Exponential backoff: 200ms, 400ms
        const delayMs = Math.pow(2, attempt) * 100;
        console.log(`[MessageService] Retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  // All retries failed
  console.error('[MessageService] All retry attempts failed to create message:', lastError);
  throw lastError || new Error('Failed to create message after 3 attempts');
}

/**
 * Persist a platform projection exactly once under a caller-owned stable ID.
 * Retries and route re-entry return the original row instead of duplicating a
 * user-visible lifecycle message.
 */
export async function ensureMessage(
  input: CreateMessageInput & { id: string },
): Promise<Message> {
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : undefined;
  const message = await prisma.message.upsert({
    where: { id: input.id },
    update: {},
    create: {
      id: input.id,
      projectId: input.projectId,
      role: input.role,
      messageType: input.messageType,
      content: input.content,
      metadataJson,
      conversationId: input.conversationId,
      cliSource: input.cliSource,
      requestId: input.requestId,
    },
  });
  if (
    message.projectId !== input.projectId ||
    message.requestId !== (input.requestId ?? null) ||
    message.role !== input.role ||
    message.messageType !== input.messageType
  ) {
    throw new Error(`Stable message ID collision: ${input.id}`);
  }
  return mapPrismaMessage(message);
}

/**
 * Get total count of messages for a project
 */
export async function getMessagesCountByProjectId(projectId: string): Promise<number> {
  const count = await prisma.message.count({
    where: { projectId },
  });

  return count;
}

/**
 * Delete all project messages
 */
export async function deleteMessagesByProjectId(projectId: string, conversationId?: string): Promise<number> {
  const result = await prisma.message.deleteMany({
    where: {
      projectId,
      ...(conversationId ? { conversationId } : {}),
    },
  });
  const scopeLabel = conversationId ? ` (conversation ${conversationId})` : '';
  console.log(`[MessageService] Deleted ${result.count} messages for project: ${projectId}${scopeLabel}`);
  return result.count;
}
