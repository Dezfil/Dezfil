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

Each of these is a variable, read when the server starts. The **System** tab of **Settings** shows the value in effect.

<!-- settings-storage:start -->

| Setting | Variable | Settings key | Default | Values | What it does | Changes |
|---|---|---|---|---|---|---|
| **Data directory** | `DEZFIL_DATA_DIR` |  | ./data; /data in the container | A folder path | The single durable directory for tables, tiles and metadata. | By variable, after a restart |
| **Encryption key** | `DEZFIL_SECRET_KEY` |  | generated | 64 hex characters (32 bytes) | At-rest encryption key for stored credentials. | By variable, after a restart |
| **Tile builder** | `DEZFIL_TIPPECANOE` |  | `tippecanoe` | A program name, looked up on `PATH`, or a path to the program | Binary used to build vector tiles. | By variable, after a restart |
| **Image renderer** | `DEZFIL_CHROMIUM_PATH` |  | `/usr/bin/chromium` | A path to a headless Chromium or Chrome | Headless browser binary used for server image export. | By variable, after a restart |

<!-- settings-storage:end -->

- Without `DEZFIL_SECRET_KEY`, Dezfil makes a key on first start and keeps it as `secret.key` in the data folder. With a lost or changed key, Dezfil cannot read the saved connection passwords and service addresses. Back it up with the data, as [Back up and restore](../backup-and-restore.md) says.
- The image ships the tile builder and the image renderer where these defaults find them.
- The data folder also holds the optional model catalogue file: see [Offer other models](../assistant.md#offer-other-models).

[Configuration](../configuration.md) shows how to set a variable.
