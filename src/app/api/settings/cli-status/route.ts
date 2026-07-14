/**
 * CLI Status API Route
 * GET /api/settings/cli-status - Check CLI installation status
 */

import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { promisify } from 'util';
import type { CLIStatus } from '@/types/backend';
import {
  CLAUDE_MODEL_DEFINITIONS,
  CODEX_MODEL_DEFINITIONS,
  CURSOR_MODEL_DEFINITIONS,
  QWEN_MODEL_DEFINITIONS,
  GLM_MODEL_DEFINITIONS,
} from '@/lib/constants/cliModels';
import { buildCodexEnvironment, getCodexRuntimeConfig } from '@/lib/services/cli/codex-config';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

function getBundledClaudeExecutable(): string | null {
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

/**
 * Check Claude Code CLI installation
 */
async function checkClaudeCodeCLI(): Promise<{
  installed: boolean;
  version?: string;
  error?: string;
  configured?: boolean;
  bundled?: boolean;
}> {
  const configured = Boolean(
    process.env.ANTHROPIC_AUTH_TOKEN?.trim() ||
      process.env.ANTHROPIC_API_KEY?.trim()
  );

  try {
    const { stdout } = await execAsync('claude --version');
    const version = stdout.trim();
    return {
      installed: true,
      version,
      configured,
    };
  } catch (globalError) {
    const bundledExecutable = getBundledClaudeExecutable();
    if (bundledExecutable) {
      try {
        const { stdout } = await execFileAsync(bundledExecutable, ['--version']);
        const version = stdout.trim();
        return {
          installed: true,
          version: version ? `${version} (bundled SDK)` : 'bundled SDK',
          configured,
          bundled: true,
        };
      } catch (bundledError) {
        return {
          installed: false,
          error: bundledError instanceof Error ? bundledError.message : 'Failed to check bundled Claude Code',
          configured,
        };
      }
    }

    return {
      installed: false,
      error: globalError instanceof Error ? globalError.message : 'Failed to check CLI',
      configured,
    };
  }
}

async function checkCodexCLI(): Promise<{
  installed: boolean;
  version?: string;
  error?: string;
  configured?: boolean;
}> {
  const runtimeConfig = getCodexRuntimeConfig();
  try {
    const { stdout } = await execFileAsync(runtimeConfig.executable, ['--version'], {
      env: buildCodexEnvironment(),
    });
    const version = stdout.trim();
    return {
      installed: true,
      version: version || 'installed',
      configured: Boolean(runtimeConfig.apiKey),
    };
  } catch (error) {
    return {
      installed: false,
      error: error instanceof Error ? error.message : 'Failed to check Codex CLI',
      configured: Boolean(runtimeConfig.apiKey),
    };
  }
}

async function checkCursorCLI(): Promise<{
  installed: boolean;
  version?: string;
  error?: string;
}> {
  const executable = process.platform === 'win32' ? 'cursor-agent.cmd' : 'cursor-agent';
  try {
    const { stdout, stderr } = await execAsync(`${executable} --version`);
    const output = `${stdout.trim()} ${stderr.trim()}`.trim();
    const version = output.length > 0 ? output : 'installed';
    return {
      installed: true,
      version,
    };
  } catch (error) {
    return {
      installed: false,
      error: error instanceof Error ? error.message : 'Failed to check Cursor CLI',
    };
  }
}

async function checkQwenCLI(): Promise<{
  installed: boolean;
  version?: string;
  error?: string;
}> {
  const executable = process.platform === 'win32' ? 'qwen.cmd' : 'qwen';
  try {
    const { stdout } = await execAsync(`${executable} --version`);
    const version = stdout.trim();
    return {
      installed: true,
      version: version || 'installed',
    };
  } catch (error) {
    return {
      installed: false,
      error: error instanceof Error ? error.message : 'Failed to check Qwen CLI',
    };
  }
}

/**
 * GET /api/settings/cli-status
 * Check CLI installation status
 */
export async function GET() {
  try {
    const status: CLIStatus = {
      claude: {
        installed: false,
        checking: false,
      },
      cursor: {
        installed: false,
        checking: false,
      },
      codex: {
        installed: false,
        checking: false,
      },
      gemini: {
        installed: false,
        checking: false,
      },
      qwen: {
        installed: false,
        checking: false,
      },
      glm: {
        installed: false,
        checking: false,
      },
    };

    // Check Claude Code CLI installation
    const claudeStatus = await checkClaudeCodeCLI();
    status.claude = {
      installed: claudeStatus.installed,
      version: claudeStatus.version,
      checking: false,
      error: claudeStatus.error,
      configured: claudeStatus.configured,
      available: claudeStatus.installed && claudeStatus.configured === true,
      models: CLAUDE_MODEL_DEFINITIONS.map((model) => model.id),
    };

    const codexStatus = await checkCodexCLI();
    status.codex = {
      installed: codexStatus.installed,
      version: codexStatus.version,
      checking: false,
      error: codexStatus.error,
      configured: codexStatus.configured,
      available: codexStatus.installed && codexStatus.configured === true,
      models: CODEX_MODEL_DEFINITIONS.map(model => model.id),
    };

    const cursorStatus = await checkCursorCLI();
    status.cursor = {
      installed: cursorStatus.installed,
      version: cursorStatus.version,
      checking: false,
      error: cursorStatus.error,
      models: CURSOR_MODEL_DEFINITIONS.map((model) => model.id),
    };

    const qwenStatus = await checkQwenCLI();
    status.qwen = {
      installed: qwenStatus.installed,
      version: qwenStatus.version,
      checking: false,
      error: qwenStatus.error,
      models: QWEN_MODEL_DEFINITIONS.map((model) => model.id),
    };

    const glmStatus = claudeStatus;
    status.glm = {
      installed: glmStatus.installed,
      version: glmStatus.version,
      checking: false,
      error: glmStatus.error,
      models: GLM_MODEL_DEFINITIONS.map((model) => model.id),
    };

    return NextResponse.json(status);
  } catch (error) {
    console.error('[API] Failed to check CLI status:', error);
    return NextResponse.json(
      {
        error: 'Failed to check CLI status',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
