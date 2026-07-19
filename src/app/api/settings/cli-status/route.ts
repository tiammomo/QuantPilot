import { NextResponse } from 'next/server';
import type { CLIStatus } from '@/types/backend';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { MOAGENT_MODEL_DEFINITIONS } from '@/lib/constants/models';
import { getProjectLlmConfig } from '@/lib/config/llm';

async function checkMoAgent(): Promise<CLIStatus[string]> {
  const configuredModels = MOAGENT_MODEL_DEFINITIONS.filter((model) => {
    const config = getProjectLlmConfig(model.id);
    return Boolean(process.env[config.credentialEnv]?.trim());
  });
  const configured = configuredModels.length > 0;

  return {
    installed: true,
    version: 'MoAgent Runtime (built-in)',
    checking: false,
    configured,
    available: configured,
    error: configured
      ? undefined
      : '请在 .env.local 中配置 MODELPORT_API_KEY；DEEPSEEK_API_KEY 仅供可选官方直连。',
    models: configuredModels.map((model) => model.id),
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
    console.error('[API] Failed to check MoAgent provider status:', error);
    return NextResponse.json(
      {
        error: 'Failed to check MoAgent provider status',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
