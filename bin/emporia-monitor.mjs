#!/usr/bin/env node
/**
 * emporia-monitor — CLI entrypoint.
 * Loads config (env + .env), starts the dashboard server.
 *
 * Flags:
 *   --version        print version
 *   --help           print usage
 *   --port <n>       override PORT
 *   --plugin <name>  override PLUGIN
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const args = process.argv.slice(2);
const flag = (name, hasValue = false) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return hasValue ? args[i + 1] : true;
};

if (flag('--version') || flag('-v')) { console.log(pkg.version); process.exit(0); }

if (flag('--help') || flag('-h')) {
  console.log(`
${pkg.name} v${pkg.version}
${pkg.description}

Usage:  emporia-monitor [options]

Options:
  --port <n>        HTTP port (default: 3030, env: PORT)
  --plugin <name>   Data source plugin (default: emporia, env: PLUGIN)
  --version, -v     Print version and exit
  --help, -h        Print this help

Configuration is read from environment variables and an optional .env file
in the current directory (or DOTENV_PATH). See .env.example for all options.

Required for the Emporia plugin:
  EMPORIA_EMAIL, EMPORIA_PASSWORD

Documentation: ${pkg.homepage || 'https://github.com/Tom-xyz/emporia-energy-monitor'}
`);
  process.exit(0);
}

const overrides = {};
const portArg   = flag('--port',   true);
const pluginArg = flag('--plugin', true);
if (portArg)   overrides.port = parseInt(portArg, 10);
if (pluginArg) overrides.plugin = pluginArg;
overrides.version = pkg.version;

const { startServer } = await import('../src/server.mjs');

try {
  const { server } = await startServer(overrides);

  const shutdown = (sig) => {
    console.log(`\nReceived ${sig}, shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
} catch (e) {
  console.error(`\n✗ Startup failed: ${e.message}\n`);
  if (e.message.includes('EMPORIA_EMAIL')) {
    console.error(`  Set EMPORIA_EMAIL and EMPORIA_PASSWORD in your environment or .env file.`);
    console.error(`  See .env.example for a template.\n`);
  }
  process.exit(1);
}
