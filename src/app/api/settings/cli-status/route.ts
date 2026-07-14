import { NextResponse } from 'next/server';
import { existsSync } from 'fs';
import path from 'path';
import type { CLIStatus } from '@/types/backend';
import { CLAUDE_MODEL_DEFINITIONS } from '@/lib/constants/cliModels';

function getBundledAgentExecutable(): string | null {
  const executable = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const packageNames =
    process.platform === 'linux'
      ? process.arch === 'arm64'
        ? ['@anthropic-ai/claude-agent-sdk-linux-arm64', '@anthropic-ai/claude-agent-sdk-linux-arm64-musl']
        : ['@anthropic-ai/claude-agent-sdk-linux-x64', '@anthropic-ai/claude-agent-sdk-linux-x64-musl']
      : process.platform === 'darwin'
        ? process.arch === 'arm64'
          ? ['@anthropic-ai/claude-agent-sdk-darwin-arm64']
          : ['@anthropic-ai/claude-agent-sdk-darwin-x64']
        : process.platform === 'win32'
          ? process.arch === 'arm64'
            ? ['@anthropic-ai/claude-agent-sdk-win32-arm64']
            : ['@anthropic-ai/claude-agent-sdk-win32-x64']
          : [];

  for (const packageName of packageNames) {
    const candidate = path.join(process.cwd(), 'node_modules', ...packageName.split('/'), executable);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function checkDeepSeekAgent(): Promise<CLIStatus[string]> {
  const configured = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
  const bundledExecutable = getBundledAgentExecutable();

  if (!bundledExecutable) {
    return {
      installed: false,
      checking: false,
      configured,
      available: false,
      error: 'DeepSeek Agent 本地执行引擎未安装，请重新安装项目依赖。',
      models: CLAUDE_MODEL_DEFINITIONS.map((model) => model.id),
    };
  }

  return {
    installed: true,
    version: 'DeepSeek Agent Runtime (bundled)',
    checking: false,
    configured,
    available: configured,
    error: configured ? undefined : '请在 .env.local 中配置 DEEPSEEK_API_KEY。',
    models: CLAUDE_MODEL_DEFINITIONS.map((model) => model.id),
  };
}

export async function GET() {
  try {
    const status: CLIStatus = {
      claude: await checkDeepSeekAgent(),
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
