import { expect, test } from "@playwright/test";

/**
 * Opt-in UI smoke. Requires API + web already running, or Playwright webServer
 * from playwright.config.ts when `pnpm test:e2e` is used.
 */
test.describe("PlayOn MVP smoke", () => {
  test("player panel loads", async ({ page }) => {
    await page.goto("/play");
    await expect(page.getByRole("heading", { name: /Play/i })).toBeVisible();
  });

  test("setup or login shell is reachable", async ({ page }) => {
    await page.goto("/");
    const setup = page.getByRole("heading", { name: /owner|setup|playon/i });
    const login = page.getByRole("button", { name: /log in|sign in/i });
    const chat = page.getByRole("heading", { name: /agent chat/i });
    await expect(setup.or(login).or(chat).first()).toBeVisible({ timeout: 15_000 });
  });
});
