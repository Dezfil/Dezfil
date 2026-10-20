---
title: "Instance defaults"
summary: "Choose what new maps, new layers, the workflow canvas, the SQL console and a fresh image export start with."
read_when:
  - "you want new maps to open somewhere else, or on another basemap"
  - "you want new layers to start with other colors, opacity or sizes"
  - "you want to change what the workflow canvas, the SQL console or the image export card opens with"
audience:
  - operator
  - agent
checked: none
order: 2
---

An admin sets these on the **Maps**, **Workflows & SQL** and **Publishing** tabs of **Settings**. A default applies to new things only: a map or a layer you already have keeps what it has.

<!-- settings-defaults:start -->

| Setting | Variable | Settings key | Default | Values | What it does | Changes |
|---|---|---|---|---|---|---|
| **New maps** › **Basemap** |  | `newMap.basemap` | `auto` | `auto`, `dark`, `light`, `streets` or `satellite` | The basemap a new map starts on. Auto follows the theme; a basemap the instance no longer offers starts on Auto. | In Settings, live |
| **Starting view** › **Latitude** |  | `newMap.latitude` | `40` | A number from -85 to 85 | The latitude a new map opens at. | In Settings, live |
| **Starting view** › **Longitude** |  | `newMap.longitude` | `0` | A number from -180 to 180 | The longitude a new map opens at. | In Settings, live |
| **Starting view** › **Zoom** |  | `newMap.zoom` | `1.3` | A number from 0 to 22 | The zoom a new map opens at. | In Settings, live |
| **Legend corner** |  | `newMap.legendCorner` | `bottom-left` | `top-left`, `top-right`, `bottom-left` or `bottom-right` | Where a new map's legend sits. | In Settings, live |
| **Color cycle** |  | `newLayer.colorCycle` | `uber_viz_qualitative` | `uber_viz_qualitative`, `bold`, `tab10`, `paired`, `dark2` or `set3` | The palette whose colors new layers take in turn, drawn sketches included. | In Settings, live |
| **Opacity** › **Points** |  | `newLayer.pointOpacity` | `72` % | A whole number from 10 to 100 | How opaque a new points layer is drawn, unless it is created with a style. | In Settings, live |
| **Opacity** › **Lines** |  | `newLayer.lineOpacity` | `95` % | A whole number from 10 to 100 | How opaque a new lines layer is drawn, unless it is created with a style. | In Settings, live |
| **Opacity** › **Areas** |  | `newLayer.areaOpacity` | `50` % | A whole number from 10 to 100 | How opaque a new areas layer is drawn, unless it is created with a style. | In Settings, live |
| **Line width** |  | `newLayer.lineWidth` | `2` px | A number from 0.5 to 50 | How wide a new lines layer is drawn, unless it is created with a style. | In Settings, live |
| **Point radius** |  | `newLayer.pointRadius` | `3` px | A number from 0.5 to 100 | How large a new layer's points are drawn, unless it is created with a style. | In Settings, live |
| **Canvas opens** |  | `canvas.opens` | `full` | `full` or `framed` | Whether a workflow canvas opens full screen or framed. | In Settings, live |
| **Workflow canvas** › **Minimap** |  | `canvas.minimap` | `auto` | `auto`, `always` or `never` | When a workflow canvas shows its minimap until the person chooses: auto shows it from six nodes. | In Settings, live |
| **Results band** |  | `canvas.resultsBand` | `closed` | `closed` or `open` | Whether a workflow canvas opens with its results band closed or open until the person chooses. | In Settings, live |
| **Text size** |  | `sqlConsole.textSize` | `12` px | `11`, `12`, `13`, `14` or `16` | The text size the SQL console's editor opens at. | In Settings, live |
| **Line wrap** |  | `sqlConsole.lineWrap` | off | `true` or `false` | Whether the SQL console's editor wraps long lines. | In Settings, live |
| **Starting width** |  | `imageExport.width` | `1920` px | `1280`, `1920` or `2560` | The width a fresh image export card opens at. | In Settings, live |
| **Starting shape** |  | `imageExport.shape` | `4:3` | `16:9`, `4:3` or `1:1` | The shape a fresh image export card opens at. | In Settings, live |

<!-- settings-defaults:end -->

- A canvas, a console or an export card already open keeps what it opened with.
- A layer created with a style keeps that style. A drawn sketch's layer takes only its color from the cycle.
- Every signed-in account and agent reads the values in effect as `defaults` in `GET /api/config`.

[Configuration](../configuration.md) shows how a change in Settings applies.
