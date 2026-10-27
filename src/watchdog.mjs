/**
 * Cross-platform guard against leaked browsers.
 *
 * The host closes every browser on dispose, but a crash or a hard kill skips
 * that path. This watcher is started detached (same Node runtime as the host,
 * `ELECTRON_RUN_AS_NODE`), polls the host pid, and — once the host is gone —
 * asks Chromium to exit through its own DevTools endpoint. No native APIs, no
 * platform-specific commands.
 *
 * Usage: node watchdog.mjs <hostPid> <debugPort>
 */
import http from 'node:http';

const hostPid = Number(process.argv[2]);
const port = Number(process.argv[3]);

if (!Number.isInteger(hostPid) || !Number.isInteger(port)) process.exit(0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const hostAlive = () => {
  try {
    process.kill(hostPid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const endpoint = (path) =>
  new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path, timeout: 2000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    request.on('error', () => resolve(null));
    request.on('timeout', () => { request.destroy(); resolve(null); });
  });

/** Ask Chromium to terminate through CDP; resolves true when the socket worked. */
const closeBrowser = async (wsUrl) => {
  if (typeof WebSocket === 'undefined') return false;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const socket = new WebSocket(wsUrl);
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
        setTimeout(() => done(true), 500);
      });
      socket.addEventListener('error', () => done(false));
      socket.addEventListener('close', () => done(true));
      setTimeout(() => done(false), 5000);
    } catch {
      done(false);
    }
  });
};

for (;;) {
  if (!hostAlive()) {
    const version = await endpoint('/json/version');
    if (version?.webSocketDebuggerUrl) await closeBrowser(version.webSocketDebuggerUrl);
    process.exit(0);
  }

  // Browser already gone (normal close): stop watching instead of lingering.
  const alive = await endpoint('/json/version');
  if (alive === null) {
    await sleep(2000);
    if ((await endpoint('/json/version')) === null) process.exit(0);
  }

  await sleep(1000);
}
