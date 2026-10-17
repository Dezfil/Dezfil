# Dezfil

Self-hosted spatial SQL and map publishing, powered by DuckDB and files.
Upload geospatial data, query it with SQL, style it on a map, publish a
shareable view — from one container.

> Status: pre-release, under active development.

## Run it

With Docker installed:

```sh
docker build -t dezfil .
docker run -d --name dezfil -p 127.0.0.1:3000:3000 -v dezfil-data:/data dezfil
```

For development, with live reload, run `npm ci` and then `npm run dev`.

Open <http://localhost:3000> and create the first admin account. [Run it](docs/start/run-it.md)
covers both ways in full, the data volume and the first-run setup.

## Documentation

The documentation lives in [docs/](docs/), one folder per section: start,
guides, reference, operate and develop. Begin with [Run it](docs/start/run-it.md).

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) says how to get a change from your machine
into the project, and [checks and testing](docs/develop/checks-and-testing.md)
which checks a change runs.

## License

[Apache-2.0](LICENSE). Code borrowed from permissively licensed projects
(e.g. GeoLibre, kepler.gl, MapStore) keeps its original license header in
the file, with the source noted in [NOTICE](NOTICE).
