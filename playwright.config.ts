import { defineConfig } from 'playwright/test';
import { loadProjectEnvironment } from './scripts/shared/load-env';

loadProjectEnvironment();

// A dedicated loopback server and empty workspace keep these UI contracts
// independent of local accounts, research data and external services.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  outputDir: 'test-results/product-health',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:3107',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.QUANTPILOT_CHROMIUM_EXECUTABLE_PATH || undefined },
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light' } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: 'node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3107',
    wait: { stdout: /Ready in/ },
    timeout: 60_000,
    env: {
      QUANTPILOT_AUTH_MODE: 'disabled',
      QUANTPILOT_DEGRADATION_MODE: 'offline',
      QUANTPILOT_DATABASE_ENABLED: '0',
      QUANTPILOT_KNOWLEDGE_ENABLED: '0',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused?connect_timeout=1',
      PROJECTS_DIR: './tmp/e2e-product-health-projects',
    },
  },
});
