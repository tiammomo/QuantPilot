import { NextRequest } from 'next/server';
import { createSuccessResponse, handleApiError } from '@/lib/utils/api-response';
import {
  getResearchAutomationDashboard,
  runDailyResearchReport,
  sendResearchReport,
  type RunDailyResearchReportOptions,
} from '@/lib/quant/research-reports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const dashboard = await getResearchAutomationDashboard();
    return createSuccessResponse(dashboard);
  } catch (error) {
    return handleApiError(error, 'research-reports:get', 'Failed to load research reports');
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as {
      action?: string;
      watchlistId?: string;
      reportId?: string;
      dryRun?: boolean;
    };

    if (!body.action || body.action === 'run-daily-report') {
      const options: RunDailyResearchReportOptions = {
        watchlistId: body.watchlistId,
        dryRun: body.dryRun ?? true,
      };
      const dashboard = await runDailyResearchReport(options);
      return createSuccessResponse(dashboard, 201);
    }

    if (body.action === 'send-latest-report') {
      const dashboard = await sendResearchReport({
        reportId: body.reportId,
        dryRun: body.dryRun ?? false,
      });
      return createSuccessResponse(dashboard, 201);
    }

    throw new Error(`Invalid research report action: ${body.action}`);
  } catch (error) {
    return handleApiError(error, 'research-reports:post', 'Failed to run research report');
  }
}
