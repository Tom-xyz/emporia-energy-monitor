/**
 * Energy Monitor — HTTP server
 *
 * Plugin-agnostic. Picks a data source plugin from config, runs a background
 * poller that keeps an in-memory cache fresh, and serves API + static UI.
 *
 * Browser polling is bounded by Emporia's underlying resolution (~1 min for
 * power), so a tight ~5s frontend poll is cheap because every server response
 * is cache-served.
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from './config.mjs';
import { loadPlugin } from './plugins/index.mjs';
import { DataCache }  from './cache.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

export async function createApp(overrides = {}) {
  const cfg    = { ...(await loadConfig()), ...overrides };
  const plugin = await loadPlugin(cfg.plugin, cfg.plugins[cfg.plugin] || {});
  // Plugins can declare a preferred live-poll cadence; emporia drops it to 5s
  // in fast-live mode so the legacy AppAPI's 1S resolution is actually felt.
  const liveIntervalMs = cfg.plugins?.[cfg.plugin]?.fastLive ? 5_000 : undefined;
  const cache  = new DataCache(plugin, liveIntervalMs ? { intervals: { live: liveIntervalMs } } : {});

  const app = express();
  app.disable('x-powered-by');
  app.use(express.static(PUBLIC_DIR, { maxAge: '1h', etag: true }));

  // Send the snapshot's metadata as response headers + a small wrapper body.
  // The body keeps the original payload at top level so existing clients still work.
  const wrap = (snapshotName) => async (req, res) => {
    try {
      const snap = await cache.get(snapshotName);
      if (!snap.data) {
        return res.status(503).json({
          error:   snap.error || 'data not yet available',
          loading: true,
        });
      }
      // Headers — easy for tools (curl, Grafana) to read
      res.set('X-Cached-At',  snap.fetchedAt.toISOString());
      res.set('X-Age-Ms',     String(snap.ageMs));
      res.set('X-Stale',      snap.error ? '1' : '0');
      // Body — annotate the payload with cache metadata
      res.json({
        ...snap.data,
        _cache: {
          fetchedAt: snap.fetchedAt,
          ageMs:     snap.ageMs,
          stale:     !!snap.error,
          error:     snap.error,
        },
      });
    } catch (e) {
      console.error(`[${req.path}]`, e.message);
      res.status(500).json({ error: e.message });
    }
  };

  app.get('/api/health', (req, res) => res.json({
    ok:      true,
    plugin:  plugin.name,
    version: cfg.version || 'dev',
    cache:   cache.status(),
  }));
  app.get('/api/ui-config', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(cfg.ui || { theme: 'dark', tween: true, sparkline: true });
  });
  app.get('/api/device', wrap('device'));
  app.get('/api/live',   wrap('live'));
  app.get('/api/today',  wrap('today'));
  app.get('/api/week',   wrap('week'));
  app.get('/api/peak',   wrap('peak'));

  return { app, cfg, plugin, cache };
}

export async function startServer(overrides = {}) {
  const { app, cfg, plugin, cache } = await createApp(overrides);

  // Start the background poller IMMEDIATELY (before the server even listens),
  // so by the time the first browser request lands the cache is warming.
  cache.startPolling();

  return new Promise((resolve) => {
    const server = app.listen(cfg.port, cfg.host, () => {
      const url = `http://localhost:${cfg.port}`;
      console.log('');
      console.log(`  ⚡ Energy Monitor — ${plugin.name}`);
      console.log(`     ${url}`);
      console.log('');
      // Surface the cache prime status (don't block startup)
      cache.get('device')
        .then(d => d.data && console.log(`  ✓ Connected: ${d.data.name}  (${d.data.circuits.length} circuits, ${d.data.timezone})\n`))
        .catch(e => console.warn(`  ⚠ Connection warning: ${e.message}\n`));
      resolve({ server, app, cfg, plugin, cache, url });
    });
  });
}
