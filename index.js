import z from '@deepseek-ai/schemastery';
import { appendFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BrowserManager } from './src/browser-manager.js';
import { createSettingsStore } from './src/settings.js';
import { createRoutingProxy } from './src/routing-proxy.js';
import { createBridge } from './src/bridge.js';
import { runCommand, COMMANDS } from './src/commands.js';

/**
 * Host half of the browser panel bundle.
 *
 * Isolation model: one Chromium per *agent*, not per Session. A subagent opens
 * its own browser, sees only its own tabs, can close only those, and its
 * browser dies with the agent. Recursion falls out of the same rule — a
 * subagent of a subagent is just another agent object.
 *
 * The dock card shows the browser of the first agent that used it (the Session's
 * primary agent); subagent browsers are invisible there on purpose.
 */
// Data directory per platform: %LOCALAPPDATA% on Windows, XDG on Linux,
// Application Support on macOS.
const DATA_HOME =
  process.env.LOCALAPPDATA ??
  (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support')
    : process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'));
const LOG_DIR = join(DATA_HOME, 'dsh-browser');
const LOG_FILE = join(LOG_DIR, 'apply.log');

function log(line) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging must never break activation */
  }
}

export const inject = ['tools'];

/**
 * Settings form: the Plugins page renders these fields from the schema, so the
 * operator does not have to edit cordis.patch.yml by hand.
 */
export const Config = z.object({
  headless: z.boolean().default(true).description('Run Chromium without a window'),
  bridgePort: z.natural().default(49221).description('Loopback port of the panel bridge'),
  idleTimeoutMs: z.natural().default(900000).description('Close an idle browser after this many milliseconds'),
  viewport: z.object({
    width: z.natural().default(1280).description('Default viewport width'),
    height: z.natural().default(800).description('Default viewport height'),
  }).default({ width: 1280, height: 800 }),
  proxy: z.object({
    server: z.string().default('127.0.0.1:10901').description('HTTP proxy address'),
    hosts: z.array(z.string()).default([]).description('Sites routed through the proxy'),
    all: z.boolean().default(false).description('Route every request through the proxy'),
  }).default({ server: '127.0.0.1:10901', hosts: [], all: false }),
  shots: z.object({
    enabled: z.boolean().default(true).description('Attach action screenshots to the chat'),
    on: z.array(z.string()).default(['open', 'navigate', 'click', 'resize', 'drag'])
      .description('Actions that produce a frame'),
    quality: z.natural().min(10).max(100).default(55).description('JPEG quality'),
    minIntervalMs: z.natural().default(1500).description('Minimum gap between frames per tab'),
  }).default({ enabled: true, on: ['open', 'navigate', 'click', 'resize', 'drag'], quality: 55, minIntervalMs: 1500 }),
});

export function apply(ctx, config = {}) {
  log('apply start');
  try {
    activate(ctx, config ?? {});
    log('apply ok');
  } catch (error) {
    log(`apply FAILED: ${error?.stack ?? error}`);
    throw error;
  }
}

const obj = (properties = {}, required = []) => ({
  type: 'object',
  additionalProperties: false,
  ...(required.length ? { required } : {}),
  properties,
});

function activate(ctx, config) {
  const headless = config.headless !== false;
  // The settings form writes overrides; the profile patch stays the default.
  const settingsStore = createSettingsStore(LOG_DIR);
  // The profile patch is the deployment default; the form writes overrides and
  // every newly created browser reads them again.
  const yamlConfig = { ...config };
  const currentConfig = () => settingsStore.merge(yamlConfig);
  config = currentConfig();

  const width = config.viewport?.width ?? 1280;
  const height = config.viewport?.height ?? 800;
  const idleMs = config.idleTimeoutMs ?? 900000;
  const bridgePort = config.bridgePort ?? 49221;
  const normalizeProxyServer = (value) => {
    const text = String(value ?? '').trim();
    const match = /^(?:https?:\/\/)?([^/:\s]+):(\d{1,5})\/?$/.exec(text);
    if (!match) throw new Error(`invalid proxy address "${text}": use host:port, e.g. 127.0.0.1:10901`);
    const port = Number(match[2]);
    if (port < 1 || port > 65535) throw new Error(`invalid proxy port ${port}`);
    return `${match[1]}:${port}`;
  };
  let proxyServer = config.proxy?.server ?? '127.0.0.1:10901';
  // Proxy rules survive restarts: the operator's host list is small and worth
  // keeping, unlike cookies which belong to a throwaway profile.
  const PROXY_STATE = join(LOG_DIR, 'proxy-state.json');
  const readProxyState = () => {
    try {
      const parsed = JSON.parse(readFileSync(PROXY_STATE, 'utf8'));
      return {
        hosts: Array.isArray(parsed?.hosts) ? parsed.hosts.filter((entry) => typeof entry === 'string') : [],
        all: parsed?.all === true,
        server: typeof parsed?.server === 'string' ? parsed.server : null,
        saved: true,
      };
    } catch {
      return { hosts: [], all: false, server: null, saved: false };
    }
  };
  const savedProxy = readProxyState();
  const writeProxyState = () => {
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(PROXY_STATE, JSON.stringify({ hosts: [...proxyHosts], all: proxyAll, server: proxyServer }), 'utf8');
    } catch (error) {
      log(`proxy state not saved: ${error?.message ?? error}`);
    }
  };

  const proxyHosts = new Set(savedProxy.saved
    ? savedProxy.hosts
    : (Array.isArray(config.proxy?.hosts) ? config.proxy.hosts : []));
  let proxyAll = savedProxy.saved ? savedProxy.all : config.proxy?.all === true;
  if (savedProxy.saved && savedProxy.server) proxyServer = savedProxy.server;
  let proxyReport = null;

  // Per-site routing happens in a loopback proxy: Chromium 156 ignores PAC.
  const routingProxy = createRoutingProxy({
    rules: () => ({ hosts: [...proxyHosts], all: proxyAll, server: proxyServer }),
    upstream: proxyServer,
    port: 49222,
  });
  const routingReady = routingProxy.listen().catch((error) => log(`routing proxy failed: ${error?.message ?? error}`));

  const proxy = {
    rules: () => ({ proxy: proxyServer, server: proxyServer, hosts: [...proxyHosts], all: proxyAll }),
    report: (payload) => { proxyReport = { ...payload, at: Date.now() }; },
    snapshot: () => ({
      proxy: proxyServer,
      hosts: [...proxyHosts],
      all: proxyAll,
      reportedAt: proxyReport?.at ?? null,
      applied: proxyReport?.applied ?? null,
    }),
  };

  const shotsConfig = () => {
    const live = currentConfig().shots ?? {};
    return {
      enabled: live.enabled !== false,
      on: Array.isArray(live.on) ? live.on : ['open', 'navigate', 'click', 'resize', 'drag'],
      quality: live.quality ?? 55,
      minIntervalMs: live.minIntervalMs ?? 1500,
    };
  };
  {
    const initialShots = shotsConfig();
    log(`shots: ${initialShots.enabled ? 'on' : 'off'} for ${initialShots.on.join(',')}`);
  }

  // Recent frames for the chat view; a small ring buffer is enough.
  const frames = new Map();
  const frameMeta = new Map();
  const keepFrame = (buffer, cursor = null, viewport = null) => {
    const id = Math.random().toString(36).slice(2, 10);
    frames.set(id, buffer);
    if (cursor && viewport) frameMeta.set(id, { x: cursor.x, y: cursor.y, w: viewport.width, h: viewport.height });
    if (frames.size > 40) {
      const oldest = frames.keys().next().value;
      frames.delete(oldest);
      frameMeta.delete(oldest);
    }
    return id;
  };

  // Artifacts follow the same one-day rule as Lighthouse reports; an archived
  // Session removes them sooner.
  try {
    const artifactsRoot = join(tmpdir(), 'dsh-browser-downloads');
    let swept = 0;
    for (const name of readdirSync(artifactsRoot)) {
      const full = join(artifactsRoot, name);
      if (Date.now() - statSync(full).mtimeMs > 24 * 60 * 60 * 1000) {
        rmSync(full, { recursive: true, force: true });
        swept++;
      }
    }
    if (swept > 0) log(`artifacts swept: ${swept} folder(s) older than a day`);
  } catch { /* the folder appears with the first download */ }

  // A hard kill can leave a throwaway profile behind: no Chromium outlives the
  // host, so any run-* older than half an hour is dead weight.
  try {
    for (const name of readdirSync(profilesRoot)) {
      if (!name.startsWith('run-')) continue;
      const full = join(profilesRoot, name);
      const age = Date.now() - statSync(full).mtimeMs;
      if (age > 30 * 60 * 1000) rmSync(full, { recursive: true, force: true });
    }
  } catch { /* the folder is created on first launch */ }

  const profilesRoot = join(LOG_DIR, 'profiles');

  /** key -> { agent, manager, timer } */
  const entries = new Map();
  const byAgent = new WeakMap();
  let counter = 0;
  let primary = null;

  const describeAgent = (agent) => {
    if (!agent) return 'no-agent';
    const id = agent.id ?? agent.sessionId ?? agent.name;
    return id ? `agent:${id}` : 'agent:anon';
  };

  /** Artifacts belong to the browser: an archived session leaves nothing behind. */
  const purgeArtifacts = (entry) => {
    if (!entry) return;
    try { rmSync(entry.manager.downloadDir, { recursive: true, force: true }); } catch { /* locked */ }
  };

  const closeEntry = (entry) => {
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.manager.closeAll().catch(() => {});
  };

  const touch = (entry) => {
    if (entry.timer) clearTimeout(entry.timer);
    if (idleMs > 0) {
      entry.timer = setTimeout(() => closeEntry(entry), idleMs);
      entry.timer.unref?.();
    }
  };

  // A browser belongs to the session that created it; the card only reports
  // those, so a second window never shows another session's tabs. Subagent
  // browsers hang off the root session that spawned them.
  const sessionIds = (agent) => {
    let node = agent;
    let guard = 0;
    while (node && (node.parentAgent ?? node.parent) && guard++ < 32) {
      node = node.parentAgent ?? node.parent;
    }
    const self = agent?.session?.id ?? null;
    // A subagent's own session carries the parent in its creation lineage, so
    // its browser belongs to the card of the session that spawned it.
    const header = node?.session?.header ?? agent?.session?.header ?? {};
    // The runtime records the spawning session as `parentSession` (an id or a
    // reference), not under `lineage`.
    const parentRaw = header.parentSession ?? header.lineage?.parentSessionId ?? null;
    const parentId = typeof parentRaw === 'string' ? parentRaw : (parentRaw?.id ?? null);
    log(`session ${self}: parent=${String(parentId)}`);
    return { self, root: parentId ?? node?.session?.id ?? self };
  };

  let debugSlot = 0;

  /** A manager always starts from the settings in force right now. */
  const makeManager = (key) => {
    const live = currentConfig();
    return new BrowserManager({
      sessionId: key,
      width: live.viewport?.width ?? width,
      height: live.viewport?.height ?? height,
      headless: live.headless !== false,
      profileRoot: profilesRoot,
      debugPort: 9300 + (++debugSlot % 90),
      onLog: log,
      proxyServer: 49222,
      proxyServerReady: routingReady,
    });
  };

  const entryFor = (exec) => {
    const agent = exec?.agent;
    let entry = agent ? byAgent.get(agent) : undefined;
    if (entry) {
      // A browser that was closed picks up the current settings next time.
      if (!entry.manager.isRunning) entry.manager = makeManager(entry.key);
      return entry;
    }

    const key = `b${++counter}`;
    const ids = sessionIds(agent);
    entry = {
      key,
      agent,
      sessionId: ids.self,
      rootSessionId: ids.root,
      manager: makeManager(key),
      timer: null,
    };
    entries.set(key, entry);
    if (agent) byAgent.set(agent, entry);
    if (!primary) primary = entry;
    log(`browser created for ${describeAgent(agent)} as ${key}`);
    return entry;
  };

  // The card is the human's overview: it shows every agent's tabs, marked with
  // their owner. Agents themselves still only ever reach their own browser.
  const route = (id) => {
    const [key, tab] = String(id).split(':');
    return { entry: entries.get(key), tab };
  };

  const view = {
    get sessionId() {
      return primary ? primary.key : 'none';
    },
    get isRunning() {
      for (const entry of entries.values()) if (entry.manager.isRunning) return true;
      return false;
    },
    async tabs(options, session) {
      const out = [];
      for (const entry of entries.values()) {
        if (!entry.manager.isRunning) continue;
        if (session && entry.sessionId !== session && entry.rootSessionId !== session) continue;
        const tabs = await entry.manager.tabs(options);
        for (const tab of tabs) {
          out.push({
            ...tab,
            id: `${entry.key}:${tab.id}`,
            key: entry.key,
            sessionId: entry.sessionId,
            rootSessionId: entry.rootSessionId,
            owner: entry === primary ? 'main' : 'sub',
          });
        }
      }
      return out;
    },
    /** Every live browser, for the sidebar section. */
    async browsers() {
      const out = [];
      for (const entry of entries.values()) {
        const running = entry.manager.isRunning;
        let count = 0;
        if (running) {
          const tabs = await entry.manager.tabs({ thumb: false }).catch(() => []);
          count = tabs.length;
        }
        out.push({
          key: entry.key,
          sessionId: entry.sessionId,
          rootSessionId: entry.rootSessionId,
          title: entry.agent?.session?.title ?? entry.agent?.session?.metadata?.title ?? null,
          running,
          tabs: count,
        });
      }
      return out;
    },

    async shot(id, options) {
      const { entry, tab } = route(id);
      if (!entry) throw new Error('unknown browser');
      return entry.manager.shot(tab, options);
    },
    async close(id) {
      const { entry, tab } = route(id);
      return entry ? entry.manager.close(tab) : { closed: false };
    },
    /** Close one browser by its key, leaving the session's others alone. */
    async closeBrowser(key, { purge = false } = {}) {
      const entry = entries.get(String(key));
      if (!entry) return { closed: false };
      await entry.manager.closeAll().catch(() => {});
      if (purge) purgeArtifacts(entry);
      return { closed: true };
    },

    async closeAll(session, { purge = false } = {}) {
      for (const entry of entries.values()) {
        if (session && entry.sessionId !== session && entry.rootSessionId !== session) continue;
        await entry.manager.closeAll().catch(() => {});
        if (purge) purgeArtifacts(entry);
      }
      return { closed: true };
    },
  };

  const bridge = createBridge({
    settings: {
      view: () => ({ values: settingsStore.merge(config), defaults: config, overrides: settingsStore.read(), file: settingsStore.file }),
      save: (input) => ({ saved: settingsStore.write(input), file: settingsStore.file, restart: true }),
    }, manager: view, proxy, frames: (id) => frames.get(id) ?? null, port: bridgePort });

  ctx.effect(() => {
    bridge
      .listen()
      .then((info) => log(`bridge on 127.0.0.1:${info.port}`))
      .catch((error) => log(`bridge FAILED: ${error?.message ?? error}`));
    return () => {
      for (const entry of entries.values()) closeEntry(entry);
      entries.clear();
      try { bridge.close(); } catch { /* ignore */ }
      try { routingProxy.close(); } catch { /* ignore */ }
    };
  });

  // A Session boundary owns every browser it contains.
  for (const event of ['session/close', 'session/delete']) {
    try {
      ctx.on(event, (payload) => {
        const id = payload?.sessionId ?? payload?.id ?? payload?.session?.id ?? null;
        // Closing one Session must not touch another Session's browser.
        if (!id) {
          log(`${event}: no session id in the payload, leaving browsers alone`);
          return;
        }
        log(`${event}: closing browsers of ${id}`);
        for (const entry of [...entries.values()]) {
          if (entry.sessionId !== id && entry.rootSessionId !== id) continue;
          closeEntry(entry);
          // A deleted Session leaves no artifacts behind; a closed one keeps them
          // so the operator can still read a report.
          if (event === 'session/delete') purgeArtifacts(entry);
          entries.delete(entry.key);
        }
        if (entries.size === 0) primary = null;
      });
    } catch (error) {
      log(`event ${event} unavailable: ${error?.message ?? error}`);
    }
  }

  // Diagnostic: find which event accompanies archiving, so the browser bound to
  // that Session can be closed instead of living until the idle timeout.
  for (const event of ['workspace/changes', 'session/disposed', 'session/close', 'session/delete']) {
    try {
      ctx.on(event, (payload) => {
        let preview = '';
        try {
          preview = JSON.stringify(payload).slice(0, 300);
        } catch {
          preview = String(payload);
        }
        log(`${event}: ${preview}`);
      });
    } catch (error) {
      log(`event ${event} unavailable: ${error?.message ?? error}`);
    }
  }

  // An agent boundary owns exactly its own browser: a finished subagent takes
  // its tabs down and leaves the primary browser untouched.
  try {
    ctx.on('agent/disposed', (payload) => {
      const agent = payload?.agent ?? payload;
      let entry = agent ? byAgent.get(agent) : undefined;
      if (!entry && payload?.id) {
        for (const candidate of entries.values()) {
          if (candidate.agent?.id === payload.id) { entry = candidate; break; }
        }
      }
      if (!entry) {
        const shape = payload && typeof payload === 'object' ? Object.keys(payload).join(',') : typeof payload;
        log(`agent/disposed unmatched: keys=${shape}`);
        return;
      }
      log(`closing browser ${entry.key} on agent/disposed`);
      closeEntry(entry);
      entries.delete(entry.key);
      if (primary === entry) primary = null;
    });
  } catch (error) {
    log(`event agent/disposed unavailable: ${error?.message ?? error}`);
  }

  // Images ride along with the tool result: they are stored in the attachment
  // store and referenced from the rendered content, never inlined as base64.
  const shotRefs = new WeakMap();
  const SHOT_ACTIONS = {
    browser_open: 'open',
    browser_navigate: 'navigate',
    browser_click: 'click',
    browser_resize: 'resize',
    browser_drag: 'drag',
  };

  // Every browser tool carries an explicit deadline: a stuck page or a dead CDP
  // session must surface as an error instead of freezing the turn.
  const DEFAULT_TIMEOUT_MS = 30000;
  const TOOL_TIMEOUTS = {
    browser_open: 45000,
    browser_navigate: 45000,
    browser_click: 20000,
    browser_fill: 20000,
    browser_hover: 15000,
    browser_drag: 20000,
    browser_resize: 10000,
    browser_text: 15000,
    browser_tabs: 20000,
    browser_cdp: 15000,
    browser_run: 20000,
  };

  const withDeadline = async (promise, ms, label) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const describeTimeout = (name, args) => {
    const fallback = TOOL_TIMEOUTS[name] ?? DEFAULT_TIMEOUT_MS;
    const asked = Number(args?.timeout ?? args?.args?.timeout);
    return Number.isFinite(asked) && asked > 0 ? Math.min(asked, 600000) : fallback;
  };

  const tool = (definition) => {
    const action = SHOT_ACTIONS[definition.name];
    // The wrapper is always installed; whether a frame is taken is decided when
    // the tool runs, so the settings form takes effect without a restart.
    if (action) {
      const execute = definition.execute;
      const render = definition.output.render;
      // The attachment id rides inside the result value: the runtime may copy it
      // before rendering, so identity-based lookup is not reliable.
      definition.output.schema.properties.shot = { type: 'string' };
      definition = {
        ...definition,
        output: {
          ...definition.output,
          render: (args, value) => {
            const blocks = render(args, value) ?? [];
            const id = value && typeof value === 'object' ? value.shot : null;
            if (!id) return blocks;
            const a = args ?? {};
            const human =
              definition.name === 'browser_click' ? (a.selector ? `Click ${a.selector}` : 'Click')
              : definition.name === 'browser_navigate' || definition.name === 'browser_open' ? (a.url ?? 'Open page')
              : definition.name === 'browser_resize' ? `Resize ${a.width ?? '?'}×${a.height ?? '?'}`
              : definition.name === 'browser_drag' ? 'Drag on page'
              : '';
            const cursor = frameMeta.get(id);
            const suffix = cursor ? `|${cursor.x},${cursor.y},${cursor.w},${cursor.h}` : '';
            return [...blocks, { type: 'text', text: `[shot:${id}${suffix}]${human}` }];
          },
        },
        execute: async (args, exec) => {
          const value = await execute(args, exec);
          const tabId = (value && typeof value === 'object' ? (value.id ?? value.tab) : null) ?? args?.tab;
          let shotId = null;
          if (tabId) {
            try {
              const live = shotsConfig();
              if (!live.enabled) return value;
              const entry = entryFor(exec);
              touch(entry);
              const frame = await entry.manager.capture(tabId, {
                quality: live.quality,
                minIntervalMs: live.minIntervalMs,
              });
              if (frame) {
                shotId = keepFrame(frame.data, entry.manager.cursor(tabId), entry.manager.viewport(tabId));
                log(`frame kept: ${shotId}`);
              }
            } catch (error) {
              log(`screenshot failed: ${error?.message ?? error}`);
            }
          }
          // Copy instead of mutating: Playwright reuses some result objects, and a
          // stray `shot` key then breaks the next tool's output schema.
          if (shotId && value && typeof value === 'object') return { ...value, shot: shotId };
          return value;
        },
        isConcurrencySafe: () => false,
      };
    }
    // The deadline is mandatory for browser tools: declare it and enforce it.
    if (definition.name.startsWith('browser_')) {
      const props = definition.parameters?.properties;
      if (props && typeof props === 'object') {
        props.timeout = {
          type: 'number',
          description: `Timeout in milliseconds (default ${TOOL_TIMEOUTS[definition.name] ?? DEFAULT_TIMEOUT_MS}).`,
        };
      }
      const execute = definition.execute;
      definition = {
        ...definition,
        execute: (args, exec) => withDeadline(
          execute(args, exec),
          describeTimeout(definition.name, args),
          definition.name,
        ),
      };
    }
    try {
      ctx.tools.register(definition);
      log(`tool registered: ${definition.name}`);
    } catch (error) {
      log(`tool ${definition.name} FAILED: ${error?.message ?? error}`);
    }
  };

  const withBrowser = (fn) => async (args, exec) => {
    const entry = entryFor(exec);
    touch(entry);
    return fn(entry.manager, args);
  };

  tool({
    name: 'browser_tabs',
    description: 'List the tabs of YOUR browser: id, title, URL and viewport. Each agent has its own isolated browser.',
    parameters: obj(),
    output: {
      schema: obj({
        running: { type: 'boolean' },
        tabs: {
          type: 'array',
          items: obj({
            id: { type: 'string' },
            url: { type: 'string' },
            title: { type: 'string' },
            ctx: { type: 'string' },
            viewport: obj({ width: { type: 'number' }, height: { type: 'number' } }, []),
            active: { type: 'boolean' },
          }, []),
        },
      }, ['running', 'tabs']),
      render: (_a, v) => [{
        type: 'text',
        text: v.tabs.length
          ? v.tabs.map((t) => `${t.id} [${t.ctx || 'ctx1'}]  ${t.title || '(untitled)'}  ${t.url}  ${t.viewport.width}x${t.viewport.height}`).join('\n')
          : 'browser: no tabs open',
      }],
    },
    isConcurrencySafe: () => true,
    execute: withBrowser(async (m) => {
      const tabs = await m.tabs({ thumb: false });
      return { running: m.isRunning, tabs: tabs.map(({ thumb, cursor, ...rest }) => rest) };
    }),
  });

  tool({
    name: 'browser_open',
    description: 'Open a new tab in YOUR browser.',
    parameters: obj({
      url: { type: 'string', description: 'Absolute http(s) URL.' },
      ctx: { type: 'string', description: 'Isolated context name, e.g. "ctx1" (default) or "ctx2" for a second client with its own cookies.' },
      width: { type: 'number', description: 'Viewport width in CSS pixels.' },
      height: { type: 'number', description: 'Viewport height in CSS pixels.' },
    }, ['url']),
    output: {
      schema: obj({ id: { type: 'string' }, ctx: { type: 'string' }, url: { type: 'string' }, title: { type: 'string' } }, ['id', 'url']),
      render: (_a, v) => [{ type: 'text', text: `opened ${v.id} [${v.ctx}]: ${v.title || ''} ${v.url}`.trim() }],
    },
    isConcurrencySafe: () => false,
    execute: withBrowser(async (m, args) => {
      const opened = await m.open(args.url, { ctx: args.ctx, timeout: args.timeout });
      if (args.width && args.height) await m.resize(opened.id, args.width, args.height);
      return opened;
    }),
  });

  tool({
    name: 'browser_navigate',
    description: 'Navigate a tab of YOUR browser to a URL.',
    parameters: obj({ tab: { type: 'string' }, url: { type: 'string' } }, ['tab', 'url']),
    output: {
      schema: obj({ url: { type: 'string' }, title: { type: 'string' } }, ['url']),
      render: (_a, v) => [{ type: 'text', text: `${v.title || ''} ${v.url}`.trim() }],
    },
    isConcurrencySafe: () => false,
    execute: withBrowser((m, args) => m.goto(args.tab, args.url)),
  });

  tool({
    name: 'browser_resize',
    description: 'Set one tab\'s viewport to test responsive layout.',
    parameters: obj({
      tab: { type: 'string' },
      width: { type: 'number' },
      height: { type: 'number' },
    }, ['tab', 'width', 'height']),
    output: {
      schema: obj({ width: { type: 'number' }, height: { type: 'number' } }, ['width', 'height']),
      render: (_a, v) => [{ type: 'text', text: `viewport ${v.width}x${v.height}` }],
    },
    isConcurrencySafe: () => false,
    execute: withBrowser((m, args) => m.resize(args.tab, args.width, args.height)),
  });

  tool({
    name: 'browser_click',
    description: 'Click an element by CSS selector.',
    parameters: obj({ tab: { type: 'string' }, selector: { type: 'string' } }, ['tab', 'selector']),
    output: {
      schema: obj({ url: { type: 'string' }, title: { type: 'string' }, dialog: { type: 'boolean' } }, ['url']),
      render: (_a, v) => [{
        type: 'text',
        text: v.dialog ? `clicked; a dialog opened at ${v.url}` : `clicked; at ${v.title || ''} ${v.url}`.trim(),
      }],
    },
    isConcurrencySafe: () => false,
    execute: withBrowser((m, args) => m.click(args.tab, args.selector)),
  });

  tool({
    name: 'browser_hover',
    description: 'Move the virtual pointer to page coordinates (CSS px) and report the element under it.',
    parameters: obj({
      tab: { type: 'string' },
      x: { type: 'number' },
      y: { type: 'number' },
      steps: { type: 'number', description: 'Intermediate moves; more steps looks more human.' },
    }, ['tab', 'x', 'y']),
    output: {
      schema: obj({ x: { type: 'number' }, y: { type: 'number' }, under: { type: 'object' } }, ['x', 'y']),
      render: (_a, v) => [{ type: 'text', text: `pointer at ${v.x},${v.y}` + (v.under ? ` over <${v.under.tag}${v.under.id ? '#' + v.under.id : ''}>` : '') }],
    },
    isConcurrencySafe: () => false,
    execute: withBrowser(async (m, args) => {
      const result = await m.hover(args.tab, args.x, args.y, args.steps ?? 1);
      const output = { x: result.x, y: result.y };
      // elementFromPoint is null outside the viewport; the schema allows no null here.
      if (result.under) output.under = result.under;
      return output;
    }),
  });

  tool({
    name: 'browser_drag',
    description: 'Press at one point, move to another and release — drag&drop and slider testing.',
    parameters: obj({
      tab: { type: 'string' },
      fromX: { type: 'number' },
      fromY: { type: 'number' },
      toX: { type: 'number' },
      toY: { type: 'number' },
      steps: { type: 'number' },
    }, ['tab', 'fromX', 'fromY', 'toX', 'toY']),
    output: {
      schema: obj({ done: { type: 'boolean' } }, ['done']),
      render: () => [{ type: 'text', text: 'dragged' }],
    },
    isConcurrencySafe: () => false,
    execute: withBrowser(async (m, args) => {
      await m.drag(args.tab, args.fromX, args.fromY, args.toX, args.toY, args.steps ?? 12);
      return { done: true };
    }),
  });

  tool({
    name: 'browser_fill',
    description: 'Fill an input matched by a CSS selector.',
    parameters: obj({
      tab: { type: 'string' },
      selector: { type: 'string' },
      text: { type: 'string' },
    }, ['tab', 'selector', 'text']),
    output: {
      schema: obj({ ok: { type: 'boolean' } }, ['ok']),
      render: () => [{ type: 'text', text: 'filled' }],
    },
    isConcurrencySafe: () => false,
    execute: withBrowser((m, args) => m.fill(args.tab, args.selector, args.text)),
  });

  tool({
    name: 'browser_text',
    description: 'Read the visible text of a tab.',
    parameters: obj({ tab: { type: 'string' }, limit: { type: 'number' } }, ['tab']),
    output: {
      schema: obj({ text: { type: 'string' } }, ['text']),
      render: (_a, v) => [{ type: 'text', text: v.text || '(empty)' }],
    },
    isConcurrencySafe: () => true,
    execute: withBrowser(async (m, args) => ({ text: await m.text(args.tab, args.limit ?? 4000) })),
  });

  tool({
    name: 'browser_close',
    description: 'Close one tab of YOUR browser, or the whole browser when tab is omitted.',
    parameters: obj({ tab: { type: 'string' } }),
    output: {
      schema: obj({ closed: { type: 'boolean' }, browserClosed: { type: 'boolean' } }, ['closed']),
      render: (_a, v) => [{
        type: 'text',
        text: !v.closed ? 'nothing to close' : v.browserClosed ? 'closed the last tab; browser shut down' : 'closed tab',
      }],
    },
    isConcurrencySafe: () => false,
    execute: withBrowser((m, args) => (args.tab ? m.close(args.tab) : m.closeAll())),
  });

  tool({
    name: 'browser_run',
    description: 'Command surface for everything beyond the basic tools, like a CLI. Call { command: "list" } to see commands, { command: "help", args: { name: "network" } } for one command, then run it: { command: "network", args: { tab: "t1", action: "list" } }. Covers console, network, cookies, storage, eval, emulate, metrics, trace, wait, ctx, cdp.',
    parameters: obj({
      command: { type: 'string', description: 'list | help | ' + Object.keys(COMMANDS).join(' | ') },
      args: { type: 'object', description: 'Command arguments; see help <command>.' },
    }, ['command']),
    output: {
      schema: obj({ text: { type: 'string' }, shot: { type: 'string' } }, ['text']),
      render: (_a, v) => {
        const blocks = [{ type: 'text', text: v.text }];
        if (v && typeof v === 'object' && v.shot) {
          blocks.push({ type: 'text', text: `[shot:${v.shot}]${v.caption ?? 'Screenshot'}` });
        }
        return blocks;
      },
    },
    isConcurrencySafe: () => false,
    execute: withBrowser(async (m, args) => {
      const text = String(await runCommand(m, args.command, args.args ?? {}));
      // A screenshot command writes a file: keep it as a chat frame too, the same
      // way click and open already show their shot.
      if (args.command === 'screenshot') {
        try {
          const data = JSON.parse(text);
          if (data && typeof data.path === 'string') {
            const shot = keepFrame(readFileSync(data.path));
            return { text, shot, caption: data.url ? `Screenshot ${data.url}` : 'Screenshot' };
          }
        } catch {
          // Keep the text result when the command did not return a JSON path.
        }
      }
      return { text };
    }),
  });

  tool({
    name: 'browser_cdp',
    description: 'Raw Chrome DevTools Protocol call on a tab — the escape hatch for anything the dedicated tools do not cover (Network.*, Runtime.*, DOM.*, Storage.*, Emulation.*, Performance.*, Tracing.*).',
    parameters: obj({
      tab: { type: 'string' },
      method: { type: 'string', description: 'CDP method, e.g. "Network.enable" or "Runtime.evaluate".' },
      params: { type: 'object', description: 'CDP parameters.' },
    }, ['tab', 'method']),
    output: {
      schema: obj({ json: { type: 'string' } }, ['json']),
      render: (_a, v) => [{ type: 'text', text: v.json }],
    },
    isConcurrencySafe: () => false,
    execute: withBrowser(async (m, args) => {
      const result = await m.cdp(args.tab, args.method, args.params ?? {});
      return { json: JSON.stringify(result).slice(0, 20000) };
    }),
  });

  const hostOf = async (manager, tabId) => {
    const tabs = await manager.tabs({ thumb: false });
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error(`unknown tab ${tabId}`);
    let host;
    try { host = new URL(tab.url).hostname; } catch { throw new Error(`tab ${tabId} has no http(s) address`); }
    if (!host) throw new Error(`tab ${tabId} has no host`);
    return host;
  };

  tool({
    name: 'browser_proxy_enable',
    description: 'Route a site through the proxy. Pass a tab, or a host for a site that cannot open yet (blocked without the proxy). The switch applies to the whole host.',
    parameters: obj({
      tab: { type: 'string' },
      host: { type: 'string', description: 'Site name, e.g. instagram.com — use when the tab never loaded.' },
      all: { type: 'boolean', description: 'Route every request through the proxy, not just listed sites.' },
      server: { type: 'string', description: 'Proxy address to use from now on, e.g. 127.0.0.1:10901 or http://host:port.' },
    }),
    output: {
      schema: obj({ host: { type: 'string' }, all: { type: 'boolean' }, enabled: { type: 'boolean' }, server: { type: 'string' } }, ['enabled']),
      render: (_a, v) => {
        const what = v.all
          ? 'proxy on for all traffic'
          : v.host
            ? `proxy on for ${v.host}`
            : 'proxy upstream updated';
        return [{ type: 'text', text: `${what}${v.server ? ` (upstream ${v.server})` : ''}` }];
      },
    },
    isConcurrencySafe: () => false,
    execute: withBrowser(async (m, args) => {
      // The upstream can be set by the agent: a URL from the user, or one it
      // found itself. It takes effect for the next connection.
      if (args.server !== undefined) proxyServer = normalizeProxyServer(args.server);
      if (args.all === true) { proxyAll = true; writeProxyState(); return { all: true, enabled: true, server: proxyServer }; }
      if (!args.tab && !args.host) {
        if (args.server !== undefined) { writeProxyState(); return { enabled: true, server: proxyServer }; }
        throw new Error('pass a tab, a host, all: true, or server');
      }
      const host = args.host ? args.host.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : await hostOf(m, args.tab);
      proxyHosts.add(host);
      writeProxyState();
      return { host, enabled: true, server: proxyServer };
    }),
  });

  tool({
    name: 'browser_proxy_disable',
    description: 'Stop routing a site through the proxy.',
    parameters: obj({ tab: { type: 'string' }, host: { type: 'string' }, all: { type: 'boolean' } }),
    output: {
      schema: obj({ host: { type: 'string' }, all: { type: 'boolean' }, enabled: { type: 'boolean' } }, ['enabled']),
      render: (_a, v) => [{ type: 'text', text: v.all ? 'proxy off for all traffic' : `proxy off for ${v.host}` }],
    },
    isConcurrencySafe: () => false,
    execute: withBrowser(async (m, args) => {
      if (args.all === true) { proxyAll = false; writeProxyState(); return { all: true, enabled: false }; }
      if (!args.tab && !args.host) throw new Error('pass a tab, a host, or all: true');
      const host = args.host ? args.host.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : await hostOf(m, args.tab);
      proxyHosts.delete(host);
      writeProxyState();
      return { host, enabled: false };
    }),
  });

  tool({
    name: 'browser_proxy_status',
    description: 'Whether the proxy is enabled for a tab\'s site, or for every site when tab is omitted.',
    parameters: obj({ tab: { type: 'string' }, host: { type: 'string' } }),
    output: {
      schema: obj({
        host: { type: 'string' },
        enabled: { type: 'boolean' },
        hosts: { type: 'array', items: { type: 'string' } },
        all: { type: 'boolean' },
        server: { type: 'string' },
        mode: { type: 'string' },
      }, []),
      render: (_a, v) => [{
        type: 'text',
        text: v.all
          ? `proxy is ON for all traffic (upstream ${v.server ?? '?'})`
          : v.host !== undefined
            ? `${v.host}: proxy ${v.enabled ? 'on' : 'off'}`
            : (v.hosts?.length
            ? `proxy on for: ${v.hosts.join(', ')} (upstream ${v.server ?? '?'})`
            : 'proxy is off for every site'),
      }],
    },
    isConcurrencySafe: () => true,
    execute: withBrowser(async (m, args) => {
      const server = proxyServer;
      if (!args.tab && !args.host) return { hosts: [...proxyHosts], all: proxyAll, server, mode: 'routing-proxy' };
      const host = args.host ? args.host.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : await hostOf(m, args.tab);
      return { host, enabled: proxyAll || proxyHosts.has(host), all: proxyAll, server, mode: 'routing-proxy' };
    }),
  });

  tool({
    name: 'browser_proxy_list',
    description: 'List every site currently routed through the proxy.',
    parameters: obj(),
    output: {
      schema: obj({ hosts: { type: 'array', items: { type: 'string' } }, all: { type: 'boolean' } }, ['hosts']),
      render: (_a, v) => [{
        type: 'text',
        text: v.all ? 'all traffic' : (v.hosts.length ? v.hosts.join('\n') : 'no site uses the proxy'),
      }],
    },
    isConcurrencySafe: () => true,
    execute: withBrowser(async () => ({ hosts: [...proxyHosts], all: proxyAll })),
  });
}
