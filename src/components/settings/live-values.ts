"use client";
import { createContext, useContext, useEffect } from "react";

const NONE: ReadonlyMap<string, string> = new Map();

/**
 * What the text fields on screen hold now, by the row each draws, so the
 * search finds a row by its field's current text, typed and not yet
 * saved included. Only plain text fields report here: a password field
 * and a new token's secret never do, and a row its tab declares secret
 * stays out of the search whatever is reported under it.
 */
export class LiveValues {
  private values: ReadonlyMap<string, string> = NONE;
  private readonly listeners = new Set<() => void>();

  /** A field reports its current text under its row's id. */
  set(row: string, text: string): void {
    if (this.values.get(row) === text) return;
    this.values = new Map(this.values).set(row, text);
    this.notify();
  }

  /** A field that leaves the page reports nothing. */
  remove(row: string): void {
    if (!this.values.has(row)) return;
    const next = new Map(this.values);
    next.delete(row);
    this.values = next;
    this.notify();
  }

  /** What is reported now; the same map until something changes. */
  readonly snapshot = (): ReadonlyMap<string, string> => this.values;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** The Settings page's live values; none outside it. */
export const LiveContext = createContext<LiveValues | null>(null);

/** A text field's current text, reported under the row it draws while it is on screen. */
export function useLiveValue(row: string, text: string) {
  const live = useContext(LiveContext);
  useEffect(() => { live?.set(row, text); }, [live, row, text]);
  useEffect(() => () => live?.remove(row), [live, row]);
}
