import { NextResponse } from 'next/server';
import type { CLIStatus } from '@/types/backend';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { MOAGENT_MODEL_DEFINITIONS } from '@/lib/constants/cliModels';

async function checkMoAgent(): Promise<CLIStatus[string]> {
  const configured = Boolean(process.env.DEEPSEEK_API_KEY?.trim());

  return {
    installed: true,
    version: 'MoAgent Runtime (built-in)',
    checking: false,
    configured,
    available: configured,
    error: configured ? undefined : '请在 .env.local 中配置 DEEPSEEK_API_KEY。',
    models: MOAGENT_MODEL_DEFINITIONS.map((model) => model.id),
  };
}

export async function GET(request: Request) {
  try {
    await requireAction({
      headers: request.headers,
      action: 'quant.data.read',
    });
    const status: CLIStatus = {
      moagent: await checkMoAgent(),
    };
    const response = NextResponse.json(status);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to check DeepSeek runtime status:', error);
    return NextResponse.json(
      {
        error: 'Failed to check DeepSeek runtime status',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
