import { NextResponse } from 'next/server';
import type { CLIStatus } from '@/types/backend';
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

export async function GET() {
  try {
    const status: CLIStatus = {
      moagent: await checkMoAgent(),
    };
    return NextResponse.json(status);
  } catch (error) {
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
