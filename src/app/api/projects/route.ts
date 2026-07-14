/**
 * Projects API Routes
 * GET /api/projects - Get all projects
 * POST /api/projects - Create new project
 */

import { NextRequest } from 'next/server';
import { getAllProjects, createProject } from '@/lib/services/project';
import type { CreateProjectInput } from '@/types/backend';
import { serializeProjects, serializeProject } from '@/lib/serializers/project';
import { DEEPSEEK_MODEL_ID } from '@/lib/constants/cliModels';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';
import { getQuantCapability } from '@/lib/quant/capabilities';

/**
 * GET /api/projects
 * Get all projects list
 */
export async function GET() {
  try {
    const projects = await getAllProjects();
    return createSuccessResponse(serializeProjects(projects));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to fetch projects');
  }
}

/**
 * POST /api/projects
 * Create new project
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const quantCapability = getQuantCapability(
      body.quantCapabilityId || body.quant_capability_id || body.capabilityId || body.capability_id
    );

    const input: CreateProjectInput = {
      project_id: body.project_id,
      name: body.name,
      initialPrompt: body.initialPrompt || body.initial_prompt,
      preferredCli: 'claude',
      selectedModel: DEEPSEEK_MODEL_ID,
      description: body.description,
      quantCapabilityId: quantCapability.id,
      quantCapabilitySource:
        body.quantCapabilitySource || body.quant_capability_source || body.capabilitySource || body.capability_source,
    };

    // Validation
    if (!input.project_id || !input.name) {
      return createErrorResponse('project_id and name are required', undefined, 400);
    }

    const project = await createProject(input);
    return createSuccessResponse(serializeProject(project), 201);
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to create project');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
