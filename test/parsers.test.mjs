import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEnergyResponse,
  parsePowerResponse,
  inferCircuitType,
} from '../src/plugins/emporia/api.mjs';

test('inferCircuitType — AC variants', () => {
  assert.equal(inferCircuitType('AC Office'),                          'ac');
  assert.equal(inferCircuitType('AC Master Bedroom'),                  'ac');
  assert.equal(inferCircuitType('Bedroom unit', 'Air Conditioner'),    'ac');
});

test('inferCircuitType — outlets', () => {
  assert.equal(inferCircuitType('Office Outlets'),                'outlet');
  assert.equal(inferCircuitType('Kitchen plug'),                  'outlet');
  assert.equal(inferCircuitType('Den', 'Room/Multi-use Circuit'), 'outlet');
});

test('inferCircuitType — lights, fans, other', () => {
  assert.equal(inferCircuitType('Office Lights'),     'light');
  assert.equal(inferCircuitType('Living room lamp'),  'light');
  assert.equal(inferCircuitType('Ceiling fan'),       'fan');
  assert.equal(inferCircuitType('Pool pump'),         'other');
});

test('parseEnergyResponse — extracts kWh by circuit', () => {
  const sample = {
    success: [{
      device_id: 'DEV1',
      circuit_usages: [
        { circuit_id: '1', usage: [
          { interval: { start: '2026-04-25T05:00:00Z' }, energy_kwhs: 1.234, partial: false },
          { interval: { start: '2026-04-26T05:00:00Z' }, energy_kwhs: 0.5,   partial: true  },
        ]},
        { circuit_id: '2', usage: [
          { interval: { start: '2026-04-25T05:00:00Z' }, energy_kwhs: 5.0, partial: false },
        ]},
        { circuit_id: 'IGNORED', usage: [
          { interval: { start: '2026-04-25T05:00:00Z' }, energy_kwhs: 99, partial: false },
        ]},
      ],
    }],
  };

  const out = parseEnergyResponse(sample, ['1', '2']);
  assert.deepEqual(Object.keys(out).sort(), ['1', '2']);
  assert.equal(out['1'].length, 2);
  assert.equal(out['1'][0].kwh, 1.234);
  assert.equal(out['1'][1].partial, true);
  assert.equal(out['2'][0].kwh, 5);
  assert.equal(out.IGNORED, undefined);
});

test('parseEnergyResponse — handles empty/missing fields', () => {
  assert.deepEqual(parseEnergyResponse({}, ['1']), {});
  assert.deepEqual(parseEnergyResponse({ success: [] }, ['1']), {});
  const r = parseEnergyResponse({
    success: [{ device_id: 'D', circuit_usages: [{ circuit_id: '1', usage: [{ interval: {}, energy_kwhs: null }] }] }],
  }, ['1']);
  assert.equal(r['1'][0].kwh, 0);
});

test('parsePowerResponse — extracts kW + volts/amps', () => {
  const sample = {
    success: [{
      device_id: 'DEV1',
      circuit_power: [
        { circuit_id: '1', power: [
          { interval: { start: '2026-04-26T03:55:00Z' }, average_power_kw: 0.123, volts: 240.5, amps: 0.5 },
          { interval: { start: '2026-04-26T03:56:00Z' }, average_power_kw: 0,     volts: 240.7, amps: 0   },
          { /* missing interval */ average_power_kw: 1.0 },
        ]},
      ],
    }],
  };

  const out = parsePowerResponse(sample, ['1']);
  assert.equal(out['1'].length, 2, 'entries with no timestamp should be filtered');
  assert.equal(out['1'][0].kw, 0.123);
  assert.equal(out['1'][0].volts, 240.5);
  assert.equal(out['1'][0].amps, 0.5);
  assert.equal(out['1'][0].ts, '2026-04-26T03:55:00Z');
});
