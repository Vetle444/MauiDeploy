import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.browser.spec.ts',
  outputDir: './test-results',
  reporter: 'list',
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:4175',
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    trace: 'off',
    screenshot: 'off',
  },
  webServer: [{
    command: 'npm run build && npm run preview -- --port 4175 --strictPort',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: false,
  }, {
    command: 'npm run preview -- --mode toolbox --port 4176 --strictPort',
    url: 'http://127.0.0.1:4176/toolbox.html',
    reuseExistingServer: false,
  }],
});