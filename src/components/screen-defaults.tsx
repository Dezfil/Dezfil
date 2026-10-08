"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import type { InstanceDefaults } from "@/lib/settings/defaults";
import { INSTANCE_DEFAULT_SETTINGS } from "@/lib/settings/instance-defaults";

/**
 * What a screen opens with. The builder's, the SQL console's and a
 * workflow's pages read the instance's defaults on the server as they are
 * served and hand them down here, so the image export card, the console
 * and the canvas can take theirs from context as they open: no request of
 * their own, and no first frame at an older value.
 *
 * Only the screens' own defaults are offered. A new map's and a new
 * layer's are written into the map or the layer when it is made, on the
 * server, and nothing that draws a map reads a default, so whatever else
 * the page hands down is not readable here. Outside a page that hands any
 * down (a test, another host) a screen opens with the product's own
 * values.
 */

const SCREEN_KEYS = [
  "canvas.opens",
  "canvas.minimap",
  "canvas.resultsBand",
  "sqlConsole.textSize",
  "sqlConsole.lineWrap",
  "imageExport.width",
  "imageExport.shape",
] as const satisfies readonly (keyof InstanceDefaults)[];

/** The defaults the workflow canvas, the SQL console and the image export
 * card open with. */
export type ScreenDefaults = Pick<InstanceDefaults, (typeof SCREEN_KEYS)[number]>;

/** The product's own: each definition's default value. */
const PRODUCT_SCREEN_DEFAULTS = Object.fromEntries(
  INSTANCE_DEFAULT_SETTINGS
    .filter((definition) => (SCREEN_KEYS as readonly string[]).includes(definition.key))
    .map((definition) => [definition.key, definition.defaultValue]),
) as ScreenDefaults;

const ScreenDefaultsContext = createContext<ScreenDefaults>(PRODUCT_SCREEN_DEFAULTS);

/** Hands the screens under it the instance's defaults as the page read
 * them; each screen reads its own. */
export function ScreenDefaultsProvider({
  defaults,
  children,
}: {
  defaults: InstanceDefaults;
  children: ReactNode;
}) {
  return (
    <ScreenDefaultsContext.Provider value={defaults}>
      {children}
    </ScreenDefaultsContext.Provider>
  );
}

/** The screens' defaults now: the export card reads them each time it
 * opens. */
export function useScreenDefaults(): ScreenDefaults {
  return useContext(ScreenDefaultsContext);
}

/** The screens' defaults as they stood when the calling screen opened. A
 * later hand-down, the page refreshed after an admin's save, leaves an open
 * screen as it was; its next opening takes the new one. */
export function useOpeningDefaults(): ScreenDefaults {
  const now = useContext(ScreenDefaultsContext);
  const [opening] = useState(now);
  return opening;
}
