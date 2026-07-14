import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { restoreQuantDashboardTemplate, scaffoldBasicNextApp } from './scaffold';

const temporaryProjects: string[] = [];

async function createProject() {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-scaffold-'));
  temporaryProjects.push(projectPath);
  await fs.mkdir(path.join(projectPath, '.quantpilot'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'data_file', 'final'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'app'), { recursive: true });
  return projectPath;
}

afterEach(async () => {
  await Promise.all(
    temporaryProjects.splice(0).map((projectPath) =>
      fs.rm(projectPath, { recursive: true, force: true })
    )
  );
});

describe('restoreQuantDashboardTemplate', () => {
  it('replaces an invalid Agent page with the platform technical dashboard', async () => {
    const projectPath = await createProject();
    await Promise.all([
      fs.writeFile(
        path.join(projectPath, '.quantpilot', 'run_plan.json'),
        JSON.stringify({
          status: 'planned',
          capabilityId: 'technical_analysis',
          symbols: ['600519'],
          visualization: { templateId: 'technical-timing' },
        })
      ),
      fs.writeFile(
        path.join(projectPath, 'data_file', 'final', 'dashboard-data.json'),
        JSON.stringify({
          symbol: '600519',
          name: '贵州茅台',
          visualization: { template_id: 'technical-timing' },
        })
      ),
      fs.writeFile(
        path.join(projectPath, 'app', 'page.tsx'),
        'export default function Page(){ return <main>TradingPlanPanel 买入区间 止损 目标价</main> }\n'
      ),
      fs.writeFile(path.join(projectPath, 'app', 'globals.css'), 'body{}\n'),
    ]);

    await restoreQuantDashboardTemplate(projectPath);

    const [page, css] = await Promise.all([
      fs.readFile(path.join(projectPath, 'app', 'page.tsx'), 'utf8'),
      fs.readFile(path.join(projectPath, 'app', 'globals.css'), 'utf8'),
    ]);
    expect(page).toContain('data-source-file={DATA_FILE}');
    expect(page).toContain('function getBars(');
    expect(page).toContain('K 线与量价结构');
    expect(page).toContain('className="ma-line ma60"');
    expect(page).toContain('风险结论');
    expect(page).not.toContain('TradingPlanPanel');
    expect(page).not.toContain('买入区间');
    expect(css).toContain('.dashboard-shell');
  });

  it('keeps an existing page and stylesheet during non-destructive scaffolding', async () => {
    const projectPath = await createProject();
    const page = 'export default function Page(){ return <main>custom dashboard</main> }\n';
    const css = '.custom-dashboard { color: rebeccapurple; }\n';
    await Promise.all([
      fs.writeFile(path.join(projectPath, 'app', 'page.tsx'), page),
      fs.writeFile(path.join(projectPath, 'app', 'globals.css'), css),
    ]);

    await scaffoldBasicNextApp(projectPath, 'non-destructive-project');

    await expect(fs.readFile(path.join(projectPath, 'app', 'page.tsx'), 'utf8')).resolves.toBe(page);
    await expect(fs.readFile(path.join(projectPath, 'app', 'globals.css'), 'utf8')).resolves.toBe(css);
  });

  it('does not rewrite an unchanged package.json during repeated scaffolding', async () => {
    const projectPath = await createProject();
    const packageJsonPath = path.join(projectPath, 'package.json');

    await scaffoldBasicNextApp(projectPath, 'idempotent-project');
    const contents = await fs.readFile(packageJsonPath, 'utf8');
    const sentinel = new Date('2026-01-01T00:00:00.000Z');
    await fs.utimes(packageJsonPath, sentinel, sentinel);
    const before = await fs.stat(packageJsonPath);

    await scaffoldBasicNextApp(projectPath, 'idempotent-project');

    const after = await fs.stat(packageJsonPath);
    await expect(fs.readFile(packageJsonPath, 'utf8')).resolves.toBe(contents);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
