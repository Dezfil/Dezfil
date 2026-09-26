"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import styles from "./Menu.module.css";

/** Every item can dismiss its own menu without the caller threading a
 * closer through the tree. */
const MenuClose = createContext<() => void>(() => {});

/** One menu contract for the application, extracted from
 * the export menu — the audits' reference implementation — with the gap it
 * had closed: it moved focus into the menu only on an arrow-key opening, so
 * Enter and Space left a keyboard user's focus behind on the trigger.
 *
 * The contract: the trigger states haspopup and expanded; a keyboard
 * opening puts focus on the first item; arrows move; Escape closes and
 * returns focus to the trigger; an outside pointer closes without taking
 * focus away from whatever was clicked; scrolling or resizing closes rather
 * than leaving a menu stranded from its trigger.
 *
 * The menu portals out because cards clip their overflow and lift on hover,
 * and a transform hijacks fixed descendants. `portalTarget` exists for the
 * published page, where the menu must land inside the theme-scoped wrapper
 * so the reader's theme reaches it — the document body would strand it
 * outside. */
export function Menu({
  className,
  label,
  triggerLabel,
  triggerClassName,
  trigger,
  triggerProps,
  onOpen,
  portalTarget,
  align = "end",
  menuClassName,
  children,
  ...data
}: {
  /** Goes on the trigger's wrapper, which also carries `data-open`. */
  className?: string;
  /** Names the menu itself. */
  label: string;
  /** Names the trigger. Defaults to the menu's label. */
  triggerLabel?: string;
  triggerClassName?: string;
  trigger: ReactNode;
  triggerProps?: { title?: string; "data-hint"?: string };
  /** Runs for every opening gesture, immediately before the menu is
   * shown. Consumers use it to refresh state that is only meaningful at
   * the moment the menu opens. */
  onOpen?: () => void;
  /** Resolves where the open menu mounts, from the trigger element. */
  portalTarget?: (from: HTMLElement) => Element | null;
  /** Which edge of the trigger the menu hangs from. Action menus at the
   * end of a row hang from the right (the default); a control at the
   * start of a toolbar — the project filter — opens under its own left
   * edge, as its reference draws it. */
  align?: "start" | "end";
  menuClassName?: string;
  children: ReactNode;
} & Record<`data-${string}`, string | boolean | undefined>) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    maxHeight: number;
  } | null>(null);
  const [target, setTarget] = useState<Element | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLSpanElement>(null);
  const focusFirst = useRef(false);

  const close = useCallback(() => {
    setOpen(false);
    setPos(null);
  }, []);

  /** Escape and an item's own dismissal are keyboard journeys: focus goes
   * back where it came from. An outside pointer is not — the user has
   * already chosen where to be. */
  const closeToTrigger = useCallback(() => {
    close();
    triggerRef.current?.focus();
  }, [close]);

  const items = () => [
    ...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
      []),
  ];

  // Placement is re-run whenever the menu's own size changes, not only
  // when it opens: a menu whose content grows in place (export menu
  // opens its layer list underneath) would otherwise keep the position
  // it was measured for and walk off the bottom of the window. The
  // height is bounded to what is actually available and the menu
  // scrolls inside that, because repositioning alone cannot make a
  // twenty-layer list fit on a short screen.
  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    const menu = menuRef.current;
    if (!rect || !menu) return;
    const { width, height } = menu.getBoundingClientRect();
    const room = {
      below: window.innerHeight - rect.bottom - 14,
      above: rect.top - 14,
    };
    const fitsBelow = height <= room.below;
    const opensBelow = fitsBelow || room.below >= room.above;
    const maxHeight = Math.max(120, opensBelow ? room.below : room.above);
    setPos({
      top: opensBelow
        ? rect.bottom + 6
        : Math.max(8, rect.top - 6 - Math.min(height, maxHeight)),
      left:
        align === "start"
          ? Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
          : Math.max(8, rect.right - width),
      maxHeight,
    });
  }, [align]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const menu = menuRef.current;
    if (!menu || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(place);
    ro.observe(menu);
    return () => ro.disconnect();
  }, [open, place]);

  // Focus lands only once the menu has a position: until then it renders
  // hidden, and focusing a hidden element is a silent no-op — which is how
  // a keyboard opening can look like it worked and leave focus behind.
  useLayoutEffect(() => {
    if (!open || !pos || !focusFirst.current) return;
    focusFirst.current = false;
    items()[0]?.focus();
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const node = e.target as Node;
      if (!wrapRef.current?.contains(node) && !menuRef.current?.contains(node))
        close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // An Escape that acted is consumed, so outer surfaces — the drawer's
      // own dismissal, a hosting dialog's Escape — hold for the next
      // press. Capture-phase with the propagation stopped: a document
      // bubble listener registered before this menu (the Dialog's) would
      // otherwise act on the same press, which is how one Escape closed
      // both the catalog and its filter popover.
      e.preventDefault();
      e.stopPropagation();
      closeToTrigger();
    };
    const onScroll = (e: Event) => {
      // A menu bounded to the viewport scrolls INSIDE itself, and that
      // scroll must not read as the page moving out from under it — the
      // capture listener closed the menu the moment a long layer list
      // was wheeled.
      const node = e.target as Node | null;
      if (node && menuRef.current?.contains(node)) return;
      close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, close, closeToTrigger]);

  const moveFocus = (delta: number) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    all[(at + delta + all.length) % all.length]?.focus();
  };

  const openMenu = (withFocus: boolean) => {
    focusFirst.current = withFocus;
    const from = triggerRef.current;
    onOpen?.();
    setTarget(from ? (portalTarget?.(from) ?? document.body) : document.body);
    setOpen(true);
  };

  return (
    <span
      {...data}
      ref={wrapRef}
      className={className}
      data-open={open || undefined}
    >
      <button
        {...triggerProps}
        ref={triggerRef}
        type="button"
        className={
          triggerClassName
            ? `${styles.trigger} ${triggerClassName}`
            : styles.trigger
        }
        aria-label={triggerLabel ?? label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          // Safari does not focus a button on click, and some triggers sit
          // in focus-within-gated rows: hold focus here explicitly.
          triggerRef.current?.focus();
          if (open) close();
          else openMenu(false);
        }}
        onKeyDown={(e) => {
          // A keyboard opening moves focus into the menu; a pointer one
          // leaves it on the trigger. Enter and Space are handled here
          // rather than inferred from the click's detail, which is a
          // brittle way to ask how the button was pressed.
          if (open) return;
          if (e.key !== "ArrowDown" && e.key !== "Enter" && e.key !== " ")
            return;
          e.preventDefault();
          openMenu(true);
        }}
      >
        {trigger}
      </button>
      {open &&
        target &&
        createPortal(
          <span
            ref={menuRef}
            className={menuClassName}
            role="menu"
            aria-label={label}
            style={
              pos
                ? {
                    position: "fixed",
                    top: pos.top,
                    left: pos.left,
                    maxHeight: pos.maxHeight,
                    overflowY: "auto",
                  }
                : { position: "fixed", top: 0, left: 0, visibility: "hidden" }
            }
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                moveFocus(e.key === "ArrowDown" ? 1 : -1);
              } else if (e.key === "Home" || e.key === "End") {
                e.preventDefault();
                const all = items();
                (e.key === "Home" ? all[0] : all[all.length - 1])?.focus();
              }
            }}
          >
            <MenuClose.Provider value={closeToTrigger}>
              {children}
            </MenuClose.Provider>
          </span>,
          target,
        )}
    </span>
  );
}

/** One row of a menu. An item that navigates renders an anchor; one that
 * acts renders a button. Either way it dismisses the menu and hands focus
 * back to the trigger after choosing. An aria-disabled item is the one
 * exception: it stays focusable and keeps the menu open so its reason
 * remains available. */
export function MenuItem({
  href,
  onSelect,
  danger,
  className,
  title,
  disabled,
  keepOpen,
  expanded,
  children,
}: {
  href?: string;
  /** Return false to refuse the action without dismissing the menu. */
  onSelect?: () => void | boolean;
  danger?: boolean;
  /** An unavailable menu action remains in the arrow-key order and can
   * receive focus so its visible reason can be discovered. aria-disabled
   * conveys the state; activation is intentionally a no-op. */
  disabled?: boolean;
  /** This item changes what the menu shows rather than acting and
   * leaving — an expander. The default is still to dismiss, because
   * that is what almost every item does. */
  keepOpen?: boolean;
  /** An expander's open state, announced as aria-expanded — without it a
   * disclosure row reads as an ordinary item. Chevrons
   * are aria-hidden, so this is the only channel the state has. */
  expanded?: boolean;
  /** For menus whose rows are not all the same shape. */
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const close = useContext(MenuClose);
  const handle = (e: MouseEvent) => {
    e.stopPropagation();
    if (disabled) {
      e.preventDefault();
      return;
    }
    const selected = onSelect?.();
    if (selected === false) e.preventDefault();
    if (!keepOpen && selected !== false) close();
  };
  if (href !== undefined)
    return (
      <a
        role="menuitem"
        href={href}
        className={className}
        title={title}
        aria-disabled={disabled || undefined}
        onClick={handle}
      >
        {children}
      </a>
    );
  return (
    <button
      type="button"
      role="menuitem"
      className={className}
      title={title}
      aria-expanded={expanded}
      aria-disabled={disabled || undefined}
      data-danger={danger || undefined}
      onClick={handle}
    >
      {children}
    </button>
  );
}
