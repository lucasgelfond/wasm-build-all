#!/usr/bin/env bash
# wasm-build-all's own test suite (npm test). Needs `wasm-build-all setup --browsers` first.
set -euo pipefail
cd "$(dirname "$0")"
./lib.sh
./abi.sh
./stdio.sh
./smoke.sh
./fixture.sh
