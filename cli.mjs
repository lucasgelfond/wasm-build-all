#!/usr/bin/env node
// wasm-build-all: build C/C++ libraries to wasm64 in three flavours (mt, st, asyncify) and run their upstream
// test suites against the wasm build under node and in Chromium, Firefox and WebKit, next to a native baseline.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { HOME, FLAVORS, spec, project, flavor } from './lib/config.mjs';
import { setup } from './lib/setup.mjs';
import { envFor, exportsFor } from './lib/env.mjs';
import { compare, complete, table, resultsFile } from './lib/results.mjs';

const USAGE = `usage: wasm-build-all <command> [args]

  setup [--browsers]                    install the pinned emsdk (${spec.emsdk}) and generated config; --browsers
                                        also installs Playwright's Chromium, Firefox and WebKit
  env <flavour>                         print shell exports: eval "$(wasm-build-all env mt)"
  build|test|all|fetch|package <recipe...|--all> [--flavor ${FLAVORS.join('|')}|all] [--jobs N]
                                        run recipe steps (all = build then test), in wasm-build-all.json order
  check <recipe...|--all>               recipe metadata, hooks, shellcheck, and complete results in every flavour
  compare <recipe...|--all> [--base REV] fail if any suite regressed against git
  report [--all]                        Markdown table of every recipe's results
  table <recipe>                        one recipe's results table
  init <name>                           scaffold <recipes>/<name>/{recipe.json,build.sh}
  run <prog.js> [args]                  run a wasm program under node (same as bin/wasm-run)

flavours: ${FLAVORS.map((f) => `${f} (${spec.flavors[f].description})`).join('\n           ')}`;

const die = (msg) => { console.error(msg); process.exit(1); };
const argv = process.argv.slice(2);
const cmd = argv.shift();
const opts = { flavor: 'all', jobs: null, base: 'HEAD', all: false, browsers: false };
const names = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--flavor') opts.flavor = argv[++i];
  else if (a === '--jobs') opts.jobs = argv[++i];
  else if (a === '--base') opts.base = argv[++i];
  else if (a === '--all') opts.all = true;
  else if (a === '--browsers') opts.browsers = true;
  else names.push(a);
}

function needProject() {
  const p = project();
  if (!p) die('no wasm-build-all.json in this directory or above');
  return p;
}
function recipe(proj, name) {
  const dir = path.join(proj.recipes, name), f = path.join(dir, 'recipe.json');
  if (!fs.existsSync(f)) die(`no recipe ${path.relative(process.cwd(), f)}`);
  return { name, dir, meta: JSON.parse(fs.readFileSync(f, 'utf8')) };
}
const selected = (proj) => (opts.all ? proj.order : names);
const flavors = () => (opts.flavor === 'all' ? FLAVORS : (flavor(opts.flavor), [opts.flavor]));

function runStep(proj, r, step, fl) {
  const m = r.meta, src = m.source || {};
  const env = {
    ...process.env, ...envFor(fl, proj),
    NAME: m.name, VERSION: m.version, RECIPE: r.dir,
    WBA_REQUIRES: (m.requires || []).join(' '),
    WBA_RECIPE_FLAVORS: (m.flavors || FLAVORS).join(' '),
    WBA_NA_REASON: m.notApplicable || '',
    WBA_SRC_URL: src.url || '', WBA_SRC_HASH: src.hash || '', WBA_SRC_GIT: src.git || '', WBA_SRC_REV: src.rev || '', WBA_SRC_PATH: src.path || '',
    WBA_SRC_FILE: src.file || (src.url ? `${m.name}-${m.version}-${path.basename(src.url.split('?')[0])}` : ''),
  };
  if (opts.jobs) env.JOBS = opts.jobs;
  const r2 = spawnSync('bash', [path.join(HOME, 'lib', 'run-recipe.sh'), step], { env, stdio: 'inherit' });
  if (r2.status !== 0) die(`${m.name} ${step} (${fl}) failed`);
}

function checkRecipe(proj, r) {
  const m = r.meta, problems = [];
  for (const k of ['name', 'version', 'description', 'source', 'basedOn', 'effort', 'tests', 'skipped'])
    if (m[k] === undefined) problems.push(`recipe.json: missing "${k}"`);
  if (m.effort && !(/^(easy|medium|hard)$/.test(m.effort.build) && /^(easy|medium|hard)$/.test(m.effort.tests)))
    problems.push('recipe.json: effort.build/effort.tests must be easy|medium|hard');
  const sh = path.join(r.dir, 'build.sh');
  if (!fs.existsSync(sh)) problems.push('no build.sh');
  else {
    const s = fs.readFileSync(sh, 'utf8');
    for (const fn of ['build', 'test']) if (!new RegExp(`^${fn}\\(\\)`, 'm').test(s)) problems.push(`build.sh: no ${fn}() hook`);
    try { execFileSync('shellcheck', ['-S', 'warning', '-s', 'bash', '-e', 'SC2034,SC1090,SC1091,SC2154', sh], { stdio: 'pipe' }); }
    catch (e) { if (e.code !== 'ENOENT') problems.push(`shellcheck:\n${e.stdout}`); }
  }
  const c = complete(r.name, r.dir);
  problems.push(...c.problems.map((p) => `results: ${p}`));
  return problems;
}

switch (cmd) {
  case 'setup': setup({ browsers: opts.browsers }); break;
  case 'env': {
    if (!names[0]) die('usage: wasm-build-all env <flavour>');
    console.log(exportsFor(envFor(names[0], project())));
    break;
  }
  case 'build': case 'test': case 'fetch': case 'package': case 'all': {
    const proj = needProject();
    const list = selected(proj);
    if (!list.length) die('name recipes or pass --all');
    for (const fl of flavors())
      for (const n of list) {
        const r = recipe(proj, n);
        for (const step of cmd === 'all' ? ['build', 'test'] : [cmd]) runStep(proj, r, step, fl);
      }
    break;
  }
  case 'check': {
    const proj = needProject();
    let bad = 0;
    for (const n of selected(proj)) {
      const p = checkRecipe(proj, recipe(proj, n));
      console.log(p.length ? `${n}: ${p.length} problem(s)\n  ${p.join('\n  ')}` : `${n}: ok`);
      bad += p.length;
    }
    process.exit(bad ? 1 : 0);
  }
  case 'compare': {
    const proj = needProject();
    const files = selected(proj).flatMap((n) => FLAVORS.map((fl) => resultsFile(recipe(proj, n).dir, fl)).filter((f) => fs.existsSync(f)));
    process.exit(compare(files, opts.base) ? 0 : 1);
  }
  case 'table': {
    const proj = needProject();
    console.log(table(recipe(proj, names[0]).dir));
    break;
  }
  case 'report': {
    const proj = needProject();
    const esc = (t) => String(t || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const out = ['| Library | Version | Effort (build / tests) | mt | st | asyncify | Notes |', '|---|---|---|---|---|---|---|'];
    for (const n of proj.order) {
      const dir = path.join(proj.recipes, n);
      if (!fs.existsSync(path.join(dir, 'recipe.json'))) { out.push(`| ${n} | | not started | | | | |`); continue; }
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'recipe.json'), 'utf8'));
      const cell = (fl) => {
        const f = resultsFile(dir, fl);
        if (!fs.existsSync(f)) return '–';
        const s = JSON.parse(fs.readFileSync(f, 'utf8')).suites;
        if (s['not-applicable']) return 'n/a';
        let p = 0, t = 0;
        for (const [k, v] of Object.entries(s)) if (!k.startsWith('bench')) { p += v.pass; t += v.pass + v.fail; }
        return `${p}/${t}`;
      };
      out.push(`| ${n} | ${m.version} | ${m.effort?.build} / ${m.effort?.tests} | ${FLAVORS.map(cell).join(' | ')} | ${esc(m.effort?.notes)} *Based on: ${esc(m.basedOn)}* |`);
    }
    console.log(out.join('\n'));
    break;
  }
  case 'init': {
    const proj = needProject();
    const name = names[0] || die('usage: wasm-build-all init <name>');
    const dir = path.join(proj.recipes, name);
    if (fs.existsSync(dir)) die(`${dir} exists`);
    fs.mkdirSync(path.join(dir, 'patches'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'recipe.json'), JSON.stringify({
      name, version: '', description: '', source: { url: '', hash: '' }, requires: [],
      basedOn: 'own recipe', effort: { build: 'easy', tests: 'easy', notes: '' }, tests: '', skipped: 'none',
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'build.sh'), `# ${name}: build and test hooks (helpers: see wasm-build-all lib/helpers.sh).
build() {
  wba_cmake
}
test() {
  wba_ctest upstream
  wba_browser_ctest upstream
  wba_native_cmake
  wba_ctest_native upstream
}
`);
    console.log(`created ${path.relative(process.cwd(), dir)}/{recipe.json,build.sh}`);
    break;
  }
  case 'run': {
    const r = spawnSync(path.join(HOME, 'bin', 'wasm-run'), names, { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  default:
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
}
