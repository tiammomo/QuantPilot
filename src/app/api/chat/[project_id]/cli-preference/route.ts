import { NextRequest, NextResponse } from 'next/server';
import {
  getProjectCliPreference,
  updateProjectCliPreference,
} from '@/lib/services/project';
import { DEEPSEEK_MODEL_ID } from '@/lib/constants/cliModels';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { project_id } = await params;
  const preference = await getProjectCliPreference(project_id);
  if (!preference) {
    return NextResponse.json(
      { success: false, error: 'Project not found' },
      { status: 404 },
    );
  }

  return NextResponse.json({ success: true, data: preference });
}

export async function POST(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const update = {
      preferredCli: 'moagent',
      fallbackEnabled: false,
      selectedModel: DEEPSEEK_MODEL_ID,
    };

    const updated = await updateProjectCliPreference(project_id, update);
    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    console.error('[API] Failed to update CLI preference:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to update CLI preference',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
