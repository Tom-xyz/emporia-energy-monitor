# Plugin Architecture

The dashboard server is data-source agnostic. The `EnergyPlugin` interface defines four async methods; any backend that implements them can be slotted in without changing the UI.

## Interface

```js
{
  name: string,                              // display name
  getDevice(): Promise<DeviceInfo>,          // device + circuits
  getLive():   Promise<LiveSnapshot>,        // current power (watts/kW per circuit)
  getToday():  Promise<TodayUsage>,          // today's kWh + hourly breakdown
  getWeek():   Promise<WeekUsage>,           // last 7 days, daily kWh
}
```

Full type definitions live in [`src/plugins/types.mjs`](../src/plugins/types.mjs).

## Adding a new plugin

1. Create `src/plugins/<name>/index.mjs` exporting a default factory:

   ```js
   export default function createMyPlugin(config) {
     return {
       name: 'My Monitor',
       async getDevice() { /* … */ },
       async getLive()   { /* … */ },
       async getToday()  { /* … */ },
       async getWeek()   { /* … */ },
     };
   }
   ```

2. Register it in `src/plugins/index.mjs`:

   ```js
   import myFactory from './my/index.mjs';
   const PLUGINS = { emporia: emporiaFactory, my: myFactory };
   ```

3. Add config keys to `src/config.mjs` under `plugins.<name>` and document them in `.env.example`.

4. Select at runtime: `PLUGIN=my emporia-monitor`

## Currently supported plugins

| Plugin    | Status | Notes                                                                                   |
|-----------|--------|-----------------------------------------------------------------------------------------|
| `emporia` | stable | Cloud API (AWS Cognito + REST). Works with all Vue 1/2/3 devices and smart plugs.       |

## Roadmap candidates

- `sense` — Sense Energy Monitor (cloud API, undocumented but reverse-engineered)
- `iotawatt` — IoTaWatt local HTTP API (no cloud dependency)
- `shelly-em` — Shelly EM/3EM via local HTTP/CoAP
- `home-assistant` — pull energy entities from a Home Assistant instance
