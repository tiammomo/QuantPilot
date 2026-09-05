import fs from 'fs/promises';
import path from 'path';
import { directoryExists, fileExists, normalizeRelativePath, readTextFile, safeRunCheck } from './files';
import { asRecord } from './inputs';
import { type QuantValidationCheck } from './contracts';

const ARTIFACT_POLICY_MAX_FILE_BYTES = 300_000;

const ARTIFACT_POLICY_ROOT_DIRS = ['app', 'components', 'hooks', 'lib', 'src', 'styles'];

const ARTIFACT_POLICY_ROOT_FILES = [
  'package.json',
  'next.config.js',
  'next.config.mjs',
  'postcss.config.js',
  'tailwind.config.js',
  'tailwind.config.ts',
];

const ARTIFACT_POLICY_SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.vercel',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

const ARTIFACT_POLICY_SOURCE_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.jsx',
  '.json',
  '.mjs',
  '.ts',
  '.tsx',
]);

const REMOTE_URL_PATTERN = /\bhttps?:\/\/[a-z0-9.-]+(?::\d+)?[^\s'"`<>){}]*/gi;

const REMOTE_USAGE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: '远程脚本', pattern: /<script[^>]+src=["']https?:\/\/[^"']+["']/gi },
  { label: '远程样式', pattern: /<link[^>]+href=["']https?:\/\/[^"']+["']/gi },
  { label: 'CSS 远程资源', pattern: /(?:@import\s+(?:url\()?["']?https?:\/\/|url\(\s*["']?https?:\/\/)[^'")\s]+/gi },
  { label: '远程模块导入', pattern: /(?:\bfrom\s+["']https?:\/\/[^"']+["']|\bimport\s*\(\s*["']https?:\/\/[^"']+["']\s*\))/gi },
  { label: '浏览器直连外部接口', pattern: /\b(?:fetch|new\s+EventSource|new\s+WebSocket)\s*\(\s*["']https?:\/\/[^"']+["']/gi },
  { label: '远程媒体资源', pattern: /<(?:img|source|iframe)[^>]+(?:src|srcSet)=["']https?:\/\/[^"']+["']/gi },
];

const SENSITIVE_ARTIFACT_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: '明文 API key', pattern: /\b(?:sk|sk-proj|sk-ant|sk-cp)-[a-z0-9_-]{16,}\b/i },
  { label: 'Bearer token', pattern: /\bbearer\s+[a-z0-9._-]{16,}\b/i },
  {
    label: '环境变量密钥字面量',
    pattern: /\b(?:DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|MINIMAX_API_KEY|CODEX_OPENAI_API_KEY)\s*[:=]\s*["'][^"'\n]{8,}["']/i,
  },
  { label: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
];

const EXECUTION_ESCAPE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  {
    label: 'Node 宿主能力导入',
    pattern: /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](?:node:)?(?:child_process|cluster|dgram|dns|http2?|https|inspector|module|net|os|process|tls|vm|worker_threads)["']/i,
  },
  { label: 'CommonJS 动态加载', pattern: /\brequire\s*\(/i },
  { label: '动态模块加载', pattern: /\bimport\s*\(/i },
  {
    label: '宿主 process 特权访问',
    pattern: /\bprocess\s*(?:\.\s*(?:env|binding|chdir|dlopen|getBuiltinModule|mainModule)|\[\s*["'](?:env|binding|chdir|dlopen|getBuiltinModule|mainModule)["'])/i,
  },
  { label: '动态代码执行', pattern: /\b(?:eval|Function)\s*\(|\bWebAssembly\b/i },
  { label: '子进程执行 API', pattern: /\b(?:execFileSync|execFile|execSync|spawnSync|spawn|fork)\s*\(/i },
  { label: '非受控网络客户端', pattern: /\bnew\s+(?:EventSource|WebSocket|XMLHttpRequest)\b|\bsendBeacon\s*\(/i },
  { label: '宿主绝对路径', pattern: /["'](?:\/(?:etc|home|proc|root|run|sys|var\/run)\/|[a-z]:\\(?:users|windows)\\)/i },
];

const MOCK_ARTIFACT_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  {
    label: 'mock/sample 静态数据变量',
    pattern:
      /\b(?:MOCK|SAMPLE|DEMO|PLACEHOLDER|STATIC)_(?:DATA|QUOTE|QUOTES|KLINE|KLINES|HISTORY|FINANCIALS|REPORTS|ANNOUNCEMENTS|DASHBOARD_DATA)\b/i,
  },
  {
    label: 'mock/sample 静态数据命名',
    pattern:
      /\b(?:mockData|sampleData|demoData|placeholderData|staticQuotes|staticKlines|staticFinancials|staticDashboardData)\b/,
  },
  { label: '示例或模拟数据标记', pattern: /lorem ipsum|假数据|模拟数据|示例数据|样例数据|占位数据/i },
];

const DISCOURAGED_VISUALIZATION_DEPENDENCIES = new Set([
  '@visx/visx',
  'chart.js',
  'd3',
  'echarts',
  'plotly.js',
  'recharts',
]);

function truncatePolicySnippet(value: string, limit = 180): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= limit) {
    return compact;
  }
  return `${compact.slice(0, limit)}...`;
}

function isAllowedBackendProxyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return (host === '127.0.0.1' || host === 'localhost') && port === '8000' && parsed.pathname.startsWith('/api/v1/');
  } catch {
    return false;
  }
}

async function collectArtifactPolicyFiles(projectPath: string): Promise<string[]> {
  const files: string[] = [];

  const visit = async (currentPath: string) => {
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (!ARTIFACT_POLICY_SKIP_DIRS.has(entry.name)) {
          await visit(absolutePath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const ext = path.extname(entry.name);
      if (!ARTIFACT_POLICY_SOURCE_EXTENSIONS.has(ext)) {
        continue;
      }

      const stat = await fs.stat(absolutePath).catch(() => null);
      if (!stat || stat.size > ARTIFACT_POLICY_MAX_FILE_BYTES) {
        continue;
      }

      files.push(absolutePath);
    }
  };

  for (const rootDir of ARTIFACT_POLICY_ROOT_DIRS) {
    const absoluteRoot = path.join(projectPath, rootDir);
    if (await directoryExists(absoluteRoot)) {
      await visit(absoluteRoot);
    }
  }

  for (const rootFile of ARTIFACT_POLICY_ROOT_FILES) {
    const absoluteFile = path.join(projectPath, rootFile);
    if (await fileExists(absoluteFile)) {
      files.push(absoluteFile);
    }
  }

  return Array.from(new Set(files));
}

function findRemotePolicyViolations(projectPath: string, filePath: string, content: string): string[] {
  const relativePath = normalizeRelativePath(projectPath, filePath);
  const isMarketProxyRoute =
    relativePath === 'app/api/market/route.ts' ||
    /^app\/api\/market\/.*\/route\.ts$/.test(relativePath);
  const violations: string[] = [];

  for (const usage of REMOTE_USAGE_PATTERNS) {
    usage.pattern.lastIndex = 0;
    const matches = Array.from(content.matchAll(usage.pattern)).slice(0, 3);
    for (const match of matches) {
      const snippet = match[0] ?? '';
      const urls = Array.from(snippet.matchAll(REMOTE_URL_PATTERN)).map((urlMatch) => urlMatch[0]);
      const disallowedUrls = urls.filter((url) => !(isMarketProxyRoute && isAllowedBackendProxyUrl(url)));
      if (disallowedUrls.length > 0) {
        violations.push(`${relativePath} 存在${usage.label}：${truncatePolicySnippet(snippet)}`);
      }
    }
  }

  REMOTE_URL_PATTERN.lastIndex = 0;
  const remoteUrls = Array.from(content.matchAll(REMOTE_URL_PATTERN)).map((match) => match[0]);
  for (const remoteUrl of remoteUrls.slice(0, 8)) {
    if (isMarketProxyRoute && isAllowedBackendProxyUrl(remoteUrl)) {
      continue;
    }

    if (/nextjs\.org|react\.dev|vercel\.com/i.test(remoteUrl) && /package\.json$|next\.config\./.test(relativePath)) {
      continue;
    }

    if (relativePath === 'package.json') {
      continue;
    }

    violations.push(`${relativePath} 存在外部 URL：${remoteUrl}`);
  }

  return Array.from(new Set(violations));
}

function findPatternPolicyViolations(
  projectPath: string,
  filePath: string,
  content: string,
  patterns: Array<{ label: string; pattern: RegExp }>
): string[] {
  const relativePath = normalizeRelativePath(projectPath, filePath);
  const violations: string[] = [];

  for (const { label, pattern } of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(content);
    if (match?.[0]) {
      violations.push(`${relativePath} 存在${label}：${truncatePolicySnippet(match[0])}`);
    }
  }

  return violations;
}

function collectVisualizationDependencyWarnings(projectPath: string, packageRaw: string | null): string[] {
  if (!packageRaw) {
    return [];
  }

  try {
    const parsed = JSON.parse(packageRaw) as Record<string, unknown>;
    const dependencyNames = [
      ...Object.keys(asRecord(parsed.dependencies) ?? {}),
      ...Object.keys(asRecord(parsed.devDependencies) ?? {}),
    ];
    return dependencyNames
      .filter((dependency) => DISCOURAGED_VISUALIZATION_DEPENDENCIES.has(dependency))
      .map(
        (dependency) =>
          `${normalizeRelativePath(projectPath, path.join(projectPath, 'package.json'))} 引入 ${dependency}，生成看板优先使用平台内置 SVG/CSS 图表，避免额外依赖拖慢 build。`
      );
  } catch {
    return [];
  }
}

export async function checkArtifactPolicy(
  projectPath: string
): Promise<Omit<QuantValidationCheck, 'id' | 'name' | 'durationMs'>> {
  const requiredArtifacts = [
    '.data-agent/finance-run-plan.json',
    'app/page.tsx',
    'data_file/final/dashboard-data.json',
    'evidence/sources.json',
    'evidence/data_quality.json',
  ];
  const missingArtifacts: string[] = [];
  for (const relativePath of requiredArtifacts) {
    if (!(await fileExists(path.join(projectPath, relativePath)))) {
      missingArtifacts.push(relativePath);
    }
  }

  const files = await collectArtifactPolicyFiles(projectPath);
  const violations: string[] = [];
  const warnings: string[] = [];

  if (missingArtifacts.length > 0) {
    violations.push(`缺少标准产物：${missingArtifacts.join('、')}。`);
  }

  for (const filePath of files) {
    const relativePath = normalizeRelativePath(projectPath, filePath);
    const content = await readTextFile(filePath);
    if (!content) {
      continue;
    }

    violations.push(...findRemotePolicyViolations(projectPath, filePath, content));
    violations.push(...findPatternPolicyViolations(projectPath, filePath, content, SENSITIVE_ARTIFACT_PATTERNS));

    if (/^(?:app|components|hooks|lib|src)\//.test(relativePath)) {
      violations.push(...findPatternPolicyViolations(projectPath, filePath, content, EXECUTION_ESCAPE_PATTERNS));
      if (
        relativePath !== 'app/api/market/[...path]/route.ts' &&
        /\b(?:globalThis\s*\.\s*)?fetch\s*\(/i.test(content)
      ) {
        violations.push(`${relativePath} 存在非平台 market proxy 的网络请求 API。`);
      }
      violations.push(...findPatternPolicyViolations(projectPath, filePath, content, MOCK_ARTIFACT_PATTERNS));
    }
  }

  const pagePath = path.join(projectPath, 'app', 'page.tsx');
  const page = await readTextFile(pagePath);
  if (page && !/data_file\/final\/dashboard-data\.json|data_file\\final\\dashboard-data\.json|\/api\/market/.test(page)) {
    violations.push('app/page.tsx 没有使用标准 final 数据文件或 /api/market 同源接口。');
  }

  const packageRaw = await readTextFile(path.join(projectPath, 'package.json'));
  warnings.push(...collectVisualizationDependencyWarnings(projectPath, packageRaw));

  if (violations.length > 0) {
    return {
      status: 'failed',
      summary: '生成产物未满足 QuantPilot 硬约束。',
      details: violations.slice(0, 20).join('\n'),
      metadata: {
        checkedFiles: files.length,
        violationCount: violations.length,
        warningCount: warnings.length,
      },
    };
  }

  if (warnings.length > 0) {
    return {
      status: 'warning',
      summary: '生成产物满足硬约束，但存在可优化依赖。',
      details: warnings.slice(0, 10).join('\n'),
      metadata: {
        checkedFiles: files.length,
        warningCount: warnings.length,
      },
    };
  }

  return {
    status: 'passed',
    summary: '生成产物满足本地化、真实数据绑定和安全策略。',
    metadata: {
      checkedFiles: files.length,
    },
  };
}

export async function checkQuantArtifactPolicy(projectPath: string): Promise<QuantValidationCheck> {
  return safeRunCheck('artifact_policy', '生成产物策略', () =>
    checkArtifactPolicy(path.resolve(/*turbopackIgnore: true*/ projectPath))
  );
}
