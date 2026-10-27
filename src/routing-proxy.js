import { createServer } from 'node:net';
import { connect as netConnect } from 'node:net';

/**
 * Loopback routing proxy.
 *
 * Chromium 156 ignores PAC (both `--proxy-pac-url` and `chrome.proxy` from an
 * extension), so the per-site decision has to live outside the browser. Every
 * connection is parsed here: hosts in the rule set are tunnelled through the
 * upstream proxy, everything else goes direct. Rules are read live.
 */
export function createRoutingProxy({ rules, port = 0, upstream = '127.0.0.1:10901' }) {
  /** The agent may change the upstream at runtime; rules() carries it. */
  const upstreamOf = () => {
    const candidate = String(rules().server ?? upstream ?? '').trim();
    const match = /^(?:https?:\/\/)?([^/:\s]+):(\d{1,5})$/.exec(candidate);
    return match ? { host: match[1], port: Number(match[2]) } : null;
  };

  const shouldProxy = (hostname) => {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!host) return false;
    if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return false;
    const state = rules();
    if (state.all) return true;
    return state.hosts.some((entry) => host === entry || host.endsWith(`.${entry}`));
  };

  const forward = (client, headText, rest, hostname, targetPort) => {
    const viaUpstream = shouldProxy(hostname);
    const upstreamAddress = upstreamOf();
    const useUpstream = viaUpstream && upstreamAddress !== null;
    const upstreamSocket = netConnect(
      useUpstream ? upstreamAddress.port : targetPort,
      useUpstream ? upstreamAddress.host : hostname,
      () => {
        if (useUpstream) {
          // Ask the upstream to open the same tunnel.
          upstreamSocket.write(`CONNECT ${hostname}:${targetPort} HTTP/1.1\r\nHost: ${hostname}:${targetPort}\r\n\r\n`);
        } else if (headText.startsWith('CONNECT')) {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (rest.length) upstreamSocket.write(rest);
          client.pipe(upstreamSocket);
          upstreamSocket.pipe(client);
        } else {
          upstreamSocket.write(rest);
          client.pipe(upstreamSocket);
          upstreamSocket.pipe(client);
        }
      },
    );

    if (useUpstream && !headText.startsWith('CONNECT')) {
      // Plain HTTP through an upstream proxy keeps the absolute URI.
      // The request line was already forwarded verbatim.
    }

    if (useUpstream) {
      let buffered = '';
      const onData = (chunk) => {
        buffered += chunk.toString('latin1');
        const boundary = buffered.indexOf('\r\n\r\n');
        if (boundary === -1) return;
        upstreamSocket.off('data', onData);
        const head = buffered.slice(0, boundary);
        const remainder = Buffer.from(buffered.slice(boundary + 4), 'latin1');
        if (!/^HTTP\/1\.[01] 200/i.test(head)) {
          client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          upstreamSocket.destroy();
          return;
        }
        if (headText.startsWith('CONNECT')) {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (remainder.length) client.write(remainder);
          if (rest.length) upstreamSocket.write(rest);
          client.pipe(upstreamSocket);
          upstreamSocket.pipe(client);
        } else {
          client.write(chunk);
          client.pipe(upstreamSocket);
          upstreamSocket.pipe(client);
        }
      };
      upstreamSocket.on('data', onData);
    }

    const fail = () => {
      client.destroy();
      upstreamSocket.destroy();
    };
    upstreamSocket.on('error', fail);
    client.on('error', fail);
  };

  const clients = new Set();

  const server = createServer((client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const boundary = buffer.indexOf('\r\n\r\n');
      if (boundary === -1) {
        if (buffer.length > 65536) client.destroy();
        return;
      }
      client.off('data', onData);
      const headText = buffer.subarray(0, boundary).toString('latin1');
      const rest = buffer.subarray(boundary + 4);
      const firstLine = headText.split('\r\n')[0];
      const [method, target] = firstLine.split(' ');

      if (method === 'CONNECT') {
        const [hostname, rawPort] = String(target).split(':');
        return forward(client, headText, rest, hostname, Number(rawPort || 443));
      }

      let hostname = '';
      let targetPort = 80;
      try {
        const url = new URL(target);
        hostname = url.hostname;
        targetPort = Number(url.port || 80);
      } catch {
        client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      return forward(client, headText, buffer, hostname, targetPort);
    };
    client.on('data', onData);
    client.on('error', () => client.destroy());
  });

  return {
    async listen() {
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
      return server.address().port;
    },
    close() {
      for (const client of clients) client.destroy();
      clients.clear();
      server.close();
    },
  };
}
