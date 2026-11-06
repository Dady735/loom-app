import { defineConfig } from '@playwright/test';
import chromium, { inflate } from '@sparticuz/chromium';

// The packaged browser ships its NSS/NSPR libraries for minimal Linux hosts.
await inflate(`${process.cwd()}/node_modules/@sparticuz/chromium/bin/al2023.tar.br`);
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3100',
    headless: true,
    viewport: { width: 1440, height: 1050 },
    launchOptions: { executablePath: await chromium.executablePath(), args: chromium.args },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'rm -rf .test-data/e2e && NODE_ENV=test DATA_DIR=.test-data/e2e PORT=3100 HOST=127.0.0.1 npx tsx server/index.ts',
    url: 'http://127.0.0.1:3100/api/health',
    reuseExistingServer: false,
    timeout: 60000,
  },
});
