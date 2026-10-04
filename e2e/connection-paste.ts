import { expect, type Locator } from "@playwright/test";

const refusal = "This connection string uses the unsupported protection parameter channel_binding; Dezfil supports connection fields and SSL required or not required.";
export const refusedConnectionStrings = {
  uri: "postgres://changed:browser-refused-password@refused.example.org:6543/changed?channel_binding=require&oauth_scope=browser-refused-scope&sslmode=require",
  libpq: "host=refused.example.org port=6543 dbname=changed user=changed password=browser-refused-password channel_binding='require' oauth_scope='browser-refused-scope' sslmode=require",
};

/** Run against the production form; only the source HTTP result is controlled. */
export async function exerciseRefusedConnectionPaste(
  scope: Locator,
  refused: string,
  submitLabel: string,
  fixture: { failNextSave: () => void; submitted: Record<string, unknown>[] },
) {
  const reveal = scope.getByRole("button", { name: "Paste a new connection URL" });
  if (await reveal.isVisible()) await reveal.click();
  const url = scope.getByLabel(/Paste a connection URL/);
  const submit = scope.getByRole("button", { name: submitLabel, exact: true });
  await scope.getByLabel("Connection name").fill("Corrected connection");
  await url.fill("postgres://reader:browser-prior-password@prior.example.org:5433/prior?sslmode=disable");
  fixture.failNextSave();
  await submit.click();
  await expect(scope.getByRole("alert")).toContainText("Prior source failure.");
  const before = fixture.submitted.length;
  await url.fill(refused);
  await expect(scope.getByLabel("Host", { exact: true })).toHaveValue("prior.example.org");
  await expect(scope.getByLabel("Port", { exact: true })).toHaveValue("5433");
  await expect(scope.getByLabel("Database", { exact: true })).toHaveValue("prior");
  await expect(scope.getByLabel("Username", { exact: true })).toHaveValue("reader");
  await expect(scope.getByLabel("Password", { exact: true })).toHaveValue("browser-prior-password");
  await expect(scope.getByLabel("Connection name")).toHaveValue("Corrected connection");
  await expect(scope.getByLabel("Require SSL for this connection")).not.toBeChecked();
  await expect(scope.getByRole("alert")).toContainText("Prior source failure.");
  const notice = scope.locator('[data-invalid="true"]');
  await expect(notice).toHaveText(refusal);
  for (const secret of ["browser-refused-password", "browser-refused-scope", "refused.example.org", refused]) {
    await expect(notice).not.toContainText(secret);
  }
  expect(fixture.submitted).toHaveLength(before);
  await expect(submit).toBeEnabled();
  fixture.failNextSave();
  await submit.click();
  await expect.poll(() => fixture.submitted.length).toBe(before + 1);
  expect(fixture.submitted.at(-1)).toMatchObject({ host: "prior.example.org", port: "5433", database: "prior", username: "reader", password: "browser-prior-password", ssl: false });
  expect(fixture.submitted.at(-1)).not.toHaveProperty("url");
  await expect(scope.getByRole("alert")).toContainText("Prior source failure.");
  await url.fill("postgres://corrected:browser-corrected-password@corrected.example.org/corrected?sslmode=require&channel_binding=prefer");
  await expect(notice).toHaveCount(0);
  await expect(scope.getByRole("alert")).toHaveCount(0);
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect.poll(() => fixture.submitted.length).toBe(before + 2);
  expect(fixture.submitted.at(-1)).toMatchObject({ host: "corrected.example.org", password: "browser-corrected-password", ssl: true });
}
