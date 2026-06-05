import { NextResponse } from 'next/server';
import { getQuantEvalRun } from '@/lib/eval';

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId } = await context.params;
    const run = await getQuantEvalRun(runId);
    if (!run) {
      return NextResponse.json(
        {
          success: false,
          error: '未找到评测运行记录。',
        },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, data: run });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
