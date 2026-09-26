"use client";

import { StageButton } from "../../map/StageStack";
import {
  CursorIcon,
  DrawCircleIcon,
  DrawFreehandIcon,
  DrawLineIcon,
  DrawPointIcon,
  DrawRectangleIcon,
  HandIcon,
  VizPolygonIcon,
} from "../../ui/icons";
import { armDrawTool, useDrawMode, type DrawTool } from "./draw-mode";
import styles from "./draw.module.css";

/**
 * The dock — a floating toolbar at the stage's top centre, open exactly
 * while a session runs: hand, select, a divider, then the six shape tools
 * in the reference order. Visual reference:
 */

const TOOLS: {
  tool: DrawTool;
  action: string;
  icon: React.ReactNode;
}[] = [
  { tool: "hand", action: "Move the map", icon: <HandIcon /> },
  { tool: "select", action: "Select a drawn shape", icon: <CursorIcon /> },
  { tool: "point", action: "Draw points", icon: <DrawPointIcon /> },
  { tool: "line", action: "Draw a line", icon: <DrawLineIcon /> },
  { tool: "polygon", action: "Draw a polygon", icon: <VizPolygonIcon /> },
  {
    tool: "rectangle",
    action: "Draw a rectangle",
    icon: <DrawRectangleIcon />,
  },
  { tool: "circle", action: "Draw a circle", icon: <DrawCircleIcon /> },
  { tool: "freehand", action: "Draw freehand", icon: <DrawFreehandIcon /> },
];

export function DrawDock() {
  const mode = useDrawMode();
  if (!mode.open) return null;
  return (
    <div className={styles.dock} role="toolbar" aria-label="Draw tools">
      {TOOLS.map(({ tool, action, icon }, i) => (
        <span key={tool} style={{ display: "contents" }}>
          {i === 2 && <span className={styles.dockRule} aria-hidden />}
          <StageButton
            className={styles.dockBtn}
            action={action}
            icon={icon}
            aria-pressed={mode.tool === tool}
            onClick={() => armDrawTool(tool)}
          />
        </span>
      ))}
    </div>
  );
}
