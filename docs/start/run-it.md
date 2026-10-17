---
title: "Run it"
summary: "The two ways to run Dezfil, where everything it stores lives, and the first-run setup that creates the admin account."
read_when:
  - "you run Dezfil for the first time"
  - "you choose between the container and a development checkout"
  - "you back up or move an instance's data"
audience:
  - user
  - operator
checked: none
---

For development, with live reload:

```sh
npm ci
npm run dev
```

Open <http://localhost:3000>.

With Docker installed:

```sh
docker build -t dezfil .
docker run -d --name dezfil -p 127.0.0.1:3000:3000 -v dezfil-data:/data dezfil
```

Open <http://localhost:3000>. The instance reports readiness at
`/api/health`.

Everything Dezfil stores, including accounts, sessions, token records, tables,
maps, layers, styles and published links,
lives in the `/data` volume (`dezfil-data` above). Back up by copying that
volume with the container stopped; move to a new container by mounting the
same volume. To move to another machine, stop the container and copy the
whole directory and preserve any externally supplied `DEZFIL_SECRET_KEY`. Running without
the volume works, but state then lasts only for that container's lifetime.

On first run, create the initial admin account. Application pages and APIs
require a session or an account API token; admins manage accounts in Users,
and the instance name, the sign-in page, the defaults for new maps, layers and
screens, the basemaps on offer, the satellite imagery and the saved palettes,
the limits, the services' addresses and numbers, and the sign-in, token,
publishing, connection and import rules in Settings.
Each person picks their own look on the **Appearance** tab of Settings: color,
contrast, panels (Glass, Liquid or Paper), background, typeface, corners and how
the side menu opens. The look is kept with the account, so it shows from the
first paint in every browser that account signs in to; published pages and
exported images keep Dezfil's default look.
An instance upgraded from a release without accounts
also shows setup once. Secure new and upgraded instances until you complete setup,
and complete it promptly: whoever reaches setup first becomes the admin.
