// Offline seeding and real-instance measurement. No server is started here.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { productLoader } from './account-deletion-source-loader.mjs';
import { probeOrigin } from './settings-probe.mjs';
import { capacityEvents, firstMeasurement, activeRenders, foregroundTiming, assertForegroundOverlap, foregroundLimits, assertForegroundInterruption, measureBacklog } from './pictures-measurement.mjs';
const execute = promisify(execFile), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const [mode, manifestPath, reportPath, baselinePath, ...restartArgs] = process.argv.slice(2);
assert.ok(['seed-first', 'seed-missing', 'seed-mixed', 'run'].includes(mode), 'Use seed-first, seed-missing, seed-mixed or run');
assert.ok(manifestPath && path.basename(manifestPath).startsWith('pictures-'), 'Use a named picture fixture manifest');
const load = productLoader(process.env.DEZFIL_STANDALONE_DIR ?? process.cwd());
const write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
if (mode.startsWith('seed-')) {
  const directory = process.env.DEZFIL_DATA_DIR;
  assert.ok(directory && path.basename(directory).startsWith('pictures-'), 'Seed only an isolated pictures- data directory');
  assert.ok(!existsSync(path.join(directory, 'metadata.sqlite')), 'Seed requires a new store and a stopped instance');
  assert.ok(!existsSync(manifestPath), 'Do not replace an existing fixture manifest');
  mkdirSync(directory, { recursive: true });
  const { metadataDb, closeMetadataDb } = load('lib/metadata/db.ts');
  const db = metadataDb(), { testAccountScope } = load('lib/test-support/accounts.ts');
  const scope = testAccountScope(db, 'picture-capacity');
  db.prepare('UPDATE accounts SET is_admin = 1 WHERE id = ?').run(scope.accountId);
  const { getAccount } = load('lib/metadata/accounts.ts');
  const { issueSession, authenticateSession, createApiToken } = load('lib/auth/credentials.ts');
  const actor = authenticateSession(issueSession(getAccount(scope.accountId), db, Date.now()).secret, db);
  const token = createApiToken(actor, 'Disposable capacity proof', db).secret;
  const { seedPictureCapacity } = load('lib/test-support/picture-capacity.ts');
  const basemapUrl = process.env.DEZFIL_PICTURE_BASEMAP_URL;
  assert.ok(basemapUrl, 'Set DEZFIL_PICTURE_BASEMAP_URL to the loopback tile fixture');
  const kind = mode.slice(5), maps = await seedPictureCapacity(scope, kind, basemapUrl);
  write(manifestPath, { kind, maps, basemapUrl, createdAt: Date.now() });
  writeFileSync(manifestPath + '.token', token, { mode: 0o600 });
  closeMetadataDb();
  console.log(JSON.stringify({ result: 'seeded', kind, maps: maps.length, manifest: manifestPath, tokenFile: manifestPath + '.token' }));
} else {
  const fixture = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const origin = probeOrigin(process.env.DEZFIL_PICTURE_TEST_URL);
  const metrics = process.env.DEZFIL_PICTURE_METRICS;
  assert.ok(metrics && existsSync(metrics), 'Start the isolated server with the metrics preload and shared event file');
  assert.ok(reportPath && path.basename(reportPath).startsWith('pictures-'), 'Supply a picture report path');
  const command = restartArgs[0] === '--' ? restartArgs.slice(1) : restartArgs;
  if (fixture.kind !== 'missing') assert.ok(command.length, 'The first and mixed proofs require an explicit restart executable and arguments after --');
  const events = () => readFileSync(metrics, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const token = readFileSync(manifestPath + '.token', 'utf8').trim();
  async function request(method, route, body) {
    const response = await fetch(origin + route, { method, redirect: 'error', signal: AbortSignal.timeout(120000),
      headers: { authorization: `Bearer ${token}`, origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(response.ok, `${method} ${route}: ${response.status} ${response.ok ? '' : await response.text()}`);
    return response;
  }
  const json = async (method, route, body) => (await request(method, route, body)).json();
  const initialSettings = await json('GET', '/api/instance/settings');
  assert.equal(initialSettings.settings.exportRenderConcurrency.value, 2, 'Measure the default two-slot lane');
  const initialBoot = events().find(event => event.kind === 'boot');
  assert.ok(initialBoot, 'The process boot must be observed');
  assert.equal(initialBoot.basemapUrl, fixture.basemapUrl, 'The seed and server must use the same loopback tile fixture');
  assert.ok(fixture.basemapUrl && initialBoot.styleFixture, 'Capacity pairs require the loopback style fixture preload');
  const baseline = fixture.kind === 'first' ? null : JSON.parse(readFileSync(baselinePath, 'utf8'));
  if (baseline) {
    assert.equal(baseline.result, 'confirmed');
    assert.ok(baseline.foregroundConcurrent, 'A baseline with five concurrent foreground samples is required');
    const frozen = foregroundLimits(baseline.foregroundConcurrent, baseline.rawEvents, baseline.timings.appearanceFloorMs, baseline.settings.concurrency);
    assert.equal(baseline.limits.exportStartMs, frozen.exportStartMs);
    assert.equal(baseline.limits.checkAnswerMs, frozen.checkAnswerMs);
  }
  const started = Date.now(), deadline = started + (baseline?.limits.capacity300Ms ?? 1800000);
  let peakBrowserRssKiB = 0, samples = 0, samplingError;
  async function sampleMemory() {
    try {
      const root = events().filter(event => event.kind === 'boot').at(-1).pid;
      const { stdout } = await execute('ps', ['-axo', 'pid=,ppid=,rss=,command=']);
      const rows = stdout.split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
        .map(match => ({ pid: +match[1], parent: +match[2], rss: +match[3], command: match[4] }));
      const descendants = new Set([root]);
      for (let i = 0; i < rows.length; i++) for (const row of rows) if (descendants.has(row.parent)) descendants.add(row.pid);
      const rss = rows.filter(row => descendants.has(row.pid) && /chrom(e|ium)|headless_shell/i.test(row.command)).reduce((sum, row) => sum + row.rss, 0);
      peakBrowserRssKiB = Math.max(peakBrowserRssKiB, rss); samples++;
    } catch (error) { samplingError = error.message; }
  }
  let sampling = false;
  const timer = setInterval(() => { if (!sampling) { sampling = true; void sampleMemory().finally(() => { sampling = false; }); } }, 250);
  const report = { result: 'failed', kind: fixture.kind, environment: initialBoot, settings: {
    concurrency: initialSettings.settings.exportRenderConcurrency.value,
    appearanceBudgetSeconds: initialSettings.settings.assistantLookTimeoutS.value,
  } };
  async function restart() {
    const before = await json('GET', '/api/instance/settings'), start = Date.now();
    await execute(command[0], command.slice(1), { timeout: 120000 });
    while (Date.now() - start < 120000) {
      try {
        const after = await json('GET', '/api/instance/settings');
        if (after.startedAt !== before.startedAt) return Date.now() - start;
      } catch { /* An actual stopped process is expected during restart. */ }
      await sleep(250);
    }
    throw new Error('The restart did not replace the isolated process');
  }
  const rows = () => json('GET', '/api/maps');
  async function until(predicate, limit = deadline) {
    while (Date.now() < limit) {
      const listing = await rows();
      assert.ok(fixture.maps.every(map => listing.some(row => row.id === map.id)), 'A fixture map disappeared');
      assert.ok(!listing.some(row => ['failed', 'unsupported', 'unavailable'].includes(row.pictureState)), 'The capacity workload must complete without failed pictures');
      if (predicate(listing)) return listing;
      await sleep(100);
    }
    throw new Error('The measured deadline expired');
  }
  const mapId = fixture.maps[0].id;
  const { cardDefinition } = load('lib/pictures/card.ts');
  const definition = cardDefinition((await json('GET', `/api/maps/${mapId}`)).viewport, 'light');
  async function foreground(check) {
    const eventOffset = events().length, requestedAt = Date.now();
    const response = await request('POST', check ? '/api/maps/look' : `/api/maps/${mapId}/export/image`, check ? { mapId } : { definition });
    await response.arrayBuffer();
    const sample = { mapId, eventOffset, requestedAt, answeredAt: Date.now() };
    return { ...sample, ...foregroundTiming(sample, events()) };
  }
  async function waitForBackground(after = 0) {
    while (Date.now() < deadline) {
      const active = activeRenders(events());
      if (active.length === 1 && active[0].background && active[0].index >= after) return active[0];
      await sleep(20);
    }
    throw new Error('No background render was in flight before the deadline');
  }
  const backgroundId = fixture.maps[1].id;
  async function refreshBackground() {
    await until(listing => listing.find(row => row.id === backgroundId)?.pictureState === 'current');
    const after = events().length;
    await json('POST', `/api/maps/${backgroundId}/picture/refresh`);
    return waitForBackground(after);
  }
  try {
    if (baseline) {
      report.limits = baseline.limits;
      report.foregroundBacklog = { export: [], check: [] };
      await measureBacklog({ maps: fixture.maps, events, foreground, limits: baseline.limits,
        record: (kind, sample) => report.foregroundBacklog[kind].push(sample),
        poll: async () => { await until(() => true); await sleep(20); },
        restart: fixture.kind === 'mixed' ? async publications => {
          report.restartAfterPublications = publications;
          report.restartMs = await restart();
        } : undefined,
      });
    }
    await until(listing => fixture.maps.every(map => listing.find(row => row.id === map.id)?.pictureState === 'current'));
    capacityEvents(fixture.maps, events());
    report.capacityElapsedMs = Date.now() - initialBoot.at;
    if (baseline) assert.ok(report.capacityElapsedMs <= baseline.limits.capacity300Ms, 'Capacity exceeded the frozen first-run ceiling');
    if (fixture.kind === 'first') {
      report.timings = firstMeasurement(fixture.maps, events());
      report.startupMs = events().find(event => event.kind === 'admitted' && event.background).at - initialBoot.at;
      report.restartMs = await restart();
      await sleep(2000);
      capacityEvents(fixture.maps, events());
      report.foregroundIdle = { export: await foreground(false), check: await foreground(true) };
      report.foregroundConcurrent = { export: [], check: [] };
      for (let i = 0; i < 5; i++) for (const kind of ['export', 'check']) {
        await refreshBackground();
        const sample = await foreground(kind === 'check');
        report.foregroundConcurrent[kind].push(sample);
        Object.assign(sample, assertForegroundOverlap(sample, events()));
      }
      const concurrentLimits = foregroundLimits(report.foregroundConcurrent, events(), report.timings.appearanceFloorMs, 2);
      const previous = initialSettings.settings.exportRenderConcurrency.storedValue;
      try {
        await until(listing => listing.find(row => row.id === backgroundId)?.pictureState === 'current');
        await json('PATCH', '/api/instance/settings', { exportRenderConcurrency: 1 });
        async function interrupt(check) {
          await refreshBackground();
          const sample = await foreground(check);
          assertForegroundInterruption(sample, events(), report.settings.appearanceBudgetSeconds * 1000);
          if (check) assert.ok(sample.answerMs <= report.settings.appearanceBudgetSeconds * 1000, 'The one-slot check exceeded its budget');
          return sample;
        }
        report.foregroundOneSlot = { export: await interrupt(false), check: await interrupt(true) };
      } finally { await json('PATCH', '/api/instance/settings', { exportRenderConcurrency: previous }); }
      await until(listing => listing.find(row => row.id === backgroundId)?.pictureState === 'current', Date.now() + 120000);
      report.limits = { capacity300Ms: Math.ceil(300 * report.timings.all.p90Ms * 1.5 + report.startupMs + report.restartMs), ...concurrentLimits };
    }
    report.changeToCard = [];
    for (const pair of [false, true]) {
      const map = fixture.maps.find(map => map.pair === pair), before = (await rows()).find(row => row.id === map.id);
      const current = await json('GET', `/api/maps/${map.id}`), start = Date.now();
      const response = await fetch(`${origin}/api/maps/${map.id}`, { method: 'PATCH', signal: AbortSignal.timeout(120000),
        headers: { authorization: `Bearer ${token}`, origin, 'content-type': 'application/json', 'X-Edit-Revision': current.editRevision },
        body: JSON.stringify({ viewport: { ...current.viewport, lng: current.viewport.lng + .1 } }) });
      assert.ok(response.ok, 'The saved drawing change must succeed');
      await until(listing => listing.some(row => row.id === map.id && row.pictureState === 'current' && row.pictureVersion !== before.pictureVersion), start + 60000);
      report.changeToCard.push({ pair, elapsedMs: Date.now() - start });
    }
    assert.ok(!samplingError, samplingError);
    assert.ok(peakBrowserRssKiB > 0, 'No real browser memory was sampled');
    report.result = 'confirmed';
  } catch (error) { report.error = error.message; process.exitCode = 1; }
  finally {
    clearInterval(timer);
    while (sampling) await sleep(10);
    report.memory = { sampledPeakBrowserRssKiB: peakBrowserRssKiB, sampleIntervalMs: 250, samples, samplingError };
    report.rawEvents = events(); write(reportPath, report);
    console.log(JSON.stringify({ result: report.result, report: reportPath, error: report.error }));
  }
}
