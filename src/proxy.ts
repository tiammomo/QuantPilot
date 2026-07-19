import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getAuthSession } from '@/lib/auth/access';
import { writeAuthAuditEvent } from '@/lib/auth/audit';
import { authorizeApplicationRequest } from '@/lib/auth/authorization';
import { getProjectAuthConfig, isPublicAuthPath } from '@/lib/config/auth';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PUBLIC_BRAND_ASSET_PATHS = new Set([
  '/apple-touch-icon.png',
  '/favicon-16.png',
  '/favicon-32.png',
  '/favicon.png',
  '/icon.svg',
  '/manifest.webmanifest',
  '/quantpilot-mark.svg',
  '/QuantPilot_Icon.png',
]);

function isPublicBrandAssetPath(pathname: string): boolean {
  return PUBLIC_BRAND_ASSET_PATHS.has(pathname) || /^\/icons\/quantpilot-(?:192|512)\.png$/.test(pathname);
}

function loginRedirect(request: NextRequest): NextResponse {
  const login = new URL('/login', request.url);
  const next = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  if (next !== '/') login.searchParams.set('next', next);
  return NextResponse.redirect(login);
}

function isSameOriginMutation(request: NextRequest): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
  const origin = request.headers.get('origin');
  if (origin) {
    const trustedOrigins = getProjectAuthConfig().trustedOrigins;
    if (trustedOrigins.includes(origin)) return true;
    const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
    const host = forwardedHost || request.headers.get('host')?.trim();
    const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
    const protocol = forwardedProto || request.nextUrl.protocol.replace(':', '');
    const requestOrigin = host ? `${protocol}://${host}` : request.nextUrl.origin;
    return origin === request.nextUrl.origin || origin === requestOrigin;
  }
  return request.headers.get('x-quantpilot-request') === 'same-origin';
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (isPublicBrandAssetPath(pathname)) return NextResponse.next();

  const config = getProjectAuthConfig();
  if (!config.enabled) return NextResponse.next();

  if (pathname !== '/login' && isPublicAuthPath(pathname, config)) {
    return NextResponse.next();
  }

  const session = await getAuthSession(request.headers);

  if (pathname === '/login') {
    return session ? NextResponse.redirect(new URL('/', request.url)) : NextResponse.next();
  }

  if (!session) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: 'AUTHENTICATION_REQUIRED', message: '请先登录 QuantPilot。' },
        { status: 401 },
      );
    }
    return loginRedirect(request);
  }

  const authorization = await authorizeApplicationRequest(
    session,
    pathname,
    request.method,
  );
  if (!authorization.allowed) {
    void writeAuthAuditEvent({
      actorUserId: session.user.id,
      eventType: 'authorization.denied',
      targetType: authorization.projectId ? 'project' : 'route',
      targetId: authorization.projectId ?? pathname,
      outcome: 'denied',
      headers: request.headers,
      metadata: {
        code: authorization.code ?? 'FORBIDDEN',
        method: request.method,
        requiredProjectRole: authorization.requiredProjectRole ?? null,
      },
    });
    if (authorization.code === 'PASSWORD_CHANGE_REQUIRED' && !pathname.startsWith('/api/')) {
      return NextResponse.redirect(new URL('/account/security?required=1', request.url));
    }
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        {
          error: authorization.code ?? 'FORBIDDEN',
          message: authorization.message ?? '当前用户无权执行该操作。',
        },
        { status: authorization.status ?? 403 },
      );
    }
    return NextResponse.rewrite(new URL('/forbidden', request.url), {
      status: authorization.status === 404 ? 404 : 403,
    });
  }

  if (pathname.startsWith('/api/') && !isSameOriginMutation(request)) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST_ORIGIN', message: '请求来源校验失败。' },
      { status: 403 },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|generated/quantpilot-tailwind.css).*)',
  ],
};
