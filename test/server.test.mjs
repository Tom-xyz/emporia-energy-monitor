import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

/**
 * Server tests with a stub plugin — verifies routing and response shape
 * without hitting the live Emporia API.
 */

const stubPlugin = {
  name: 'stub',
  getDevice: async () => ({
    deviceId: 'STUB1', name: 'Test House', model: 'STUB', firmware: 'v1',
    ratePerKwh: 0.15, timezone: 'America/Chicago',
    circuits: [
      { id: '1', name: 'AC',     type: 'ac' },
      { id: '2', name: 'Lights', type: 'light' },
    ],
  }),
  getLive: async () => ({
    totalKw: 1.5,
    circuits: { '1': { kw: 1.2, volts: 240, amps: 5 }, '2': { kw: 0.3, volts: 120, amps: 2.5 } },
    series: [{ ts: '2026-04-26T00:00:00Z', totalKw: 1.5, circuits: {} }],
    updatedAt: new Date().toISOString(),
  }),
  getToday: async () => ({
    totalKwh: 12.5, costDollars: 1.875,
    circuits: { '1': 10, '2': 2.5 }, hours: [],
    updatedAt: new Date().toISOString(),
  }),
  getWeek: async () => ({
    totalKwh: 87.5, costDollars: 13.13, days: [],
    updatedAt: new Date().toISOString(),
  }),
};

function buildApp(plugin = stubPlugin) {
  const app = express();
  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn()); } catch (e) { res.status(500).json({ error: e.message }); }
  };
  app.get('/api/health', (req, res) => res.json({ ok: true, plugin: plugin.name }));
  app.get('/api/device', wrap(() => plugin.getDevice()));
  app.get('/api/live',   wrap(() => plugin.getLive()));
  app.get('/api/today',  wrap(() => plugin.getToday()));
  app.get('/api/week',   wrap(() => plugin.getWeek()));
  return app;
}

async function req(app, path) {
  const server = app.listen(0);
  const port   = server.address().port;
  try {
    const res  = await fetch(`http://127.0.0.1:${port}${path}`);
    const body = await res.json();
    return { status: res.status, body };
  } finally {
    server.close();
  }
}

test('GET /api/health returns ok', async () => {
  const r = await req(buildApp(), '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.plugin, 'stub');
});

test('GET /api/device returns device info', async () => {
  const r = await req(buildApp(), '/api/device');
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Test House');
  assert.equal(r.body.circuits.length, 2);
  assert.equal(r.body.circuits[0].type, 'ac');
});

test('GET /api/live returns power snapshot', async () => {
  const r = await req(buildApp(), '/api/live');
  assert.equal(r.status, 200);
  assert.equal(r.body.totalKw, 1.5);
  assert.equal(r.body.circuits['1'].kw, 1.2);
});

test('GET /api/today returns today summary', async () => {
  const r = await req(buildApp(), '/api/today');
  assert.equal(r.status, 200);
  assert.equal(r.body.totalKwh, 12.5);
  assert.equal(r.body.costDollars, 1.875);
});

test('GET /api/week returns week aggregate', async () => {
  const r = await req(buildApp(), '/api/week');
  assert.equal(r.status, 200);
  assert.equal(r.body.totalKwh, 87.5);
});

test('plugin error → 500 with error body', async () => {
  const failing = { ...stubPlugin, getDevice: async () => { throw new Error('boom'); } };
  const r = await req(buildApp(failing), '/api/device');
  assert.equal(r.status, 500);
  assert.equal(r.body.error, 'boom');
});
