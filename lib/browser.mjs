// Runs an Emscripten program (built with -sENVIRONMENT=web,worker -sEXIT_RUNTIME) in real browsers.
// Serves its directory with COOP/COEP (needed for SharedArrayBuffer/pthreads), captures stdout/stderr
// and the exit code.  Usage as a module: runInBrowsers(jsPath, {args, browsers, timeoutMs, files}).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, firefox, webkit } from 'playwright';

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html', '.data': 'application/octet-stream' };
const ENGINES = { chromium, firefox, webkit };

function page(script, args) {
  return `<!doctype html><meta charset="utf-8"><script>
var __bwOut = [];
var Module = {
  arguments: ${JSON.stringify(args)},
  print: (t) => __bwOut.push(t), printErr: (t) => __bwOut.push('[err] ' + t),
  // In mt, output printed on a worker can arrive just after the exit notice: keep collecting briefly.
  onExit: (code) => { setTimeout(() => { window.__result = { code, out: __bwOut }; }, 200); },
  onAbort: (what) => { window.__result = { code: 'abort', out: __bwOut.concat(['[abort] ' + what]) }; },
};
window.addEventListener('error', (e) => { window.__result ??= { code: 'error', out: __bwOut.concat(['[error] ' + e.message]) }; });
</script><script src="${script}"></script>`;
}

export async function serve(dir, extraRoutes = {}) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' };
    if (extraRoutes[url]) { res.writeHead(200, { ...headers, 'Content-Type': 'text/html' }); return res.end(extraRoutes[url]); }
    const file = path.join(dir, url);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, headers); return res.end(); }
    res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

export async function runInBrowsers(jsPath, { args = [], browsers = ['chromium', 'firefox', 'webkit'], timeoutMs = 60000 } = {}) {
  const dir = path.dirname(path.resolve(jsPath));
  const { server, base } = await serve(dir, { '/__run.html': page(path.basename(jsPath), args) });
  const results = {};
  try {
    for (const name of browsers) {
      let browser;
      try {
        browser = await ENGINES[name].launch();
        const p = await browser.newPage();
        const consoleErr = [];
        p.on('pageerror', (e) => consoleErr.push('[pageerror] ' + e.message));
        await p.goto(`${base}/__run.html`);
        const handle = await p.waitForFunction(() => window.__result, null, { timeout: timeoutMs }).catch(() => null);
        const r = handle ? await handle.jsonValue() : { code: 'timeout', out: [] };
        const info = await p.evaluate(() => ({ crossOriginIsolated: self.crossOriginIsolated, ua: navigator.userAgent }));
        results[name] = { ...r, out: [...r.out, ...consoleErr], ...info, version: browser.version() };
      } catch (e) {
        results[name] = { code: 'launch-error', out: [String(e.message || e)] };
      } finally { await browser?.close(); }
    }
  } finally { server.close(); }
  return results;
}

// node lib/browser.mjs prog.js [--browsers chromium,firefox,webkit] [args...]
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const bi = argv.indexOf('--browsers');
  const browsers = bi >= 0 ? argv.splice(bi, 2)[1].split(',') : undefined;
  const [js, ...args] = argv;
  const r = await runInBrowsers(js, { args, ...(browsers ? { browsers } : {}) });
  for (const [b, v] of Object.entries(r)) { console.log(`== ${b} ${v.version ?? ''} exit=${v.code}`); v.out.forEach((l) => console.log('  ' + l)); }
  process.exit(Object.values(r).every((v) => v.code === 0) ? 0 : 1);
}
