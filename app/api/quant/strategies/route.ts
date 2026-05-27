import { NextRequest } from 'next/server';
import { createSuccessResponse, handleApiError } from '@/lib/utils/api-response';
import { buildStrategyPrompt, getStrategyDashboardData, runStrategyParameterScan } from '@/lib/quant/strategies';

export async function GET() {
  try {
    return createSuccessResponse(await getStrategyDashboardData());
  } catch (error) {
    return handleApiError(error, 'StrategyPlatform', 'Failed to fetch strategies');
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body.action === 'run-scan') {
      return createSuccessResponse(
        await runStrategyParameterScan({
          templateId: String(body.templateId ?? ''),
          scanId: String(body.scanId ?? ''),
          symbol: typeof body.symbol === 'string' ? body.symbol : undefined,
        }),
        201
      );
    }
    return createSuccessResponse(buildStrategyPrompt(String(body.templateId ?? ''), body.symbol), 201);
  } catch (error) {
    return handleApiError(error, 'StrategyPlatform', 'Failed to build strategy prompt');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
