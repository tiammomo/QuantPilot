import { NextResponse } from 'next/server';
import {
  cancelQuantEvalRun,
  checkQuantEvalSchedule,
  getQuantEvalDashboardData,
  simulateQuantEvalFlow,
  startQuantEvalRun,
  updateQuantEvalSchedule,
} from '@/lib/quant/evals';

export async function GET() {
  try {
    return NextResponse.json({
      success: true,
      data: await getQuantEvalDashboardData(),
    });
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

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body.action ?? '');
    if (action === 'start-benchmark') {
      const item = await startQuantEvalRun({
        cli: typeof body.cli === 'string' ? body.cli : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
        reasoningEffort: typeof body.reasoningEffort === 'string' ? body.reasoningEffort : undefined,
        selectedCases: Array.isArray(body.selectedCases) ? body.selectedCases.map(String) : [],
        limit: typeof body.limit === 'number' ? body.limit : null,
        keepProjects: Boolean(body.keepProjects),
      });

      return NextResponse.json({ success: true, data: item });
    }

    if (action === 'simulate-flow') {
      const simulation = await simulateQuantEvalFlow({
        cli: typeof body.cli === 'string' ? body.cli : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
        reasoningEffort: typeof body.reasoningEffort === 'string' ? body.reasoningEffort : undefined,
        selectedCases: Array.isArray(body.selectedCases) ? body.selectedCases.map(String) : [],
        limit: typeof body.limit === 'number' ? body.limit : null,
        keepProjects: Boolean(body.keepProjects),
      });

      return NextResponse.json({ success: true, data: simulation });
    }

    if (action === 'cancel-benchmark') {
      const item = await cancelQuantEvalRun(String(body.queueId ?? ''));
      return NextResponse.json({ success: true, data: item });
    }

    if (action === 'update-schedule') {
      const schedule = await updateQuantEvalSchedule({
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        intervalHours: typeof body.intervalHours === 'number' ? body.intervalHours : undefined,
        cli: typeof body.cli === 'string' ? body.cli : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
        reasoningEffort: typeof body.reasoningEffort === 'string' ? body.reasoningEffort : undefined,
        selectedCases: Array.isArray(body.selectedCases) ? body.selectedCases.map(String) : undefined,
        limit: typeof body.limit === 'number' || body.limit === null ? body.limit : undefined,
        keepProjects: typeof body.keepProjects === 'boolean' ? body.keepProjects : undefined,
        nextRunAt: typeof body.nextRunAt === 'string' || body.nextRunAt === null ? body.nextRunAt : undefined,
      });
      return NextResponse.json({ success: true, data: schedule });
    }

    if (action === 'check-schedule') {
      const result = await checkQuantEvalSchedule();
      return NextResponse.json({ success: true, data: result });
    }

    {
      return NextResponse.json(
        {
          success: false,
          error: '不支持的评测 action。',
        },
        { status: 400 }
      );
    }
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 400 }
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
