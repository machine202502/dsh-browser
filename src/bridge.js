import { createServer } from 'node:http';

/**
 * Loopback bridge between the Host browser service, the DSH Web UI card, and
 * the proxy extension inside each Chromium profile.
 *
 * Binds to 127.0.0.1 only. `proxy` is the Host-side rule state:
 *   { rules(): { proxy: string, hosts: string[] }, report(payload): void,
 *     snapshot(): { hosts, reportedAt } }
 */
export function createBridge({ manager, proxy = null, frames = null, token = null, port = 0, settings = null }) {
  // Live sockets are tracked so shutdown never waits for a polling client.
  const sockets = new Set();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Cache-Control': 'no-store',
    };
    const json = (code, body) => {
      res.writeHead(code, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    if (token && url.searchParams.get('token') !== token) return json(403, { error: 'bad token' });

    try {
      const [, api, action] = url.pathname.split('/');
      if (api !== 'api') return json(404, { error: 'not found' });

      if (action === 'tabs' && req.method === 'GET') {
        const session = url.searchParams.get('session');
        return json(200, { sessionId: manager.sessionId, running: manager.isRunning, tabs: await manager.tabs({}, session) });
      }
      if (action === 'browsers' && req.method === 'GET') {
        return json(200, { browsers: await manager.browsers() });
      }
      if (action === 'shot' && req.method === 'GET') {
        const tab = url.searchParams.get('tab');
        const full = url.searchParams.get('full') === '1';
        return json(200, { image: await manager.shot(tab, { fullPage: full }) });
      }
      if (action === 'close' && req.method === 'POST') {
        return json(200, await manager.close(url.searchParams.get('tab')));
      }
      if (action === 'close-browser' && req.method === 'POST') {
        const purge = url.searchParams.get('purge') === '1';
        return json(200, await manager.closeBrowser(url.searchParams.get('key'), { purge }));
      }
      if (action === 'close-all' && req.method === 'POST') {
        const purge = url.searchParams.get('purge') === '1';
        return json(200, await manager.closeAll(url.searchParams.get('session'), { purge }));
      }

      if (action === 'frame' && req.method === 'GET') {
        const id = url.pathname.split('/')[3];
        const buffer = frames ? frames(id) : null;
        if (!buffer) return json(404, { error: 'no frame' });
        res.writeHead(200, { ...cors, 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
        return res.end(buffer);
      }

      // --- proxy extension protocol
      if (action === 'proxy-rules' && req.method === 'GET') {
        return json(200, proxy ? proxy.rules() : { proxy: '', hosts: [] });
      }
      if (action === 'proxy-report' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        try { proxy?.report(JSON.parse(body || '{}')); } catch { /* ignore malformed */ }
        return json(200, { ok: true });
      }
      if (action === 'settings' && req.method === 'GET') {
        return json(200, settings ? settings.view() : { values: {}, defaults: {} });
      }
      if (action === 'settings' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        if (!settings) return json(503, { error: 'settings are not available' });
        try {
          return json(200, settings.save(JSON.parse(body || '{}')));
        } catch (error) {
          return json(400, { error: String(error?.message ?? error) });
        }
      }
      if (action === 'proxy-state' && req.method === 'GET') {
        return json(200, proxy ? proxy.snapshot() : { hosts: [], reportedAt: null });
      }

      return json(404, { error: 'not found' });
    } catch (error) {
      return json(500, { error: String(error?.message ?? error) });
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return {
    token,
    async listen() {
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
      return { port: server.address().port, token };
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
