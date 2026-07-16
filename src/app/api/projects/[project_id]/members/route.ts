import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { requireAction } from '@/lib/auth/action';
import { writeAuthAuditEvent } from '@/lib/auth/audit';
import { authErrorResponse } from '@/lib/auth/http';
import { projectRouteAction } from '@/lib/auth/project-route-action';
import { prisma } from '@/lib/db/client';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

const membershipSchema = z.object({
  email: z.string().trim().email().max(320),
  role: z.enum(['editor', 'viewer']),
}).strict();

const removeSchema = z.object({ userId: z.string().min(1) }).strict();

async function requireProjectMemberManager(request: NextRequest, projectId: string) {
  return requireAction({
    headers: request.headers,
    action: projectRouteAction('members', request.method),
    projectId,
  });
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    await requireProjectMemberManager(request, project_id);
    const project = await prisma.project.findUnique({
      where: { id: project_id },
      select: {
        ownerId: true,
        memberships: {
          select: {
            id: true,
            role: true,
            createdAt: true,
            user: { select: { id: true, name: true, email: true, banned: true } },
          },
          orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    if (!project) return NextResponse.json({ success: false, error: 'PROJECT_NOT_FOUND' }, { status: 404 });
    return NextResponse.json({ success: true, data: project });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const authorization = await requireProjectMemberManager(request, project_id);
    const input = membershipSchema.parse(await request.json());
    const user = await prisma.authUser.findUnique({
      where: { email: input.email.toLowerCase() },
      select: { id: true, banned: true },
    });
    if (!user || user.banned) {
      return NextResponse.json({ success: false, error: 'USER_NOT_AVAILABLE' }, { status: 404 });
    }
    const membership = await prisma.projectMembership.upsert({
      where: { projectId_userId: { projectId: project_id, userId: user.id } },
      create: { projectId: project_id, userId: user.id, role: input.role },
      update: { role: input.role },
    });
    await writeAuthAuditEvent({
      actorUserId: authorization.session?.user.id ?? null,
      eventType: 'project.member_updated',
      targetType: 'project_membership',
      targetId: membership.id,
      outcome: 'success',
      headers: request.headers,
      metadata: { projectId: project_id, role: input.role },
    });
    return NextResponse.json({ success: true, data: membership });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const authorization = await requireProjectMemberManager(request, project_id);
    const input = removeSchema.parse(await request.json());
    const project = await prisma.project.findUnique({ where: { id: project_id }, select: { ownerId: true } });
    if (project?.ownerId === input.userId) throw new Error('不能移除项目所有者。');
    const result = await prisma.projectMembership.deleteMany({
      where: { projectId: project_id, userId: input.userId, role: { not: 'owner' } },
    });
    await writeAuthAuditEvent({
      actorUserId: authorization.session?.user.id ?? null,
      eventType: 'project.member_removed',
      targetType: 'project',
      targetId: project_id,
      outcome: 'success',
      headers: request.headers,
      metadata: { removedUserId: input.userId, removedCount: result.count },
    });
    return NextResponse.json({ success: true, data: { removedCount: result.count } });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
