/**
 * Plugin loader. Pick a plugin by name from config and return an instance.
 * Adding a new energy monitor plugin:
 *   1. Create src/plugins/<name>/index.mjs that default-exports `(cfg) => EnergyPlugin`
 *   2. Add it to PLUGINS below
 */

import emporiaFactory from './emporia/index.mjs';

const PLUGINS = {
  emporia: emporiaFactory,
};

/**
 * @param {string} name
 * @param {object} config
 * @returns {Promise<import('./types.mjs').EnergyPlugin>}
 */
export async function loadPlugin(name, config) {
  const factory = PLUGINS[name];
  if (!factory) {
    const available = Object.keys(PLUGINS).join(', ');
    throw new Error(`Unknown plugin "${name}". Available: ${available}`);
  }
  return factory(config);
}

export const availablePlugins = Object.keys(PLUGINS);
