// `wasm-build-all setup`: install the pinned emsdk into the shared cache, apply our Emscripten patches, generate
// the wrapper config, and (with --browsers) install the Playwright browsers used by the browser pass.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HOME, EMSDK, spec, writeGenerated } from './config.mjs';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const quiet = (cmd, args, opts = {}) => { try { execFileSync(cmd, args, { stdio: 'ignore', ...opts }); return true; } catch { return false; } };

export function setup({ browsers = false } = {}) {
  if (!fs.existsSync(path.join(EMSDK, 'emsdk'))) {
    fs.mkdirSync(path.dirname(EMSDK), { recursive: true });
    run('git', ['clone', '--quiet', 'https://github.com/emscripten-core/emsdk.git', EMSDK]);
  }
  const em = path.join(EMSDK, 'upstream', 'emscripten');
  const verFile = path.join(em, 'emscripten-version.txt');
  const have = fs.existsSync(verFile) ? fs.readFileSync(verFile, 'utf8').replace(/["\s]/g, '') : '';
  if (have !== spec.emsdk) {
    run(path.join(EMSDK, 'emsdk'), ['install', spec.emsdk], { cwd: EMSDK });
    run(path.join(EMSDK, 'emsdk'), ['activate', spec.emsdk], { cwd: EMSDK });
  }

  // Our fixes to Emscripten itself: applied once each; the system libraries they touch are dropped from emsdk's
  // cache so they rebuild with the fix.
  const pdir = path.join(HOME, 'patches', 'emscripten');
  for (const p of fs.existsSync(pdir) ? fs.readdirSync(pdir).filter((f) => f.endsWith('.patch')).sort() : []) {
    const file = path.join(pdir, p), stamp = path.join(em, `.wba-${p}.applied`);
    if (fs.existsSync(stamp)) continue;
    const input = fs.readFileSync(file);
    if (!quiet('patch', ['-d', em, '-p1', '-R', '--dry-run', '-s'], { input })) {
      run('patch', ['-d', em, '-p1', '--forward', '-s'], { input });
      if (input.includes('system/lib/wasmfs')) {
        for (const d of fs.readdirSync(path.join(em, 'cache', 'sysroot', 'lib'), { recursive: true }))
          if (path.basename(String(d)).startsWith('libwasmfs')) fs.rmSync(path.join(em, 'cache', 'sysroot', 'lib', String(d)));
      }
      console.log(`applied ${p}`);
    }
    fs.writeFileSync(stamp, '');
  }

  writeGenerated();
  if (browsers) run('npx', ['playwright', 'install', 'chromium', 'firefox', 'webkit'], { cwd: HOME });
  console.log(`emsdk ${spec.emsdk} ready in ${EMSDK}`);
}
