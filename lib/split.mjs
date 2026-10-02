// `wasm-build-all split <recipe>`: make a standalone repo for one recipe (default <project>/../<owner-dir>/<name>-wasm64),
// and `wasm-build-all install-packages`: fetch the packages a recipe requires from their <dep>-wasm64 GitHub
// releases into the sysroot, so a split repo builds without the monorepo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HOME, FLAVORS, spec, sysroot } from './config.mjs';
import { table } from './results.mjs';

export const repoName = (name) => `${name}-wasm64`;

export function split(proj, name, dest) {
  const src = path.join(proj.recipes, name);
  const meta = JSON.parse(fs.readFileSync(path.join(src, 'recipe.json'), 'utf8'));
  dest = dest || path.join(path.dirname(proj.root), 'wasm64-libs', repoName(name));
  const fresh = !fs.existsSync(path.join(dest, '.git'));
  fs.mkdirSync(path.join(dest, 'recipes'), { recursive: true });
  fs.rmSync(path.join(dest, 'recipes', name), { recursive: true, force: true });
  fs.cpSync(src, path.join(dest, 'recipes', name), { recursive: true, filter: (p) => !/\/(build|src)(\/|$)/.test(path.relative(src, p) ? '/' + path.relative(src, p) : '') });
  const w = (f, s) => fs.writeFileSync(path.join(dest, f), s);
  w('wasm-build-all.json', JSON.stringify({ recipes: 'recipes', order: [name], packages: proj.packages || 'lucasgelfond' }, null, 2) + '\n');
  w('package.json', JSON.stringify({ name: repoName(name), private: true, devDependencies: { 'wasm-build-all': 'github:lucasgelfond/wasm-build-all' } }, null, 2) + '\n');
  w('.gitignore', '/node_modules/\n/sysroot/\n/dist/\n/.cache/\nrecipes/*/build/\nrecipes/*/src/\n');
  fs.mkdirSync(path.join(dest, '.github', 'workflows'), { recursive: true });
  fs.copyFileSync(path.join(HOME, 'templates', 'recipe-ci.yml'), path.join(dest, '.github', 'workflows', 'ci.yml'));
  const reqs = (meta.requires || []).map((r) => `[${repoName(r)}](https://github.com/${proj.packages || 'lucasgelfond'}/${repoName(r)})`).join(', ');
  w('README.md', `# ${repoName(name)}

${meta.name} ${meta.version} built to wasm64 with [wasm-build-all](https://github.com/lucasgelfond/wasm-build-all), in three flavours (\`mt\`, \`st\`, \`asyncify\`), and tested with its upstream test suite under Node and in Chromium, Firefox and WebKit, next to a native build.

${table(src)}

${reqs ? `Requires: ${reqs}.\n\n` : ''}Packages (static libraries, headers, CMake/pkg-config files) are attached to each release. Build it yourself: \`npm install && npx wasm-build-all setup --browsers && npx wasm-build-all install-packages --all && npx wasm-build-all all --all\`. Details of the build and tests: \`recipes/${name}/recipe.json\`.
`);
  const git = (...a) => execFileSync('git', ['-C', dest, ...a], { stdio: 'pipe' });
  if (fresh) git('init', '-q', '-b', 'main');
  git('add', '-A');
  let rev = '';
  try { rev = execFileSync('git', ['-C', proj.root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
  try { git('commit', '-q', '-m', `${fresh ? 'Import' : 'Update'} ${name} ${meta.version} recipe${rev ? ` (from ${path.basename(proj.root)} ${rev})` : ''}`); } catch {}
  return dest;
}

// Downloads the latest release package of each required recipe for every flavour into the sysroot.
export function installPackages(proj, meta) {
  const owner = proj.packages || 'lucasgelfond';
  for (const dep of meta.requires || []) {
    for (const fl of FLAVORS) {
      const sr = sysroot(proj, fl), marker = path.join(sr, 'share', 'wba', dep);
      if (fs.existsSync(marker)) continue;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wba-pkg-'));
      execFileSync('gh', ['release', 'download', '--repo', `${owner}/${repoName(dep)}`, '--pattern', `${dep}-*-wasm64-${fl}.tar.gz`, '--dir', tmp], { stdio: 'inherit' });
      const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tar.gz'));
      execFileSync('tar', ['-xzf', path.join(tmp, tgz), '-C', tmp]);
      const pkg = path.join(tmp, tgz.replace(/\.tar\.gz$/, ''));
      const info = Object.fromEntries(fs.readFileSync(path.join(pkg, 'WBA-PACKAGE'), 'utf8').trim().split('\n').map((l) => l.split('=')));
      if (info.emsdk !== spec.emsdk) throw new Error(`${dep} (${fl}) was built with emsdk ${info.emsdk}; this wasm-build-all pins ${spec.emsdk}`);
      fs.mkdirSync(sr, { recursive: true });
      execFileSync('bash', ['-c', `cd "${pkg}" && tar -cf - --exclude WBA-PACKAGE --exclude '*.json' . | (cd "${sr}" && tar -xf -)`]);
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, info.version + '\n');
      fs.rmSync(tmp, { recursive: true, force: true });
      console.log(`installed ${dep} ${info.version} (${fl})`);
    }
  }
}

// Creates the GitHub repo (public, no description), pushes, and attaches the local packages + results as a
// release so other recipes' install-packages can use them right away.
export function publish(proj, name, dir) {
  const owner = proj.packages || 'lucasgelfond', repo = `${owner}/${repoName(name)}`;
  const meta = JSON.parse(fs.readFileSync(path.join(proj.recipes, name, 'recipe.json'), 'utf8'));
  const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
  let exists = true;
  try { execFileSync('gh', ['repo', 'view', repo], { stdio: 'ignore' }); } catch { exists = false; }
  if (!exists) run('gh', ['repo', 'create', repo, '--public', '--source', dir, '--push']);
  else run('git', ['-C', dir, 'push', '-q', `https://github.com/${repo}.git`, 'main']);
  const pkgs = FLAVORS.map((fl) => path.join(proj.dist, `${name}-${meta.version}-wasm64-${fl}.tar.gz`)).filter((f) => fs.existsSync(f));
  if (pkgs.length !== FLAVORS.length) throw new Error(`missing packages in ${proj.dist}: run wasm-build-all package ${name}`);
  const results = FLAVORS.map((fl) => path.join(proj.recipes, name, 'results', `wasm64-${fl}.json`));
  let n = 1;
  const tags = (() => { try { return execFileSync('gh', ['release', 'list', '--repo', repo, '--json', 'tagName', '--jq', '.[].tagName'], { encoding: 'utf8' }); } catch { return ''; } })();
  while (tags.split('\n').includes(`v${meta.version}-${n}`)) n++;
  const tag = `v${meta.version}-${n}`;
  run('gh', ['release', 'create', tag, '--repo', repo, '--title', `${name} ${meta.version} (${tag})`, '--notes', `emsdk ${spec.emsdk}; flavours ${FLAVORS.join(', ')}.`, ...pkgs, ...results]);
  console.log(`published https://github.com/${repo} (${tag})`);
}
