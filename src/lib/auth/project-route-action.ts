import type { PermissionAction } from '@/lib/auth/permissions';

export type ProjectRouteResource =
  | 'project'
  | 'members'
  | 'source'
  | 'artifact'
  | 'asset'
  | 'services'
  | 'service-connection'
  | 'deploy'
  | 'install-dependencies'
  | 'agent-cancel'
  | 'chat-data';

/**
 * Central mapping for project resource routes. Authentication stays in each
 * route through requireAction; this helper only prevents method/action drift.
 */
export function projectRouteAction(
  resource: ProjectRouteResource,
  method: string,
): PermissionAction {
  const normalizedMethod = method.toUpperCase();
  const readOnly = normalizedMethod === 'GET' || normalizedMethod === 'HEAD';

  switch (resource) {
    case 'project':
      if (readOnly) return 'project.read';
      if (normalizedMethod === 'DELETE') return 'project.delete';
      return 'project.update';
    case 'members':
      return 'project.members.manage';
    case 'source':
    case 'artifact':
    case 'asset':
      return readOnly ? 'project.source.read' : 'project.source.write';
    case 'services':
      return readOnly ? 'project.services.read' : 'project.services.manage';
    case 'service-connection':
      return 'project.services.manage';
    case 'deploy':
      return 'project.deploy';
    case 'install-dependencies':
      return 'project.source.write';
    case 'agent-cancel':
      return 'agent.cancel';
    case 'chat-data':
      return readOnly ? 'project.read' : 'project.update';
  }
}
