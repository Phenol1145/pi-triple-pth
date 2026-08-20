import { expect, test, type Page } from "@playwright/test";

const TOKEN = "e".repeat(64);

let sharedPage: Page;

test.describe.configure({ mode: "serial" });

test.describe("Operator Console v1.4", () => {
  test.beforeAll(async ({ browser }) => {
    // One-time bootstrap token：整个 server 生命周期只能兑换一次，所以共享一个 page。
    const context = await browser.newContext();
    sharedPage = await context.newPage();
    sharedPage.on("pageerror", (error) => console.log(`[pageerror] ${error.stack ?? error.message}`));
    sharedPage.on("console", (message) => {
      if (message.type() === "error") console.log(`[console.error] ${message.text()}`);
    });
    await sharedPage.goto(`http://127.0.0.1:3197/#${TOKEN}`);
    await expect(sharedPage.locator("[data-page-root]").first()).toBeVisible();
    await expect(sharedPage.getByText("playwright-operator").first()).toBeVisible({ timeout: 10_000 });
  });

  test("五页导航与数据页", async () => {
    const page = sharedPage;
    await expect(page.locator('[data-page-root="overview"]')).toBeVisible();
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await expect(page.getByText("e2e-snapshot")).toBeVisible();

    await page.getByRole("button", { name: "Work", exact: true }).click();
    await expect(page.locator('[data-page-root="work"]')).toBeVisible();
    await page.getByRole("button", { name: "Debug", exact: true }).click();
    await expect(page.getByText("worker-a")).toBeVisible();
    await page.getByRole("button", { name: "Memory", exact: true }).click();
    await expect(page.getByText("idx:lean:list-map")).toBeVisible();
    await page.getByRole("button", { name: "Config", exact: true }).click();
    await expect(page.locator('[data-page-root="config"]')).toBeVisible();
    await page.getByRole("tab", { name: /PTH/ }).click();
    await expect(page.getByText("DATABASE_URL")).toBeVisible();
  });

  test("secret 零泄漏与键盘聚焦可见", async () => {
    const page = sharedPage;
    const content = await page.content();
    expect(content).not.toContain("playwright-fake-pth-token");
    expect(content).not.toContain("postgres://");

    await page.getByRole("button", { name: "Memory", exact: true }).click();
    await page.keyboard.press("Tab");
    const focusedTag = await page.evaluate(() => document.activeElement?.tagName);
    expect(focusedTag).not.toBe("BODY");
  });

  test("移动端视口仍可导航", async () => {
    const page = sharedPage;
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".sidebar")).toBeVisible();
    await page.getByRole("button", { name: "Config", exact: true }).click();
    await expect(page.locator('[data-page-root="config"]')).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("五页截图基线", async () => {
    const page = sharedPage;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
    for (const label of ["overview", "work", "debug", "memory", "config"]) {
      await page.getByRole("button", { name: label[0]!.toUpperCase() + label.slice(1), exact: true }).click();
      await expect(page.locator(`[data-page-root="${label}"]`)).toBeVisible();
      await page.waitForTimeout(400);
      await expect(page).toHaveScreenshot(`${label}.png`, { fullPage: true });
    }
  });
});
