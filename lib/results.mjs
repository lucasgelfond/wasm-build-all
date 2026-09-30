// Test results: regression comparison against git, completeness across flavours, and a Markdown summary table.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FLAVORS } from './config.mjs';

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
export const resultsFile = (recipeDir, fl) => path.join(recipeDir, 'results', `wasm64-${fl}.json`);

// Fails if a suite passes fewer tests, fails more, or disappeared relative to git (HEAD or --base).
export function compare(files, base = 'HEAD') {
  let bad = 0;
  for (const f of files) {
    let before;
    try { before = JSON.parse(execFileSync('git', ['show', `${base}:./${path.relative(process.cwd(), f)}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
    catch { console.log(`new   ${f}`); continue; }
    const after = read(f);
    for (const [suite, b] of Object.entries(before.suites)) {
      const a = after.suites[suite];
      if (suite.startsWith('bench')) { if (a && a.note !== b.note) console.log(`bench ${f} ${suite}: ${b.note} -> ${a.note}`); continue; }
      if (!a) { console.log(`GONE  ${f} ${suite}`); bad++; continue; }
      const worse = a.pass < b.pass || a.fail > b.fail;
      if (worse) bad++;
      if (worse || a.pass !== b.pass || a.skip !== b.skip) console.log(`${worse ? 'WORSE' : 'diff '} ${f} ${suite}: pass ${b.pass}->${a.pass} fail ${b.fail}->${a.fail} skip ${b.skip}->${a.skip}`);
    }
  }
  console.log(bad ? `${bad} regression(s)` : 'no regressions');
  return bad === 0;
}

// Every flavour has results with the same suites (an interrupted run leaves fewer). Suites only in mt need
// threads and are allowed; "not-applicable" marks a flavour a recipe isn't built for; no suite may run nothing.
export function complete(name, recipeDir) {
  const problems = [], sets = {};
  for (const fl of FLAVORS) {
    const f = resultsFile(recipeDir, fl);
    if (!fs.existsSync(f)) { problems.push(`no ${fl} results`); continue; }
    const r = read(f);
    sets[fl] = Object.keys(r.suites);
    for (const [s, v] of Object.entries(r.suites)) if (v.pass + v.fail + v.skip === 0) problems.push(`${fl}: suite ${s} ran nothing`);
  }
  const all = [...new Set(Object.values(sets).flat())];
  const mtOnly = (x) => sets.mt?.includes(x) && FLAVORS.every((fl) => fl === 'mt' || !sets[fl]?.includes(x));
  for (const [fl, s] of Object.entries(sets)) {
    if (s.length === 1 && s[0] === 'not-applicable') continue;
    const missing = all.filter((x) => !s.includes(x) && x !== 'not-applicable' && !(fl !== 'mt' && mtOnly(x)));
    if (missing.length) problems.push(`${fl}: missing ${missing.join(', ')}`);
  }
  return { ok: problems.length === 0, problems, suites: all.length };
}

// passed/run per flavour and test environment: node, each browser, native baseline, interop (wasm vs native).
export function table(recipeDir) {
  const cols = ['node', 'chromium', 'firefox', 'webkit', 'native', 'interop'];
  const rows = [`| | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`];
  const bench = [];
  for (const fl of FLAVORS) {
    const f = resultsFile(recipeDir, fl);
    if (!fs.existsSync(f)) continue;
    const agg = Object.fromEntries(cols.map((c) => [c, [0, 0, 0]]));
    for (const [s, v] of Object.entries(read(f).suites)) {
      if (s.startsWith('bench')) { if (fl === 'mt' && v.note) bench.push(`${s}: ${v.note}`); continue; }
      if (s === 'not-applicable') continue;
      const m = s.match(/-(chromium|firefox|webkit|native)$/);
      const c = s.startsWith('interop') ? 'interop' : m ? m[1] : 'node';
      agg[c][0] += v.pass; agg[c][1] += v.pass + v.fail; agg[c][2] += v.skip;
    }
    const na = Object.values(agg).every((a) => a[1] === 0);
    rows.push(`| ${fl} | ${cols.map((c) => (na ? 'n/a' : agg[c][1] ? `${agg[c][0]}/${agg[c][1]}${agg[c][2] ? ` (+${agg[c][2]} skipped)` : ''}` : '–')).join(' | ')} |`);
  }
  return rows.join('\n') + (bench.length ? `\n\nBenchmarks (mt vs native): ${bench.join('; ')}` : '');
}
