#!/usr/bin/env node

require('tsconfig-paths/register');

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const jiti = require('jiti')(path.join(process.cwd(), 'scripts/check-generated-artifact-policy.js'), {
  interopDefault: true,
});

const { checkQuantArtifactPolicy } = jiti('../lib/quant/validation.ts');

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function createBaseProject(projectPath) {
  await writeJson(path.join(projectPath, '.quantpilot/run_plan.json'), {
    schemaVersion: 1,
    capabilityId: 'market_analysis',
    symbols: ['600519'],
    visualization: {
      templateId: 'market-dashboard',
      panels: ['quote', 'kline', 'volume'],
    },
  });
  await writeJson(path.join(projectPath, 'data_file/final/dashboard-data.json'), {
    symbol: '600519',
    name: '贵州茅台',
    source: 'eastmoney',
    fetched_at: '2026-05-25T00:00:00.000Z',
    quote: {
      price: 1660.12,
      change_percent: 1.28,
    },
    kline: {
      bars: [
        { trade_date: '2026-05-22', open: 1620, high: 1668, low: 1610, close: 1660.12, volume: 1200000 },
      ],
    },
  });
  await writeJson(path.join(projectPath, 'evidence/sources.json'), {
    sources: [
      {
        source: 'eastmoney',
        endpoint: '/api/v1/quotes/realtime/600519',
        fetched_at: '2026-05-25T00:00:00.000Z',
        artifact_path: 'data_file/final/dashboard-data.json',
      },
    ],
  });
  await writeJson(path.join(projectPath, 'evidence/data_quality.json'), {
    status: 'ok',
    datasets: [{ id: 'quote', row_count: 1, status: 'ok' }],
    warnings: [],
    limitations: [],
  });
  await writeJson(path.join(projectPath, 'package.json'), {
    scripts: { build: 'next build' },
    dependencies: { next: '^16.2.6', react: '^19.2.6', 'react-dom': '^19.2.6' },
  });
}

async function main() {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-artifact-policy-'));

  try {
    await createBaseProject(projectPath);
    await writeFile(
      path.join(projectPath, 'app/page.tsx'),
      `const MOCK_DATA = { price: 1 };
export default function Page() {
  return (
    <main>
      <script src="https://cdn.jsdelivr.net/npm/echarts"></script>
      <div>{MOCK_DATA.price}</div>
    </main>
  );
}
`
    );

    const failed = await checkQuantArtifactPolicy(projectPath);
    const failedDetails = `${failed.summary}\n${failed.details ?? ''}`;
    const failedAsExpected =
      failed.status === 'failed' &&
      failedDetails.includes('外部') &&
      failedDetails.includes('MOCK_DATA');

    if (!failedAsExpected) {
      console.error('[artifact-policy] expected failed policy check');
      console.error(JSON.stringify(failed, null, 2));
      process.exit(1);
    }

    await writeFile(
      path.join(projectPath, 'app/page.tsx'),
      `import fs from 'fs/promises';

const DATA_FILE = 'data_file/final/dashboard-data.json';

export default async function Page() {
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  const data = JSON.parse(raw) as { symbol?: string; quote?: { price?: number } };

  return (
    <main data-source-file={DATA_FILE}>
      <h1>QuantPilot 看板</h1>
      <section aria-label="K 线与量价结构">
        <svg role="img" viewBox="0 0 120 60">
          <title>K 线与成交量</title>
          <rect className="candle-up" x="20" y="12" width="12" height="28" />
          <rect className="volume-chart" x="60" y="34" width="12" height="18" />
        </svg>
      </section>
      <p>{data.symbol} 最新价 {data.quote?.price}</p>
    </main>
  );
}
`
    );

    const passed = await checkQuantArtifactPolicy(projectPath);
    if (passed.status !== 'passed') {
      console.error('[artifact-policy] expected passed policy check');
      console.error(JSON.stringify(passed, null, 2));
      process.exit(1);
    }

    console.log('[artifact-policy] ok');
  } finally {
    await fs.rm(projectPath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[artifact-policy] failed');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
