---
title: "Data and services"
summary: "Point the instance at an address finder, a travel-time service, an Overpass server or S3 storage, and choose its template catalogue."
read_when:
  - "you want to turn on place search and geocoding with an address finder"
  - "you want travel-time areas, or your own Overpass server for OpenStreetMap"
  - "you want the server to reach a host on your private network"
  - "you want imports from private cloud storage buckets"
audience:
  - operator
  - agent
checked: none
order: 4
---

An admin sets most of these on the **Data & services** tab of **Settings**. The rest are variables alone.

<!-- settings-services:start -->

| Setting | Variable | Settings key | Default | Values | What it does | Changes |
|---|---|---|---|---|---|---|
| **Address finder** › **Address** | `DEZFIL_GEOCODER_URL` | `geocoderUrl` | unset | An `http` or `https` address, up to 2,048 characters, in Settings; any address as a variable | Nominatim-compatible endpoint for search and batch geocoding. | In Settings, live; by variable, after a restart |
| **Address finder** › **Gap between requests** | `DEZFIL_GEOCODE_PACE_MS` | `geocodePaceMs` | `1000` milliseconds | 0 to 60 seconds in Settings; any number from 0, in milliseconds, as a variable | Minimum request gap; zero means no gap. | In Settings, live; by variable, after a restart |
| **Address finder** › **Answer time limit** | `DEZFIL_GEOCODE_REQUEST_TIMEOUT_S` | `geocodeRequestTimeoutS` | `10` seconds | 1 to 120 in Settings; any number above 0 as a variable | Deadline for one geocoding exchange. | In Settings, live; by variable, after a restart |
| **Keep found addresses for** | `DEZFIL_GEOCODE_MATCH_CACHE_HOURS` | `geocodeMatchCacheHours` | `720` hours | 1 to 365 days in Settings; any number above 0, in hours, as a variable | How long matched addresses are cached. | In Settings, live; by variable, after a restart |
| **Unmatched address freshness** | `DEZFIL_GEOCODE_NO_MATCH_CACHE_HOURS` |  | `24` hours | Any number above 0 | How long no-match answers are cached. | By variable, after a restart |
| **Address cache size** | `DEZFIL_GEOCODE_CACHE_MB` |  | `64` MB | Any number above 0 | Size budget for cached geocoding answers. | By variable, after a restart |
| **Travel time** › **Address** | `DEZFIL_ISOCHRONE_URL` | `isochroneUrl` | unset | An `http` or `https` address, up to 2,048 characters, in Settings; any address as a variable | Valhalla-compatible endpoint for travel-time areas. | In Settings, live; by variable, after a restart |
| **Travel time** › **Gap between requests** | `DEZFIL_ISOCHRONE_PACE_MS` | `isochronePaceMs` | `1000` milliseconds | 0 to 60 seconds in Settings; any number from 0, in milliseconds, as a variable | Minimum routing request gap; zero means no gap. | In Settings, live; by variable, after a restart |
| **Travel time** › **Answer time limit** | `DEZFIL_ISOCHRONE_REQUEST_TIMEOUT_S` | `isochroneRequestTimeoutS` | `20` seconds | 1 to 120 in Settings; any number above 0 as a variable | Deadline for one routing exchange. | In Settings, live; by variable, after a restart |
| **Keep areas for** | `DEZFIL_ISOCHRONE_CACHE_HOURS` | `isochroneCacheHours` | `168` hours | 1 to 365 days in Settings; any number above 0, in hours, as a variable | How long complete routing answers are cached. | In Settings, live; by variable, after a restart |
| **Travel-time cache size** | `DEZFIL_ISOCHRONE_CACHE_MB` |  | `64` MB | Any number above 0 | Size budget for cached routing answers. | By variable, after a restart |
| **OpenStreetMap** › **Address** | `DEZFIL_OVERPASS_URL` | `overpassUrl` | `https://overpass-api.de/api/interpreter` | An `http` or `https` address, up to 2,048 characters, in Settings; any address as a variable | Endpoint for OpenStreetMap imports. | In Settings, live; by variable, after a restart |
| **Time budget per query** | `DEZFIL_OVERPASS_TIMEOUT_S` | `overpassTimeoutS` | `60` seconds | 10 to 900 in Settings; any number above 0 as a variable | Time budget sent with every Overpass query. | In Settings, live; by variable, after a restart |
| **Overpass response budget** | `DEZFIL_OVERPASS_MAXSIZE_MB` |  | `512` MB | Any number above 0 | Response budget sent to Overpass; twice this aborts locally. | By variable, after a restart |
| **Keep answers for** | `DEZFIL_OVERPASS_CACHE_H` | `overpassCacheHours` | `24` hours | 1 to 720 in Settings; any number above 0 as a variable | How long an Overpass response stays fresh. | In Settings, live; by variable, after a restart |
| **Overpass cache size** | `DEZFIL_OVERPASS_CACHE_MB` |  | `2048` MB | Any number above 0 | Cache size budget, evicted oldest first. | By variable, after a restart |
| **S3 address** | `DEZFIL_S3_ENDPOINT` | `s3Endpoint` | AWS | An `http` or `https` address, up to 2,048 characters, in Settings; any address as a variable | The S3-compatible store that s3:// links are read from without the server's credentials. | In Settings, live; by variable, after a restart |
| **Read with the server’s credentials** | `DEZFIL_OBJECT_STORE_CREDENTIALS` |  | off | `1`, `true` or `yes` turns it on; any other value leaves it off | Read cloud storage links with the server's own credentials. | By variable, after a restart |
| **Templates** › **Catalogue** |  | `templates.catalogue` | on | `true` or `false` | Whether the server reads the template catalogue: its list, its pictures and its downloads. Off, it reaches the catalogue for nothing; shipped and downloaded templates still open and copy. | In Settings, live |
| **Catalogue address** | `DEZFIL_TEMPLATES_CATALOGUE` | `templatesCatalogueUrl` | `https://github.com/Dezfil/templates/releases/latest/download/index.json` | An `http` or `https` address, up to 2,048 characters, in Settings; any address, or a folder on the server, as a variable | Where the template catalogue's index is read. | In Settings, live; by variable, after a restart |
| **Hosts the server may reach** | `DEZFIL_EGRESS_ALLOWLIST` |  | unset | Host names, IP addresses or CIDR networks, separated by commas | Hosts on a private network that the server may reach. | By variable, after a restart |

<!-- settings-services:end -->

- A saved address is kept encrypted with the instance's key, and shows only its scheme and host. To change a key inside it, save the whole address again.
- The server refuses an address on a loopback, private or link-local network, at save and at each request, unless `DEZFIL_EGRESS_ALLOWLIST` names it. [What leaves the instance](../what-leaves-the-instance.md) lists every request this governs.
- Without `DEZFIL_OBJECT_STORE_CREDENTIALS`, cloud storage links are read anonymously, so people import only what the public can read.

[Configuration](../configuration.md) shows how to set a variable and which value wins.
