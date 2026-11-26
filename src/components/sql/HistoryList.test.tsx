import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HistoryList } from "./HistoryList";
import type { HistoryEntry } from "./sql-history";
import styles from "./SqlConsole.module.css";

/**
 * A History card shows its query as SQL: the saved text with its tokens
 * marked as the editor's grammar reads them, and as its title the tables
 * the query reads, written as the SQL wrote them. The words the app adds
 * to a title (the count of tables past the first two, and "Query" where
 * none was recognized) are its own, apart from those names.
 */

const entry = (over: Partial<HistoryEntry>): HistoryEntry => ({
  id: "h1",
  sql: "SELECT name FROM parks",
  at: new Date().toISOString(),
  ok: true,
  rows: 3,
  ms: 4,
  code: null,
  tables: ["parks"],
  ...over,
});

const render = (entries: HistoryEntry[]) =>
  renderToStaticMarkup(
    <HistoryList entries={entries} geometryOf={() => undefined} onLoad={() => {}} onRun={() => {}} onRemove={() => {}} onClear={() => {}} />,
  );

describe("a History card", () => {
  it("titles itself with the SQL names the query reads, and sets the app's count apart", () => {
    const html = render([entry({ tables: ["parks", "jonas_weber.bike_racks", "roads"] })]);
    expect(html).toContain(
      `<span class="${styles.cardTitle}">parks + jonas_weber.bike_racks<span class="${styles.cardRest}"> + 1 more</span></span>`,
    );
  });

  it("titles a query that reads one table with its name alone", () => {
    expect(render([entry({ tables: ["parks"] })])).toContain(`<span class="${styles.cardTitle}">parks</span>`);
  });

  it("marks the stand-in title of a query that reads no known table as a word", () => {
    expect(render([entry({ tables: [], sql: "SELECT 1" })])).toContain(`<span class="${styles.cardTitle}" data-plain="">Query</span>`);
  });

  it("shows the saved query as SQL, its keywords marked as the editor marks them", () => {
    const html = render([entry({})]);
    expect(html).toContain(`<div class="${styles.cardSql}"`);
    expect(html).toContain(`<span class="${styles.tkKw}">SELECT</span>`);
    expect(html).toContain(`<span class="${styles.tkKw}">FROM</span>`);
  });
});
