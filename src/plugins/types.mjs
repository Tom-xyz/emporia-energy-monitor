/**
 * Energy data source plugin contract.
 *
 * A plugin is an object that exposes the four async methods below. The dashboard
 * server is plugin-agnostic — it calls these methods and renders the returned
 * data. To add a new energy monitor (Sense, Iotawatt, Shelly EM, etc.), drop a
 * new module in `src/plugins/<name>/index.mjs` that default-exports a factory
 * `(config) => Plugin` and add the name to `PLUGINS` in `src/plugins/index.mjs`.
 *
 * @typedef {Object} CircuitInfo
 * @property {string} id     - stable identifier used in the API (e.g. "1")
 * @property {string} name   - human-friendly label shown in the UI
 * @property {'ac'|'outlet'|'light'|'fan'|'other'} type
 *
 * @typedef {Object} DeviceInfo
 * @property {string} deviceId
 * @property {string} name        - location/device label, shown in header
 * @property {string} model
 * @property {string} firmware
 * @property {number} ratePerKwh  - $/kWh
 * @property {string} timezone    - IANA tz name, used to bucket "today"
 * @property {CircuitInfo[]} circuits
 *
 * @typedef {Object} CircuitLive
 * @property {number}      kw
 * @property {number|null} volts
 * @property {number|null} amps
 *
 * @typedef {Object} LiveSnapshot
 * @property {number} totalKw                            - sum across circuits
 * @property {Object<string, CircuitLive>} circuits     - circuitId → reading
 * @property {Array<{ts:string, totalKw:number, circuits:Object<string,CircuitLive>}>} series
 * @property {string} updatedAt - ISO timestamp
 *
 * @typedef {Object} TodayUsage
 * @property {number} totalKwh
 * @property {number} costDollars
 * @property {Object<string, number>} circuits          - circuitId → kWh today
 * @property {Array<{ts:string, totalKwh:number, circuits:Object<string,number>}>} hours
 * @property {string} updatedAt
 *
 * @typedef {Object} DayUsage
 * @property {string} ts
 * @property {string} date         - YYYY-MM-DD in device tz
 * @property {number} totalKwh
 * @property {Object<string, number>} circuits
 * @property {boolean} partial
 *
 * @typedef {Object} WeekUsage
 * @property {number} totalKwh
 * @property {number} costDollars
 * @property {DayUsage[]} days
 * @property {string} updatedAt
 *
 * @typedef {Object} PeakSnapshot
 * @property {number} peakKw       - highest instantaneous total kW seen since local midnight
 * @property {string|null} peakAt  - ISO timestamp of the peak minute (or null if unknown)
 * @property {string} date         - YYYY-MM-DD in device tz
 * @property {string} updatedAt
 *
 * @typedef {Object} EnergyPlugin
 * @property {string} name
 * @property {() => Promise<DeviceInfo>}     getDevice
 * @property {() => Promise<LiveSnapshot>}   getLive
 * @property {() => Promise<TodayUsage>}     getToday
 * @property {() => Promise<WeekUsage>}      getWeek
 * @property {() => Promise<PeakSnapshot>=}  getPeakToday  - optional; if absent, /api/peak is unavailable and the UI falls back to client-tracked peak
 */

export {};
