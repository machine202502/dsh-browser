/**
 * Command surface for `browser_run` — a CLI inside one tool schema.
 *
 * The catalog is intentionally flat: `browser_run({ command: "list" })` prints
 * names, `{ command: "help", args: { name: "network" } }` prints one command's
 * details. Nothing is added to the prompt until the model asks for it.
 */

const TABS_HINT = 'tab id from browser_tabs';

const need = (args, field) => {
  const value = args?.[field];
  if (value === undefined || value === null || value === '') {
    throw new Error(`missing required arg "${field}"`);
  }
  return value;
};

const json = (value) => JSON.stringify(value, null, 2).slice(0, 12000);

/** Reject a value outside the documented set instead of silently defaulting. */
const oneOf = (value, allowed, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).toLowerCase();
  if (!allowed.includes(text)) {
    throw new Error(`unknown value "${value}"; use ${allowed.join(' | ')}`);
  }
  return text;
};

const THROTTLE = {
  slow3g: { offline: false, latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 25 * 1024 },
  fast3g: { offline: false, latency: 150, downloadThroughput: 400 * 1024, uploadThroughput: 200 * 1024 },
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  off: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
};

export const COMMANDS = {
  list: {
    summary: 'show every command',
    run: () => Object.entries(COMMANDS)
      .map(([name, cmd]) => `${name.padEnd(9)} ${cmd.summary}`)
      .join('\n'),
  },

  help: {
    summary: 'details for one command: help { name }',
    run: (_m, args) => {
      const name = args?.name;
      if (!name) return COMMANDS.list.run();
      const cmd = COMMANDS[String(name).toLowerCase()];
      if (!cmd) throw new Error(`unknown command "${name}"; try list`);
      return `${name}\n${cmd.summary}\n\n${cmd.help ?? '(no extra args)'}`;
    },
  },

  console: {
    summary: 'console output and page errors, with arguments and stacks',
    help: 'action: list | clear   (default list)\ntab, limit (default 100)\nlevel: filter by kind, e.g. error | warning | log\ncontains: substring filter',
    run: (m, args) => {
      const tab = need(args, 'tab');
      const action = oneOf(args.action, ['list', 'clear'], 'list');
      if (action === 'clear') {
        m.consoleLogs(tab, { clear: true });
        return 'console cleared';
      }
      let rows = m.consoleLogs(tab, { limit: args.limit ?? 100 });
      if (args.level) rows = rows.filter((row) => row.kind === String(args.level).toLowerCase());
      if (args.contains) {
        const needle = String(args.contains).toLowerCase();
        rows = rows.filter((row) => `${row.text} ${(row.args ?? []).join(' ')}`.toLowerCase().includes(needle));
      }
      if (!rows.length) return 'console is empty';
      return rows.map((row) => {
        const args = row.args?.length ? `\n  args: ${JSON.stringify(row.args)}` : '';
        const stack = row.stack ? `\n  stack: ${row.stack.split('\n').slice(0, 3).join(' | ')}` : '';
        return `[${row.kind}] ${row.text}${args}${stack}`;
      }).join('\n');
    },
  },

  ws: {
    summary: 'WebSocket sockets and their frames',
    help: 'tab\nfilter: substring of the socket url\nlimit: frames per socket (default 100)\nclear: true wipes captured frames',
    run: (m, args) => {
      const sockets = m.wsLogs(need(args, 'tab'), {
        filter: args.filter ?? '',
        limit: args.limit ?? 100,
        clear: args.clear === true,
      });
      if (args.clear === true) return 'websocket frames cleared';
      if (!sockets.length) return 'no websocket connections captured';
      return sockets.map((socket) => {
        const header = `${socket.url}  (${socket.total} frames)`;
        if (args.frames === false) return header;
        const rows = socket.frames.map((frame) => `  ${frame.direction === 'out' ? '→' : '←'} ${frame.data}`);
        return [header, ...rows].join('\n');
      }).join('\n\n');
    },
  },

  css: {
    summary: 'rules that apply to an element: selectors, properties, media',
    help: 'tab, selector (default body), limit (default 30)',
    run: async (m, args) => json(await m.css(need(args, 'tab'), {
      selector: args.selector ?? 'body',
      limit: args.limit ?? 30,
    })),
  },

  assets: {
    summary: 'page resources by type; download: true saves them to disk',
    help: 'tab\ngroup: document | stylesheet | script | image | font | xhr | fetch\ndownload: true to save every asset\nlimit (default 200)',
    run: async (m, args) => json(await m.assets(need(args, 'tab'), {
      group: args.group,
      download: args.download === true,
      limit: args.limit ?? 200,
    })),
  },

  html: {
    summary: 'full page HTML written to a file',
    run: async (m, args) => json(await m.pageHtml(need(args, 'tab'))),
  },

  diff: {
    summary: 'compare two screenshots pixel by pixel',
    help: 'tab, a: path, b: path, threshold: 0–255 (default 30)',
    run: async (m, args) => json(await m.diffImages(need(args, 'tab'), {
      a: need(args, 'a'),
      b: need(args, 'b'),
      threshold: args.threshold ?? 30,
    })),
  },

  network: {
    summary: 'requests, plus headers and bodies by index',
    help: 'action: list | clear | detail | body   (default list)\ntab, filter (substring of url), limit (default 100)\nindex: row number from the list, for detail/body',
    run: async (m, args) => {
      const tab = need(args, 'tab');
      const action = oneOf(args.action, ['list', 'clear', 'detail', 'body'], 'list');
      if (action === 'clear') {
        m.networkLogs(tab, { clear: true });
        return 'network log cleared';
      }
      if (action === 'detail') {
        const record = await m.networkDetail(tab, Number(need(args, 'index')));
        return json({
          url: record.url,
          method: record.method,
          status: record.status,
          type: record.type,
          failed: record.failed,
          requestHeaders: record.requestHeaders,
          responseHeaders: record.responseHeaders,
          postData: record.postData ? String(record.postData).slice(0, 1000) : null,
        });
      }
      if (action === 'body') {
        return json(await m.networkBody(tab, Number(need(args, 'index'))));
      }
      const rows = m.networkLogs(tab, { filter: args.filter ?? '', limit: args.limit ?? 100 });
      if (!rows.length) return 'no requests captured';
      return rows
        .map((r, index) => {
          const status = r.failed ? `ERR ${r.failed}` : (r.status ?? 'pending');
          return `[${index}] ${status}  ${r.method}  ${r.type}  ${r.url.slice(0, 160)}`;
        })
        .join('\n');
    },
  },

  perf: {
    summary: 'trace the main thread and show where the time went',
    help: 'tab, seconds (default 3, max 20)',
    run: async (m, args) => json(await m.perf(need(args, 'tab'), { seconds: args.seconds ?? 3 })),
  },

  cookies: {
    summary: 'read, set, clear cookies of the tab context',
    help: 'action: get | set | clear   (default get)\ntab\nfor set: name, value, domain (default the tab host), path (default "/")',
    run: async (m, args) => {
      const tab = need(args, 'tab');
      const action = oneOf(args.action, ['get', 'set', 'clear'], 'get');
      if (action === 'clear') {
        await m.clearCookies(tab);
        return 'cookies cleared';
      }
      if (action === 'set') {
        const cookie = { name: need(args, 'name'), value: need(args, 'value') };
        if (args.domain) {
          cookie.domain = args.domain;
          cookie.path = args.path ?? '/';
        } else {
          // Without a domain Playwright wants an url and derives path itself.
          const tabInfo = (await m.tabs({ thumb: false })).find((t) => t.id === tab);
          if (!tabInfo) throw new Error(`unknown tab ${tab}`);
          cookie.url = new URL(tabInfo.url).origin;
        }
        await m.setCookie(tab, cookie);
      }
      const list = await m.cookies(tab);
      if (!list.length) return 'no cookies';
      return list.map((c) => `${c.domain}${c.path}  ${c.name}=${String(c.value).slice(0, 60)}${c.httpOnly ? ' (httpOnly)' : ''}`).join('\n');
    },
  },

  storage: {
    summary: 'localStorage / sessionStorage',
    help: 'action: get | set | clear   (default get)\ntab\nkind: local | session (default local)\nfor set: key, value',
    run: async (m, args) => {
      const tab = need(args, 'tab');
      const kind = oneOf(args.kind, ['local', 'session'], 'local');
      const action = oneOf(args.action, ['get', 'set', 'clear'], 'get');
      if (action === 'clear') {
        await m.clearStorage(tab, kind);
        return `${kind}Storage cleared`;
      }
      if (action === 'set') {
        await m.setStorage(tab, kind, need(args, 'key'), args.value ?? '');
      }
      const data = await m.getStorage(tab, kind);
      return Object.keys(data).length ? json(data) : `${kind}Storage is empty`;
    },
  },

  eval: {
    summary: 'run JavaScript in the page and return the value',
    help: 'tab, expression (an expression, e.g. "document.title" or "({a:1,b:2})")',
    run: async (m, args) => json(await m.evaluate(need(args, 'tab'), need(args, 'expression'))),
  },

  emulate: {
    summary: 'network preset, colour scheme, timezone, geolocation, CPU throttle',
    help: 'tab\nnetwork: slow3g | fast3g | offline | off\ncolorScheme: light | dark\ncpu: slowdown factor (1 = off)\ntimezone: IANA id, e.g. Europe/Berlin\ngeolocation: "lat,lng"',
    run: async (m, args) => {
      const tab = need(args, 'tab');
      const done = [];
      if (args.network !== undefined) {
        const preset = String(args.network).toLowerCase();
        const conditions = THROTTLE[preset];
        if (!conditions) throw new Error(`unknown network preset "${preset}"; use ${Object.keys(THROTTLE).join(' | ')}`);
        await m.cdp(tab, 'Network.enable', {});
        await m.cdp(tab, 'Network.emulateNetworkConditions', conditions);
        done.push(`network: ${preset}`);
      }
      if (args.colorScheme !== undefined) {
        const scheme = oneOf(args.colorScheme, ['light', 'dark'], 'light');
        await m.cdp(tab, 'Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: scheme }],
        });
        done.push(`colorScheme: ${scheme}`);
      }
      if (args.cpu !== undefined) {
        const rate = Number(args.cpu);
        if (!Number.isFinite(rate) || rate < 1) throw new Error('cpu must be a number >= 1');
        await m.cdp(tab, 'Emulation.setCPUThrottlingRate', { rate });
        done.push(`cpu: x${rate}`);
      }
      if (args.timezone !== undefined) {
        await m.cdp(tab, 'Emulation.setTimezoneOverride', { timezoneId: String(args.timezone) });
        done.push(`timezone: ${args.timezone}`);
      }
      if (args.geolocation !== undefined) {
        const [lat, lng] = String(args.geolocation).split(',').map(Number);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('geolocation must be "lat,lng"');
        await m.cdp(tab, 'Emulation.setGeolocationOverride', { latitude: lat, longitude: lng, accuracy: 1 });
        done.push(`geolocation: ${lat},${lng}`);
      }
      if (done.length === 0) throw new Error('pass network, colorScheme, cpu, timezone, or geolocation');
      return done.join('; ');
    },
  },

  metrics: {
    summary: 'page performance metrics (DOM nodes, JS heap, timings)',
    help: 'tab',
    run: async (m, args) => json(await m.metrics(need(args, 'tab'))),
  },

  trace: {
    summary: 'record a Playwright trace to a zip',
    help: 'action: start | stop   (required)\ntab, file (for stop, default trace.zip in the workspace)',
    run: async (m, args) => {
      const tab = need(args, 'tab');
      const action = oneOf(need(args, 'action'), ['start', 'stop'], 'start');
      const file = args.file ?? 'trace.zip';
      return json(await m.trace(tab, action, file));
    },
  },



  screenshot: {
    summary: 'save a screenshot to a file and return its path',
    help: 'tab\nfullPage: true for the whole document\nquality: 10–100 (default 80)\nOpen the path with the read_image tool to look at the page.',
    run: async (m, args) => json(await m.screenshotFile(need(args, 'tab'), {
      fullPage: args.fullPage === true,
      quality: args.quality ?? 80,
      selector: args.selector ?? null,
    })),
  },

  keyboard: {
    summary: 'press keys, chords, or type text',
    help: 'tab\npress: "Enter" | "Tab" | "Control+a" | "Escape"\ntype: literal text\ndown / up: hold or release a single key',
    run: async (m, args) => {
      const tab = need(args, 'tab');
      await m.keyboard(tab, { press: args.press, type: args.type, down: args.down, up: args.up });
      const what = [args.press && `pressed ${args.press}`, args.type && `typed ${args.type.length} chars`,
        args.down && `held ${args.down}`, args.up && `released ${args.up}`].filter(Boolean).join(', ');
      return what || 'no key action';
    },
  },

  dialog: {
    summary: 'answer alert / confirm / prompt',
    help: 'tab\naction: accept | dismiss (default accept)\ntext: prompt input when accepting',
    run: async (m, args) => {
      const tab = need(args, 'tab');
      const accept = oneOf(args.action, ['accept', 'dismiss'], 'accept') === 'accept';
      const result = await m.answerDialog(tab, { accept, text: args.text });
      return `${result.type} "${result.message}" -> ${result.accepted ? 'accepted' : 'dismissed'}`;
    },
  },

  snapshot: {
    summary: 'accessibility tree (roles and names) for reliable targets',
    help: 'tab, limit (default 400)',
    run: async (m, args) => {
      const rows = await m.axTree(need(args, 'tab'), args.limit ?? 400);
      return rows.length ? rows.join('\n') : 'accessibility tree is empty';
    },
  },

  dom: {
    summary: 'element html, text, box, attributes, computed styles, or count',
    help: 'tab, selector\nmode: html | text | attrs | styles | count (default html)\nlimit: characters for html/text',
    run: async (m, args) => {
      const result = await m.dom(need(args, 'tab'), {
        selector: need(args, 'selector'),
        mode: oneOf(args.mode, ['html', 'text', 'attrs', 'styles', 'count'], 'html'),
        limit: args.limit ?? 4000,
      });
      return json(result);
    },
  },

  idb: {
    summary: 'IndexedDB databases, stores, and rows',
    help: 'tab\nname: database (omit to list databases)\nstore: object store (omit to list stores)',
    run: async (m, args) => json(await m.indexedDb(need(args, 'tab'), {
      database: args.name,
      store: args.store,
      limit: args.limit ?? 20,
    })),
  },

  coverage: {
    summary: 'JS usage coverage between start and stop',
    help: 'action: start | stop   (required)\ntab',
    run: async (m, args) => {
      const tab = need(args, 'tab');
      const action = oneOf(need(args, 'action'), ['start', 'stop'], 'start');
      return json(await m.coverage(tab, action));
    },
  },

  lighthouse: {
    summary: 'Lighthouse audit: scores, core metrics, failing audits',
    help: 'tab\ncategories: comma list (performance,accessibility,best-practices,seo)\npreset: desktop | mobile (default desktop)\nthreshold: only audits below this score (default 0.9)',
    run: async (m, args) => {
      const tab = need(args, 'tab');
      const categories = typeof args.categories === 'string' && args.categories.length
        ? args.categories.split(',').map((value) => value.trim()).filter(Boolean)
        : undefined;
      const result = await m.lighthouse(tab, {
        categories,
        preset: oneOf(args.preset, ['desktop', 'mobile'], 'desktop'),
        threshold: args.threshold ?? 0.9,
        limit: args.limit ?? 12,
      });
      return json(result);
    },
  },

  report: {
    summary: 'inspect a saved Lighthouse report: audit list or one audit detail',
    help: 'path: file returned by lighthouse\naudit: audit id for full details (items, description)\nlist: false to shorten the audit list',
    run: async (m, args) => json(await m.report({
      path: need(args, 'path'),
      audit: args.audit,
      list: args.list,
    })),
  },

  downloads: {
    summary: 'files the browser saved during this run',
    run: async (m) => json(await m.downloads()),
  },

  ctx: {
    summary: 'list tabs grouped by their isolated context',
    run: async (m) => {
      const tabs = await m.tabs({ thumb: false });
      if (!tabs.length) return 'no tabs';
      const groups = new Map();
      for (const tab of tabs) {
        const key = tab.ctx ?? 'ctx1';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(`${tab.id}  ${tab.url}`);
      }
      return [...groups.entries()].map(([ctx, rows]) => `${ctx}:\n  ${rows.join('\n  ')}`).join('\n');
    },
  },

  wait: {
    summary: 'wait for a selector or text to appear',
    help: 'tab, selector or text, timeout in ms (default 10000)',
    run: async (m, args) => {
      const tab = need(args, 'tab');
      const timeout = Number(args.timeout ?? 10000);
      if (args.selector) {
        await m.waitFor(tab, { selector: String(args.selector), timeout });
        return `found selector ${args.selector}`;
      }
      if (args.text) {
        await m.waitFor(tab, { text: String(args.text), timeout });
        return `found text ${args.text}`;
      }
      throw new Error('pass selector or text');
    },
  },

  cdp: {
    summary: 'raw Chrome DevTools Protocol call',
    help: 'tab, method (e.g. "Network.enable"), params (object)',
    run: async (m, args) => json(await m.cdp(need(args, 'tab'), need(args, 'method'), args.params ?? {})),
  },
};

/** Normalise "network.list" / "NETWORK" into a command + action pair. */
export async function runCommand(manager, command, args = {}) {
  const raw = String(command ?? '').trim().toLowerCase();
  if (!raw) return COMMANDS.list.run();
  const [head, tail] = raw.split(/[.\s]+/);
  const cmd = COMMANDS[head];
  if (!cmd) {
    throw new Error(`unknown command "${command}". Available: ${Object.keys(COMMANDS).join(', ')}`);
  }
  const merged = tail && args.action === undefined ? { ...args, action: tail } : args;
  return cmd.run(manager, merged);
}
