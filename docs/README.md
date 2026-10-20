# Dezfil documentation

Every page under `docs/`, generated from the pages' own frontmatter. Find the
section for what you are doing, then the page whose "read when" line is
your situation. The same pages are published at https://dezfil.io/docs/.

This file is written by `npm run docs:write` and held by `npm run lint:docs`:
change the pages, then regenerate it.

## Get started

What Dezfil is, how to install it, and your first map.

- [What Dezfil is](start/what-is-dezfil.md)
  - path: `docs/start/what-is-dezfil.md`
  - summary: See what you can do with Dezfil, what each of its main screens is for, and how an instance runs and keeps your data.
  - read when: you want to know what Dezfil does before you install it; you want to see the main screens and what each one is for; you want to know how Dezfil runs and where it keeps your data; you want to script Dezfil or connect an AI agent to it; you want to know Dezfil's licence
  - audience: user, operator, developer, agent

- [Install](start/install.md)
  - path: `docs/start/install.md`
  - summary: Install Dezfil with Docker, Docker Compose or from source, create the admin account, and keep the instance running day to day.
  - read when: you want Dezfil running on your computer or a server; you choose between Docker, Docker Compose and a development checkout; you create the first admin account; you stop, start, upgrade, back up or check a running instance
  - audience: user, operator, developer

- [Your first map](start/first-map.md)
  - path: `docs/start/first-map.md`
  - summary: Upload a CSV of world cities, put it on a new map, color the points by population and publish the map as a link.
  - read when: you have just installed Dezfil and want to build something; you want to turn a CSV with latitude and longitude columns into points on a map; you want to color points by a column and show a legend; you want to share a map as a link
  - audience: user

## Use Dezfil

Do things in the app: data, maps, SQL, workflows and sharing.

- [Templates](use/templates.md)
  - path: `docs/use/templates.md`
  - summary: The finished maps and workflow examples an instance offers: what a card shows, opening one read only, and making a copy of your own.
  - read when: you want a finished map or workflow example to start from; you want to know where a template's data comes from
  - audience: user

## Self-host

Install, secure, configure and back up your own instance.

- [Reverse proxy and HTTPS](self-host/reverse-proxy.md)
  - path: `docs/self-host/reverse-proxy.md`
  - summary: Serve Dezfil at your own domain over HTTPS, with Caddy or nginx in front of it.
  - read when: you want people to reach Dezfil at your own domain over HTTPS; you put Caddy or nginx in front of Dezfil; you need to know what to set DEZFIL_TRUSTED_PROXIES to; sign-in works on the server but fails through your domain; uploads, long imports or the assistant's answers fail or stall behind nginx
  - audience: operator

- [Configuration](self-host/configuration.md)
  - path: `docs/self-host/configuration.md`
  - summary: Change your instance's settings in the app or with environment variables, and check which value is in effect.
  - read when: you want to change how your instance behaves; you set an environment variable and want to check that it took effect; you want to know whether a change applies at once or after a restart; you look for a setting's default or the values it takes
  - audience: operator, agent

- [Set up the assistant](self-host/assistant.md)
  - path: `docs/self-host/assistant.md`
  - summary: Turn on the in-app assistant with an Anthropic or OpenAI key, choose its models, and check that it answers.
  - read when: you want to turn on the assistant for your instance; you want to change which models people can choose; you want to offer a model or an effort level Dezfil does not list; you need to know what the assistant sends to the AI provider; the assistant pane shows an error instead of an answer
  - audience: operator, agent

- [Runbook](self-host/backup-and-restore.md)
  - path: `docs/self-host/backup-and-restore.md`
  - summary: Recipes for the work around an instance: its data directory, backups, upgrades, account recovery and deletion, and API clients without a browser.
  - read when: you back up, restore or upgrade an instance; you recover an admin account; you finish deleting an account, or drive the API from a shell script
  - audience: operator, developer

- [Self-hosting](self-host/what-leaves-the-instance.md)
  - path: `docs/self-host/what-leaves-the-instance.md`
  - summary: What to decide before you put data in an instance, what the instance keeps, and what it sends out.
  - read when: you run an instance for yourself or for others; you put Dezfil behind a reverse proxy; you need to know what leaves the instance
  - audience: operator

### Configuration

- [General](self-host/configuration/general.md)
  - path: `docs/self-host/configuration/general.md`
  - summary: Name the instance, write the sign-in page's message and lost-password contact, and choose where people land after they sign in.
  - read when: you want to give the instance a name or a sign-in message; you want to tell people whom to ask when they lose their password; you want people to land on another page after they sign in
  - audience: operator, agent

- [Instance defaults](self-host/configuration/defaults.md)
  - path: `docs/self-host/configuration/defaults.md`
  - summary: Choose what new maps, new layers, the workflow canvas, the SQL console and a fresh image export start with.
  - read when: you want new maps to open somewhere else, or on another basemap; you want new layers to start with other colors, opacity or sizes; you want to change what the workflow canvas, the SQL console or the image export card opens with
  - audience: operator, agent

- [Basemaps and imagery](self-host/configuration/libraries.md)
  - path: `docs/self-host/configuration/libraries.md`
  - summary: Choose which basemaps the instance offers, set up satellite imagery, and pin a basemap style of your own.
  - read when: you want to hide a basemap from the pickers; you want to offer satellite imagery with your own tile address; you want every map to use your own basemap style, such as on a network without internet access
  - audience: operator, agent

- [Data and services](self-host/configuration/services.md)
  - path: `docs/self-host/configuration/services.md`
  - summary: Point the instance at an address finder, a travel-time service, an Overpass server or S3 storage, and choose its template catalogue.
  - read when: you want to turn on place search and geocoding with an address finder; you want travel-time areas, or your own Overpass server for OpenStreetMap; you want the server to reach a host on your private network; you want imports from private cloud storage buckets
  - audience: operator, agent

- [Security and rules](self-host/configuration/rules.md)
  - path: `docs/self-host/configuration/rules.md`
  - summary: Set how long sign-ins and links last, the shortest password, and who may create tokens, publish, embed, add connections and import.
  - read when: you want people to stay signed in for a shorter or longer time; you want only admins to publish, create tokens, add connections or import from links; you want to limit which sites may embed a published map
  - audience: operator, agent

- [Storage and programs](self-host/configuration/storage.md)
  - path: `docs/self-host/configuration/storage.md`
  - summary: Set the data folder, the key that encrypts saved connection passwords and addresses, and the programs that build tiles and render images.
  - read when: you want to keep the data in another folder; you want to set the encryption key yourself; the tile builder or the image renderer is somewhere else on the server
  - audience: operator, agent

## API and agents

Script Dezfil over HTTP, or connect an AI agent through MCP.

- [Limits](api/limits.md)
  - path: `docs/api/limits.md`
  - summary: The fixed byte ceilings on SQL answers and previews, and the time, size, memory, rate and queue limits an operator changes.
  - read when: a query or an inspection answers query_result_too_large; you need to know which reads are bounded and by how much; you want to raise the largest upload, the query time limit or another limit
  - audience: user, developer, agent, operator

- [The HTTP API](api/http-api.md)
  - path: `docs/api/http-api.md`
  - summary: How the HTTP API is organised: where its description is served, how sign-in, revisions and errors work, and where the exact rules live.
  - read when: you script Dezfil over HTTP; you look for the operation that does a thing; a request is refused and you want to know why
  - audience: developer, agent

- [The MCP server](api/mcp.md)
  - path: `docs/api/mcp.md`
  - summary: How an AI agent reaches an instance over the Model Context Protocol: the endpoint, sign-in, the generated tools and the agent plugin.
  - read when: you connect an AI agent or MCP client to an instance; you want to know which operations an agent can call; you install the agent plugin
  - audience: user, developer, agent

## Contribute

Work on Dezfil's code.

- [Development setup](contribute/development-setup.md)
  - path: `docs/contribute/development-setup.md`
  - summary: Run a checkout for development, run the checks and tests the pipeline runs, and start the instances the browser suite and the scripts need.
  - read when: you set up a checkout to change Dezfil's code; you want to run the pipeline's checks before you push; you run the unit tests or the browser suite against an instance of your own; a test needs DEZFIL_TEST_PG_URL or another test-only variable; you regenerate the docs index, the design specimen or another generated file
  - audience: developer, agent

- [Architecture](contribute/architecture.md)
  - path: `docs/contribute/architecture.md`
  - summary: Find where each part of the Dezfil container lives in the source, and keep the rules that hold the parts together.
  - read when: you change the code and need to know where a part lives; you wonder why Dezfil needs no database server or second service; you trace a layer from the browser to the query engine and back; you add a feature and want to know which rules it must keep; you add an API operation and want the UI, the assistant and MCP clients to get it
  - audience: developer, agent

- [How this is built](contribute/how-this-is-built.md)
  - path: `docs/contribute/how-this-is-built.md`
  - summary: Take a change from an idea to main: describe the behavior, build it on a branch with its tests, pass the checks and get it reviewed.
  - read when: you plan to contribute a change and want to know what is expected of it; you write a change with an AI coding agent; you want to know what a reviewer looks for before a pull request merges; you say in a pull request what you tested and what you did not; a pull request check says a commit is not signed off or its message carries an internal reference
  - audience: developer, agent

- [Write a docs page](contribute/write-docs.md)
  - path: `docs/contribute/write-docs.md`
  - summary: Write or rewrite a page under docs/ that people and agents can act on, and pass every check of npm run lint:docs.
  - read when: you write a new page under docs/ or rewrite one; npm run lint:docs fails on a page you changed; you add a code block, a tab set, a notice or a picture to a page; you take a page off the list of pages not yet rewritten; you change a writing rule or the check that holds it
  - audience: developer, agent

## About

Licence, credits, changes and policies.

- [Licence and credits](about/licence-and-credits.md)
  - path: `docs/about/licence-and-credits.md`
  - summary: Check Dezfil's licence, the libraries, fonts and tools it includes, and the map data credits your maps show.
  - read when: you want to know Dezfil's licence and what it lets you do; you need the libraries, fonts and tools Dezfil includes, and their licences; you want to know where a map, a published map or an exported image shows its map data credit; you add your own basemap or satellite imagery and need its credit on the map; you publish a map made from a template or imported data and want to credit its sources
  - audience: user, operator, developer

## Also

- [Changelog](../CHANGELOG.md) (About): What changed in each release.
- [Security policy](../SECURITY.md) (About): Which versions get fixes and how to report a vulnerability.
- [Contributing to Dezfil](../CONTRIBUTING.md) (Contribute): How to get a change from your machine into the project.
- [Contributor Covenant Code of Conduct](../CODE_OF_CONDUCT.md) (Contribute): The standards for taking part and how they are enforced.
- [The OpenAPI description](api/openapi.json) (API and agents): the HTTP API as the server serves it, generated from the source; the operation reference is built from it.
- [The image manifest](images/manifest.json): one row per picture and recording, each scene in its light and its dark take, with the scene it shows, the take's theme, its size and when it was taken.
