"use client";

import type { ModelKnowledge } from "@/lib/assistant/model-knowledge";
import { CheckIcon } from "../../ui/icons";
import { menuEfforts, type ModelChoice } from "./model-choice";
import styles from "./ModelPicker.module.css";

/**
 * The picker's menu: the offered models, each with the identity a request
 * would name, and the selected model's own effort levels beneath them.
 *
 * The levels follow the selection, not the instance default, because a
 * level is one model's own word; a model Dezfil knows no levels
 * for brings no effort section at all, since its one entry is what a
 * request with no effort already sends and there is nothing to choose.
 * That states what Dezfil supports, never that the provider lacks the
 * capability.
 *
 * The levels are rows of the same list as the models, one per level with
 * the tick on the current one (a field round):
 * a horizontal segmented control cramped six of them at the pane's width.
 * The menu's ceiling is the room the picker measures inside the pane, and
 * it scrolls inside only when the list would not fit.
 */
export function ModelMenu({ models, choice, onPickModel, onPickEffort, itemRef }: {
  models: ModelKnowledge[];
  choice: ModelChoice;
  onPickModel: (id: string) => void;
  onPickEffort: (value: string) => void;
  /** The keyboard walk's hold on each item, in render order. */
  itemRef?: (index: number) => (element: HTMLButtonElement | null) => void;
}) {
  const efforts = menuEfforts(models, choice.model);
  const at = (index: number) => (itemRef ? { ref: itemRef(index) } : {});
  return (
    <div className={styles.menu} role="menu" aria-label="Model and effort" data-model-menu>
      <p className={styles.head}>Model</p>
      {models.map((model, index) => (
        <button
          key={model.id}
          type="button"
          className={styles.item}
          data-model={model.id}
          role="menuitemradio"
          aria-checked={model.id === choice.model}
          onClick={() => onPickModel(model.id)}
          {...at(index)}
        >
          <span className={styles.words}>
            <b>{model.name}</b>
            {model.name !== model.id && <span className={styles.identity}>{model.id}</span>}
          </span>
          <span className={styles.tick}><CheckIcon /></span>
        </button>
      ))}
      {efforts.length > 0 && (
        <>
          <div className={styles.separator} />
          <p className={styles.head}>Effort</p>
          <div role="group" aria-label="Effort">
            {efforts.map((level, index) => (
              <button
                key={level.value}
                type="button"
                className={`${styles.item} ${styles.level}`}
                data-effort={level.value}
                role="menuitemradio"
                aria-checked={level.value === choice.effort}
                onClick={() => onPickEffort(level.value)}
                {...at(models.length + index)}
              >
                <span className={styles.label}>{level.label}</span>
                <span className={styles.tick}><CheckIcon /></span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
