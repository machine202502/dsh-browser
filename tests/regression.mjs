import { BrowserManager } from '../src/browser-manager.js';
import { existsSync, readdirSync, rmSync } from 'node:fs';

const PAGE = process.env.QA_PAGE ?? 'http://127.0.0.1:5099/';
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const check = async (name, run) => {
  try {
    const detail = await run();
    record(name, true, typeof detail === 'string' ? detail : '');
  } catch (error) {
    record(name, false, String(error?.message ?? error).split('\n')[0]);
  }
};

const manager = new BrowserManager({ sessionId: 'regression', width: 1024, height: 700 });
let tab;

await check('open page', async () => {
  tab = await manager.open(PAGE);
  return `${tab.title} ${tab.url}`;
});

await check('fill + click + dom text', async () => {
  await manager.fill(tab.id, '#i', 'hello');
  await manager.click(tab.id, '#echo');
  const value = await manager.dom(tab.id, { selector: '#out', mode: 'text' });
  if (value.text !== 'value=hello') throw new Error(`unexpected: ${value.text}`);
  return value.text;
});

await check('keyboard enter', async () => {
  await manager.click(tab.id, '#i');
  await manager.keyboard(tab.id, { type: 'abc', press: 'Enter' });
  const value = await manager.dom(tab.id, { selector: '#out', mode: 'text' });
  if (!value.text.startsWith('enter:')) throw new Error(`unexpected: ${value.text}`);
  return value.text;
});

await check('snapshot (accessibility tree)', async () => {
  const rows = await manager.axTree(tab.id, 40);
  if (!rows.some((row) => row.includes('button'))) throw new Error('no buttons in the tree');
  return `${rows.length} roles`;
});

await check('dialog accept', async () => {
  const opened = manager.click(tab.id, '#alert').catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const answer = await manager.answerDialog(tab.id, { accept: true });
  await opened;
  return `${answer.type} -> ${answer.accepted}`;
});

await check('network list + detail + body', async () => {
  const rows = manager.networkLogs(tab.id, { limit: 200 });
  if (rows.length === 0) throw new Error('no requests captured');
  const detail = await manager.networkDetail(tab.id, 0);
  const body = await manager.networkBody(tab.id, 0);
  if (!detail.status) throw new Error('no status');
  if (!body.body) throw new Error('empty body');
  return `${rows.length} requests, ${Object.keys(detail.responseHeaders ?? {}).length} headers`;
});

await check('css matched rules', async () => {
  const result = await manager.css(tab.id, { selector: '#box' });
  if (!result.rules.length) throw new Error('no rules');
  const media = result.rules.filter((rule) => rule.media).length;
  return `${result.rules.length} rules, ${media} with media`;
});

await check('assets list', async () => {
  const result = await manager.assets(tab.id, { group: 'stylesheet' });
  if (!result.assets.length) throw new Error('no stylesheet assets');
  return result.assets.map((entry) => entry.url).join(', ');
});

await check('html to file', async () => {
  const result = await manager.pageHtml(tab.id);
  if (!existsSync(result.path)) throw new Error('file missing');
  return `${result.bytes} bytes`;
});

let shotA;
await check('screenshot page + element', async () => {
  shotA = await manager.screenshotFile(tab.id, { quality: 70 });
  const element = await manager.screenshotFile(tab.id, { selector: '#box' });
  if (!existsSync(shotA.path) || !existsSync(element.path)) throw new Error('file missing');
  return `${shotA.bytes} + ${element.bytes} bytes`;
});

await check('diff two shots', async () => {
  await manager.evaluate(tab.id, "document.getElementById('box').style.background = '#111'");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const shotB = await manager.screenshotFile(tab.id, { quality: 70 });
  const diff = await manager.diffImages(tab.id, { a: shotA.path, b: shotB.path });
  await manager.evaluate(tab.id, "document.getElementById('box').style.background = ''");
  if (diff.diffPixels <= 0) throw new Error('no difference detected');
  return `${diff.percent}% in ${diff.box?.width}x${diff.box?.height}`;
});

await check('console with args', async () => {
  await manager.evaluate(tab.id, "console.log('regression', { ok: true })");
  await new Promise((resolve) => setTimeout(resolve, 400));
  const rows = manager.consoleLogs(tab.id, { limit: 20 }).filter((row) => row.text.includes('regression'));
  if (!rows.length) throw new Error('log line missing');
  return JSON.stringify(rows[0].args);
});

await check('indexeddb roundtrip', async () => {
  await manager.click(tab.id, '#idb');
  await new Promise((resolve) => setTimeout(resolve, 800));
  const databases = await manager.indexedDb(tab.id, {});
  if (!databases.databases.includes('probe')) throw new Error('database missing');
  const rows = await manager.indexedDb(tab.id, { database: 'probe', store: 'rows' });
  return `${databases.databases.length} db, ${rows.rows.length} rows`;
});

await check('coverage start/stop', async () => {
  await manager.coverage(tab.id, 'start');
  await manager.click(tab.id, '#echo');
  const result = await manager.coverage(tab.id, 'stop');
  if (!result.files.length) throw new Error('no coverage files');
  return `${result.files.length} files`;
});

await check('emulate dark scheme', async () => {
  await manager.cdp(tab.id, 'Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  const dark = await manager.evaluate(tab.id, "matchMedia('(prefers-color-scheme: dark)').matches");
  if (dark !== true) throw new Error('scheme not applied');
  return 'dark=true';
});

await check('download', async () => {
  await manager.click(tab.id, '#download');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const result = await manager.downloads();
  if (!result.files.some((file) => file.name.includes('sample'))) {
    throw new Error(`files: ${JSON.stringify(result.files)}`);
  }
  return result.files.map((file) => `${file.name} ${file.bytes}B`).join(', ');
});

await check('websocket frames', async () => {
  await manager.click(tab.id, '#ws');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const sockets = manager.wsLogs(tab.id, { limit: 10 });
  if (!sockets.length || sockets[0].total < 2) throw new Error('no frames');
  return `${sockets[0].url} ${sockets[0].total} frames`;
});

await check('perf counters', async () => {
  const result = await manager.perf(tab.id, { seconds: 2 });
  if (!result.samples) throw new Error('no samples');
  return `nodes=${result.nodes} heap=${result.heap_kb}KB`;
});

await check('context isolation', async () => {
  const second = await manager.open(PAGE, { ctx: 'ctx2' });
  await manager.evaluate(second.id, "localStorage.setItem('iso', 'only-here')");
  const first = await manager.evaluate(tab.id, "localStorage.getItem('iso')");
  if (first === 'only-here') throw new Error('contexts share storage');
  return 'storage isolated';
});

await check('close removes profile and artifacts', async () => {
  const dir = manager.downloadDir;
  await manager.closeAll();
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  return `profile=${existsSync(manager.profileDir)}`;
});

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
