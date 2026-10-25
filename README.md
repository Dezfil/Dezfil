# Dezfil

Self-hosted spatial SQL and map publishing, powered by DuckDB and files.
Upload geospatial data, query it with SQL, style it on a map, publish a
shareable view, from one container.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/use/build-a-map-hex-bins.dark.webp">
  <img src="docs/images/use/build-a-map-hex-bins.webp" alt="The map builder with forty years of big earthquakes near Japan counted in hex bins: the layer's style settings on the left, the legend on the map, and the basemap credit in the lower right corner">
</picture>

> Status: pre-release, under active development.

## Run it

With Docker installed:

```sh
docker run -d --name dezfil -p 127.0.0.1:3000:3000 -v dezfil-data:/data ghcr.io/dezfil/dezfil
```

For development, with live reload, run `npm ci` and then `npm run dev`.

Open <http://localhost:3000> and create the first admin account. [Install](docs/start/install.md)
covers each way in full, with Docker Compose and the first-run setup.

## Documentation

The documentation is published at [dezfil.io/docs](https://dezfil.io/docs/).
The same pages live in [docs/](docs/), one folder per section, and
[the index](docs/README.md) lists every page with its summary and when to
read it. Begin with [What Dezfil is](docs/start/what-is-dezfil.md) or
[Install](docs/start/install.md).

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) says how to get a change from your machine
into the project, and [Development setup](docs/contribute/development-setup.md)
which checks a change runs.

## License

[Apache-2.0](LICENSE). Code adapted from permissively licensed projects
(such as MapLibre GL JS, kepler.gl, deck.gl and osmtogeojson) keeps its
original license header in the file, with the source noted in
[NOTICE](NOTICE). The data in the shipped templates stays under its
sources' licences, also listed there.
