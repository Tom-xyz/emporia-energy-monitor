/**
 * Thin wrapper around the Emporia cloud REST APIs.
 * Two endpoints are used: a legacy one for /devices, and the newer c-api for
 * energy/power readings (which use a different auth header convention).
 */

const LEGACY_API = 'https://api.emporiaenergy.com';
const NEW_API    = 'https://c-api.emporiaenergy.com';

export class EmporiaAPI {
  constructor(auth) { this.auth = auth; }

  async _get(url, headerName) {
    const token = await this.auth.getIdToken();
    const res = await fetch(url, { headers: { [headerName]: token, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url} → ${res.status} ${await res.text()}`);
    return res.json();
  }

  /** List all devices on the account (legacy API). */
  getDevices() {
    return this._get(`${LEGACY_API}/customers/devices`, 'AuthToken');
  }

  /** Channel layout per device (new API). */
  getChannels() {
    return this._get(`${NEW_API}/v1/customers/devices/channels`, 'Authorization');
  }

  /** Energy (kWh) for circuits over a window. */
  getEnergy({ deviceId, circuitIds, start, end, resolution = 'DAYS' }) {
    const p = new URLSearchParams({
      device_ids:  deviceId,
      circuit_ids: circuitIds.join(','),
      start, end,
      energy_resolution: resolution,
    });
    return this._get(`${NEW_API}/v1/devices/energy-monitors/circuits/usages/energy?${p}`, 'Authorization');
  }

  /** Power (kW) — typically MINUTES resolution. */
  getPower({ deviceId, circuitIds, start, end, resolution = 'MINUTES' }) {
    const p = new URLSearchParams({
      device_ids:  deviceId,
      circuit_ids: circuitIds.join(','),
      start, end,
      power_resolution: resolution,
    });
    return this._get(`${NEW_API}/v1/devices/energy-monitors/circuits/usages/power?${p}`, 'Authorization');
  }

  /**
   * Legacy AppAPI — instant per-channel usage at fine resolutions. Unlike the
   * c-api `power` endpoint (floor: MINUTES), this accepts scale="1S" returning
   * kWh consumed in the 1-second bucket aligned to `instant`. Multiply by
   * 3600 for kW.  Caveats:
   *   - Only ~3 hours of 1S history is retained.
   *   - Polling faster than ~5s starts returning null channels under load
   *     (PyEmVue retries with backoff for the same reason).
   *   - This endpoint uses AuthToken header, not Authorization.
   */
  getDeviceListUsages({ deviceGid, instant, scale = '1S', energyUnit = 'KilowattHours' }) {
    const p = new URLSearchParams({
      apiMethod:  'getDeviceListUsages',
      deviceGids: String(deviceGid),
      instant,
      scale,
      energyUnit,
    });
    return this._get(`${LEGACY_API}/AppAPI?${p}`, 'AuthToken');
  }
}

// kWh-per-bucket → kW conversion factor for each scale.
const SCALE_KW_FACTOR = { '1S': 3600, '1MIN': 60, '15MIN': 4, '1H': 1 };

/**
 * Parse the AppAPI getDeviceListUsages response into a flat
 * { circuitId: { kw, name } } map. Returns null kw for missing channels so the
 * caller can detect partial responses and retry.
 */
export function parseDeviceListUsages(data, deviceGid, scale = '1S') {
  const factor = SCALE_KW_FACTOR[scale] ?? 1;
  const dlu = data?.deviceListUsages || {};
  const devices = dlu.devices || [];
  const dev = devices.find(d => String(d.deviceGid) === String(deviceGid)) || devices[0];
  if (!dev) return {};
  const byId = {};
  for (const ch of dev.channelUsages || []) {
    const usage = ch.usage;
    byId[String(ch.channelNum)] = {
      kw:   usage == null ? null : usage * factor,
      name: ch.name,
    };
    // Recurse into nestedDevices (some installs split mains across sub-devices)
    if (Array.isArray(ch.nestedDevices)) {
      for (const sub of ch.nestedDevices) {
        for (const subCh of sub.channelUsages || []) {
          const u = subCh.usage;
          byId[String(subCh.channelNum)] = {
            kw:   u == null ? null : u * factor,
            name: subCh.name,
          };
        }
      }
    }
  }
  return byId;
}

// ── Response parsers ────────────────────────────────────────────────────────

export function parseEnergyResponse(data, circuitIds) {
  const byId = {};
  for (const dev of data.success || []) {
    for (const c of dev.circuit_usages || []) {
      if (!circuitIds.includes(c.circuit_id)) continue;
      byId[c.circuit_id] = (c.usage || []).map(u => ({
        start:   u.interval?.start,
        kwh:     u.energy_kwhs ?? 0,
        partial: !!u.partial,
      }));
    }
  }
  return byId;
}

export function parsePowerResponse(data, circuitIds) {
  const byId = {};
  for (const dev of data.success || []) {
    for (const c of dev.circuit_power || []) {
      if (!circuitIds.includes(c.circuit_id)) continue;
      byId[c.circuit_id] = (c.power || []).filter(p => p.interval?.start).map(p => ({
        ts:    p.interval.start,
        kw:    p.average_power_kw ?? 0,
        volts: p.volts ?? null,
        amps:  p.amps  ?? null,
      }));
    }
  }
  return byId;
}

export function inferCircuitType(name = '', subType = '') {
  const n = name.toLowerCase();
  const s = subType.toLowerCase();
  if (s.includes('air conditioner') || /\bac\b/.test(n) || n.startsWith('ac '))  return 'ac';
  if (n.includes('light') || n.includes('lamp'))                                  return 'light';
  if (n.includes('fan'))                                                          return 'fan';
  if (n.includes('outlet') || n.includes('plug') || s.includes('multi-use'))     return 'outlet';
  return 'other';
}
