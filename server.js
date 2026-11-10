// host-now static origin: serves published folders by Host header, never executes them.
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = process.env.STATIC_ROOT ?? '/srv/sites';
const TOKEN = process.env.STATIC_TOKEN ?? '';
const MIME = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.txt':'text/plain; charset=utf-8','.map':'application/json','.webmanifest':'application/manifest+json' };
const ext = (p) => { const i = p.lastIndexOf('.'); return i < 0 ? '' : p.slice(i).toLowerCase(); };
const siteOf = (host) => (host ?? '').split(':')[0].split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '');

createServer(async (req, res) => {
  const host = siteOf(req.headers.host);
  if (req.method === 'POST' && req.url === '/_upload') {
    if (!TOKEN || req.headers['x-static-token'] !== TOKEN) { res.writeHead(401).end('no'); return; }
    let body = ''; for await (const c of req) body += c;
    let payload; try { payload = JSON.parse(body); } catch { res.writeHead(400).end('bad json'); return; }
    const site = String(payload.site ?? '').replace(/[^a-z0-9-]/g, '');
    if (!site) { res.writeHead(400).end('no site'); return; }
    const dir = join(ROOT, site);
    let n = 0, bytes = 0;
    try {
      for (const f of payload.files ?? []) {
        const rel = String(f.path ?? '');
        if (!rel || rel.includes('..') || rel.startsWith('/')) continue;
        const buf = Buffer.from(f.data ?? '', 'base64');
        const target = join(dir, ...rel.split('/'));
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, buf); n++; bytes += buf.length;
      }
    } catch (err) { res.writeHead(500).end(String(err.message)); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, site, files: n, bytes }));
    return;
  }
  if (req.method === 'POST' && req.url === '/_delete') {
    if (!TOKEN || req.headers['x-static-token'] !== TOKEN) { res.writeHead(401).end('no'); return; }
    let body = ''; for await (const c of req) body += c;
    let payload; try { payload = JSON.parse(body); } catch { res.writeHead(400).end('bad json'); return; }
    const site = String(payload.site ?? '').replace(/[^a-z0-9-]/g, '');
    if (!site) { res.writeHead(400).end('no site'); return; }
    // Removes the published folder so an expired or deleted site stops serving immediately.
    rmSync(join(ROOT, site), { recursive: true, force: true });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, deleted: site }));
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const url = (req.url ?? '/').split('?')[0];
    const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
    if (rel.includes('..')) { res.writeHead(400).end(); return; }
    const file = join(ROOT, host, ...rel.split('/'));
    const looksLikeFile = /\.[a-z0-9]{1,8}$/i.test(rel);
    if (!existsSync(file) && looksLikeFile) { res.writeHead(404, { 'content-type':'text/plain' }).end('not found'); return; }
    if (!existsSync(file)) {
      // The static app's own disk is wiped by every redeploy, so fall back to the API, which
      // keeps the published bytes in Postgres. Serve, then cache locally.
      // Prefer the internal service address: a container on this host cannot reliably reach the
      // public hostname through the NAT (hairpin). Never send client headers upstream.
      const base = (process.env.API_INTERNAL ?? 'https://api.host.abslm.nl').replace(/\/$/, '');
      const upstream = await fetch(`${base}/s/${encodeURIComponent(host)}/${rel.split('/').map(encodeURIComponent).join('/')}`, {
        signal: AbortSignal.timeout(5_000),
        headers: { accept: 'text/html,application/octet-stream' },
      }).catch((err) => { console.error('fallback failed:', base, err.name ?? err.message); return null; });
      if (upstream && !upstream.ok) console.error('fallback not ok:', base, upstream.status, host, rel);
      if (!upstream || !upstream.ok) {
        const index = join(ROOT, host, 'index.html');
        if (!existsSync(index)) { res.writeHead(404, { 'content-type':'text/html' }).end('<!doctype html><title>not found</title><h1>This site is not here</h1><p>It may have expired.</p>'); return; }
        res.writeHead(200, { 'content-type': MIME['.html'] }).end(readFileSync(index));
        return;
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      if (buf.length > 8 * 1024 * 1024) { res.writeHead(502).end('too large'); return; }
      try { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, buf); } catch { /* read only */ }
      res.writeHead(200, { 'content-type': MIME[ext(rel)] ?? 'application/octet-stream', 'content-length': buf.length, 'x-content-type-options': 'nosniff' });
      return res.end(buf);
    }
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[ext(rel)] ?? 'application/octet-stream', 'content-length': body.length, 'x-content-type-options': 'nosniff' }).end(req.method === 'HEAD' ? undefined : body);
    return;
  }
  res.writeHead(405).end();
}).listen(PORT, '0.0.0.0', () => console.log(`static origin on :${PORT} root=${ROOT} token=${TOKEN ? 'set' : 'MISSING'}`));
