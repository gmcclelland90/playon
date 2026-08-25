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

  test("forgot password offers a host-file challenge from the login screen", async ({ page }) => {
    await page.goto("/login");
    const forgot = page.getByRole("button", { name: /forgot password/i });
    const createOwner = page.getByRole("button", { name: /create owner/i });
    await expect(forgot.or(createOwner).first()).toBeVisible({ timeout: 15_000 });
    if (await createOwner.isVisible()) return;
    await forgot.click();
    await expect(page.getByRole("button", { name: /continue/i })).toBeVisible();
    await expect(page.getByText(/password-reset\.txt|authenticator/i)).toBeVisible();
  });

  test("setup skip authenticator is offered on first run", async ({ page }) => {
    await page.goto("/");
    const createOwner = page.getByRole("button", { name: /create owner/i });
    const skip = page.getByRole("button", { name: /skip for now/i });
    const signIn = page.getByRole("button", { name: /sign in/i });
    await expect(createOwner.or(skip).or(signIn).first()).toBeVisible({ timeout: 15_000 });
    if (await skip.isVisible()) {
      await skip.click();
      return;
    }
    if (!(await createOwner.isVisible())) return;
    await page.getByLabel("Password").first().fill("password123");
    await page.getByLabel("Confirm password").fill("password123");
    await createOwner.click();
    await expect(page.getByRole("button", { name: /skip for now/i })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: /skip for now/i }).click();
  });
});
