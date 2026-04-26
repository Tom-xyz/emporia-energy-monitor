/**
 * In-memory data cache + background poller.
 *
 * The dashboard's perceived latency was bottlenecked on Emporia's cloud API
 * (1–5s per call, sometimes more). Solution: poll Emporia in the background on
 * server-side intervals; serve API responses from cache instantly.
 *
 * Each snapshot tracks:
 *   data        — last successful payload (or null until first fetch)
 *   fetchedAt   — Date of the last successful fetch
 *   error       — message from last failed fetch (or null)
 *   fetching    — in-flight Promise to dedupe concurrent fetches
 *
 * Cold-start strategy:
 *   On `startPolling()` we kick off all four fetches in parallel immediately,
 *   so by the time the first browser request arrives the data is usually warm.
 *   If a request beats the cache (no data yet), we await the in-flight fetch
 *   instead of issuing a second one.
 */

const SNAPSHOTS = ['device', 'live', 'today', 'week'];

const PLUGIN_METHOD = {
  device: 'getDevice',
  live:   'getLive',
  today:  'getToday',
  week:   'getWeek',
};

export class DataCache {
  /**
   * @param {import('./plugins/types.mjs').EnergyPlugin} plugin
   * @param {Object} [opts]
   * @param {Object<string, number>} [opts.intervals] - ms between polls per snapshot
   */
  constructor(plugin, opts = {}) {
    this.plugin = plugin;

    const defaults = {
      device: 5 * 60_000,   // device layout rarely changes
      live:   30_000,       // Emporia's power resolution is ~1 min anyway
      today:  60_000,       // hourly buckets, refresh every minute
      week:   5 * 60_000,   // daily buckets, refresh every 5 min
    };
    this.intervals = { ...defaults, ...opts.intervals };

    this.snapshots = {};
    for (const name of SNAPSHOTS) {
      this.snapshots[name] = {
        data: null,
        fetchedAt: null,
        error: null,
        fetching: null,
        consecutiveFailures: 0,
      };
    }
    this.timers = [];
  }

  /** Get a snapshot. If we have data, returns immediately (cache may be stale).
   *  If we have no data yet, awaits the in-flight (or new) fetch. */
  async get(name) {
    const snap = this.snapshots[name];
    if (!snap) throw new Error(`Unknown snapshot: ${name}`);

    if (snap.data) return this._format(name);

    if (!snap.fetching) snap.fetching = this._fetch(name);
    await snap.fetching;
    return this._format(name);
  }

  _format(name) {
    const s = this.snapshots[name];
    return {
      data:      s.data,
      fetchedAt: s.fetchedAt,
      ageMs:     s.fetchedAt ? Date.now() - s.fetchedAt.getTime() : null,
      error:     s.error,
      fresh:     !!s.data && !s.error,
    };
  }

  async _fetch(name) {
    const snap   = this.snapshots[name];
    const method = PLUGIN_METHOD[name];
    const t0     = Date.now();
    try {
      const data = await this.plugin[method]();
      snap.data      = data;
      snap.fetchedAt = new Date();
      snap.error     = null;
      snap.consecutiveFailures = 0;
      const took = Date.now() - t0;
      if (took > 2000) console.log(`[cache] ${name} refreshed in ${took}ms`);
    } catch (e) {
      snap.error = e.message;
      snap.consecutiveFailures++;
      console.warn(`[cache] ${name} fetch failed (${snap.consecutiveFailures}x): ${e.message}`);
    } finally {
      snap.fetching = null;
    }
  }

  /** Kick off initial parallel fetches and start interval timers. */
  startPolling() {
    // Cold-start: fire all four in parallel (don't await — let the server boot)
    for (const name of SNAPSHOTS) {
      const snap = this.snapshots[name];
      if (!snap.fetching) snap.fetching = this._fetch(name);
    }

    // Background refresh
    for (const name of SNAPSHOTS) {
      const t = setInterval(() => {
        const snap = this.snapshots[name];
        // Skip if a fetch is already in flight (prevent stacking on slow API)
        if (snap.fetching) return;
        snap.fetching = this._fetch(name);
      }, this.intervals[name]);
      // Don't keep the event loop alive just for these timers
      t.unref?.();
      this.timers.push(t);
    }
  }

  stopPolling() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Snapshot of cache health for /api/health. */
  status() {
    const out = {};
    for (const name of SNAPSHOTS) {
      const s = this.snapshots[name];
      out[name] = {
        fresh:               !!s.data,
        fetchedAt:           s.fetchedAt,
        ageMs:               s.fetchedAt ? Date.now() - s.fetchedAt.getTime() : null,
        consecutiveFailures: s.consecutiveFailures,
        lastError:           s.error,
      };
    }
    return out;
  }
}
