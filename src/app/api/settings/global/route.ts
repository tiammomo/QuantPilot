import { NextRequest, NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import {
  loadGlobalSettings,
  updateGlobalSettings,
  normalizeCliSettings,
} from '@/lib/services/settings';

function serialize(settings: Awaited<ReturnType<typeof loadGlobalSettings>>) {
  return {
    ...settings,
    defaultCli: settings.default_cli,
    cliSettings: settings.cli_settings,
  };
}

export async function GET(request: NextRequest) {
  try {
    await requireAction({
      headers: request.headers,
      action: 'quant.data.read',
    });
    const settings = await loadGlobalSettings();
    const response = NextResponse.json(serialize(settings));
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    return NextResponse.json(
      { error: 'Failed to load global settings' },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    await requireAction({
      headers: request.headers,
      action: 'platform.settings.manage',
    });
    const body = await request.json();
    const candidate = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};

    const update: Record<string, unknown> = {};

    const defaultCli = candidate.default_cli ?? candidate.defaultCli;
    if (typeof defaultCli === 'string') {
      update.default_cli = defaultCli;
    }

    const cliSettingsRaw = candidate.cli_settings ?? candidate.cliSettings;
    const cliSettings = normalizeCliSettings(cliSettingsRaw as Record<string, unknown> | undefined);
    if (cliSettings) {
      update.cli_settings = cliSettings;
    }

    const nextSettings = await updateGlobalSettings(update);
    return NextResponse.json(serialize(nextSettings));
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to update global settings:', error);
    return NextResponse.json(
      {
        error: 'Failed to update global settings',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
