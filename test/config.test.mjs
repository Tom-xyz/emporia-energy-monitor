import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig } from '../src/config.mjs';

test('loadConfig — reads from .env file in CWD', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'em-cfg-'));
  const dotenv = path.join(tmp, '.env');
  await fs.writeFile(dotenv,
    'EMPORIA_EMAIL=test@example.com\n' +
    'EMPORIA_PASSWORD=secret\n' +
    'PORT=4000\n' +
    'PLUGIN=emporia\n');

  // Clean env first to avoid pollution
  delete process.env.EMPORIA_EMAIL;
  delete process.env.EMPORIA_PASSWORD;
  delete process.env.PORT;
  delete process.env.PLUGIN;
  process.env.DOTENV_PATH = dotenv;
  process.env.DATA_DIR    = tmp;

  const cfg = await loadConfig();
  assert.equal(cfg.port, 4000);
  assert.equal(cfg.plugin, 'emporia');
  assert.equal(cfg.plugins.emporia.email, 'test@example.com');
  assert.equal(cfg.plugins.emporia.password, 'secret');

  await fs.rm(tmp, { recursive: true, force: true });
});

test('loadConfig — env vars override .env file', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'em-cfg-'));
  const dotenv = path.join(tmp, '.env');
  await fs.writeFile(dotenv, 'PORT=5000\n');

  process.env.PORT        = '6000';
  process.env.DOTENV_PATH = dotenv;
  process.env.DATA_DIR    = tmp;

  const cfg = await loadConfig();
  assert.equal(cfg.port, 6000, 'process.env should win over .env file');

  delete process.env.PORT;
  await fs.rm(tmp, { recursive: true, force: true });
});

test('loadConfig — handles quoted values in .env', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'em-cfg-'));
  const dotenv = path.join(tmp, '.env');
  await fs.writeFile(dotenv,
    'EMPORIA_EMAIL="quoted@example.com"\n' +
    "EMPORIA_PASSWORD='single-quoted-pass'\n");

  delete process.env.EMPORIA_EMAIL;
  delete process.env.EMPORIA_PASSWORD;
  process.env.DOTENV_PATH = dotenv;
  process.env.DATA_DIR    = tmp;

  const cfg = await loadConfig();
  assert.equal(cfg.plugins.emporia.email, 'quoted@example.com');
  assert.equal(cfg.plugins.emporia.password, 'single-quoted-pass');

  await fs.rm(tmp, { recursive: true, force: true });
});

test('loadConfig — defaults port to 3030', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'em-cfg-'));
  delete process.env.PORT;
  process.env.DOTENV_PATH = path.join(tmp, '.nonexistent');
  process.env.DATA_DIR    = tmp;

  const cfg = await loadConfig();
  assert.equal(cfg.port, 3030);
  assert.equal(cfg.plugin, 'emporia');

  await fs.rm(tmp, { recursive: true, force: true });
});
