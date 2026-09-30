// Records one suite's counts into a recipe's results/wasm64-<flavour>.json (committed next to the recipe).
import fs from 'node:fs';
const [file, dep, version, suite, pass, fail, skip, note] = process.argv.slice(2);
let data = { dep, version, suites: {} };
try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
data.dep = dep; data.version = version;
data.suites[suite] = { pass: +pass, fail: +fail, skip: +skip, ...(note ? { note } : {}), date: new Date().toISOString().slice(0, 10) };
fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
