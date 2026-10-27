import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));

const LAUNCH_ARGS = [
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-background-timer-throttling',
  '--no-first-run',
  '--no-default-browser-check',
];

/** Locate the Playwright-managed Chromium build, newest revision first. */
export function findChromium() {
  if (process.env.DSH_BROWSER_EXE) return process.env.DSH_BROWSER_EXE;
  const home = homedir();
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright'),
    join(home, '.cache', 'ms-playwright'),
    join(home, 'Library', 'Caches', 'ms-playwright'),
  ].filter(Boolean);
  // Playwright's bundle layout differs per platform; try every known shape.
  const rels = [
    'chrome-win64\\chrome.exe',
    'chrome-win\\chrome.exe',
    'chrome-linux\\chrome',
    'chrome-mac\\Chromium.app\\Contents\\MacOS\\Chromium',
    'chrome-mac-arm64\\Chromium.app\\Contents\\MacOS\\Chromium',
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const revs = readdirSync(root)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const rev of revs) {
      for (const rel of rels) {
        const exe = join(root, rev, rel);
        if (existsSync(exe)) return exe;
      }
    }
  }
  throw new Error('Playwright Chromium not found; set DSH_BROWSER_EXE');
}

/**
 * One Chromium per agent, several isolated BrowserContexts inside it.
 *
 * - Every context ("ctx1", "ctx2", …) has its own cookies and storage, which is
 *   what two-client scenarios need.
 * - The profile directory is a temporary folder created at launch and deleted
 *   when the browser closes, so a new Session never inherits anything.
 */
export class BrowserManager {
  #sessionId;
  #browser = null;
  #persistent = null;           // default context of the persistent profile
  #contexts = new Map();        // ctxName -> BrowserContext
  #pages = new Map();           // tabId -> { page, ctx }
  #cdp = new Map();             // tabId -> CDPSession
  #counter = 0;
  #closed = false;
  #shuttingDown = false;
  #cursors = new Map();         // tabId -> { x, y, down }
  #logs = new Map();            // tabId -> [{ kind, text, at }]
  #net = new Map();             // tabId -> Map(requestKey, record)
  #cdpNet = new Map();          // tabId -> Map(requestId, record)
  #ws = new Map();              // tabId -> [{ url, at, frames }]
  #launchedAt = 0;              // when this browser's Chromium started
  #netOn = new Set();           // tabIds with CDP network capture
  #profileDir = null;
  #watchdog = null;
  #dialogs = new Map();          // tabId -> open Dialog
  #coverage = new Set();         // tabIds with recording on
  #downloadDir = null;   // resolved once so it survives closeAll
  #shotState = new Map();        // tabId -> { hash, at }

  constructor({
    sessionId,
    width = 1280,
    height = 800,
    headless = true,
    profileRoot = join(tmpdir(), 'dsh-browser-profiles'),
    debugPort = 0,
    defaultContext = 'ctx1',
    onLog = null,
    proxyServer = null,
    proxyServerReady = null,
  } = {}) {
    this.debugPort = debugPort || 9300 + Math.floor(Math.random() * 500);
    this.#sessionId = sessionId ?? 'default';
    this.width = width;
    this.height = height;
    this.headless = headless;
    this.profileRoot = profileRoot;
    this.defaultContext = defaultContext;
    this.onLog = onLog;
    this.proxyServer = proxyServer;
    this.proxyServerReady = proxyServerReady;
  }

  async #ensure() {
    if (this.#persistent) return this.#persistent;
    this.#closed = false;
    if (this.proxyServerReady) await this.proxyServerReady.catch(() => {});
    // Chromium ignores PAC here, so routing lives in our own loopback proxy.
    const proxyArgs = this.proxyServer ? [`--proxy-server=http://127.0.0.1:${this.proxyServer}`] : [];
    // A fresh throwaway profile per launch: nothing survives the session.
    mkdirSync(this.profileRoot, { recursive: true });
    this.#profileDir = mkdtempSync(join(this.profileRoot, 'run-'));
    this.#persistent = await chromium.launchPersistentContext(this.#profileDir, {
      executablePath: findChromium(),
      headless: this.headless,
      viewport: { width: this.width, height: this.height },
      ignoreHTTPSErrors: true,
      acceptDownloads: true,
      args: [...LAUNCH_ARGS, `--remote-debugging-port=${this.debugPort}`, ...proxyArgs],
    });
    this.#launchedAt = Date.now();
    this.#browser = this.#persistent.browser();
    this.#contexts.set(this.defaultContext, this.#persistent);
    this.#spawnWatchdog();
    // Keep every download inside this run's own folder so `downloads` can list it
    // and the profile cleanup removes it with the browser.
    this.#persistent.on('download', async (download) => {
      if (this.onLog) this.onLog(`download started: ${download.suggestedFilename()}`);
      try {
        const dir = this.downloadDir;
        mkdirSync(dir, { recursive: true });
        await download.saveAs(join(dir, download.suggestedFilename()));
      } catch (error) {
        if (this.onLog) this.onLog(`download failed: ${error?.message ?? error}`);
      }
    });
    return this.#persistent;
  }

  async #contextFor(name) {
    const wanted = name || this.defaultContext;
    const existing = this.#contexts.get(wanted);
    if (existing) return existing;
    await this.#ensure();
    const created = await this.#browser.newContext({
      viewport: { width: this.width, height: this.height },
      ignoreHTTPSErrors: true,
    });
    this.#contexts.set(wanted, created);
    return created;
  }

  #adopt(page, ctx) {
    for (const [id, entry] of this.#pages) if (entry.page === page) return id;
    const id = `t${++this.#counter}`;
    this.#pages.set(id, { page, ctx });
    // Chrome saves straight into this run's folder; Playwright's own download
    // interception is unreliable for persistent profiles.
    this.#allowDownloads(id).catch(() => {});
    // Downloads must land in this run's folder; the page-scoped switch is the
    // one that applies to this profile's context.
    this.#logs.set(id, []);
    this.#net.set(id, new Map());
    this.#ws.set(id, []);
    const log = (kind, text, meta = null) => {
      const list = this.#logs.get(id);
      if (!list) return;
      list.push({ kind, text: String(text).slice(0, 2000), at: Date.now(), ...(meta ?? {}) });
      if (list.length > 300) list.shift();
    };
    // Dialogs block the page until answered; keep the handle so a tool call can
    // accept, dismiss, or type into it, and dismiss on timeout to avoid a hang.
    page.on('dialog', (dialog) => {
      this.#dialogs.set(id, dialog);
      const timer = setTimeout(() => {
        if (this.#dialogs.get(id) !== dialog) return;
        this.#dialogs.delete(id);
        dialog.dismiss().catch(() => {});
      }, 30000);
      timer.unref?.();
    });
    // WebSocket frames: CDP events never reach this socket, Playwright's do.
    page.on('websocket', (socket) => {
      const list = this.#ws.get(id);
      if (!list) return;
      const record = { url: socket.url(), at: Date.now(), frames: [] };
      list.push(record);
      if (list.length > 20) list.shift();
      const push = (direction) => (event) => {
        record.frames.push({
          direction,
          at: Date.now(),
          data: String(event.payload ?? '').slice(0, 2000),
        });
        if (record.frames.length > 500) record.frames.shift();
      };
      socket.on('framesent', push('out'));
      socket.on('framereceived', push('in'));
    });
    page.on('console', (msg) => {
      const meta = { location: msg.location() };
      // Arguments arrive as handles; primitives are worth keeping verbatim.
      Promise.all(msg.args().map((arg) => arg.jsonValue().then(
        (value) => (typeof value === 'object' && value !== null ? JSON.stringify(value).slice(0, 300) : String(value)),
        () => '[unserializable]',
      ))).then((args) => {
        meta.args = args;
        log(msg.type(), msg.text(), meta);
      }, () => log(msg.type(), msg.text(), meta));
    });
    page.on('pageerror', (error) => log('pageerror', error?.message ?? String(error), {
      stack: String(error?.stack ?? '').split('\n').slice(0, 6).join('\n'),
    }));
    page.on('request', (request) => {
      const table = this.#net.get(id);
      if (!table) return;
      table.set(request, {
        url: request.url(),
        method: request.method(),
        type: request.resourceType(),
        at: Date.now(),
        status: null,
        failed: null,
        request,
        response: null,
      });
      if (table.size > 250) table.delete(table.keys().next().value);
    });
    page.on('response', (response) => {
      const record = this.#net.get(id)?.get(response.request());
      if (record) {
        record.status = response.status();
        record.response = response;
      }
    });
    page.on('requestfailed', (request) => {
      const record = this.#net.get(id)?.get(request);
      if (record) record.failed = request.failure()?.errorText ?? 'failed';
    });
    page.on('close', () => {
      this.#pages.delete(id);
      this.#dialogs.delete(id);
      this.#closeSocket(id);
      this.#logs.delete(id);
      this.#net.delete(id);
      this.#cdpNet.delete(id);
      this.#netOn.delete(id);
      this.#ws.delete(id);
    });
    // A crashed renderer never answers CDP or screenshots; drop the tab so the
    // card and the next tool call see a browser that still works.
    page.on('crash', () => {
      this.#pages.delete(id);
      this.#closeSocket(id);
      this.#logs.delete(id);
      this.#net.delete(id);
      this.#cdpNet.delete(id);
      this.#netOn.delete(id);
      this.#ws.delete(id);
      page.close().catch(() => {});
      if (this.#pages.size === 0 && !this.#shuttingDown) this.closeAll().catch(() => {});
    });
    return id;
  }

  /** Tab id of a Playwright page, if it is tracked. */
  #idOf(page) {
    for (const [id, entry] of this.#pages) if (entry.page === page) return id;
    return null;
  }

  #entry(tabId) {
    const entry = this.#pages.get(tabId);
    if (!entry) throw new Error(`unknown tab ${tabId}`);
    return entry;
  }

  async open(url, { ctx, timeout } = {}) {
    if (typeof url !== 'string' || url.trim() === '') {
      throw new Error('url is required: pass an absolute http(s) address');
    }
    const context = await this.#contextFor(ctx);
    let page = await context.newPage();
    let id = this.#adopt(page, ctx || this.defaultContext);
    try {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeout ?? 30000 });
      } catch (firstError) {
        // The very first tab after a cold start can lose its target while
        // Chromium finishes booting; one clean retry is enough.
        if (!/has been closed|Target closed/i.test(String(firstError?.message ?? ''))) throw firstError;
        this.#pages.delete(id);
        this.#closeSocket(id);
        page = await context.newPage();
        id = this.#adopt(page, ctx || this.defaultContext);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeout ?? 30000 });
      }
    } catch (rawError) {
      const text = BrowserManager.#clean(rawError);
      const error = /Cannot navigate to invalid URL/i.test(text)
        ? new Error(`invalid URL: ${url}`)
        : new Error(`navigation failed: ${text}`);
      // A navigation that gave up must not leave a half-loaded tab behind.
      this.#pages.delete(id);
      this.#closeSocket(id);
      this.#logs.delete(id);
      this.#net.delete(id);
      this.#cdpNet.delete(id);
      this.#netOn.delete(id);
      this.#ws.delete(id);
      await page.close().catch(() => {});
      if (this.#pages.size === 0) await this.closeAll().catch(() => {});
      throw error;
    }
    await this.#allowDownloads(id);
    return { id, ctx: ctx || this.defaultContext, url: page.url(), title: await page.title() };
  }

  async tabs({ thumb = true, quality = 35 } = {}) {
    if (!this.#persistent) return [];
    // Tabs closed by the page itself must not keep the browser alive.
    for (const [id, entry] of [...this.#pages]) if (entry.page.isClosed()) this.#pages.delete(id);
    if (this.#pages.size === 0 && !this.#shuttingDown) {
      await this.closeAll().catch(() => {});
      return [];
    }
    const out = [];
    for (const [id, { page, ctx }] of this.#pages) {
      const entry = {
        id,
        ctx,
        url: page.url(),
        title: await page.title().catch(() => ''),
        viewport: page.viewportSize(),
        cursor: this.#cursors.get(id) ?? null,
        active: false,
      };
      if (thumb) {
        try {
          const buf = await page.screenshot({ type: 'jpeg', quality });
          entry.thumb = `data:image/jpeg;base64,${buf.toString('base64')}`;
        } catch {
          entry.thumb = null;
        }
      }
      out.push(entry);
    }
    return out;
  }

  async shot(tabId, { fullPage = false, quality = 75 } = {}) {
    const { page } = this.#entry(tabId);
    const buf = await page.screenshot({ type: 'jpeg', quality, fullPage });
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  }

  /**
   * Save a screenshot to disk and return its path.
   *
   * The chat card renders frames for the human; this is the agent's own eye:
   * the path can be opened with the `read_image` tool.
   */
  async screenshotFile(tabId, { fullPage = false, quality = 80, selector = null } = {}) {
    const { page } = this.#entry(tabId);
    if (selector) {
      const buffer = await page.locator(selector).first().screenshot({ type: 'jpeg', quality });
      const dir = this.downloadDir;
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `shot-${Date.now()}.jpg`);
      writeFileSync(file, buffer);
      return { path: file, bytes: buffer.length, selector, url: page.url() };
    }
    const buffer = await page.screenshot({ type: 'jpeg', quality, fullPage });
    const dir = this.downloadDir;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `shot-${Date.now()}.jpg`);
    writeFileSync(file, buffer);
    return {
      path: file,
      bytes: buffer.length,
      fullPage: Boolean(fullPage),
      viewport: page.viewportSize(),
      url: page.url(),
    };
  }

  /** DOM node id of a selector, needed by the CSS domain. */
  async #nodeId(tabId, selector) {
    await this.cdp(tabId, 'DOM.enable', {});
    const document = await this.cdp(tabId, 'DOM.getDocument', { depth: 0 });
    const found = await this.cdp(tabId, 'DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector,
    });
    if (!found?.nodeId) throw new Error(`element not found: ${selector}`);
    return found.nodeId;
  }

  /** Rules that apply to an element: what actually set each property. */
  async css(tabId, { selector = 'body', limit = 30 } = {}) {
    // DOM must be enabled before CSS, otherwise the CSS agent refuses to work.
    const nodeId = await this.#nodeId(tabId, selector);
    await this.cdp(tabId, 'CSS.enable', {});
    const matched = await this.cdp(tabId, 'CSS.getMatchedStylesForNode', { nodeId });
    const properties = (style) => (style?.cssProperties ?? [])
      .filter((entry) => entry.value !== undefined && entry.disabled !== true)
      .map((entry) => `${entry.name}: ${entry.value}${entry.important ? ' !important' : ''}`);

    const rules = [];
    for (const item of matched.matchedCSSRules ?? []) {
      const rule = item.rule ?? {};
      if (rule.origin === 'user-agent') continue;
      const list = properties(rule.style);
      if (!list.length) continue;
      rules.push({
        selector: rule.selectorList?.text ?? '',
        media: (rule.media ?? []).map((entry) => entry.text).filter(Boolean).join(' and ') || null,
        properties: list.slice(0, 20),
      });
      if (rules.length >= limit) break;
    }

    let fonts = [];
    try {
      const result = await this.cdp(tabId, 'CSS.getPlatformFontsForNode', { nodeId });
      fonts = [...new Set((result.fonts ?? []).map((font) => font.familyName))];
    } catch { /* older Chromium */ }

    return {
      selector,
      fonts,
      inline: properties(matched.inlineStyle),
      attributes: matched.attributesStyle ? properties(matched.attributesStyle) : [],
      rules,
    };
  }

  /** Resource inventory of the page, optionally saved to disk. */
  async assets(tabId, { group, download = false, limit = 200 } = {}) {
    this.#entry(tabId);
    const rows = this.networkLogs(tabId, { limit: 1000 });
    const wanted = group ? String(group).toLowerCase() : null;
    const picked = (wanted ? rows.filter((row) => row.type === wanted) : rows).slice(-limit);
    const assets = picked.map((row) => ({
      url: row.url,
      type: row.type,
      status: row.status,
      failed: row.failed,
    }));
    if (!download) return { count: assets.length, assets };

    const dir = join(this.downloadDir, 'assets');
    mkdirSync(dir, { recursive: true });
    const { page } = this.#entry(tabId);
    const request = page.context().request;
    const saved = [];
    for (const row of assets) {
      try {
        const response = await request.get(row.url, { timeout: 15000 });
        if (!response.ok()) {
          saved.push({ url: row.url, error: `HTTP ${response.status()}` });
          continue;
        }
        const buffer = await response.body();
        const tail = (row.url.split('/').pop() ?? 'file').split('?')[0].replace(/[^\w.-]/g, '_').slice(0, 60);
        const name = `${String(saved.length).padStart(3, '0')}-${tail || 'file'}`;
        writeFileSync(join(dir, name), buffer);
        saved.push({ url: row.url, file: join(dir, name), bytes: buffer.length });
      } catch (error) {
        saved.push({ url: row.url, error: String(error?.message ?? error) });
      }
    }
    return { dir, count: saved.length, saved };
  }

  /** Full document HTML written to a file, without the 4 KB inline limit. */
  async pageHtml(tabId) {
    const { page } = this.#entry(tabId);
    const content = await page.content();
    const dir = this.downloadDir;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `page-${Date.now()}.html`);
    writeFileSync(file, content, 'utf8');
    return { path: file, bytes: content.length, url: page.url() };
  }

  /** Pixel comparison of two images, done inside the page's canvas. */
  async diffImages(tabId, { a, b, threshold = 30 } = {}) {
    if (!a || !b) throw new Error('pass two image paths: a and b');
    for (const file of [a, b]) if (!existsSync(file)) throw new Error(`image not found: ${file}`);
    const left = readFileSync(a).toString('base64');
    const right = readFileSync(b).toString('base64');
    const { page } = this.#entry(tabId);
    return page.evaluate(async ({ left, right, threshold }) => {
      const load = (src) => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('image decode failed'));
        image.src = `data:image/jpeg;base64,${src}`;
      });
      const [first, second] = await Promise.all([load(left), load(right)]);
      const width = Math.min(first.width, second.width);
      const height = Math.min(first.height, second.height);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });

      context.drawImage(first, 0, 0);
      const leftPixels = context.getImageData(0, 0, width, height).data;
      context.clearRect(0, 0, width, height);
      context.drawImage(second, 0, 0);
      const rightPixels = context.getImageData(0, 0, width, height).data;

      let diff = 0;
      let minX = width;
      let minY = height;
      let maxX = 0;
      let maxY = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const index = (y * width + x) * 4;
          const delta =
            Math.abs(leftPixels[index] - rightPixels[index]) +
            Math.abs(leftPixels[index + 1] - rightPixels[index + 1]) +
            Math.abs(leftPixels[index + 2] - rightPixels[index + 2]);
          if (delta <= threshold) continue;
          diff++;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
      return {
        width,
        height,
        diffPixels: diff,
        percent: Number(((diff / (width * height)) * 100).toFixed(2)),
        box: diff ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
      };
    }, { left, right, threshold });
  }

  async resize(tabId, width, height) {
    for (const [name, value] of [['width', width], ['height', height]]) {
      if (!Number.isFinite(value) || value < 1) {
        throw new Error(`${name} must be a positive number of pixels`);
      }
    }
    const { page } = this.#entry(tabId);
    await page.setViewportSize({ width: Math.round(width), height: Math.round(height) });
    return page.viewportSize();
  }

  async goto(tabId, url, timeout) {
    if (typeof url !== 'string' || url.trim() === '') {
      throw new Error('url is required: pass an absolute http(s) address');
    }
    const { page } = this.#entry(tabId);
    try {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeout ?? 30000 });
      } catch (firstError) {
        // The very first tab after a cold start can lose its target while
        // Chromium finishes booting; one clean retry is enough.
        if (!/has been closed|Target closed/i.test(String(firstError?.message ?? ''))) throw firstError;
        this.#pages.delete(id);
        this.#closeSocket(id);
        page = await context.newPage();
        id = this.#adopt(page, ctx || this.defaultContext);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeout ?? 30000 });
      }
    } catch (rawError) {
      const text = BrowserManager.#clean(rawError);
      if (/Cannot navigate to invalid URL/i.test(text)) {
        throw new Error(`invalid URL: ${url}`);
      }
      if (/Timeout|exceeded/i.test(text)) {
        throw new Error(`page did not load in ${timeout ?? 30000}ms: ${url}`);
      }
      throw new Error(`navigation failed: ${text}`);
    }
    await this.#allowDownloads(tabId);
    return { url: page.url(), title: await page.title() };
  }

  async click(tabId, selector, timeout = 5000) {
    const { page } = this.#entry(tabId);
    const locator = page.locator(selector).first();
    await locator.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
    const box = await locator.boundingBox({ timeout: 1500 }).catch(() => null);

    if (box) {
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      this.#mark(tabId, x, y, false);
      // A click that opens a dialog blocks until the dialog is answered, so the
      // press is raced: if the page stops responding and a dialog exists, the
      // click is reported as done and the dialog command answers it.
      const press = page.mouse.click(x, y).then(() => 'done', (error) => ({ error }));
      const raced = await Promise.race([
        press,
        new Promise((resolve) => setTimeout(() => resolve('slow'), 1200)),
      ]);
      if (raced === 'slow') {
        if (this.#dialogs.has(tabId)) return { url: page.url(), title: '', dialog: true };
        await this.#withTimeout(press, Math.max(1000, timeout - 1200), 'click');
      } else if (raced && typeof raced === 'object' && raced.error) {
        throw BrowserManager.#elementMissing(selector, timeout, raced.error);
      }
      return { url: page.url(), title: await page.title().catch(() => '') };
    }

    // Off-screen or zero-sized elements still respond to a DOM click.
    const clicked = await page.evaluate((target) => {
      const element = document.querySelector(target);
      if (!element) return false;
      element.click();
      return true;
    }, selector).catch(() => false);
    if (!clicked) throw new Error(`element not found: ${selector}`);
    return { url: page.url(), title: await page.title().catch(() => '') };
  }

  /** Virtual pointer: hover/move/drag with the OS cursor left untouched. */
  async hover(tabId, x, y, steps = 1) {
    const { page } = this.#entry(tabId);
    this.#requireInside(page, x, y, 'pointer');
    await page.mouse.move(x, y, { steps });
    this.#mark(tabId, x, y, false);
    const under = await page.evaluate(([px, py]) => {
      const el = document.elementFromPoint(px, py);
      if (!el) return null;
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: el.className || null,
        text: (el.textContent || '').trim().slice(0, 80),
      };
    }, [x, y]).catch(() => null);
    return { x, y, under };
  }

  async drag(tabId, fromX, fromY, toX, toY, steps = 12) {
    const { page } = this.#entry(tabId);
    this.#requireInside(page, fromX, fromY, 'drag start');
    this.#requireInside(page, toX, toY, 'drag end');
    await page.mouse.move(fromX, fromY);
    this.#mark(tabId, fromX, fromY, true);
    await page.mouse.down();
    await page.mouse.move(toX, toY, { steps });
    this.#mark(tabId, toX, toY, true);
    await page.mouse.up();
    this.#mark(tabId, toX, toY, false);
    return { from: { x: fromX, y: fromY }, to: { x: toX, y: toY } };
  }

  /** Both pointer tools address CSS pixels inside the rendered viewport. */
  #requireInside(page, x, y, label) {
    const size = page.viewportSize() ?? { width: 0, height: 0 };
    const inside = Number.isFinite(x) && Number.isFinite(y)
      && x >= 0 && y >= 0 && x <= size.width && y <= size.height;
    if (!inside) {
      throw new Error(`${label} (${x}, ${y}) is outside the viewport (${size.width}x${size.height})`);
    }
  }

  #mark(tabId, x, y, down) {
    this.#cursors.set(tabId, { x: Math.round(x), y: Math.round(y), down: Boolean(down) });
  }

  async fill(tabId, selector, text, timeout = 5000) {
    const { page } = this.#entry(tabId);
    try {
      await page.fill(selector, text, { timeout });
    } catch (error) {
      throw BrowserManager.#elementMissing(selector, timeout, error);
    }
    return { ok: true };
  }

  async text(tabId, limit = 4000) {
    const { page } = this.#entry(tabId);
    const body = await page.evaluate(() => document.body?.innerText ?? '');
    return body.length > limit ? `${body.slice(0, limit)}…` : body;
  }

  /** Raw Chrome DevTools Protocol access — the escape hatch for anything else. */
  /**
   * Raw CDP through the browser's own DevTools socket.
   *
   * Playwright's CDPSession validates every protocol message and raises a fatal
   * assert on shapes it does not type ("Message may have object 'params'
   * property"), which killed the whole host. Talking to the endpoint directly
   * keeps Playwright entirely out of the path.
   */
  async cdp(tabId, method, params = {}) {
    if (method === 'Page.crash') {
      throw new Error('Page.crash kills the renderer and never answers; use browser_close to drop the tab');
    }
    const { page } = this.#entry(tabId);
    const target = await this.#withTimeout(this.#targetFor(page), 10000, 'CDP target lookup');

    const socket = await this.#socketFor(tabId, target.webSocketDebuggerUrl);
    const id = socket.nextId++;
    const reply = new Promise((resolve, reject) => socket.pending.set(id, { resolve, reject }));
    socket.ws.send(JSON.stringify({ id, method, params: params ?? {} }));
    const result = await this.#withTimeout(reply, 15000, `CDP ${method}`);
    return result ?? {};
  }

  /** Chrome must be told where to put downloads before the page offers one. */
  async #allowDownloads(tabId) {
    await this.cdp(tabId, 'Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: this.downloadDir,
    }).catch(() => {});
  }

  /** Send one command to the browser endpoint (not to a page target). */
  async #browserCommand(method, params = {}) {
    const url = await this.#browserSocketUrl();
    if (!url) throw new Error('CDP endpoint is unavailable');
    if (typeof WebSocket === 'undefined') throw new Error('WebSocket is unavailable in this runtime');
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        try { socket.close(); } catch { /* already closed */ }
        reject(new Error(`CDP ${method} timed out`));
      }, 8000);
      timer.unref?.();
      socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method, params })));
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP socket failed')); });
      socket.addEventListener('message', (event) => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.id !== 1) return;
        clearTimeout(timer);
        try { socket.close(); } catch { /* already closed */ }
        if (message.error) reject(new Error(`CDP ${method}: ${message.error.message}`));
        else resolve(message.result ?? {});
      });
    });
  }

  /** Browser-level DevTools socket for this Chromium. */
  async #browserSocketUrl() {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.debugPort}/json/version`);
        const body = await response.json();
        if (body?.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
      } catch {
        // the endpoint may still be starting
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return null;
  }

  /** Match the Playwright page to a DevTools target by url, then title. */
  async #targetFor(page) {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.debugPort}/json/list`);
        const targets = await response.json();
        const pages = targets.filter((entry) => entry.type === 'page');
        const wantedUrl = page.url();
        const wantedTitle = await page.title().catch(() => '');
        const target = pages.find((entry) => entry.url === wantedUrl)
          ?? pages.find((entry) => entry.title === wantedTitle)
          // A fresh tab is still about:blank; when it is the only page target
          // there is nothing to confuse it with.
          ?? (pages.length === 1 ? pages[0] : null);
        if (target) return target;
      } catch {
        // retry while the endpoint warms up
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('no DevTools target matches this tab');
  }

  /** One command over a short-lived socket: attach to the target, send, close. */
  static async #sendOverSocket(socketUrl, targetId, method, params) {
    if (typeof WebSocket === 'undefined') throw new Error('WebSocket is unavailable in this runtime');
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(socketUrl);
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        try { socket.close(); } catch { /* already closed */ }
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error(`CDP ${method} timed out`)), 14000);
      timer.unref?.();

      socket.addEventListener('error', () => finish(new Error('CDP socket failed')));
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ id: 1, method: 'Target.attachToTarget', params: { targetId, flatten: true } }));
      });
      socket.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.id === 1) {
          const sessionId = message.result?.sessionId;
          if (!sessionId) {
            finish(new Error(message.error?.message ?? 'CDP attach failed'));
            return;
          }
          socket.send(JSON.stringify({ id: 2, method, params, sessionId }));
          return;
        }
        if (message.id === 2) {
          clearTimeout(timer);
          if (message.error) finish(new Error(`CDP ${method}: ${message.error.message}`));
          else finish(null, message.result ?? {});
        }
      });
    });
  }


  /** Track requests through CDP so headers, bodies and ids are available. */
  async #startNetworkCapture(tabId) {
    if (this.#netOn.has(tabId)) return;
    // The table survives retries: wiring may fail before the tab has a target.
    let table = this.#cdpNet.get(tabId);
    if (!table) {
      table = new Map();
      this.#cdpNet.set(tabId, table);
    }

    await this.#on(tabId, 'Network.requestWillBeSent', (params) => {
      const request = params.request ?? {};
      table.set(params.requestId, {
        id: params.requestId,
        url: request.url ?? '',
        method: request.method ?? 'GET',
        type: params.type ?? '',
        at: Date.now(),
        headers: request.headers ?? {},
        postData: request.postData ?? null,
        status: null,
        mimeType: null,
        responseHeaders: null,
        failed: null,
        size: null,
      });
      if (table.size > 250) table.delete(table.keys().next().value);
    });
    await this.#on(tabId, 'Network.responseReceived', (params) => {
      const record = table.get(params.requestId);
      if (!record) return;
      const response = params.response ?? {};
      record.status = response.status ?? null;
      record.mimeType = response.mimeType ?? null;
      record.responseHeaders = response.headers ?? null;
      record.size = response.encodedDataLength ?? null;
    });
    await this.#on(tabId, 'Network.loadingFinished', (params) => {
      const record = table.get(params.requestId);
      if (record) record.size = params.encodedDataLength ?? record.size;
    });
    await this.#on(tabId, 'Network.loadingFailed', (params) => {
      const record = table.get(params.requestId);
      if (record) record.failed = params.errorText ?? 'failed';
    });
    await this.cdp(tabId, 'Network.enable', {});
    this.#netOn.add(tabId);
  }

  /** One request by index: headers on both sides, post data, status. */
  async networkDetail(tabId, index) {
    const rows = this.networkLogs(tabId, { limit: 1000 });
    const record = rows[index];
    if (!record) throw new Error(`no request #${index}; the list has ${rows.length} entries`);
    const detail = {
      url: record.url,
      method: record.method,
      type: record.type,
      status: record.status,
      failed: record.failed,
      requestHeaders: null,
      responseHeaders: null,
      postData: null,
    };
    try { detail.requestHeaders = await record.request.allHeaders(); } catch { /* gone */ }
    try { detail.postData = record.request.postData(); } catch { /* binary or gone */ }
    try {
      if (record.response) {
        detail.responseHeaders = await record.response.allHeaders();
        detail.status = record.response.status();
      }
    } catch { /* response body already consumed */ }
    return detail;
  }

  /** Response body of a request, decoded as text. */
  async networkBody(tabId, index) {
    const rows = this.networkLogs(tabId, { limit: 1000 });
    const record = rows[index];
    if (!record) throw new Error(`no request #${index}; the list has ${rows.length} entries`);
    if (!record.response) throw new Error('no response for this request yet');
    let body = '';
    try {
      body = await record.response.text();
    } catch (error) {
      throw new Error(`body unavailable: ${error?.message ?? error}`);
    }
    return { url: record.url, status: record.status, body: body.slice(0, 8000) };
  }

  /**
   * Sample performance counters for a few seconds and report the deltas.
   *
   * Tracing events do not reach this socket, so the summary is built from
   * Performance.getMetrics intervals: it still answers "how much of the wall
   * time went to script, layout and style".
   */
  async perf(tabId, { seconds = 3 } = {}) {
    this.#entry(tabId);
    const span = Math.max(1, Math.min(seconds, 20));
    await this.cdp(tabId, 'Performance.enable', {});
    const read = async () => {
      const result = await this.cdp(tabId, 'Performance.getMetrics', {});
      const values = {};
      for (const row of result.metrics ?? []) values[row.name] = row.value;
      return values;
    };
    const first = await read();
    const samples = [];
    const startedAt = Date.now();
    while (Date.now() - startedAt < span * 1000) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      samples.push(await read());
    }
    const last = samples[samples.length - 1] ?? first;
    const delta = (name) => Math.round(((last[name] ?? 0) - (first[name] ?? 0)) * 1000);
    const wall = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const heap = Math.round((last.JSHeapUsedSize ?? 0) / 1024);
    return {
      seconds: wall,
      scripting_ms: delta('ScriptDuration'),
      layout_ms: delta('LayoutDuration'),
      style_ms: delta('RecalcStyleDuration'),
      task_ms: delta('TaskDuration'),
      js_compile_ms: delta('V8CompileDuration'),
      nodes: last.Nodes ?? null,
      listeners: last.JSEventListeners ?? null,
      heap_kb: heap,
      samples: samples.length,
    };
  }

  /** WebSocket sockets and their frames for a tab. */
  wsLogs(tabId, { clear = false, filter = '', limit = 100 } = {}) {
    this.#entry(tabId);
    const list = this.#ws.get(tabId) ?? [];
    const needle = String(filter || '').toLowerCase();
    const sockets = (needle ? list.filter((entry) => entry.url.toLowerCase().includes(needle)) : list)
      .map((entry) => ({
        url: entry.url,
        at: entry.at,
        frames: entry.frames.slice(-limit),
        total: entry.frames.length,
      }));
    if (clear) {
      for (const entry of list) entry.frames.length = 0;
    }
    return sockets;
  }

  /** Console entries (kind, text, time) for a tab. */
  consoleLogs(tabId, { clear = false, limit = 100 } = {}) {
    this.#entry(tabId);
    const list = this.#logs.get(tabId) ?? [];
    const slice = list.slice(-limit);
    if (clear) list.length = 0;
    return slice;
  }

  /** Network records for a tab, newest last. */
  networkLogs(tabId, { clear = false, filter = '', limit = 100 } = {}) {
    this.#entry(tabId);
    const table = this.#net.get(tabId) ?? new Map();
    const all = [...table.values()];
    if (clear) table.clear();
    const needle = String(filter || '').toLowerCase();
    const rows = needle ? all.filter((r) => r.url.toLowerCase().includes(needle)) : all;
    return rows.slice(-limit);
  }

  /** One persistent DevTools socket per tab: domain state survives calls. */
  async #socketFor(tabId, socketUrl) {
    const cached = this.#cdp.get(tabId);
    if (cached && cached.ws.readyState === 1) return cached;
    if (cached) this.#cdp.delete(tabId);
    if (!socketUrl) throw new Error('this tab exposes no DevTools socket');
    if (typeof WebSocket === 'undefined') throw new Error('WebSocket is unavailable in this runtime');

    const ws = new WebSocket(socketUrl);
    const socket = { ws, nextId: 1, pending: new Map(), listeners: new Map() };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP socket did not open')), 5000);
      timer.unref?.();
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP socket failed')); }, { once: true });
    });
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id === undefined) {
        const listener = socket.listeners.get(message.method);
        if (listener) listener(message.params ?? {});
        return;
      }
      const pending = socket.pending.get(message.id);
      if (!pending) return;
      socket.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`CDP: ${message.error.message}`));
      else pending.resolve(message.result ?? {});
    });
    ws.addEventListener('close', () => {
      for (const pending of socket.pending.values()) pending.reject(new Error('CDP socket closed'));
      socket.pending.clear();
      if (this.#cdp.get(tabId) === socket) this.#cdp.delete(tabId);
    });
    this.#cdp.set(tabId, socket);
    return socket;
  }

  /** Subscribe to a CDP event on the tab socket, opening it if needed. */
  async #on(tabId, method, handler) {
    const { page } = this.#entry(tabId);
    const socket = await this.#socketFor(tabId, (await this.#targetFor(page)).webSocketDebuggerUrl);
    socket.listeners.set(method, handler);
    return socket;
  }

  /** Close the socket of a tab that went away. */
  #closeSocket(tabId) {
    const socket = this.#cdp.get(tabId);
    if (!socket) return;
    this.#cdp.delete(tabId);
    try { socket.ws.close(); } catch { /* already closed */ }
  }

  async cookies(tabId) {
    const { page } = this.#entry(tabId);
    return page.context().cookies();
  }

  async setCookie(tabId, cookie) {
    const { page } = this.#entry(tabId);
    await page.context().addCookies([cookie]);
    return this.cookies(tabId);
  }

  async clearCookies(tabId) {
    const { page } = this.#entry(tabId);
    await page.context().clearCookies();
    return [];
  }

  async getStorage(tabId, kind = 'local') {
    const { page } = this.#entry(tabId);
    return page.evaluate((which) => {
      const store = which === 'session' ? window.sessionStorage : window.localStorage;
      const out = {};
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key !== null) out[key] = store.getItem(key);
      }
      return out;
    }, kind);
  }

  async setStorage(tabId, kind, key, value) {
    const { page } = this.#entry(tabId);
    await page.evaluate(([which, k, v]) => {
      const store = which === 'session' ? window.sessionStorage : window.localStorage;
      store.setItem(k, v);
    }, [kind, key, value]);
    return this.getStorage(tabId, kind);
  }

  async clearStorage(tabId, kind = 'local') {
    const { page } = this.#entry(tabId);
    await page.evaluate((which) => {
      const store = which === 'session' ? window.sessionStorage : window.localStorage;
      store.clear();
    }, kind);
    return {};
  }

  async evaluate(tabId, expression) {
    const { page } = this.#entry(tabId);
    const value = await page.evaluate((code) => {
      // Try as an expression first, then fall back to a statement body.
      try {
        // eslint-disable-next-line no-new-func
        return new Function(`return (${code});`)();
      } catch (error) {
        if (error instanceof SyntaxError) {
          // Indirect eval runs the statements and yields the completion value,
          // so "var a=2; a*3" returns 6 instead of undefined.
          // eslint-disable-next-line no-eval
          return (0, eval)(code);
        }
        throw error;
      }
    }, expression);
    return value === undefined ? null : value;
  }

  /** CDP Performance metrics for a tab. */
  async metrics(tabId) {
    await this.cdp(tabId, 'Performance.enable', {});
    const result = await this.cdp(tabId, 'Performance.getMetrics', {});
    const metrics = {};
    for (const row of result.metrics ?? []) metrics[row.name] = row.value;
    return metrics;
  }

  /** Playwright tracing on the tab's context. */
  async trace(tabId, action, file) {
    const { page } = this.#entry(tabId);
    const context = page.context();
    if (action === 'start') {
      await context.tracing.start({ screenshots: true, snapshots: true });
      return { tracing: true };
    }
    await context.tracing.stop({ path: file });
    return { tracing: false, path: file };
  }

  /** Wait for a selector or a text to appear. */
  async waitFor(tabId, { selector, text, timeout = 10000 }) {
    const { page } = this.#entry(tabId);
    if (selector) await page.waitForSelector(selector, { timeout });
    else if (text) await page.getByText(text).first().waitFor({ timeout });
    else throw new Error('pass selector or text');
    return { ok: true };
  }


  /**
   * JPEG frame for chat attachments, with per-tab dedupe and throttling so an
   * unchanged page does not flood the conversation.
   */
  /**
   * Detached guard: if this host dies without disposing the plugin, the watcher
   * kills the Chromium that owns this profile instead of leaking the process.
   */
  #spawnWatchdog() {
    if (this.#watchdog) return;
    try {
      const script = join(HERE, 'watchdog.mjs');
      if (!existsSync(script)) return;
      // Same runtime as the host: under Electron this needs RUN_AS_NODE so the
      // guard starts as plain Node instead of another app window.
      const child = spawn(
        process.execPath,
        [script, String(process.pid), String(this.debugPort)],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        },
      );
      child.unref();
      this.#watchdog = child;
    } catch {
      // A missing watchdog must never block the browser itself.
    }
  }

  /** Strip ANSI and Playwright's call log so tool output stays readable. */
  static #clean(error) {
    const raw = String(error?.message ?? error);
    return raw
      .replace(/\u001b\[[0-9;]*m/g, '')
      .split('Call log:')[0]
      .split('\n')
      .filter((line) => !/^\s+at /.test(line))
      .join('\n')
      .replace(/^page\.[a-zA-Z]+:\s*/, '')
      .replace(/^Error:\s*/, '')
      .trim();
  }

  static #elementMissing(selector, ms, error) {
    const text = BrowserManager.#clean(error);
    if (/Timeout|exceeded/i.test(text)) return new Error(`element not found: ${selector} (waited ${ms}ms)`);
    return new Error(`cannot use ${selector}: ${text}`);
  }

  /** Reject instead of hanging when the browser stops answering. */
  async #withTimeout(promise, ms, label) {
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
  }

  /** Last virtual pointer position for a tab, if any. */
  cursor(tabId) {
    return this.#cursors.get(tabId) ?? null;
  }

  /** Current viewport size of a tab. */
  viewport(tabId) {
    const { page } = this.#entry(tabId);
    return page.viewportSize() ?? null;
  }

  async capture(tabId, { quality = 55, minIntervalMs = 1500 } = {}) {
    const { page } = this.#entry(tabId);
    const state = this.#shotState.get(tabId) ?? { hash: null, at: 0 };
    const now = Date.now();
    if (now - state.at < minIntervalMs) return null;
    const buffer = await this.#withTimeout(page.screenshot({ type: 'jpeg', quality }), 10000, 'screenshot');
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha1').update(buffer).digest('hex');
    if (hash === state.hash) return null;
    this.#shotState.set(tabId, { hash, at: now });
    return { data: buffer, mediaType: 'image/jpeg' };
  }

  /** Keyboard: press one key or chord, hold, release, or type text. */
  async keyboard(tabId, { press, type, down, up }) {
    const { page } = this.#entry(tabId);
    if (down) await page.keyboard.down(String(down));
    if (press) await page.keyboard.press(String(press));
    if (type) await page.keyboard.type(String(type));
    if (up) await page.keyboard.up(String(up));
    if (!down && !press && !type && !up) throw new Error('pass press, type, down, or up');
    return { ok: true };
  }

  /** Answer the dialog currently blocking a tab. */
  async answerDialog(tabId, { accept = true, text } = {}) {
    this.#entry(tabId);
    const dialog = this.#dialogs.get(tabId);
    if (!dialog) throw new Error('no open dialog on this tab');
    this.#dialogs.delete(tabId);
    const type = dialog.type();
    const message = dialog.message();
    if (accept) await dialog.accept(text === undefined ? undefined : String(text));
    else await dialog.dismiss();
    return { type, message, accepted: Boolean(accept) };
  }

  /** Accessibility tree, flattened to role/name/value rows. */
  async axTree(tabId, limit = 400) {
    const result = await this.cdp(tabId, 'Accessibility.getFullAXTree', {});
    const rows = [];
    for (const node of result.nodes ?? []) {
      const role = node.role?.value;
      if (!role || role === 'none' || role === 'generic' || role === 'Ignored') continue;
      const name = node.name?.value ? String(node.name.value).slice(0, 120) : '';
      const value = node.value?.value !== undefined ? String(node.value.value).slice(0, 80) : '';
      if (!name && !value) continue;
      rows.push(`${role}${name ? ` "${name}"` : ''}${value ? ` = ${value}` : ''}`);
      if (rows.length >= limit) break;
    }
    return rows;
  }

  /** IndexedDB catalog; values are truncated for context safety. */
  async indexedDb(tabId, { database, store, limit = 20 } = {}) {
    const { page } = this.#entry(tabId);
    try {
      return await page.evaluate(async ({ database, store, limit }) => {
      const dbs = await indexedDB.databases();
      const names = dbs.map((entry) => entry.name).filter(Boolean);
      if (database === undefined) return { databases: names };

      if (!names.includes(database)) {
        throw new Error(`database "${database}" not found; available: ${names.join(', ') || '(none)'}`);
      }
      const open = (name) => new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const db = await open(database);
      const stores = Array.from(db.objectStoreNames);
      if (store === undefined) {
        db.close();
        return { database, stores };
      }
      if (!stores.includes(store)) {
        db.close();
        throw new Error(`store "${store}" not found in "${database}"; available: ${stores.join(', ') || '(none)'}`);
      }
      const rows = await new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const objectStore = tx.objectStore(store);
        const keys = objectStore.getAllKeys();
        const values = objectStore.getAll(undefined, limit);
        tx.oncomplete = () => resolve(keys.result.slice(0, limit).map((key, index) => ({
          key: typeof key === 'object' ? JSON.stringify(key).slice(0, 120) : key,
          value: JSON.stringify(values.result[index])?.slice(0, 400) ?? '',
        })));
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return { database, store, rows };
      }, { database, store, limit });
    } catch (error) {
      throw new Error(BrowserManager.#clean(error));
    }
  }

  /** Structured content of one element: html, text, box, attributes. */
  async dom(tabId, { selector, mode = 'html', limit = 4000 } = {}) {
    const { page } = this.#entry(tabId);
    return page.evaluate(({ selector, mode, limit }) => {
      const element = document.querySelector(selector);
      if (!element) return { found: false, selector };
      const rect = element.getBoundingClientRect();
      if (mode === 'count') return { found: true, count: document.querySelectorAll(selector).length };
      if (mode === 'styles') {
        const computed = getComputedStyle(element);
        const wanted = ['display', 'position', 'width', 'height', 'color', 'background-color',
          'font-size', 'font-weight', 'line-height', 'margin', 'padding', 'border', 'z-index', 'opacity'];
        const styles = {};
        for (const name of wanted) styles[name] = computed.getPropertyValue(name);
        return { found: true, selector, tag: element.tagName.toLowerCase(), styles };
      }
      if (mode === 'text') return { found: true, text: (element.innerText ?? '').slice(0, limit) };
      if (mode === 'attrs') return { found: true, attrs: Object.fromEntries(Array.from(element.attributes).map((a) => [a.name, a.value])) };
      return {
        found: true,
        selector,
        tag: element.tagName.toLowerCase(),
        box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        html: element.outerHTML.slice(0, limit),
      };
    }, { selector, mode, limit });
  }

  /** JS/CSS usage collected between start and stop. */
  async coverage(tabId, action) {
    if (action === 'start') {
      await this.cdp(tabId, 'Profiler.enable', {});
      await this.cdp(tabId, 'Profiler.startPreciseCoverage', { callCount: true, detailed: true });
      await this.cdp(tabId, 'DOM.enable', {});
      await this.cdp(tabId, 'CSS.enable', {});
      await this.cdp(tabId, 'CSS.startRuleUsageTracking', {});
      this.#coverage.add(tabId);
      return { coverage: 'recording' };
    }
    const result = await this.cdp(tabId, 'Profiler.takePreciseCoverage', {});
    this.#coverage.delete(tabId);
    const files = (result.result ?? []).map((entry) => {
      const total = entry.functions.reduce((sum, fn) => sum + fn.ranges.length, 0);
      const used = entry.functions.reduce((sum, fn) => sum + fn.ranges.filter((range) => range.count > 0).length, 0);
      return { url: entry.url || '(inline)', ranges: total, used, percent: total ? Math.round((used / total) * 100) : 0 };
    }).filter((entry) => entry.ranges > 0);
    return { files: files.slice(0, 60) };
  }

  /** Files the browser saved into this profile's download directory. */
  async downloads() {
    const dir = this.downloadDir;
    if (!dir) return { dir: null, files: [] };
    if (!existsSync(dir)) return { dir, files: [] };
    const files = readdirSync(dir)
      .map((name) => {
        const stat = statSync(join(dir, name));
        return { name, bytes: stat.size, at: new Date(stat.mtimeMs).toISOString() };
      })
      .sort((a, b) => (a.at < b.at ? 1 : -1));
    return { dir, files };
  }

  /**
   * Lighthouse audit against this tab's URL, over the browser's own debug port.
   *
   * Lighthouse is an optional dependency: the plugin keeps working without it,
   * and the command reports a clear reason instead of crashing.
   */
  async lighthouse(tabId, { categories, preset = 'desktop', threshold = 0.9, limit = 12 } = {}) {
    const { page } = this.#entry(tabId);
    const url = page.url();
    if (!/^https?:/i.test(url)) throw new Error(`lighthouse needs an http(s) page, this tab is ${url}`);

    let runner;
    try {
      const module = await import('lighthouse');
      runner = module.default ?? module;
    } catch {
      throw new Error('lighthouse is not installed in this plugin (npm install lighthouse)');
    }

    const desktop = preset !== 'mobile';
    const options = {
      port: this.debugPort,
      output: 'json',
      logLevel: 'error',
      onlyCategories: categories ?? ['performance', 'accessibility', 'best-practices', 'seo'],
      formFactor: desktop ? 'desktop' : 'mobile',
      screenEmulation: desktop
        ? { mobile: false, width: 1280, height: 800, deviceScaleFactor: 2, disabled: false }
        : { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false },
      throttlingMethod: 'simulate',
    };

    const result = await this.#withTimeout(runner(url, options), 180000, 'lighthouse');
    const report = JSON.parse(result.report);

    const scores = {};
    for (const [id, category] of Object.entries(report.categories ?? {})) {
      scores[id] = category.score === null ? null : Math.round(category.score * 100);
    }
    const metricKeys = ['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time',
      'cumulative-layout-shift', 'speed-index'];
    const metrics = {};
    for (const key of metricKeys) {
      const value = report.audits?.[key]?.displayValue;
      if (value) metrics[key] = value;
    }
    const failures = Object.values(report.audits ?? {})
      .filter((audit) => audit.score !== null && audit.score < threshold && audit.scoreDisplayMode !== 'informative')
      .map((audit) => ({ id: audit.id, title: audit.title, value: audit.displayValue ?? '', score: audit.score }))
      .sort((a, b) => a.score - b.score)
      .slice(0, limit);

    const dir = this.downloadDir;
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir).filter((entry) => entry.startsWith('lighthouse-'))) {
      const full = join(dir, name);
      // Reports survive a day; an archived session removes them with the browser.
      if (Date.now() - statSync(full).mtimeMs > 24 * 60 * 60 * 1000) rmSync(full, { force: true });
    }
    const jsonPath = join(dir, `lighthouse-${Date.now()}.json`);
    const fsMod = await import('node:fs');
    fsMod.writeFileSync(jsonPath, result.report ?? '', 'utf8');

    return { url, scores, metrics, failures, report: jsonPath };
  }

  /** Read a saved Lighthouse report: list audits or return one audit's details. */
  async report({ path, audit, list } = {}) {
    if (!path) throw new Error('pass path (the report returned by the lighthouse command)');
    if (!existsSync(path)) throw new Error(`report not found: ${path}`);
    const report = JSON.parse(readFileSync(path, 'utf8'));
    const audits = report.audits ?? {};
    if (audit) {
      const found = audits[audit];
      if (!found) throw new Error(`no audit "${audit}" in this report`);
      const items = Array.isArray(found.details?.items) ? found.details.items.slice(0, 10) : [];
      return {
        id: found.id,
        title: found.title,
        score: found.score,
        displayValue: found.displayValue ?? null,
        description: String(found.description ?? '').slice(0, 400),
        items: JSON.parse(JSON.stringify(items).slice(0, 4000)),
      };
    }
    const rows = Object.values(audits)
      .map((entry) => ({ id: entry.id, score: entry.score, title: entry.title }))
      .sort((a, b) => (a.score ?? 1) - (b.score ?? 1));
    return {
      url: report.finalUrl ?? report.requestedUrl ?? null,
      version: report.lighthouseVersion ?? null,
      scores: Object.fromEntries(Object.entries(report.categories ?? {}).map(([id, value]) => [id, value.score])),
      audits: (list === false ? rows.slice(0, 20) : rows).slice(0, 200),
    };
  }

  async close(tabId) {
    const entry = this.#pages.get(tabId);
    if (!entry) throw new Error(`unknown tab ${tabId}`);
    this.#pages.delete(tabId);
    this.#cdp.delete(tabId);
    this.#cursors.delete(tabId);
    await entry.page.close().catch(() => {});
    if (this.#pages.size === 0) {
      await this.closeAll().catch(() => {});
      return { closed: true, browserClosed: true };
    }
    return { closed: true, browserClosed: false };
  }

  async closeAll() {
    if (this.#shuttingDown) return { closed: true };
    this.#shuttingDown = true;
    this.#closed = true;
    for (const { page } of this.#pages.values()) await page.close().catch(() => {});
    this.#pages.clear();
    this.#cdp.clear();
    this.#cursors.clear();
    this.#contexts.clear();
    await this.#persistent?.close().catch(() => {});
    this.#persistent = null;
    this.#launchedAt = 0;
    this.#browser = null;
    // The throwaway profile goes away with the browser.
    if (this.#profileDir) {
      try { rmSync(this.#profileDir, { recursive: true, force: true }); } catch { /* locked; OS cleans temp */ }
      this.#profileDir = null;
    }
    this.#shuttingDown = false;
    return { closed: true };
  }

  get isRunning() {
    return this.#persistent !== null && !this.#closed;
  }

  get downloadDir() {
    // Keep the resolved path even after the profile is gone, so callers can
    // still clean the artifacts of a closed browser.
    if (!this.#downloadDir) {
      const name = this.#profileDir ? this.#profileDir.split(/[\\/]/).pop() : 'default';
      this.#downloadDir = join(tmpdir(), 'dsh-browser-downloads', name);
    }
    return this.#downloadDir;
  }

  get sessionId() {
    return this.#sessionId;
  }
}
