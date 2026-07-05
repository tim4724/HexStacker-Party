// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  fullyParallel: true,
  retries: 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${process.env.PW_PORT || '4100'}`,
    actionTimeout: 5000,
  },
  webServer: {
    // Build first and force bundle serving (SERVE_BUNDLES=1) so the e2e project
    // runs against the real content-hashed bundle, exercising the concatenation
    // (strict-mode flattening, cross-file hoisting) that ships to users. The
    // AirConsole entries use individual files by design, so e2e-airconsole is
    // unaffected. SERVE_BUNDLES (not APP_ENV=production) keeps the dev CSP the AC
    // mock's http.airconsole.com framing needs.
    command: 'npm run build && node server/index.js',
    env: {
      ...process.env,
      PORT: process.env.PW_PORT || '4100',
      SERVE_BUNDLES: '1',
    },
    port: Number(process.env.PW_PORT || 4100),
    reuseExistingServer: false,
  },
  projects: [
    {
      name: 'e2e',
      testDir: './tests/e2e',
      testIgnore: /airconsole.*\.spec\.js/,
      use: { viewport: { width: 1280, height: 720 } },
    },
    {
      name: 'e2e-airconsole',
      testDir: './tests/e2e',
      testMatch: /airconsole.*\.spec\.js/,
      use: { viewport: { width: 1280, height: 720 } },
    },
  ],
});
