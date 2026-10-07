"use client";
import type { ReactNode } from "react";
import { ChoiceGroup } from "@/components/ui/ChoiceGroup";
import styles from "./PictureChoice.module.css";

export interface PictureOption<T extends string> {
  value: T;
  /** The card's words under its picture, and its accessible name. */
  label: string;
  /** What the option looks like, drawn in the card's 16:10 box. */
  picture: ReactNode;
}

/**
 * A settings row's choice drawn as picture cards, the picked one marked.
 * It is the shipped choice group under the cards: one radio group named by
 * its row, one tab stop on the picked card, the arrows moving the pick and
 * the focus together, wrapping at either end. The picture is how the
 * option looks, never its name, so it stays out of the accessible name.
 * Cards sit in even columns, the same size in every row of a tab.
 */
export function PictureChoice<T extends string>({ label, value, onChange, choices, disabled = false }: {
  /** The row's label: the group's accessible name. */
  label: string;
  value: T;
  onChange: (next: T) => void;
  choices: readonly PictureOption<T>[];
  disabled?: boolean;
}) {
  return <ChoiceGroup label={label} value={value} onChange={onChange} disabled={disabled}
    className={styles.pictures} itemClassName={styles.card}
    choices={choices.map(choice => ({
      value: choice.value,
      label: <>
        <span className={styles.box} data-picture-box aria-hidden="true">{choice.picture}</span>
        <span className={styles.name}>{choice.label}</span>
      </>,
    }))} />;
}
