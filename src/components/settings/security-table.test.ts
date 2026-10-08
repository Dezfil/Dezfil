import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readInstanceSettings } from "@/lib/settings/read";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { PUBLIC_LINKS_CARD, RULE_CHOICE_WORDS, RULE_LABELS, ruleRefusalWords, ruleRowWords, ruleRows, SECURITY_CARDS, sitesList, sitesText } from "./security-table";
import { instanceReadFixture } from "./read-fixture";

/**
 * The Security tab's and the Public links card's table, held against the
 * configuration read the server answers: every sign-in, token, publishing
 * and embedding setting an admin may change has a row, every row names a
 * setting the read carries, and every choice is worded exactly as the
 * read offers it.
 */

let fixture: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { fixture = instanceSettingsFixture(); });
afterEach(() => fixture.close());
// Through the wire, as the page receives it.
const read = () => JSON.parse(JSON.stringify(readInstanceSettings(fixture.context, fixture.db)));
type Read = Record<string, { kind: string; editable: boolean; environment?: string; write?: { kind: string; values?: string[]; min?: number; max?: number } }>;

describe("the Security and Public links table against the read", () => {
  it("gives every sign-in, token, publishing and embedding setting a row, and names nothing the read lacks", () => {
    const settings: Read = read().settings;
    const families = ["security", "tokens", "publishing"];
    const expected = Object.keys(settings).filter(key => families.includes(key.split(".")[0]) && settings[key].editable);
    const drawn = ruleRows().flatMap(row => row.fields.map(field => field.key));
    expect(new Set(drawn).size).toBe(drawn.length);
    expect([...drawn].sort()).toEqual([...expected].sort());
    expect(drawn).toHaveLength(10);
    for (const key of drawn) {
      expect(settings[key]?.editable, key).toBe(true);
      expect(settings[key]?.environment, key).toBeUndefined();
    }
    // The two rules on connections and link imports are drawn with Data & services.
    expect(drawn).not.toContain("connections.create");
    expect(drawn).not.toContain("imports.links");
  });

  it("words every choice exactly as the read offers it, and draws each number within the read's range", () => {
    const settings: Read = read().settings;
    for (const [key, words] of Object.entries(RULE_CHOICE_WORDS)) {
      expect(settings[key].write?.kind, key).toBe("choice");
      expect(Object.keys(words), key).toEqual(settings[key].write!.values);
    }
    const numbers = ruleRows().filter(row => row.draw === "numbers").flatMap(row => row.fields.map(field => field.key));
    expect(numbers.map(key => [key, settings[key].write?.min, settings[key].write?.max])).toEqual([
      ["security.failedPerAccount", 3, 100], ["security.failedPerAddress", 10, 1000], ["security.passwordMin", 8, 64],
    ]);
    expect(settings["publishing.embedSites"].write?.kind).toBe("sites");
  });

  it("lays out the cards in the order and under the labels the page shows", () => {
    expect(SECURITY_CARDS.map(card => [card.title, card.rows.map(row => row.label)])).toEqual([
      ["Sign-in", ["Stay signed in for", "Invite and reset links last", "Failed sign-ins before a pause", "Shortest password"]],
      ["API tokens", ["Who may create tokens", "New tokens expire after"]],
    ]);
    expect([PUBLIC_LINKS_CARD.title, PUBLIC_LINKS_CARD.rows.map(row => row.label)]).toEqual(["Public links", ["Who may publish", "Embedding on other sites"]]);
    const ids = [...SECURITY_CARDS, PUBLIC_LINKS_CARD].flatMap(card => [card.id, ...card.rows.map(row => row.id)]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(RULE_LABELS).toMatchObject({
      "security.failedPerAccount": "Failed sign-ins per account", "security.passwordMin": "Shortest password",
      "publishing.embedSites": "Sites that may embed published maps", "tokens.expiry": "New tokens expire after",
    });
  });
});

describe("the words the page shows", () => {
  it("names a refused setting by its label, and the two rows that only hold together in one sentence", () => {
    expect(ruleRefusalWords("security.failedPerAddress must be at least security.failedPerAccount.")).toEqual({
      text: "Allow at least as many per address as per account.", together: true });
    expect(ruleRefusalWords("publishing.embedSites must list at least one site while publishing.embedding is listed.")).toEqual({
      text: "Add at least one site, or choose Any site.", together: true });
    expect(ruleRefusalWords("Expected a whole number from 8 to 64 for security.passwordMin.")).toEqual({
      text: "Expected a whole number from 8 to 64 for Shortest password.", together: false });
  });

  it("shows the listed sites one per line and sends them with blank lines dropped", () => {
    expect(sitesText(["https://www.stadtwerke.example", "http://intranet.example:8080"])).toBe("https://www.stadtwerke.example\nhttp://intranet.example:8080");
    expect(sitesText(null)).toBe("");
    expect(sitesList("  https://a.example \n\n \nhttp://b.example:8080\n")).toEqual(["https://a.example", "http://b.example:8080"]);
    expect(sitesList("")).toEqual([]);
  });

  it("reads each row's value as its card shows it", () => {
    const words = (stored: Record<string, unknown>) => {
      const answer = instanceReadFixture(Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, { value, source: "stored" as const, storedValue: value }])));
      return Object.fromEntries(ruleRows().map(row => [row.label, ruleRowWords(row, answer.settings)]));
    };
    expect(words({})).toEqual({
      "Stay signed in for": "30 days", "Invite and reset links last": "7 days", "Failed sign-ins before a pause": "5 per account, 20 per address",
      "Shortest password": "8 characters", "Who may create tokens": "Everyone", "New tokens expire after": "Never",
      "Who may publish": "Everyone", "Embedding on other sites": "Any site",
    });
    expect(words({ "publishing.embedding": "listed", "publishing.embedSites": ["https://a.example", "http://b.example:8080"], "tokens.expiry": "1y" }))
      .toMatchObject({ "Embedding on other sites": "Listed sites: https://a.example, http://b.example:8080", "New tokens expire after": "1 year" });
  });
});
