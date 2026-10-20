---
title: "Basemaps and imagery"
summary: "Choose which basemaps the instance offers, set up satellite imagery, and pin a basemap style of your own."
read_when:
  - "you want to hide a basemap from the pickers"
  - "you want to offer satellite imagery with your own tile address"
  - "you want every map to use your own basemap style, such as on a network without internet access"
audience:
  - operator
  - agent
checked: none
order: 3
---

An admin sets the basemap switches and the satellite imagery on the **Libraries** tab of **Settings**. The deployment's own basemap style is a variable alone.

<!-- settings-libraries:start -->

| Setting | Variable | Settings key | Default | Values | What it does | Changes |
|---|---|---|---|---|---|---|
| **Dark** |  | `basemaps.dark` | on | `true` or `false` | Whether Dark is offered where a basemap is chosen: the builder's picker, a published page's switcher and the Maps tab. Off, choosing it anew is refused; a map already on it keeps it. Auto keeps following the theme with it either way. | In Settings, live |
| **Light** |  | `basemaps.light` | on | `true` or `false` | Whether Light is offered where a basemap is chosen: the builder's picker, a published page's switcher and the Maps tab. Off, choosing it anew is refused; a map already on it keeps it. Auto keeps following the theme with it either way. | In Settings, live |
| **Streets** |  | `basemaps.streets` | on | `true` or `false` | Whether Streets is offered where a basemap is chosen: the builder's picker, a published page's switcher and the Maps tab. Off, choosing it anew is refused; a map already on it keeps it. | In Settings, live |
| **Satellite** |  | `basemaps.satellite` | on | `true` or `false` | Whether Satellite is offered, while imagery is set up, where a basemap is chosen: the builder's picker, a published page's switcher and the Maps tab. Off, choosing it anew is refused; a map already on it keeps it. | In Settings, live |
| **Style addresses on single maps** |  | `basemaps.singleMapStyles` | on | `true` or `false` | Whether a map may take a style address the library does not offer. Off, such an address is refused on any map, for everyone, admins included; a map that holds one keeps it. | In Settings, live |
| **Satellite template** | `DEZFIL_SATELLITE_URL` | `satelliteUrl` | unset | An `http` or `https` address, up to 2,048 characters, holding `{z}`, `{x}` and `{y}`, with no user name or password | Raster tile template enabling satellite imagery. | In Settings, live; by variable, after a restart |
| **Satellite credit** | `DEZFIL_SATELLITE_ATTRIBUTION` | `satelliteAttribution` | unset | Text, up to 160 characters | Credit line required by the imagery provider. | In Settings, live; by variable, after a restart |
| **Basemap address** | `DEZFIL_BASEMAP_URL` |  | built-in styles | A MapLibre style address | Style override pinning the automatic basemap in both themes. | By variable, after a restart |
| **Basemap credit** | `DEZFIL_BASEMAP_ATTRIBUTION` |  | unset | Text | Credit line for the deployment basemap override. | By variable, after a restart |

<!-- settings-libraries:end -->

- The satellite tile address never reaches a browser. The server fetches each tile and passes it back, so the imagery provider sees your server, not each viewer. A key limited to browser origins needs that limit lifted.
- Without a readable tile address, **Satellite** leaves every basemap picker. A map already on it draws the default style until an address is saved again.
- With `DEZFIL_BASEMAP_URL` set and no `DEZFIL_BASEMAP_ATTRIBUTION`, maps show no credit for the basemap.

[Configuration](../configuration.md) shows how to set a variable and which value wins.
