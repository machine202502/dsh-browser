import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>QA page</title>
<link rel="stylesheet" href="/style.css">
<body style="font:16px system-ui;padding:24px">
  <h1 id="h">QA page</h1>
  <input id="i" placeholder="type here">
  <button id="echo">Echo</button>
  <p id="out">none</p>
  <div id="box" style="color: rgb(255,0,0); width: 120px; padding: 4px">BOX</div>
  <button id="alert">Alert</button>
  <button id="confirm">Confirm</button>
  <button id="prompt">Prompt</button>
  <button id="idb">IndexedDB</button>
  <button id="download">Download</button>
  <button id="ws">WebSocket</button>
  <script>
    const out = document.getElementById('out');
    document.getElementById('echo').onclick = () => { out.textContent = 'value=' + document.getElementById('i').value; };
    document.getElementById('i').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') out.textContent = 'enter:' + document.getElementById('i').value;
    });
    document.getElementById('alert').onclick = () => alert('hello from alert');
    document.getElementById('confirm').onclick = () => { out.textContent = confirm('ok?') ? 'confirmed' : 'dismissed'; };
    document.getElementById('prompt').onclick = () => { out.textContent = 'prompt:' + prompt('name?', 'guest'); };
    document.getElementById('idb').onclick = async () => {
      const request = indexedDB.open('probe', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('rows', { autoIncrement: true });
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('rows', 'readwrite');
        tx.objectStore('rows').add({ a: 1, b: 'two' });
        tx.oncomplete = () => { out.textContent = 'idb-ok'; db.close(); };
      };
    };
    document.getElementById('download').onclick = () => { location.href = '/file.txt'; };
    document.getElementById('ws').onclick = () => {
      const socket = new WebSocket('ws://127.0.0.1:5099/ws');
      socket.onopen = () => socket.send('hello');
      socket.onmessage = (event) => { out.textContent = 'ws:' + event.data; };
    };
  </script>
</body>`;

const server = createServer((req, res) => {
  if (req.url === '/style.css') {
    res.writeHead(200, { 'content-type': 'text/css' });
    return res.end(`#box { color: rgb(255, 0, 0); width: 120px; padding: 4px; }
@media (min-width: 700px) { #box { border-left: 4px solid #333; } }
h1 { font-size: 28px; }
`);
  }
  if (req.url === '/file.txt') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="sample.txt"' });
    return res.end('downloaded payload\n');
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(PAGE);
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'] ?? '';
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.on('data', (buffer) => {
    // Minimal masked client frame decode: payload starts after the header bytes.
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) { length = buffer.readUInt16BE(2); offset = 4; }
    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.alloc(length);
    for (let i = 0; i < length; i++) payload[i] = buffer[offset + i] ^ mask[i % 4];
    const reply = Buffer.from(`pong:${payload.toString('utf8')}`, 'utf8');
    const frame = Buffer.alloc(2 + reply.length);
    frame[0] = 0x81;
    frame[1] = reply.length;
    reply.copy(frame, 2);
    socket.write(frame);
  });
  socket.on('error', () => {});
});

server.listen(5099, '127.0.0.1', () => console.log('qa page on http://127.0.0.1:5099'));
