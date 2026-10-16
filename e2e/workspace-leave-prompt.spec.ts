import { test, expect, type Page } from "@playwright/test";

/**
 * A Back or Forward no page keeps reloads the workspace's document at the
 * address the browser shows. When the page on screen holds unsaved work,
 * the browser asks before the document goes, and a person who answers Stay
 * keeps the page as it was: shown, and still answering the next step.
 *
 * The unsaved work is stood in for by a leave question the test arms on the
 * page, the same question any page holding unsaved work arms.
 */

const armLeaveQuestion = (page: Page) => page.evaluate(() => {
  const ask = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
  (window as unknown as { leaveQuestion: typeof ask }).leaveQuestion = ask;
  window.addEventListener("beforeunload", ask);
});
const disarmLeaveQuestion = (page: Page) => page.evaluate(() => {
  window.removeEventListener("beforeunload", (window as unknown as { leaveQuestion: (event: Event) => void }).leaveQuestion);
});

test("a Back answered Stay at the browser's leave question leaves the page shown, and the next step still reloads", async ({ page }) => {
  await page.goto("/maps");
  await expect(page.getByRole("heading", { name: "Maps", exact: true })).toBeVisible();
  await page.locator('a[href="/data"]').first().click();
  await expect(page).toHaveURL(/\/data$/);
  const data = page.getByRole("heading", { name: "Data", exact: true });
  await expect(data).toBeVisible();

  await armLeaveQuestion(page);
  // The browser asks only on a page the person has used.
  await page.keyboard.press("Shift");
  const [question] = await Promise.all([
    page.waitForEvent("dialog"),
    page.evaluate(() => { history.back(); }),
  ]);
  expect(question.type()).toBe("beforeunload");
  await question.dismiss();

  // Stay: the page on screen is the one the person was using, shown.
  expect(await page.evaluate(() => document.documentElement.hidden)).toBe(false);
  await expect(data).toBeVisible();

  // The next step is still answered: with nothing left to ask about, the
  // document reloads at the address the step arrives at.
  await disarmLeaveQuestion(page);
  await Promise.all([
    page.waitForEvent("load"),
    page.evaluate(() => { history.forward(); }),
  ]);
  await expect(page).toHaveURL(/\/data$/);
  await expect(data).toBeVisible();
});
