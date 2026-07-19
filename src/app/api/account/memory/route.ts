import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { requireAuthSession } from '@/lib/auth/authorization';
import { writeAuthAuditEvent } from '@/lib/auth/audit';
import { authErrorResponse } from '@/lib/auth/http';
import {
  ExternalMemoryHttpError,
  getMemoryIntegrationConfig,
  getPersonalMemoryControl,
  getPersonalMemoryValueSummary,
  inspectPersonalMemory,
  listPersonalPreferences,
  MemoryIntegrationError,
  setPersonalMemoryEnabled,
} from '@/lib/platform/memory';

const updateSchema = z.object({
  personalizationEnabled: z.boolean(),
}).strict();

function serializedControl(control: Awaited<ReturnType<typeof getPersonalMemoryControl>>) {
  return {
    ...control,
    enabledAt: control.enabledAt?.toISOString() ?? null,
    disabledAt: control.disabledAt?.toISOString() ?? null,
    updatedAt: control.updatedAt?.toISOString() ?? null,
  };
}

function integrationFailure(error: unknown): string {
  if (error instanceof MemoryIntegrationError || error instanceof ExternalMemoryHttpError) {
    return error.code;
  }
  return 'MEMORY_INTEGRATION_ERROR';
}

export async function GET(request: NextRequest) {
  try {
    const session = await requireAuthSession(request.headers);
    const control = await getPersonalMemoryControl(session.user.id);
    const valueSummary = await getPersonalMemoryValueSummary(session.user.id);
    let config: ReturnType<typeof getMemoryIntegrationConfig> | null = null;
    let configurationError: string | null = null;
    try {
      config = getMemoryIntegrationConfig();
    } catch {
      configurationError = 'MEMORY_CONFIGURATION_INVALID';
    }
    let status: 'disabled' | 'ready' | 'unavailable' = config?.enabled
      ? 'unavailable'
      : config
        ? 'disabled'
        : 'unavailable';
    let service: Awaited<ReturnType<typeof inspectPersonalMemory>> | null = null;
    let preferences: Awaited<ReturnType<typeof listPersonalPreferences>> | null = null;
    let error: string | null = configurationError;

    if (config?.enabled) {
      try {
        service = await inspectPersonalMemory('quantpilot-account-memory');
        preferences = await listPersonalPreferences({
          actorUserId: session.user.id,
          requestId: 'quantpilot-account-memory',
        });
        status = 'ready';
      } catch (cause) {
        error = integrationFailure(cause);
      }
    }

    const response = NextResponse.json({
      success: true,
      data: {
        control: serializedControl(control),
        integration: {
          configurationValid: config !== null,
          enabled: config?.enabled ?? false,
          required: config?.required ?? false,
          requireProductionReady: config?.requireProductionReady ?? false,
          status,
          error,
          service,
        },
        preferences,
        valueSummary: {
          ...valueSummary,
          lastExposedAt: valueSummary.lastExposedAt?.toISOString() ?? null,
        },
        lifecycle: {
          productUsageFenceAvailable: true,
          providerErasureAvailable: false,
          notice: '关闭后 QuantPilot 不再把外部记忆用于新任务，但不会删除 Memory 服务中已经保存的数据。',
        },
      },
    });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await requireAuthSession(request.headers);
    const body = updateSchema.parse(await request.json());
    const control = await setPersonalMemoryEnabled(
      session.user.id,
      body.personalizationEnabled,
    );
    await writeAuthAuditEvent({
      actorUserId: session.user.id,
      eventType: body.personalizationEnabled
        ? 'personal_memory.enabled'
        : 'personal_memory.disabled',
      targetType: 'personal_memory_control',
      targetId: session.user.id,
      outcome: 'success',
      headers: request.headers,
      metadata: {
        changed: control.changed,
        policyVersion: control.policyVersion,
      },
    });
    const response = NextResponse.json({
      success: true,
      data: serializedControl(control),
    });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
