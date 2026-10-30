import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MapNotFound from "./maps/[id]/not-found";
import WorkflowNotFound from "./workflows/[id]/not-found";
import DatasetNotFound from "./tables/[name]/not-found";
import ProjectNotFound from "./projects/[id]/not-found";
import TemplateNotFound from "./templates/[id]/not-found";
import WorkspaceNotFound from "./not-found";

/**
 * An address for one item the person cannot reach says which kind of thing
 * was not found and goes back to that kind's list. Any other address keeps
 * the workspace's generic page.
 */
const SHARED = (noun: string) =>
  `There's no ${noun} at this address, or it's in a project that isn't shared with you. If someone sent you the link, ask them to add you to the project.`;

const CASES: [ComponentType, string, string, string, string][] = [
  [MapNotFound, "Map not found", SHARED("map"), "Go to Maps", "/maps"],
  [WorkflowNotFound, "Workflow not found", SHARED("workflow"), "Go to Workflows", "/workflows"],
  [DatasetNotFound, "Dataset not found", SHARED("dataset"), "Go to Data", "/data"],
  [
    ProjectNotFound,
    "Project not found",
    "There's no project at this address, or it isn't shared with you. If someone sent you the link, ask them to add you to it.",
    "Go to Projects",
    "/projects",
  ],
  [TemplateNotFound, "Template not found", "There's no template at this address.", "Go to Templates", "/templates"],
];

const text = (s: string) => s.replaceAll("'", "&#x27;");

describe("not found for one item", () => {
  it.each(CASES)("%o says its kind and goes back to its list", (Page, title, sentence, back, href) => {
    const markup = renderToStaticMarkup(<Page />);
    expect(markup).toContain(`<h1>${title}</h1>`);
    expect(markup).toContain(`<p>${text(sentence)}</p>`);
    expect(markup).toContain(`href="${href}"`);
    expect(markup).toContain(`>${back}</a>`);
  });

  it("leaves every other address on the generic page", () => {
    const markup = renderToStaticMarkup(<WorkspaceNotFound />);
    expect(markup).toContain("<h1>Page not found</h1>");
    expect(markup).toContain("Nothing is at this address.");
    expect(markup).toContain('href="/"');
  });
});
