// Runs a suite's wasm test programs in real browsers (Chromium, Firefox, WebKit).
// Reads the exact tests from `ctest --show-only=json-v1` (command, args, working directory, WILL_FAIL,
// SKIP_RETURN_CODE, DISABLED), swaps each program for its browser relink (foo.web.js, from relink-web.sh),
// loads every file or directory the test's arguments point at into the in-browser filesystem at the same
// absolute path, runs it, and records "<suite>-<browser>" results.
//   node browser-ctest.mjs --build DIR --suite NAME --results FILE --dep NAME --version V
//        [--browsers chromium,firefox,webkit] [--preload dir1:dir2] [--jobs 4] [--timeout 120] [-R regex]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Normal module resolution: playwright may be hoisted next to wasm-build-all when installed as a dependency.
const { chromium, firefox, webkit } = require('playwright');
const ENGINES = { chromium, firefox, webkit };

const opt = { browsers: 'chromium,firefox,webkit', jobs: '4', timeout: '120', preload: '' };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) { const k = argv[i].replace(/^--?/, ''); opt[k] = argv[++i]; }
const build = path.resolve(opt.build);
const MAX_PRELOAD = 512 << 20;

// 1. The test list, exactly as ctest would run it (or, with --tests FILE, a JSON list of
//    {name, command: [program.js, ...args], cwd} for suites not driven by ctest).
const listing = opt.tests ? { tests: JSON.parse(fs.readFileSync(opt.tests, 'utf8')).map((t) => ({ name: t.name, command: t.command, properties: t.cwd ? [{ name: 'WORKING_DIRECTORY', value: t.cwd }] : [] })) }
  : JSON.parse(execFileSync('ctest', ['--show-only=json-v1', ...(opt.R ? ['-R', opt.R] : [])], { cwd: build, encoding: 'utf8', maxBuffer: 1 << 28 }));
const prop = (t, n) => t.properties?.find((p) => p.name === n)?.value;
const tests = listing.tests.map((t) => {
  const cmd = t.command ?? [];
  const i = cmd.findIndex((c) => /wasm-run$/.test(c));
  let prog = i >= 0 ? cmd[i + 1] : cmd[0];
  const args = i >= 0 ? cmd.slice(i + 2) : cmd.slice(1);
  if (prog && !prog.endsWith('.js')) prog += '.js';
  return { name: t.name, prog, args, cwd: prop(t, 'WORKING_DIRECTORY') ?? build, willFail: !!prop(t, 'WILL_FAIL'),
           skipCode: prop(t, 'SKIP_RETURN_CODE'), disabled: !!prop(t, 'DISABLED') };
});

// 2. Files each test needs: anything its arguments name (absolute, or relative to its cwd), plus --preload dirs.
function walk(p, out, budget) {
  let st; try { st = fs.statSync(p); } catch { return; }
  if (st.isDirectory()) { for (const e of fs.readdirSync(p)) walk(path.join(p, e), out, budget); }
  else if (st.isFile() && budget.left >= st.size && !/\.(wasm|js|o|a)$/.test(p)) { out.add(p); budget.left -= st.size; }
}
const extra = opt.preload ? opt.preload.split(':').filter(Boolean) : [];
for (const t of tests) {
  const files = new Set(), budget = { left: MAX_PRELOAD };
  for (const d of extra) walk(path.resolve(d), files, budget);
  for (let a of t.args) {
    for (const part of a.split(/[=,]/)) {
      if (!part || part.length > 4096) continue;
      const p = path.isAbsolute(part) ? part : path.resolve(t.cwd, part);
      if (fs.existsSync(p) && p !== '/' && !p.startsWith(build + '/CMakeFiles')) walk(p, files, budget);
    }
  }
  t.files = [...files];
}

// 3. Serve absolute paths under /fs/ with the headers threads need.
const allowed = [build, ...new Set(tests.flatMap((t) => t.files))];
const server = http.createServer((req, res) => {
  const h = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' };
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/run.html') { res.writeHead(200, { ...h, 'Content-Type': 'text/html' }); return res.end('<!doctype html><meta charset="utf-8"><body>'); }
  const p = url.replace(/^\/fs/, '');
  if (!url.startsWith('/fs/') || !(p.startsWith(build + '/') || allowed.includes(p)) || !fs.existsSync(p)) { res.writeHead(404, h); return res.end(); }
  const type = p.endsWith('.js') ? 'text/javascript' : p.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
  res.writeHead(200, { ...h, 'Content-Type': type }); fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function runOne(browser, t) {
  if (t.disabled) return { status: 'skip', why: 'disabled in ctest' };
  const web = t.prog?.replace(/\.js$/, '.web.js');
  if (!web || !fs.existsSync(web)) return { status: 'skip', why: 'no browser relink' };
  const page = await browser.newPage();
  if (process.env.WBA_DEBUG) { page.on('console', (m) => console.log(`[console ${t.name}] ${m.text()}`)); page.on('pageerror', (e) => console.log(`[pageerror ${t.name}] ${e.message}`)); page.on('requestfailed', (r) => console.log(`[reqfail ${t.name}] ${r.url()}`)); page.on('response', (r) => { if (r.status() >= 400) console.log(`[${r.status()} ${t.name}] ${r.url()}`); }); }
  try {
    await page.goto(`${base}/run.html`);
    const r = await page.evaluate(async ({ web, args, cwd, files, timeoutMs }) => {
      const bufs = await Promise.all(files.map((f) => fetch('/fs' + f).then((x) => x.arrayBuffer())));
      return await new Promise((resolve) => {
        const out = [];
        const timer = setTimeout(() => resolve({ code: 'timeout', out }), timeoutMs);
        const done = (v) => { clearTimeout(timer); resolve(v); };
        window.Module = {
          arguments: args, print: (s) => out.push(s), printErr: (s) => out.push(s),
          // After runtime init, before main(): with WasmFS the FS API calls into wasm, so it can't run in preRun.
          onRuntimeInitialized: () => {
            const FS = window.Module.FS;
            const mkdirp = (d) => { let p = ''; for (const part of d.split('/').filter(Boolean)) { p += '/' + part; try { FS.mkdir(p); } catch {} } };
            files.forEach((f, i) => { mkdirp(f.slice(0, f.lastIndexOf('/'))); FS.writeFile(f, new Uint8Array(bufs[i])); });
            mkdirp(cwd); FS.chdir(cwd);
          },
          // Output printed on a worker (mt) can arrive just after the exit notice: collect it briefly.
          onExit: (code) => setTimeout(() => done({ code, out }), 200), onAbort: (w) => done({ code: 'abort', out: [...out, String(w)] }),
        };
        window.addEventListener('error', (e) => done({ code: 'error', out: [...out, e.message] }));
        const s = document.createElement('script'); s.src = '/fs' + web; document.body.appendChild(s);
      });
    }, { web, args: t.args, cwd: t.cwd, files: t.files, timeoutMs: +opt.timeout * 1000 });
    if (t.skipCode !== undefined && r.code === +t.skipCode) return { status: 'skip', why: 'SKIP_RETURN_CODE' };
    const ok = t.willFail ? r.code !== 0 : r.code === 0;
    return { status: ok ? 'pass' : 'fail', why: ok ? '' : `exit ${r.code}: ${r.out.slice(-3).join(' | ').slice(0, 300)}` };
  } catch (e) { return { status: 'fail', why: String(e.message).slice(0, 300) }; }
  finally { await page.close().catch(() => {}); }
}

let anyFail = false;
for (const name of opt.browsers.split(',')) {
  let browser;
  try { browser = await ENGINES[name].launch(); } catch (e) { console.log(`${name}: cannot launch (${e.message})`); continue; }
  const results = new Array(tests.length); let next = 0;
  await Promise.all(Array.from({ length: +opt.jobs }, async () => { while (next < tests.length) { const i = next++; results[i] = await runOne(browser, tests[i]); } }));
  await browser.close();
  const count = (s) => results.filter((r) => r.status === s).length;
  const failed = tests.filter((_, i) => results[i].status === 'fail');
  failed.slice(0, 15).forEach((t) => console.log(`  FAIL [${name}] ${t.name}: ${results[tests.indexOf(t)].why}`));
  const skips = [...new Set(results.filter((r) => r.status === 'skip').map((r) => r.why))].join('; ');
  const note = [failed.length ? `failed: ${failed.map((t) => t.name).slice(0, 30).join(' ')}` : '', skips ? `skipped: ${skips}` : ''].filter(Boolean).join(' / ');
  execFileSync(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), 'record-result.mjs'), opt.results, opt.dep, opt.version,
    `${opt.suite}-${name}`, String(count('pass')), String(count('fail')), String(count('skip')), note]);
  console.log(`${opt.suite}-${name}: ${count('pass')} passed, ${count('fail')} failed, ${count('skip')} skipped`);
  if (count('fail')) anyFail = true;
}
server.close();
process.exit(0);
