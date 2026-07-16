import { NextResponse } from 'next/server';

import { AuthorizationError } from '@/lib/auth/authorization';

export function authErrorResponse(error: unknown): NextResponse {
  if (error instanceof AuthorizationError) {
    return NextResponse.json(
      { success: false, error: error.code, message: error.message },
      { status: error.status },
    );
  }
  const message = error instanceof Error ? error.message : 'Unknown error';
  return NextResponse.json(
    { success: false, error: 'AUTH_OPERATION_FAILED', message },
    { status: 400 },
  );
}
