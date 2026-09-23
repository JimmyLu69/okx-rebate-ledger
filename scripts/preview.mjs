import { createServer } from 'node:http';
import worker from '../dist/server/index.js';
const port=Number(process.env.REBATE_PREVIEW_PORT||52567);
createServer(async (req, res) => {
  try {
    let body = '', size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 16384) { res.writeHead(413).end(); return; } body += chunk; }
    const request = new Request('http://' + req.headers.host + req.url, { method: req.method, headers: req.headers, ...(!['GET','HEAD'].includes(req.method) ? { body } : {}) });
    const response = await worker.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500).end('Preview request failed'); }
}).listen(port, '127.0.0.1', () => console.log(`Local preview ready: http://127.0.0.1:${port}`));
