import { defineConfig, devices } from "@playwright/test";

// Optional override for sandboxes with a preinstalled browser. CI leaves it unset and uses `playwright install`.
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://localhost:3000",
    // Service workers would bypass page.route mocks, so the e2e run keeps them off.
    serviceWorkers: "block",
    trace: "retain-on-failure",
    launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // The app builds in standalone mode (traced from the monorepo root), so the server runs from
    // .next/standalone/apps/web with its static files copied in.
    command:
      "next build && cp -r .next/static .next/standalone/apps/web/.next/ && cp -r public .next/standalone/apps/web/ && PORT=3000 node .next/standalone/apps/web/server.js",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
});
