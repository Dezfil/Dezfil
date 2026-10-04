// All payloads are authored here, offline, with no third-party assets.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

export const timing = JSON.parse(readFileSync(new URL('./render-timing-fixture.json', import.meta.url), 'utf8'));
export const tile = Buffer.from(timing.tilePng, 'base64');
export function fixtureHashes() {
  const hash = value => createHash('sha256').update(value).digest('hex');
  return { style: hash(JSON.stringify(timing.style)), definition: hash(JSON.stringify(timing.definition)), tile: hash(tile) };
}
assert.deepEqual(fixtureHashes(), timing.sha256, 'frozen timing fixture changed without its manifest');

const point = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { label: 'A' }, geometry: { type: 'Point', coordinates: [13.37, 52.5] } }] };
const background = { id: 'background', type: 'background', paint: { 'background-color': '#00c8d8' } };
const json = value => ({ status: 200, type: 'application/json', body: JSON.stringify(value) });
const redirect = location => ({ status: 302, type: 'text/plain', body: '', location });
const image = { status: 200, type: 'image/png', body: tile };

/** @returns {{status: number, type: string, body: string | Buffer, location?: string}} */
export function fixtureResponse(state, pathname, role) {
  const privateHost = role !== 'host';
  const root = `http://${state.root}:8080`, target = `http://${state.author}:8080`;
  if (pathname === '/live') return { status: 200, type: 'text/plain', body: 'listener-alive' };
  if (privateHost && state.variant === 'blind') return { status: 200, type: 'text/plain', body: 'internal-service-body' };
  if (state.kind === 'timing') {
    if (pathname === '/style.json') return json(timing.style);
    if (/^\/tiles\/\d+\/\d+\/\d+\.png$/.test(pathname)) return image;
  }
  if (state.road) {
    if (pathname === '/style.json') {
      if (state.road === 'redirect') return redirect(`${target}/payload.json`);
      const style = { version: 8, sources: {}, layers: [background] };
      if (state.road === 'source') {
        style.sources.raster = { type: 'raster', url: `${target}/metadata.json` };
        style.layers.push({ id: 'raster', type: 'raster', source: 'raster' });
      }
      if (state.road === 'tile') {
        style.sources.raster = { type: 'raster', tiles: [`${target}/tiles/{z}/{x}/{y}.png`], tileSize: 512 };
        style.layers.push({ id: 'raster', type: 'raster', source: 'raster' });
      }
      if (['sprite', 'glyph', 'worker'].includes(state.road)) {
        style.sources.points = { type: 'geojson', data: state.road === 'worker' ? `${target}/points.json` : point };
        if (state.road === 'worker') style.layers.push({ id: 'points', type: 'circle', source: 'points', paint: { 'circle-color': '#ff00ff', 'circle-radius': 12 } });
        else {
          style.layers.push({ id: 'symbol', type: 'symbol', source: 'points', layout: state.road === 'glyph'
            ? { 'text-field': 'A', 'text-font': ['Probe Sans'], 'text-size': 20 }
            : { 'icon-image': 'marker', 'icon-size': 0.1 } });
          if (state.road === 'glyph') style.glyphs = `${target}/glyphs/{fontstack}/{range}.pbf`;
          // Sprite JSON and PNG are requested concurrently. Only the JSON
          // redirects to the changed name, so two admissions cannot consume
          // its one public answer before any browser connection begins.
          else style.sprite = `${root}/sprite`;
        }
      }
      return json(style);
    }
    if (pathname === '/payload.json') return json({ version: 8, sources: {}, layers: [background] });
    if (pathname === '/metadata.json') return json({ tilejson: '3.0.0', tiles: [`${root}/tiles/{z}/{x}/{y}.png`], tileSize: 256 });
    if (pathname === '/points.json') return json(point);
    if (/^\/sprite(?:@2x)?\.json$/.test(pathname)) return redirect(`${target}/sprite-data.json`);
    if (pathname === '/sprite-data.json') return json({ marker: { x: 0, y: 0, width: 256, height: 256, pixelRatio: 1 } });
    if (/^\/sprite(?:@2x)?\.png$/.test(pathname) || /^\/tiles\//.test(pathname)) return image;
    // Valid empty glyph protobuf: no fixture text pixels claimed. The
    // request itself, including its completed response, is the stimulus.
    if (/^\/glyphs\//.test(pathname)) return { status: 200, type: 'application/x-protobuf', body: Buffer.alloc(0) };
  }
  if (pathname === '/style.json' && state.redirectTo) return redirect(state.redirectTo);
  if (pathname === '/style.json') return json({ version: 8, sources: {}, layers: [{
    ...background, paint: { 'background-color': privateHost ? '#ff00ff' : '#00c8d8' },
  }] });
  return { status: 404, type: 'text/plain', body: 'missing' };
}
