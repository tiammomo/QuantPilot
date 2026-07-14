import { NextResponse } from 'next/server';

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly expose: boolean;

  constructor(status: number, code: string, message: string, options: { expose?: boolean } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.expose = options.expose ?? status < 500;
  }
}

export function createSuccessResponse<T>(data: T, status = 200): NextResponse<ApiResponse<T>> {
  return NextResponse.json({ success: true, data }, { status });
}

export function createErrorResponse<T = never>(
  error: string,
  message?: string,
  status = 500,
): NextResponse<ApiResponse<T>> {
  const safeMessage = message ?? (status >= 500 ? 'Internal server error' : undefined);
  return NextResponse.json(
    {
      success: false,
      error,
      ...(safeMessage ? { message: safeMessage } : {}),
    },
    { status },
  );
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function isValidationError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'name' in error &&
      error.name === 'ZodError' &&
      'issues' in error &&
      Array.isArray(error.issues),
  );
}

function classifyError(error: unknown): { status: number; message?: string } {
  if (error instanceof ApiError) {
    return { status: error.status, message: error.expose ? error.message : undefined };
  }
  if (error instanceof Error && 'status' in error && typeof error.status === 'number' && error.status >= 400 && error.status <= 599) {
    return { status: error.status, message: error.status < 500 ? error.message : undefined };
  }
  if (error instanceof SyntaxError) {
    return { status: 400, message: 'Invalid JSON request body' };
  }
  if (isValidationError(error)) {
    return { status: 400, message: 'Invalid request payload' };
  }

  const code = errorCode(error);
  if (code === 'P2025') return { status: 404, message: 'Resource not found' };
  if (code === 'P2002') return { status: 409, message: 'Resource already exists' };

  if (!(error instanceof Error)) return { status: 500 };
  const normalized = error.message.toLowerCase();
  if (normalized.includes('unauthorized')) return { status: 401, message: error.message };
  if (normalized.includes('forbidden')) return { status: 403, message: error.message };
  if (normalized.includes('not found')) return { status: 404, message: error.message };
  if (normalized.includes('already exists') || normalized.includes('conflict')) {
    return { status: 409, message: error.message };
  }
  if (
    normalized.includes('invalid') ||
    normalized.includes('missing') ||
    normalized.includes('required') ||
    normalized.includes('cannot be empty')
  ) {
    return { status: 400, message: error.message };
  }
  return { status: 500 };
}

export function handleApiError<T = never>(
  error: unknown,
  context: string,
  defaultMessage = 'Operation failed',
): NextResponse<ApiResponse<T>> {
  const classified = classifyError(error);
  console.error(`[${context}] ${defaultMessage}`, {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    status: classified.status,
  });
  return createErrorResponse<T>(defaultMessage, classified.message, classified.status);
}

export function withApiHandler<T = unknown>(
  handler: () => Promise<NextResponse<ApiResponse<T>>>,
  context: string,
  errorMessage?: string,
): Promise<NextResponse<ApiResponse<T>>> {
  return handler().catch((error) => handleApiError<T>(error, context, errorMessage));
}
