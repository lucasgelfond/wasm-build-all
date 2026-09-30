# wasm-build-all

I am working on a project to get Blender running on the web, and am first compiling all of its dependencies.
Many of these could be reusable on their own. Every library is built to be maximally compatible, in three
wasm64 flavours:

| flavour | for | threads | async JS | exceptions |
|---|---|---|---|---|
| `mt` | the primary build | pthreads, `main()` on a worker | JSPI | wasm-native |
| `st` | pages without cross-origin isolation | none | JSPI | wasm-native |
| `asyncify` | older browsers without JSPI | none | ASYNCIFY | JS-based |

wasm-build-all makes each build, then runs the library's full upstream test suite against the new binaries in
each flavour: under Node, and in Chromium, Firefox and WebKit, next to a native build of the same version.

```sh
npm install -g wasm-build-all        # or clone and use ./cli.mjs
wasm-build-all setup --browsers      # pinned emsdk + Playwright browsers, shared in ~/.cache/wasm-build-all
cd my-project                        # has wasm-build-all.json: { "recipes": "recipes", "order": ["zlib", ...] }
wasm-build-all init zlib             # recipes/zlib/{recipe.json, build.sh}
wasm-build-all all zlib              # build + test in every flavour
wasm-build-all check zlib            # metadata, hooks, complete results
wasm-build-all package zlib          # dist/zlib-<version>-wasm64-<flavour>.tar.gz (relocatable)
eval "$(wasm-build-all env mt)"      # CC/CXX/CMake toolchain/meson cross file for your own builds
```

- `flavors.json` is the single definition of every flavour's compile, link and test flags.
- `lib/helpers.sh` documents what a recipe's `build()`/`test()` hooks can call.
- `npm test` runs this package's own suite (ABI guards, stdio, smoke tests in every flavour × Node/Chromium/Firefox/WebKit, and an end-to-end CLI run).

Libraries built with it: [webgpu-blender](https://github.com/lucasgelfond/webgpu-blender) `deps/`.
