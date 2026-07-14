import { timingSafeEqual } from 'node:crypto';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class PrivilegedRequestError extends Error {
  constructor(message: string, readonly status: 401 | 403) {
    super(message);
    this.name = 'PrivilegedRequestError';
  }
}

function hostname(value: string | null): string {
  if (!value) return '';
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function tokenMatches(expected: string, provided: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requestToken(request: Request): string {
  const direct = request.headers.get('x-quantpilot-admin-token')?.trim();
  if (direct) return direct;
  const authorization = request.headers.get('authorization')?.trim() ?? '';
  return authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice('bearer '.length).trim()
    : '';
}

function effectiveRequestOrigin(request: Request, requestUrl: URL): string {
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwardedHost || request.headers.get('host')?.trim() || requestUrl.host;
  const forwardedProtocol = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const protocol = forwardedProtocol || requestUrl.protocol.replace(/:$/, '');
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return requestUrl.origin;
  }
}

/**
 * Protects host-level mutation APIs without making local-first development painful.
 *
 * - Cross-origin browser requests are always rejected.
 * - When an admin token is configured it is always required.
 * - Without a token only a loopback request is accepted in non-strict development.
 * - Production and strict degradation mode fail closed.
 */
export function assertPrivilegedMutation(request: Request): void {
  const requestUrl = new URL(request.url);
  const effectiveOrigin = effectiveRequestOrigin(request, requestUrl);
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');

  if (fetchSite === 'cross-site') {
    throw new PrivilegedRequestError('拒绝跨站管理请求。', 403);
  }
  if (origin) {
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      throw new PrivilegedRequestError('请求 Origin 无效。', 403);
    }
    // Next.js may normalize Request.url to NEXT_PUBLIC_APP_URL while retaining
    // the browser-facing authority in Host/X-Forwarded-Host. Compare against
    // that effective authority so a page opened through 127.0.0.1 is not
    // mistaken for a cross-origin request merely because the configured URL
    // uses localhost.
    if (originUrl.origin !== effectiveOrigin) {
      throw new PrivilegedRequestError('管理请求必须来自同源页面。', 403);
    }
  }

  const expected = process.env.QUANTPILOT_ADMIN_TOKEN?.trim() ?? '';
  const provided = requestToken(request);
  if (expected) {
    if (!provided || !tokenMatches(expected, provided)) {
      throw new PrivilegedRequestError('缺少有效的 QuantPilot 管理令牌。', 401);
    }
    return;
  }

  const strict = process.env.NODE_ENV === 'production' || process.env.QUANTPILOT_DEGRADATION_MODE === 'strict';
  const forwardedHost = request.headers.get('x-forwarded-host');
  const host = forwardedHost || request.headers.get('host');
  const loopback = LOOPBACK_HOSTS.has(requestUrl.hostname.toLowerCase()) && LOOPBACK_HOSTS.has(hostname(host));
  if (strict || !loopback) {
    throw new PrivilegedRequestError('管理接口未配置 QUANTPILOT_ADMIN_TOKEN，已拒绝非本机写入。', 403);
  }
}
