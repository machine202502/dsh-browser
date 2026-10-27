import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Operator overrides for the plugin config.
 *
 * The profile patch stays the deployment default; this file holds what the
 * settings form saves, so a form write never has to edit YAML by hand.
 */
const KEYS = {
  headless: 'boolean',
  bridgePort: 'number',
  idleTimeoutMs: 'number',
  viewport: 'object',
  proxy: 'object',
  shots: 'object',
};

const bounded = (value, min, max) => Math.min(max, Math.max(min, value));

const sanitizeViewport = (value) => {
  const width = Number(value?.width);
  const height = Number(value?.height);
  return {
    ...(Number.isFinite(width) ? { width: bounded(Math.round(width), 320, 7680) } : {}),
    ...(Number.isFinite(height) ? { height: bounded(Math.round(height), 240, 4320) } : {}),
  };
};

const sanitizeProxy = (value) => {
  const out = {};
  if (typeof value?.server === 'string') out.server = value.server.trim().slice(0, 200);
  if (Array.isArray(value?.hosts)) {
    out.hosts = value.hosts
      .filter((host) => typeof host === 'string')
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0 && host.length <= 200)
      .slice(0, 200);
  }
  if (typeof value?.all === 'boolean') out.all = value.all;
  return out;
};

const sanitizeShots = (value) => {
  const out = {};
  if (typeof value?.enabled === 'boolean') out.enabled = value.enabled;
  if (Array.isArray(value?.on)) {
    out.on = value.on.filter((name) => typeof name === 'string').slice(0, 20);
  }
  const quality = Number(value?.quality);
  if (Number.isFinite(quality)) out.quality = bounded(Math.round(quality), 10, 100);
  const interval = Number(value?.minIntervalMs);
  if (Number.isFinite(interval)) out.minIntervalMs = bounded(Math.round(interval), 0, 60000);
  return out;
};

/** Keep only known keys with sane values; unknown input is dropped. */
export function sanitizeSettings(input = {}) {
  const out = {};
  for (const [key, kind] of Object.entries(KEYS)) {
    if (input[key] === undefined) continue;
    if (kind === 'boolean' && typeof input[key] === 'boolean') out[key] = input[key];
    if (kind === 'number') {
      const value = Number(input[key]);
      if (Number.isFinite(value)) {
        out[key] = key === 'bridgePort' ? bounded(Math.round(value), 1024, 65535) : bounded(Math.round(value), 0, 86_400_000);
      }
    }
    if (kind === 'object') {
      if (key === 'viewport') out.viewport = sanitizeViewport(input[key]);
      if (key === 'proxy') out.proxy = sanitizeProxy(input[key]);
      if (key === 'shots') out.shots = sanitizeShots(input[key]);
    }
  }
  return out;
}

export function createSettingsStore(root) {
  const file = join(root, 'settings.json');

  const read = () => {
    try {
      return sanitizeSettings(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return {};
    }
  };

  const write = (input) => {
    const clean = sanitizeSettings(input);
    mkdirSync(root, { recursive: true });
    writeFileSync(file, JSON.stringify(clean, null, 2), 'utf8');
    return clean;
  };

  /** Overrides win over the profile patch, section by section. */
  const merge = (defaults = {}) => {
    const overrides = read();
    return {
      ...defaults,
      ...overrides,
      viewport: { ...(defaults.viewport ?? {}), ...(overrides.viewport ?? {}) },
      proxy: { ...(defaults.proxy ?? {}), ...(overrides.proxy ?? {}) },
      shots: { ...(defaults.shots ?? {}), ...(overrides.shots ?? {}) },
    };
  };

  return { file, read, write, merge, exists: () => existsSync(file) };
}
