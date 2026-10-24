import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cssRules } from "../testing/css-rules";
import { HostEvent, installDomHost, type HostElement } from "../testing/dom-host";
import { Face, pictureAddress } from "./Face";

/**
 * A person's face in its host's circle. Each host keeps its own rule for
 * the letters (the side menu and the Users rows take the first two words,
 * the sharing marks the first and the last) and hands them in: the face
 * draws them as given until the picture has loaded, hides them after so a
 * transparent picture shows the circle's own colour, and shows them again
 * when the picture fails. A person without a picture asks for none.
 */

let host: ReturnType<typeof installDomHost>;
let container: HostElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
});

type Person = { sqlName: string; pictureVersion?: string };
async function draw(person: Person, letters: string, extra: Record<string, unknown> = {}) {
  await act(async () => root.render(<Face person={person} letters={letters} className="hostCircle" {...extra} />));
  return container.querySelector("span")!;
}
const image = () => container.querySelector("img");
const fire = async (type: "load" | "error") => {
  await act(async () => { image()!.dispatchEvent(new HostEvent(type)); });
};

describe("a person's face", () => {
  it("without a picture shows the host's letters in the host's circle and asks for nothing", async () => {
    const face = await draw({ sqlName: "ada_byron_king" }, "AB");
    expect(face.textContent).toBe("AB");
    expect(face.className.split(" ")).toContain("hostCircle");
    expect(face.getAttribute("aria-hidden")).toBe("true");
    expect(face.getAttribute("data-face")).toBe("letters");
    expect(image()).toBeNull();
  });

  it.each([
    ["the first two words", "AB"],
    ["the first and the last word", "AK"],
  ])("draws the letters under each host's own rule as given, %s of a three-word name", async (_, letters) => {
    const face = await draw({ sqlName: "ada_byron_king", pictureVersion: "v1" }, letters);
    expect(face.textContent).toBe(letters);
  });

  it("asks for the picture by its version, keeps the letters until it loads and hides them after", async () => {
    const face = await draw({ sqlName: "ada_byron_king", pictureVersion: "k3/x+y" }, "AB");
    expect(image()!.getAttribute("src")).toBe("/api/accounts/ada_byron_king/picture?v=k3%2Fx%2By");
    expect(image()!.getAttribute("alt")).toBe("");
    expect(face.textContent).toBe("AB");
    expect(face.getAttribute("data-face")).toBe("letters");
    await fire("load");
    expect(face.textContent).toBe("");
    expect(face.getAttribute("data-face")).toBe("picture");
    expect(image()).not.toBeNull();
  });

  it("shows the letters again when the picture fails, and asks again for a new version", async () => {
    const face = await draw({ sqlName: "ada", pictureVersion: "v1" }, "A");
    await fire("error");
    expect(image()).toBeNull();
    expect(face.textContent).toBe("A");
    expect(face.getAttribute("data-face")).toBe("letters");
    await draw({ sqlName: "ada", pictureVersion: "v2" }, "A");
    expect(image()!.getAttribute("src")).toBe(pictureAddress("ada", "v2"));
    expect(face.textContent).toBe("A");
  });

  it("goes back to the letters while a replaced picture loads, and to them alone once it is removed", async () => {
    const face = await draw({ sqlName: "ada", pictureVersion: "v1" }, "A");
    await fire("load");
    await draw({ sqlName: "ada", pictureVersion: "v2" }, "A");
    expect(image()!.getAttribute("src")).toBe(pictureAddress("ada", "v2"));
    expect(face.textContent).toBe("A");
    await fire("load");
    expect(face.textContent).toBe("");
    await draw({ sqlName: "ada" }, "A");
    expect(image()).toBeNull();
    expect(face.textContent).toBe("A");
  });

  it("keeps the host's marks, such as a deactivated person's dimming, on the circle", async () => {
    const face = await draw({ sqlName: "ada", pictureVersion: "v1" }, "A", { "data-off": true });
    expect(face.getAttribute("data-off")).toBe("true");
  });
});

describe("the face's stylesheet", () => {
  const rules = cssRules("src/components/people/Face.module.css");
  it("draws the picture round over the whole circle", () => {
    const picture = rules.filter((rule) => rule.selector === ".picture").map((rule) => rule.body).join(";");
    expect(picture).toMatch(/border-radius:\s*50%/);
    expect(picture).toMatch(/object-fit:\s*cover/);
    expect(picture).toMatch(/inset:\s*0/);
  });
  it("paints no background of its own, so a transparent picture shows the host's circle", () => {
    expect(rules.filter((rule) => /background/.test(rule.body))).toEqual([]);
  });
  it("sets nothing a host's circle sets: size, colour and type stay the host's", () => {
    const face = rules.filter((rule) => rule.selector === ".face").map((rule) => rule.body).join(";");
    expect(face).not.toMatch(/(^|[;\s])(width|height|color|font|border-radius|opacity)\s*:/);
  });
});
