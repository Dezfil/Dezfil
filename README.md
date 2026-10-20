# Dezfil

Self-hosted spatial SQL and map publishing, powered by DuckDB and files.
Upload geospatial data, query it with SQL, style it on a map, publish a
shareable view — from one container.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/use/templates.dark.webp">
  <img src="docs/images/use/templates.webp" alt="The Templates page of a Dezfil instance: a search box, tag chips and the cards of two finished maps and a workflow example">
</picture>

> Status: pre-release, under active development.

## Run it

With Docker installed:

```sh
docker build -t dezfil .
docker run -d --name dezfil -p 127.0.0.1:3000:3000 -v dezfil-data:/data dezfil
```

For development, with live reload, run `npm ci` and then `npm run dev`.

Open <http://localhost:3000> and create the first admin account. [Run it](docs/start/install.md)
covers both ways in full, the data volume and the first-run setup.

## Documentation

The documentation is published at [dezfil.io/docs](https://dezfil.io/docs/).
The same pages live in [docs/](docs/), one folder per section, and
[the index](docs/README.md) lists every page with its summary and when to
read it. Begin with [Run it](docs/start/install.md).

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) says how to get a change from your machine
into the project, and [Development setup](docs/contribute/development-setup.md)
which checks a change runs.

## License

[Apache-2.0](LICENSE). Code borrowed from permissively licensed projects
(e.g. GeoLibre, kepler.gl, MapStore) keeps its original license header in
the file, with the source noted in [NOTICE](NOTICE).
