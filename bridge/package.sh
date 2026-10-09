#!/usr/bin/env bash
# Build the bridge Lambda artifact: a deterministic zip of lambda/ with its
# production dependencies (ssh2 must ship in the zip).
#
# Usage:
#   bridge/package.sh            # writes bridge/build/bridge-<sha256>.zip, prints its path
#
# Dependencies are installed from package-lock.json into a clean staging
# copy with `npm ci --omit=dev --omit=optional --ignore-scripts`: no native
# builds (ssh2's optional sshcrypto binding and cpu-features would be built
# for THIS machine, not the arm64 Lambda, and ssh2 falls back to pure JS
# without them), so the tree depends only on the lockfile. The zip has
# sorted entries, fixed 1980-01-01 timestamps and fixed modes, so the same
# source + lockfile yields the same bytes and digest.
#
# The `pocketshell-web` stack (template + deploy script) lives in aws-infra,
# sandbox/pocketshell-web/. Deploy with:
#   BRIDGE_SRC=<this repo> <aws-infra>/sandbox/pocketshell-web/deploy.sh
# which runs this script, uploads the zip to
# pocketshell-web/bridge-<sha256>.zip and passes it as BridgeCodeKey.
# Only the zip path goes to stdout; diagnostics go to stderr.
set -euo pipefail
BRIDGE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${OUT_DIR:-$BRIDGE/build}"
mkdir -p "$OUT_DIR"
STAGE="$(mktemp -d)"
trap 'rm -rf -- "$STAGE"' EXIT
cp "$BRIDGE/lambda/index.mjs" "$BRIDGE/lambda/package.json" "$BRIDGE/lambda/package-lock.json" "$STAGE/"
(cd "$STAGE" && npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund >&2)
python3 - "$STAGE" "$OUT_DIR" <<'PY'
import hashlib, io, os, stat, sys, zipfile
src, out_dir = sys.argv[1], sys.argv[2]
files = []
for dirpath, dirnames, filenames in os.walk(src):
    dirnames.sort()
    for name in sorted(filenames):
        full = os.path.join(dirpath, name)
        if os.path.islink(full) or not os.path.isfile(full):
            continue
        rel = os.path.relpath(full, src).replace(os.sep, "/")
        if rel == "node_modules/.package-lock.json":
            continue  # npm bookkeeping, not code
        files.append((rel, full))
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
    for arc, full in sorted(files):
        info = zipfile.ZipInfo(arc, date_time=(1980, 1, 1, 0, 0, 0))
        mode = 0o755 if os.stat(full).st_mode & stat.S_IXUSR else 0o644
        info.external_attr = (0o100000 | mode) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        with open(full, "rb") as fh:
            zf.writestr(info, fh.read(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
data = buf.getvalue()
digest = hashlib.sha256(data).hexdigest()
path = os.path.join(out_dir, f"bridge-{digest}.zip")
with open(path, "wb") as fh:
    fh.write(data)
print(f"{len(files)} files, sha256 {digest}", file=sys.stderr)
print(path)
PY
