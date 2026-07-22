/**
 * Messages API Route
 * GET /api/chat/[project_id]/messages - Get message history
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { projectRouteAction } from '@/lib/auth/project-route-action';
import {
  getMessagesByProjectId,
  getMessagesByProjectIdAfter,
  createMessage,
  deleteMessagesByProjectId,
  getMessagesCountByProjectId,
} from '@/lib/services/message';
import type { CreateMessageInput } from '@/types/backend';
import { serializeMessages, serializeMessage } from '@/lib/serializers/chat';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

const createMessageSchema = z.object({
  content: z.string().trim().min(1).max(200_000),
  role: z.enum(['assistant', 'user', 'system', 'tool']).default('user'),
  messageType: z.enum(['chat', 'tool_use', 'tool_result', 'error', 'info', 'system']).optional(),
  conversationId: z.string().trim().min(1).max(256).optional(),
  cliSource: z.literal('moagent').optional(),
}).strict();

/**
 * GET /api/chat/[project_id]/messages
 * Get project message history
 */
export async function GET(
  request: NextRequest,
  { params }: RouteContext
) {
  try {
    const { project_id } = await params;
    await requireAction({
      headers: request.headers,
      action: projectRouteAction('chat-data', request.method),
      projectId: project_id,
    });
    const { searchParams } = new URL(request.url);
    const rawLimit = Number.parseInt(searchParams.get('limit') || '50', 10);
    const rawOffset = Number.parseInt(searchParams.get('offset') || '0', 10);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 500);
    const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);
    const after = searchParams.get('after');
    const afterId = searchParams.get('afterId') ?? undefined;

    if (after) {
      const afterCreatedAt = new Date(after);
      if (Number.isNaN(afterCreatedAt.getTime())) {
        return NextResponse.json(
          {
            success: false,
            error: 'Invalid after cursor',
          },
          { status: 400 }
        );
      }

      const [messages, totalCount] = await Promise.all([
        getMessagesByProjectIdAfter(project_id, afterCreatedAt, afterId, limit),
        getMessagesCountByProjectId(project_id),
      ]);
      const serialized = serializeMessages(messages);
      const latest = serialized[serialized.length - 1] ?? null;

      const res = NextResponse.json({
        success: true,
        data: serialized,
        totalCount,
        pagination: {
          mode: 'incremental',
          limit,
          offset: null,
          count: serialized.length,
          hasMore: serialized.length === limit,
          cursor: latest
            ? {
                id: latest.id,
                createdAt: latest.createdAt,
              }
            : {
                id: afterId ?? null,
                createdAt: after,
              },
        },
      });
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }

    const [messages, totalCount] = await Promise.all([
      getMessagesByProjectId(project_id, limit, offset),
      getMessagesCountByProjectId(project_id),
    ]);
    const serialized = serializeMessages(messages);

    const res = NextResponse.json({
      success: true,
      data: serialized,
      totalCount,
      pagination: {
        limit,
        offset,
        count: serialized.length,
        hasMore: offset + serialized.length < totalCount,
      },
    });
    res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to get messages:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch messages',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/chat/[project_id]/messages
 * Create new message (for system/user logging)
 */
export async function POST(
  request: NextRequest,
  { params }: RouteContext
) {
  try {
    const { project_id } = await params;
    await requireAction({
      headers: request.headers,
      action: projectRouteAction('chat-data', request.method),
      projectId: project_id,
    });
    const payload = createMessageSchema.parse(await request.json());
    const messageType: CreateMessageInput['messageType'] =
      payload.messageType ?? (payload.role === 'system' ? 'info' : 'chat');

    const input: CreateMessageInput = {
      projectId: project_id,
      role: payload.role,
      messageType,
      content: payload.content,
      conversationId: payload.conversationId,
      cliSource: payload.cliSource,
    };

    const message = await createMessage(input);
    const res = NextResponse.json({ success: true, data: serializeMessage(message) }, { status: 201 });
    res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: 'INVALID_MESSAGE_REQUEST', issues: error.issues },
        { status: 400 },
      );
    }
    console.error('[API] Failed to create message:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to create message',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/chat/[project_id]/messages
 * Delete all messages (optionally filter by conversation)
 */
export async function DELETE(
  request: NextRequest,
  { params }: RouteContext
) {
  try {
    const { project_id } = await params;
    await requireAction({
      headers: request.headers,
      action: projectRouteAction('chat-data', request.method),
      projectId: project_id,
    });
    const { searchParams } = new URL(request.url);
    const conversationId = searchParams.get('conversationId') ?? undefined;

    const deleted = await deleteMessagesByProjectId(project_id, conversationId || undefined);

    return NextResponse.json({
      success: true,
      deleted,
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to delete messages:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to delete messages',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}


// Force dynamic and Node runtime to avoid caching and ensure DB freshness
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
