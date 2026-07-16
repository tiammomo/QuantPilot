import { NextResponse } from 'next/server';
import {
  cancelQuantEvalRun,
  createQuantEvalCase,
  createQuantEvalSet,
  checkQuantEvalSchedule,
  getQuantEvalDashboardData,
  simulateQuantEvalFlow,
  startQuantEvalRun,
  updateQuantEvalSchedule,
} from '@/lib/eval';
import { assertPrivilegedMutation, PrivilegedRequestError } from '@/lib/server/privileged-request';

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
    assertPrivilegedMutation(request);
    const body = await request.json().catch(() => ({}));
    const action = String(body.action ?? '');
    if (action === 'start-benchmark') {
      const item = await startQuantEvalRun({
        cli: typeof body.cli === 'string' ? body.cli : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
        reasoningEffort: typeof body.reasoningEffort === 'string' ? body.reasoningEffort : undefined,
        evaluatorId: typeof body.evaluatorId === 'string' ? body.evaluatorId : undefined,
        concurrency: typeof body.concurrency === 'number' ? body.concurrency : undefined,
        repeat: typeof body.repeat === 'number' ? body.repeat : undefined,
        mode: body.mode === 'e2e' ? 'e2e' : 'contract',
        selectedCases: Array.isArray(body.selectedCases) ? body.selectedCases.map(String) : [],
        limit: typeof body.limit === 'number' ? body.limit : null,
        keepProjects: Boolean(body.keepProjects),
      });

      return NextResponse.json({ success: true, data: item });
    }

    if (action === 'create-case') {
      const item = await createQuantEvalCase({
        id: typeof body.id === 'string' ? body.id : undefined,
        name: typeof body.name === 'string' ? body.name : undefined,
        question: typeof body.question === 'string' ? body.question : undefined,
        capabilityId: typeof body.capabilityId === 'string' ? body.capabilityId : undefined,
        type: typeof body.type === 'string' ? body.type : undefined,
        expectedSymbols: Array.isArray(body.expectedSymbols) ? body.expectedSymbols.map(String) : undefined,
        expectedAssetType: typeof body.expectedAssetType === 'string' ? body.expectedAssetType : undefined,
        expectedTemplateId: typeof body.expectedTemplateId === 'string' ? body.expectedTemplateId : undefined,
        expectedVariantId: typeof body.expectedVariantId === 'string' ? body.expectedVariantId : undefined,
        expectedDatasets: Array.isArray(body.expectedDatasets) ? body.expectedDatasets.map(String) : undefined,
        expectedRawFiles: Array.isArray(body.expectedRawFiles) ? body.expectedRawFiles.map(String) : undefined,
        expectedFinalFields: Array.isArray(body.expectedFinalFields) ? body.expectedFinalFields.map(String) : undefined,
        coverageLevel: body.coverageLevel === 'routing' || body.coverageLevel === 'contract'
          ? body.coverageLevel
          : undefined,
        productionSupported: typeof body.productionSupported === 'boolean' ? body.productionSupported : undefined,
        oracleAssertions: Array.isArray(body.oracleAssertions) ? body.oracleAssertions : undefined,
        safetyTags: Array.isArray(body.safetyTags) ? body.safetyTags.map(String) : undefined,
        expectClarification: typeof body.expectClarification === 'boolean' ? body.expectClarification : undefined,
        visualCheck: typeof body.visualCheck === 'boolean' ? body.visualCheck : undefined,
      });
      return NextResponse.json({ success: true, data: item });
    }

    if (action === 'create-eval-set') {
      const item = await createQuantEvalSet({
        id: typeof body.id === 'string' ? body.id : undefined,
        name: typeof body.name === 'string' ? body.name : undefined,
        description: typeof body.description === 'string' ? body.description : undefined,
        category: typeof body.category === 'string' ? body.category : undefined,
        caseIds: Array.isArray(body.caseIds) ? body.caseIds.map(String) : undefined,
      });
      return NextResponse.json({ success: true, data: item });
    }

    if (action === 'simulate-flow') {
      const simulation = await simulateQuantEvalFlow({
        cli: typeof body.cli === 'string' ? body.cli : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
        reasoningEffort: typeof body.reasoningEffort === 'string' ? body.reasoningEffort : undefined,
        evaluatorId: typeof body.evaluatorId === 'string' ? body.evaluatorId : undefined,
        concurrency: typeof body.concurrency === 'number' ? body.concurrency : undefined,
        repeat: typeof body.repeat === 'number' ? body.repeat : undefined,
        mode: body.mode === 'e2e' ? 'e2e' : 'contract',
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
      { status: error instanceof PrivilegedRequestError ? error.status : 400 }
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
