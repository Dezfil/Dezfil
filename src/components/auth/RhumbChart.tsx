import { createElement } from "react";
import chart from "./entry-chart.json";
import styles from "./EntryScreen.module.css";

/** A still chart: sixteen winds, a coastline, soundings and harbour routes. */
export function RhumbChart() {
  return <svg className={styles.art} viewBox="0 0 600 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    {chart.map(({ tag, attrs }, index) => {
      const { class: classes, ...attributes } = attrs;
      return createElement(tag, { ...attributes, key: index, className: classes.split(" ").map(name => styles[name]).join(" ") });
    })}
  </svg>;
}
