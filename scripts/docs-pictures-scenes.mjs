// The picture script's scene list: one entry per picture or recording the
// documentation carries. "Every scene" means this list, and a manifest row's
// scene is one of its ids. Every scene is taken in both of the app's themes:
// `file` and `poster` name the light take, which is what pages and the
// README name, and the dark take is written beside each with `.dark` before
// the extension.
//
// Each scene names:
// - `id`, the scene, and `file`, its light take's file under docs/images/;
// - `pages`, the pages that use it (for the author: the page contract holds
//   the use);
// - `kind`, a still or a recording;
// - `state`, the instance state it is taken in: `fresh` before any account
//   exists, `seeded` after the seeding, signed in as the first account. The
//   script takes every fresh scene before it seeds;
// - `crop`, when the picture is not the full frame: the element to frame
//   and the margin around it, in CSS pixels; the rectangle it comes to is
//   declared in the scene's manifest rows and shared by its two takes;
// - `open`, how the page is brought to the scene's first frame;
// - for a recording, `poster`, its poster's file, and `steps`: each one an
//   optional action, after which the page is settled and the frame is held
//   for `hold` frames of the cadence (ten a second), so the recording's
//   length is the frames held, at most eight seconds.

/** Open the Templates page and wait until the catalogue has been read and
 * the three shipped cards are drawn with their pictures. */
async function openTemplates(page) {
  const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/templates/refresh" && response.request().method() === "POST");
  await page.goto("/templates");
  const answer = await refreshed;
  if (!answer.ok()) throw new Error(`The template catalogue read answered ${answer.status()}.`);
  await page.locator("article[data-template]").nth(2).waitFor();
  if (await page.locator("[data-catalogue-line]").count()) throw new Error("The Templates page shows a catalogue line: the catalogue folder was not read as listed.");
}

export const SCENES = [
  {
    id: "setup-card",
    file: "start/setup-card.webp",
    pages: ["docs/start/install.md"],
    kind: "still",
    state: "fresh",
    crop: { selector: "main > div", margin: 48 },
    async open(page) {
      await page.goto("/setup");
      await page.locator("form button[type=submit]:not([disabled])").waitFor();
    },
  },
  {
    id: "templates-page",
    file: "use/templates.webp",
    pages: ["README.md", "docs/use/templates.md"],
    kind: "still",
    state: "seeded",
    open: openTemplates,
  },
  {
    id: "templates-search",
    file: "use/templates-search.webm",
    poster: "use/templates-search-poster.webp",
    pages: ["docs/use/templates.md"],
    kind: "recording",
    state: "seeded",
    open: openTemplates,
    steps: [
      { hold: 10 },
      { act: (page) => page.keyboard.press("/"), hold: 5 },
      ...[..."quake"].map((letter) => ({ act: (page) => page.keyboard.type(letter), hold: 3 })),
      { hold: 20 },
    ],
  },
];

export const STATES = ["fresh", "seeded"];
