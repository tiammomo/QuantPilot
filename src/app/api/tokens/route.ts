import { NextRequest } from 'next/server';
import { z } from 'zod';
import { createServiceToken } from '@/lib/services/tokens';
import { createSuccessResponse, handleApiError } from '@/lib/utils/api-response';

const tokenInputSchema = z.object({
  provider: z.enum(['github', 'supabase', 'vercel']),
  token: z.string().trim().min(1).max(65_536),
  name: z.string().trim().max(120).optional().default(''),
}).strict();

export async function POST(request: NextRequest) {
  try {
    const body = tokenInputSchema.parse(await request.json());
    const record = await createServiceToken(body.provider, body.token, body.name);
    return createSuccessResponse(record, 201);
  } catch (error) {
    return handleApiError(error, 'Tokens API', 'Failed to save token');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
