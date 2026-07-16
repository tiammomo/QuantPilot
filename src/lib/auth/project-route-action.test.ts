import { describe, expect, it } from 'vitest';

import { projectRouteAction } from './project-route-action';

describe('projectRouteAction', () => {
  it('maps the project lifecycle to read, update, and delete', () => {
    expect(projectRouteAction('project', 'GET')).toBe('project.read');
    expect(projectRouteAction('project', 'PUT')).toBe('project.update');
    expect(projectRouteAction('project', 'DELETE')).toBe('project.delete');
    expect(projectRouteAction('members', 'GET')).toBe('project.members.manage');
  });

  it('maps source, artifact, and asset methods without granting writes to readers', () => {
    for (const resource of ['source', 'artifact', 'asset'] as const) {
      expect(projectRouteAction(resource, 'GET')).toBe('project.source.read');
      expect(projectRouteAction(resource, 'POST')).toBe('project.source.write');
      expect(projectRouteAction(resource, 'PUT')).toBe('project.source.write');
    }
  });

  it('keeps service management, deployment, install, cancellation and chat data distinct', () => {
    expect(projectRouteAction('services', 'GET')).toBe('project.services.read');
    expect(projectRouteAction('services', 'DELETE')).toBe('project.services.manage');
    expect(projectRouteAction('service-connection', 'POST')).toBe('project.services.manage');
    expect(projectRouteAction('deploy', 'POST')).toBe('project.deploy');
    expect(projectRouteAction('install-dependencies', 'POST')).toBe('project.source.write');
    expect(projectRouteAction('agent-cancel', 'POST')).toBe('agent.cancel');
    expect(projectRouteAction('chat-data', 'GET')).toBe('project.read');
    expect(projectRouteAction('chat-data', 'POST')).toBe('project.update');
    expect(projectRouteAction('chat-data', 'DELETE')).toBe('project.update');
  });
});
