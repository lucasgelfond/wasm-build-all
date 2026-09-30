# Shared by the test scripts: HOME_DIR, a work dir, pass/fail counting, and flavour environments.
HOME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$HOME_DIR/cli.mjs"
FLAVORS="$(node -e 'console.log(Object.keys(require(process.argv[1]).flavors).join(" "))' "$HOME_DIR/flavors.json")"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
fails=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fails=$((fails+1)); }
use_flavor() { eval "$(cd "$work" && "$CLI" env "$1")"; }   # in $work: its own sysroot, not a project's
finish() { [ $fails = 0 ] && echo "$1: ok" || { echo "$1: $fails failure(s)"; exit 1; }; }
