/**
 * Configuration loader. Reads from environment, with .env file support.
 * Order of precedence:
 *   1. process.env (already set)
 *   2. .env file in CWD or DOTENV_PATH
 *   3. defaults
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

/** Minimal .env parser — no expansion, no quotes-magic, just KEY=VALUE per line. */
async function loadDotenv(file) {
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); } catch { return {}; }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function defaultDataDir() {
  // ~/.local/share/emporia-monitor — XDG-friendly
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdg, 'emporia-monitor');
}

export async function loadConfig() {
  const dotenvPath = process.env.DOTENV_PATH || path.join(process.cwd(), '.env');
  const fromFile = await loadDotenv(dotenvPath);
  const env = { ...fromFile, ...process.env };

  const dataDir = env.DATA_DIR || defaultDataDir();
  await fs.mkdir(dataDir, { recursive: true });

  const theme = (env.THEME || 'dark').toLowerCase();
  const validThemes = ['dark', 'light', 'auto'];

  return {
    plugin:    env.PLUGIN || 'emporia',
    port:      parseInt(env.PORT || '3030', 10),
    host:      env.HOST || '0.0.0.0',
    dataDir,
    logLevel:  env.LOG_LEVEL || 'info',
    ui: {
      theme:        validThemes.includes(theme) ? theme : 'dark',
      tween:        env.TWEEN === '1',
      jitter:       env.JITTER !== '0',
      sparkline:    env.SHOW_SPARKLINE !== '0',
    },
    plugins: {
      emporia: {
        email:       env.EMPORIA_EMAIL,
        password:    env.EMPORIA_PASSWORD,
        keysFile:    env.EMPORIA_KEYS_FILE,
        deviceIndex: parseInt(env.EMPORIA_DEVICE_INDEX || '0', 10),
        timezone:    env.EMPORIA_TIMEZONE,
        fastLive:    env.EMPORIA_FAST_LIVE === '1',
        dataDir,
      },
    },
  };
}
