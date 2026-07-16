import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import {
  buildServiceDependencyEdges,
  getResolvedServiceCatalog,
  validateServiceCatalog,
} from '@/lib/platform/service-catalog';

export async function GET(request: Request) {
  try {
    await requireAction({
      headers: request.headers,
      action: 'platform.observability.read',
    });
    const services = getResolvedServiceCatalog();
    const validation = validateServiceCatalog();
    const response = NextResponse.json(
      {
        success: validation.ok,
        data: {
          version: 1,
          services,
          dependencies: buildServiceDependencyEdges(services),
          validation,
        },
        error: validation.errors[0] ?? null,
      },
      { status: validation.ok ? 200 : 500 }
    );
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    return NextResponse.json(
      { success: false, error: 'Failed to resolve service catalog' },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
