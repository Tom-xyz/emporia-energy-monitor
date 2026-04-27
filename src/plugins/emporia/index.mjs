/**
 * Emporia Vue plugin — implements the EnergyPlugin interface.
 *
 * Config (from environment):
 *   EMPORIA_EMAIL
 *   EMPORIA_PASSWORD
 *   EMPORIA_KEYS_FILE        (optional; defaults to <data-dir>/emporia_keys.json)
 *   EMPORIA_DEVICE_INDEX     (optional; default 0 — picks first device on the account)
 *   EMPORIA_TIMEZONE         (optional; defaults to device's reported timezone)
 */

import path from 'path';
import { EmporiaAuth } from './auth.mjs';
import { EmporiaAPI, parseEnergyResponse, parsePowerResponse, parseDeviceListUsages, inferCircuitType } from './api.mjs';

const DEVICE_TTL_MS = 5 * 60 * 1000;

export default function createEmporiaPlugin(cfg) {
  const auth = new EmporiaAuth({
    username: cfg.email,
    password: cfg.password,
    keysFile: cfg.keysFile || path.join(cfg.dataDir, 'emporia_keys.json'),
  });
  const api = new EmporiaAPI(auth);

  let deviceCache    = null;
  let deviceCachedAt = 0;

  // ── Internal: device + channel discovery (cached) ──
  async function getDeviceCached() {
    if (deviceCache && Date.now() - deviceCachedAt < DEVICE_TTL_MS) return deviceCache;

    const [devs, channelsResp] = await Promise.all([api.getDevices(), api.getChannels()]);
    const devices = devs.devices || [];
    if (!devices.length) throw new Error('Emporia: no devices on this account');

    const idx = Math.max(0, Math.min(cfg.deviceIndex || 0, devices.length - 1));
    const raw = devices[idx];
    const loc = raw.locationProperties || {};
    const channels = channelsResp.find(d => d.device_id === raw.manufacturerDeviceId)?.channels || [];

    // Skip the composite "Mains" entries — we only surface individually-named branches.
    const circuits = channels
      .filter(c => !c.channel_num.includes(',') && !c.channel_num.startsWith('Mains'))
      .map(c => ({
        id:   c.channel_num,
        name: c.display_name,
        type: inferCircuitType(c.display_name, c.sub_type),
      }));

    deviceCache = {
      deviceId:    raw.manufacturerDeviceId,
      deviceGid:   raw.deviceGid,             // numeric GID required by legacy AppAPI
      name:        loc.deviceName || loc.displayName || raw.model || 'Emporia Vue',
      model:       raw.model,
      firmware:    raw.firmware,
      ratePerKwh:  (loc.usageCentPerKwHour || 0) / 100,
      timezone:    cfg.timezone || raw.timeZone || loc.timeZone || 'UTC',
      circuits,
    };
    deviceCachedAt = Date.now();
    return deviceCache;
  }

  // ── Date helpers ──
  function nowISO()       { return new Date().toISOString(); }
  function daysAgoISO(n)  { return new Date(Date.now() - n * 86400 * 1000).toISOString(); }

  function startOfTodayISO(tz) {
    // Compute "today midnight" in the device's local tz, expressed as UTC ISO.
    // Strategy: ask Intl what the wall-clock time is in `tz` right now, then
    // derive the tz's offset from UTC, then anchor midnight in that tz.
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const p = Object.fromEntries(fmt.formatToParts(now).map(x => [x.type, x.value]));
    const Y = +p.year, M = +p.month - 1, D = +p.day;
    const tzWallMs   = Date.UTC(Y, M, D, +p.hour % 24, +p.minute, +p.second);
    const offsetMin  = Math.round((tzWallMs - now.getTime()) / 60_000);
    const tzMidnight = Date.UTC(Y, M, D, 0, 0, 0);
    return new Date(tzMidnight - offsetMin * 60_000).toISOString();
  }

  // ── Live-power fetch implementations ──
  // c-api MINUTES: floor is 1 minute; safe to poll every 15s; returns 15min series.
  async function getLiveNormal(dev) {
    const ids = dev.circuits.map(c => c.id);
    const end   = nowISO();
    const start = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const raw   = await api.getPower({ deviceId: dev.deviceId, circuitIds: ids, start, end });
    const byId  = parsePowerResponse(raw, ids);

    const latest = {};
    let totalKw = 0;
    for (const c of dev.circuits) {
      const arr  = byId[c.id] || [];
      const last = arr[arr.length - 1] || { kw: 0, volts: null, amps: null };
      latest[c.id] = last;
      totalKw += last.kw;
    }

    const tsSet = new Set();
    Object.values(byId).forEach(arr => arr.forEach(r => tsSet.add(r.ts)));
    const series = [...tsSet].sort().map(ts => {
      const point = { ts, totalKw: 0, circuits: {} };
      for (const c of dev.circuits) {
        const r = (byId[c.id] || []).find(x => x.ts === ts);
        point.circuits[c.id] = { kw: r?.kw ?? 0, volts: r?.volts ?? null, amps: r?.amps ?? null };
        point.totalKw += r?.kw ?? 0;
      }
      return point;
    });

    return { totalKw, circuits: latest, series, updatedAt: new Date().toISOString(), source: 'c-api' };
  }

  // Legacy AppAPI scale=1S: 1-second resolution kWh → ×3600 for kW.
  // Sub-minute fresh, but no series, no volts. Retries on null channels.
  async function getLiveFast(dev) {
    if (dev.deviceGid == null) {
      // Device discovery didn't surface a numeric gid — fall back rather than fail.
      return getLiveNormal(dev);
    }
    const ids = dev.circuits.map(c => c.id);

    let byId = {};
    let attempt = 0;
    const maxAttempts = 3;
    while (attempt < maxAttempts) {
      const instant = nowISO();
      const raw = await api.getDeviceListUsages({
        deviceGid: dev.deviceGid,
        instant,
        scale: '1S',
      });
      byId = parseDeviceListUsages(raw, dev.deviceGid, '1S');
      const allValid = ids.every(id => byId[id]?.kw != null);
      if (allValid) break;
      attempt++;
      // PyEmVue-style backoff: 250 → 500 → 1000 ms
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 250 * Math.pow(2, attempt - 1)));
      }
    }

    const latest = {};
    let totalKw = 0;
    for (const c of dev.circuits) {
      const kw = byId[c.id]?.kw ?? 0;
      latest[c.id] = { kw, volts: null, amps: null };
      totalKw += kw;
    }

    return {
      totalKw,
      circuits: latest,
      series: [],          // legacy endpoint doesn't return a range
      updatedAt: new Date().toISOString(),
      source: 'AppAPI:1S',
    };
  }

  // ── Plugin interface ──
  return {
    name: 'Emporia Vue',

    async getDevice() {
      return getDeviceCached();
    },

    async getLive() {
      const dev = await getDeviceCached();
      if (cfg.fastLive) return getLiveFast(dev);
      return getLiveNormal(dev);
    },

    async getToday() {
      const dev = await getDeviceCached();
      const ids = dev.circuits.map(c => c.id);
      const start = startOfTodayISO(dev.timezone);
      const end   = nowISO();
      const raw   = await api.getEnergy({ deviceId: dev.deviceId, circuitIds: ids, start, end, resolution: 'HOURS' });
      const byId  = parseEnergyResponse(raw, ids);

      const totals = {};
      let grand = 0;
      for (const c of dev.circuits) {
        const kwh = (byId[c.id] || []).reduce((s, r) => s + r.kwh, 0);
        totals[c.id] = kwh;
        grand += kwh;
      }

      const tsSet = new Set();
      Object.values(byId).forEach(arr => arr.forEach(r => tsSet.add(r.start)));
      const hours = [...tsSet].sort().map(ts => {
        const p = { ts, totalKwh: 0, circuits: {} };
        for (const c of dev.circuits) {
          const r = (byId[c.id] || []).find(x => x.start === ts);
          const kwh = r?.kwh ?? 0;
          p.circuits[c.id] = kwh;
          p.totalKwh += kwh;
        }
        return p;
      });

      return {
        totalKwh:    grand,
        costDollars: grand * dev.ratePerKwh,
        circuits:    totals,
        hours,
        updatedAt:   new Date().toISOString(),
      };
    },

    async getPeakToday() {
      const dev = await getDeviceCached();
      const ids = dev.circuits.map(c => c.id);
      const start = startOfTodayISO(dev.timezone);
      const end   = nowISO();
      const raw   = await api.getPower({ deviceId: dev.deviceId, circuitIds: ids, start, end, resolution: 'MINUTES' });
      const byId  = parsePowerResponse(raw, ids);

      // Sum across circuits per minute, find the max minute.
      const totalsByTs = new Map();
      for (const id of ids) {
        for (const r of byId[id] || []) {
          totalsByTs.set(r.ts, (totalsByTs.get(r.ts) || 0) + (r.kw || 0));
        }
      }
      let peakKw = 0, peakAt = null;
      for (const [ts, kw] of totalsByTs) {
        if (kw > peakKw) { peakKw = kw; peakAt = ts; }
      }
      // Date in device tz (YYYY-MM-DD)
      const date = new Date().toLocaleDateString('en-CA', { timeZone: dev.timezone || 'UTC' });
      return { peakKw, peakAt, date, updatedAt: new Date().toISOString() };
    },

    async getWeek() {
      const dev = await getDeviceCached();
      const ids = dev.circuits.map(c => c.id);
      const start = daysAgoISO(7);
      const end   = nowISO();
      const raw   = await api.getEnergy({ deviceId: dev.deviceId, circuitIds: ids, start, end, resolution: 'DAYS' });
      const byId  = parseEnergyResponse(raw, ids);

      const tsSet = new Set();
      Object.values(byId).forEach(arr => arr.forEach(r => tsSet.add(r.start)));
      const days = [...tsSet].sort().map(ts => {
        const d = { ts, date: ts.slice(0, 10), totalKwh: 0, circuits: {}, partial: false };
        for (const c of dev.circuits) {
          const r = (byId[c.id] || []).find(x => x.start === ts);
          const kwh = r?.kwh ?? 0;
          d.circuits[c.id] = kwh;
          d.totalKwh += kwh;
          if (r?.partial) d.partial = true;
        }
        return d;
      });

      const totalKwh = days.reduce((s, d) => s + d.totalKwh, 0);
      return { totalKwh, costDollars: totalKwh * dev.ratePerKwh, days, updatedAt: new Date().toISOString() };
    },
  };
}
