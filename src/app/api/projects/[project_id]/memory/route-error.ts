import { NextResponse } from 'next/server';

import { ExternalMemoryHttpError, MemoryIntegrationError } from '@/lib/platform/memory';

export function memoryRouteError(error: unknown): NextResponse {
  if (error instanceof MemoryIntegrationError) {
    return NextResponse.json(
      { success: false, error: error.code, message: error.message },
      { status: error.status },
    );
  }
  if (error instanceof ExternalMemoryHttpError) {
    const passthrough = error.status && [400, 404, 409, 422].includes(error.status)
      ? error.status
      : 502;
    return NextResponse.json(
      { success: false, error: error.code, requestId: error.requestId },
      { status: passthrough },
    );
  }
  console.error('[PersonalMemory API] Unexpected integration failure.', {
    name: error instanceof Error ? error.name : 'UnknownError',
  });
  return NextResponse.json(
    { success: false, error: 'MEMORY_INTEGRATION_ERROR' },
    { status: 500 },
  );
}
