/**
 * Energy Monitor — HTTP server
 *
 * Plugin-agnostic. Picks a data source plugin from config, exposes a small JSON
 * API that the dashboard consumes, and serves the static UI.
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from './config.mjs';
import { loadPlugin } from './plugins/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

export async function createApp(overrides = {}) {
  const cfg    = { ...(await loadConfig()), ...overrides };
  const plugin = await loadPlugin(cfg.plugin, cfg.plugins[cfg.plugin] || {});

  const app = express();
  app.disable('x-powered-by');

  // Static UI
  app.use(express.static(PUBLIC_DIR, { maxAge: '1h', etag: true }));

  // ── API ──────────────────────────────────────────────────────────────────
  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn()); }
    catch (e) {
      console.error(`[${req.path}]`, e.message);
      res.status(500).json({ error: e.message });
    }
  };

  app.get('/api/health',  (req, res) => res.json({ ok: true, plugin: plugin.name, version: cfg.version || 'dev' }));
  app.get('/api/device',  wrap(() => plugin.getDevice()));
  app.get('/api/live',    wrap(() => plugin.getLive()));
  app.get('/api/today',   wrap(() => plugin.getToday()));
  app.get('/api/week',    wrap(() => plugin.getWeek()));

  return { app, cfg, plugin };
}

export async function startServer(overrides = {}) {
  const { app, cfg, plugin } = await createApp(overrides);

  return new Promise((resolve) => {
    const server = app.listen(cfg.port, cfg.host, () => {
      const url = `http://localhost:${cfg.port}`;
      console.log('');
      console.log(`  ⚡ Energy Monitor — ${plugin.name}`);
      console.log(`     ${url}`);
      console.log('');
      // Warm caches in background; don't block startup
      plugin.getDevice()
        .then(d => console.log(`  ✓ Connected: ${d.name}  (${d.circuits.length} circuits, ${d.timezone})\n`))
        .catch(e => console.warn(`  ⚠ Connection warning: ${e.message}\n`));
      resolve({ server, app, cfg, plugin, url });
    });
  });
}
