import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3197",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npm run build && node --import tsx packages/pth-console/e2e/operator-server.ts",
    cwd: "../..",
    url: "http://127.0.0.1:3197",
    reuseExistingServer: false,
    timeout: 180_000,
  },
  snapshotPathTemplate: "{testDir}/screenshots/{arg}{ext}",
});
