import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataCache } from '../src/cache.mjs';

function stubPlugin(opts = {}) {
  let calls = { device: 0, live: 0, today: 0, week: 0 };
  const baseDevice = {
    deviceId: 'D1', name: 'Test', model: 'X', firmware: 'fw', ratePerKwh: 0.15,
    timezone: 'UTC', circuits: [{ id: '1', name: 'A', type: 'ac' }],
  };
  return {
    calls,
    name: 'stub',
    getDevice: async () => { calls.device++; if (opts.failDevice) throw new Error('boom'); return baseDevice; },
    getLive:   async () => { calls.live++;   return { totalKw: 0.5, circuits: {}, series: [], updatedAt: new Date().toISOString() }; },
    getToday:  async () => { calls.today++;  return { totalKwh: 1, costDollars: 0.15, circuits: {}, hours: [], updatedAt: new Date().toISOString() }; },
    getWeek:   async () => { calls.week++;   return { totalKwh: 7, costDollars: 1.05, days: [], updatedAt: new Date().toISOString() }; },
  };
}

test('DataCache.get awaits first fetch then serves from cache', async () => {
  const p = stubPlugin();
  const c = new DataCache(p);

  const r1 = await c.get('live');
  assert.equal(p.calls.live, 1);
  assert.equal(r1.fresh, true);
  assert.ok(r1.fetchedAt instanceof Date);
  assert.equal(typeof r1.ageMs, 'number');

  const r2 = await c.get('live');
  assert.equal(p.calls.live, 1, 'second call should hit cache, not plugin');
  assert.equal(r2.data, r1.data);
});

test('DataCache.get dedupes concurrent cold fetches', async () => {
  let resolveFetch;
  const p = {
    name: 'slow',
    getDevice: () => new Promise(r => (resolveFetch = () => r({ id: 'D' }))),
    getLive: async () => ({}), getToday: async () => ({}), getWeek: async () => ({}),
  };
  const c = new DataCache(p);

  const a = c.get('device');
  const b = c.get('device');
  const d = c.get('device');
  resolveFetch();
  const [ra, rb, rd] = await Promise.all([a, b, d]);
  assert.equal(ra.data, rb.data);
  assert.equal(ra.data, rd.data);
});

test('DataCache.get surfaces errors on cold fetch', async () => {
  const p = stubPlugin({ failDevice: true });
  const c = new DataCache(p);

  const r = await c.get('device');
  assert.equal(r.fresh, false);
  assert.equal(r.data, null);
  assert.equal(r.error, 'boom');
});

test('DataCache serves stale data while a refresh is failing', async () => {
  let shouldFail = false;
  const p = {
    name: 'flaky',
    getDevice: async () => ({ name: 'ok' }),
    getLive:   async () => { if (shouldFail) throw new Error('temp'); return { totalKw: 1.0 }; },
    getToday:  async () => ({}), getWeek: async () => ({}),
  };
  const c = new DataCache(p);

  const ok = await c.get('live');
  assert.equal(ok.fresh, true);
  assert.equal(ok.data.totalKw, 1.0);

  // Now make the next refresh fail; serve cached data
  shouldFail = true;
  await c._fetch('live');
  const stale = await c.get('live');
  assert.equal(stale.data.totalKw, 1.0, 'old data preserved on failure');
  assert.equal(stale.error, 'temp');
});

test('DataCache.startPolling triggers all four fetches in parallel', async () => {
  const p = stubPlugin();
  const c = new DataCache(p, { intervals: { device: 999_999, live: 999_999, today: 999_999, week: 999_999 } });
  c.startPolling();
  // Yield once so the in-flight promises resolve
  await new Promise(r => setTimeout(r, 10));
  assert.equal(p.calls.device, 1);
  assert.equal(p.calls.live,   1);
  assert.equal(p.calls.today,  1);
  assert.equal(p.calls.week,   1);
  c.stopPolling();
});

test('DataCache.status reports per-snapshot health', async () => {
  const p = stubPlugin();
  const c = new DataCache(p);
  await c.get('live');
  const s = c.status();
  assert.equal(s.live.fresh, true);
  assert.equal(s.live.consecutiveFailures, 0);
  assert.equal(typeof s.live.ageMs, 'number');
  assert.equal(s.device.fresh, false, 'device not fetched yet');
});
