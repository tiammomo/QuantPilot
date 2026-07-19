import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(process.cwd());
const APP_API_ROOT = path.join(ROOT, 'src', 'app', 'api');
const PAGES_API_ROOT = path.join(ROOT, 'src', 'pages', 'api');

const PUBLIC_ROUTE_FILES = new Set([
  'src/app/api/health/route.ts',
  'src/app/api/ready/route.ts',
]);

const ROUTE_BOUNDARY = /\b(?:requireAction|requireAdminSession|requireAuthSession|toNextJsHandler)\s*\(/;
const ROUTE_HANDLER = /export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|export\s+default\s+(?:async\s+)?function\b/;

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.ts') ? [absolute] : [];
  }));
  return nested.flat();
}

function relative(file: string): string {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

describe('API route authorization coverage', () => {
  it('keeps every concrete API/WS handler behind an explicit service-side boundary', async () => {
    const files = [
      ...(await listTypeScriptFiles(APP_API_ROOT)),
      ...(await listTypeScriptFiles(PAGES_API_ROOT)),
    ];
    const missing: string[] = [];

    for (const file of files) {
      const source = await fs.readFile(file, 'utf8');
      if (!ROUTE_HANDLER.test(source)) continue;
      const route = relative(file);
      if (PUBLIC_ROUTE_FILES.has(route)) continue;
      if (!ROUTE_BOUNDARY.test(source)) missing.push(route);
    }

    expect(missing).toEqual([]);
  });

  it('keeps the public route allowlist minimal and intentional', async () => {
    await expect(Promise.all(
      [...PUBLIC_ROUTE_FILES].map((file) => fs.access(path.join(ROOT, file))),
    )).resolves.toBeDefined();
    expect([...PUBLIC_ROUTE_FILES]).toEqual([
      'src/app/api/health/route.ts',
      'src/app/api/ready/route.ts',
    ]);
  });

  it('maps high-risk global and cross-project routes to catalogued capabilities', async () => {
    const expectedActions: Record<string, string[]> = {
      'src/app/api/evals/route.ts': [
        'platform.observability.read',
        'platform.settings.manage',
      ],
      'src/app/api/evals/runs/[runId]/route.ts': ['platform.observability.read'],
      'src/app/api/github/check-repo/[repo_name]/route.ts': ['platform.tokens.manage'],
      'src/app/api/github/create-repo/route.ts': ['platform.tokens.manage'],
      'src/app/api/infrastructure/health/route.ts': ['platform.observability.read'],
      'src/app/api/infrastructure/service-catalog/route.ts': ['platform.observability.read'],
      'src/app/api/ops/platform/route.ts': ['platform.observability.read'],
      'src/app/api/workspaces/health/route.ts': ['platform.observability.read'],
      'src/app/api/workspaces/trace/route.ts': ['platform.observability.read'],
      'src/app/api/settings/cli-status/route.ts': ['quant.data.read'],
      'src/app/api/settings/global/route.ts': ['quant.data.read', 'platform.settings.manage'],
      'src/app/api/skills/[skillId]/package/route.ts': ['quant.data.read'],
      'src/app/api/skills/route.ts': ['quant.data.read', 'platform.settings.manage'],
      'src/app/api/tokens/route.ts': ['platform.tokens.manage'],
      'src/app/api/tokens/[...segments]/route.ts': ['platform.tokens.manage'],
      'src/app/api/supabase/create-project/route.ts': ['project.services.manage'],
      'src/app/api/supabase/organizations/route.ts': ['platform.tokens.manage'],
      'src/app/api/supabase/projects/[supabase_project_id]/route.ts': [
        'platform.tokens.manage',
      ],
      'src/app/api/supabase/projects/[supabase_project_id]/api-keys/route.ts': [
        'platform.tokens.manage',
      ],
      'src/app/api/vercel/check-project/[name]/route.ts': ['platform.tokens.manage'],
      'src/pages/api/ws/[projectId].ts': ['project.read'],
    };

    for (const [file, actions] of Object.entries(expectedActions)) {
      const source = await fs.readFile(path.join(ROOT, file), 'utf8');
      for (const action of actions) {
        expect(source, `${file} must enforce ${action}`).toContain(`action: '${action}'`);
      }
    }
  });

  it('marks sensitive authenticated payloads as non-cacheable', async () => {
    const sensitiveRoutes = [
      'src/app/api/account/sessions/route.ts',
      'src/app/api/account/memory/route.ts',
      'src/app/api/account/memory/preferences/[record_id]/corrections/route.ts',
      'src/app/api/account/memory/preferences/[record_id]/revisions/route.ts',
      'src/app/api/account/usage/route.ts',
      'src/app/api/admin/audit/route.ts',
      'src/app/api/admin/users/route.ts',
      'src/app/api/admin/users/[user_id]/access/route.ts',
      'src/app/api/assets/[project_id]/[filename]/route.ts',
      'src/app/api/env/[project_id]/route.ts',
      'src/app/api/env/[project_id]/conflicts/route.ts',
      'src/app/api/evals/route.ts',
      'src/app/api/evals/runs/[runId]/route.ts',
      'src/app/api/projects/[project_id]/artifact/route.ts',
      'src/app/api/supabase/projects/[supabase_project_id]/api-keys/route.ts',
      'src/app/api/tokens/[...segments]/route.ts',
      'src/app/api/workspaces/trace/route.ts',
    ];

    for (const file of sensitiveRoutes) {
      const source = await fs.readFile(path.join(ROOT, file), 'utf8');
      expect(source, `${file} must disable response caching`).toMatch(
        /Cache-Control['"],\s*['"][^'"]*no-store/,
      );
    }
  });
});
