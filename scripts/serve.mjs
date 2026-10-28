import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const root = resolve(process.cwd()), port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer(async (request, response) => {
  try {
    let path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    // Match the project subpath used by GitHub Pages as well as the local root.
    if (path === '/ics-pipeline') { response.writeHead(302, { Location: '/ics-pipeline/' }); response.end(); return; }
    if (path.startsWith('/ics-pipeline/')) path = path.slice('/ics-pipeline'.length);
    if (path.endsWith('/')) path += 'index.html';
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + sep) || /(?:^|[\/\\])\./.test(path)) { response.writeHead(403); response.end('Forbidden'); return; }
    const bytes = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); response.end(bytes);
  } catch { response.writeHead(404); response.end('Not found'); }
});
server.listen(port, '127.0.0.1', () => process.stdout.write(`Local: http://localhost:${port}/ics-pipeline/\n`));
