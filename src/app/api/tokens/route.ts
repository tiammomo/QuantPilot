import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { createServiceToken } from '@/lib/services/tokens';
import { createSuccessResponse, handleApiError } from '@/lib/utils/api-response';

const tokenInputSchema = z.object({
  provider: z.enum(['github', 'supabase', 'vercel']),
  token: z.string().trim().min(1).max(65_536),
  name: z.string().trim().max(120).optional().default(''),
}).strict();

export async function POST(request: NextRequest) {
  try {
    await requireAction({
      headers: request.headers,
      action: 'platform.tokens.manage',
    });
    const body = tokenInputSchema.parse(await request.json());
    const record = await createServiceToken(body.provider, body.token, body.name);
    return createSuccessResponse(record, 201);
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    return handleApiError(error, 'Tokens API', 'Failed to save token');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
