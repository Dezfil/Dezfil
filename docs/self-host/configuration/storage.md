---
title: "Storage and programs"
summary: "Set the data folder, the key that encrypts saved connection passwords and addresses, and the programs that build tiles and render images."
read_when:
  - "you want to keep the data in another folder"
  - "you want to set the encryption key yourself"
  - "the tile builder or the image renderer is somewhere else on the server"
audience:
  - operator
  - agent
checked: none
order: 6
---

Each of these is a variable. The **System** tab of **Settings** shows the value in effect.

<!-- settings-storage:start -->

| Setting | Variable | Settings key | Default | Values | What it does | Changes |
|---|---|---|---|---|---|---|
| **Data directory** | `DEZFIL_DATA_DIR` |  | ./data; /data in the container | A folder path | The single durable directory for tables, tiles and metadata. | By variable, after a restart |
| **Encryption key** | `DEZFIL_SECRET_KEY` |  | generated | 64 hex characters (32 bytes) | At-rest encryption key for stored credentials. | By variable, after a restart |
| **Tile builder** | `DEZFIL_TIPPECANOE` |  | `tippecanoe` | A program name, looked up on `PATH`, or a path to the program | Binary used to build vector tiles. | By variable, after a restart |
| **Image renderer** | `DEZFIL_CHROMIUM_PATH` |  | `/usr/bin/chromium` | A path to a headless Chromium or Chrome | Headless browser binary used for server image export. | By variable, after a restart |

<!-- settings-storage:end -->

The data folder also holds the optional model catalogue file: see [the model catalogue file](../backup-and-restore.md#the-model-catalogue-file).

[Configuration](../configuration.md) shows how to set a variable.
