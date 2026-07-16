import { createHash } from 'node:crypto';

import { toNextJsHandler } from 'better-auth/next-js';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth/server';
import { getAuthSession } from '@/lib/auth/access';
import { writeAuthAuditEvent } from '@/lib/auth/audit';
import { getProjectAuthConfig } from '@/lib/config/auth';
import { prisma } from '@/lib/db/client';

const handlers = toNextJsHandler(auth);

function disabledResponse() {
  return NextResponse.json(
    { error: 'AUTH_DISABLED', message: 'QuantPilot 登录能力当前未启用。' },
    { status: 404 },
  );
}

export function GET(request: NextRequest) {
  if (!getProjectAuthConfig().enabled) return disabledResponse();
  return handlers.GET(request);
}

function digestIdentity(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex').slice(0, 20);
}

export async function POST(request: NextRequest) {
  if (!getProjectAuthConfig().enabled) return disabledResponse();
  const pathname = request.nextUrl.pathname;
  const isSignIn = pathname.endsWith('/sign-in/email');
  const isSignOut = pathname.endsWith('/sign-out');
  const currentSession = isSignOut ? await getAuthSession(request.headers) : null;
  const signInBody = isSignIn
    ? await request.clone().json().catch(() => ({})) as { email?: unknown }
    : null;
  const email = typeof signInBody?.email === 'string' ? signInBody.email.trim().toLowerCase() : '';
  const response = await handlers.POST(request);

  if (isSignIn) {
    const user = email
      ? await prisma.authUser.findUnique({ where: { email }, select: { id: true } })
      : null;
    if (response.ok && user) {
      void prisma.authUser.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      }).catch((error) => {
        console.error('[Auth] Failed to update last login timestamp:', error);
      });
    }
    void writeAuthAuditEvent({
      actorUserId: response.ok ? user?.id : null,
      eventType: response.ok ? 'authentication.login_success' : 'authentication.login_failure',
      targetType: 'user_identity',
      targetId: email ? digestIdentity(email) : null,
      outcome: response.ok ? 'success' : 'failure',
      headers: request.headers,
      metadata: { status: response.status },
    });
  } else if (isSignOut) {
    void writeAuthAuditEvent({
      actorUserId: currentSession?.user.id,
      eventType: 'authentication.logout',
      targetType: 'session',
      targetId: currentSession?.session.id,
      outcome: response.ok ? 'success' : 'failure',
      headers: request.headers,
    });
  }
  return response;
}
