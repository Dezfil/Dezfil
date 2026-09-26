"use client";

import { useRef, type ReactNode } from "react";

export type Choice<T extends string> = {
  value: T;
  label: ReactNode;
  name?: string;
  disabled?: boolean;
  /** Why this choice is unavailable — a disabled segment that cannot say
   * why is a dead end. */
  title?: string;
};

/** A set of mutually exclusive values shown as segments.
 *
 * Not tabs: a tab reveals a panel, and a strip that declares tab roles
 * while owning no tabpanel describes something it is not (the query-area
 * picker did exactly that). This is a radio group — one tab stop, arrows
 * moving the choice, the selected value carried by aria-checked — and it
 * contributes no look, so an adopting surface keeps its own segments. */
export function ChoiceGroup<T extends string>({
  label,
  value,
  onChange,
  choices,
  disabled = false,
  className,
  style,
  itemClassName,
}: {
  label: string;
  value: T;
  onChange: (next: T) => void;
  choices: readonly Choice<T>[];
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  itemClassName?: string;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const selectable = disabled ? [] : choices.filter((c) => !c.disabled);

  const move = (delta: number) => {
    if (selectable.length === 0) return;
    const at = selectable.findIndex((c) => c.value === value);
    const next =
      selectable[
        (Math.max(at, 0) + delta + selectable.length) % selectable.length
      ];
    if (!next || next.value === value) return;
    onChange(next.value);
    const index = choices.findIndex((c) => c.value === next.value);
    groupRef.current
      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
      [index]?.focus();
  };

  // The single tab stop must land on a focusable radio: the checked
  // choice when it is enabled, else the first enabled choice — a
  // disabled button cannot take focus, and a group whose only stop is
  // disabled is unreachable (picker made this edge real).
  const stopIndex = (() => {
    if (disabled) return -1;
    const checkedAt = choices.findIndex(
      (c) => c.value === value && !c.disabled,
    );
    if (checkedAt !== -1) return checkedAt;
    return choices.findIndex((c) => !c.disabled);
  })();

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={className}
      style={style}
      onKeyDown={(e) => {
        if (disabled) return;
        const step =
          e.key === "ArrowRight" || e.key === "ArrowDown"
            ? 1
            : e.key === "ArrowLeft" || e.key === "ArrowUp"
              ? -1
              : null;
        if (step === null) return;
        e.preventDefault();
        move(step);
      }}
    >
      {choices.map((choice, i) => {
        const checked = choice.value === value;
        const choiceDisabled = disabled || choice.disabled;
        // A disabled choice's reason: the styled hint shows it on
        // hover, and a hidden description keeps it for assistive
        // technology — a bubble alone would erase it there.
        const reasonId =
          choiceDisabled && choice.title
            ? `choice-reason-${label.replace(/\s+/g, "-")}-${choice.value}`
            : undefined;
        return (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={choice.name}
            data-hint={choiceDisabled ? choice.title : undefined}
            data-hint-always={choiceDisabled && choice.title ? "" : undefined}
            aria-describedby={reasonId}
            disabled={choiceDisabled}
            data-active={checked || undefined}
            className={itemClassName}
            tabIndex={i === stopIndex ? 0 : -1}
            onClick={() => onChange(choice.value)}
          >
            {choice.label}
            {reasonId && (
              <span id={reasonId} hidden>
                {choice.title}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
