#!/usr/bin/env bash
# Combined shipping-contract proof: the REAL production Vite browser bundle
# (normal UI/config paths — connection.ts / webApi / pin store, no transport
# adapters, no fallbacks) against the REAL Go gateway built from the ROOT
# ACCEPTED pocketshell-gateway revision (registry-enabled: production
# routingauth JWT verification through the local broker fixture's JWKS), the
# REAL pocketshell-link home agent bridging its LOOPBACK sshd, and a
# multi-key OpenSSH fixture fleet (six host-key modes matching the browser
# host-key algorithm contract: ssh-ed25519 > rsa-sha2-512 > rsa-sha2-256 >
# ssh-rsa).
#
# ACCEPTED-REVISION PROTOCOL (fail-closed, enforced HERE — not merely
# logged): the run starts by reading the ROOT ACCEPTANCE MARKER
# (go-opus-followup-root-accepted.txt). Its FIRST LINE must be EXACTLY one
# 40-char lowercase hex SHA — a line that merely CONTAINS a SHA, carries
# 41+ hex chars, two SHAs or surrounding text REFUSES (the parser control:
# GATEWAY_E2E_MARKER_CONTROL=1). Missing marker => the composed run is
# PENDING (exit 3, no old-runtime substitution, no hybrid). The gateway
# repo's HEAD must EQUAL the marker SHA. The binaries are built from a
# FRESH DETACHED CHECKOUT of exactly that committed revision (never from a
# mutable working tree), and BOTH binaries must carry the EMBEDDED VCS
# stamps of that revision (vcs.revision == marker SHA, vcs.modified ==
# false, vcs.time == the commit's time) — `go build -buildvcs=true` refuses
# to build unstamped. The pinned core checkout must be exactly the accepted
# published revision, clean, and be the checkout the production web build
# ACTUALLY resolves (node_modules/@pocketshell/core), and the web worktree
# must be clean.
#
# BOUNDED OPERATION: the whole run carries an absolute WORK deadline
# (GATEWAY_E2E_WORK_BUDGET_SECS, default 3600s) enforced by phase gates and
# by EVERY owned command (Go builds, docker build/run/inspect/exec/remove/
# logs, ssh, curl, git worktree ops, npm builds, the composed Python proof)
# running under run_bounded: its own process GROUP (setsid), stopped
# TERM->KILL at the deadline, with the group's emptiness verified — a
# foreign pid or group is never a target. Cleanup carries its OWN separate
# absolute reserve (GATEWAY_E2E_CLEANUP_BUDGET_SECS, default 300s), so a
# timed-out run still cleans up within a bounded window. The Python harness
# enforces the same deadline gracefully (exported as GW_E2E_DEADLINE_SECS,
# 90s ahead of the hard bound): phase gates, an asyncio umbrella over the
# whole flow, bounded context closes, and timeouts on every blocking docker
# call. The offline control GATEWAY_E2E_BUDGET_CONTROL=1 exercises the
# actual helpers with real processes and signals.
#
# What runs, concretely:
#   1. the broker fixture (tests/e2e/gateway_fixture_broker.py): a LOCAL
#      stand-in for the separately-trusted sync service's auth broker. Its
#      authorizer is an exact-match LOCAL fixture sign-in — NOT Google, NOT
#      the live Cloud authorizer; the tokens it mints are verified by the
#      gateway's PRODUCTION routingauth verifier (RS256, exact issuer,
#      aud/scope/exp claims, JWKS).
#   2. gateway instance A from the ACCEPTED source WITH -registry (identity
#      + tunnel enabled, zero dev-auth flags — the shipping auth posture,
#      plain-HTTP listener for the lab only) and instance B serving the
#      legacy browser-direct relay under its DOCUMENTED dev posture
#      (-dev-allow-any-token -dev-allow-private-hosts, no registry — the
#      legacy direct transport cannot verify a fixture sign-in without a
#      live Google JWKS, so the direct leg's authorization is explicitly a
#      dev posture, not a production claim).
#   3. pocketshell-link enroll (broker token on stdin, --expect-host-key
#      pinned out of band) + run per dial-able host-key mode; the ECDSA-only
#      mode's enrollment must REFUSE honestly — asserted against the run's
#      OWN fixtures: zero broker requests on record, no registry device
#      record, no agent state.
#   4. the production browser bundle served by vite preview, driven by
#      Playwright with READ-ONLY WebSocket observation (page.on('websocket')
#      frame events — no route interception on any transport) through
#      tests/e2e/e2e_gateway_prod.py.
#
# Everything is run-scoped: uniquely named containers, freshly allocated
# ports (reservation sockets are closed before the listeners start — this is
# ALLOCATION INTENT, never held ownership; a lost race fails the bind health
# check and nothing ever kills another actor's process — cleanup touches
# only this run's exact PIDs), a run-scoped registry state file under
# /var/lib/pocketshell-relay/ (the production default base dir), an
# ephemeral broker signing key, ephemeral SSH keys. Peer containers, ports
# and daemons are never touched. CLEANUP IS VERIFIED AND HONEST: each owned
# process is killed by its exact PID (including the restarted gateway A via
# its pid file) and awaited to absence, containers are confirmed removed,
# the registry file and the build worktree are confirmed gone, and every
# cleanup failure is reported — a run whose own objects survive cannot exit
# 0.
#
# Usage: tests/e2e/run-gateway-e2e.sh
#        GATEWAY_E2E_PREFLIGHT_ONLY=1 ... (validate marker/revision/builds,
#        then stop before any fixture starts — a plumbing rehearsal, NOT a
#        run and not an acceptance)
# Requires: docker, go (for the gateway build), /usr/bin/python3 with
# playwright + cryptography + websockets, ELECTRON_REPO pointing at the
# desktop checkout that owns tests-docker/ (default: $HOME/git/pocketshell-desktop).
set -euo pipefail
cd "$(dirname "$0")/../.."

DESKTOP_REPO="${ELECTRON_REPO:-$HOME/git/pocketshell-desktop}"
GATEWAY_REPO="${GATEWAY_REPO:-$HOME/git/pocketshell-gateway}"
CORE_DIR="${CORE_DIR:-$HOME/git/gateway-browser-integrated-workspace/pocketshell-core}"
CORE_PIN='4096fc569e207cb2b245e84b3a1a8acf2c30894b'
MARKER_FILE="${GATEWAY_ACCEPT_MARKER:-/home/alexey/tmp/pocketshell-gateway/go-opus-followup-root-accepted.txt}"

# Budgets: the WHOLE operation carries an absolute work deadline, and cleanup
# carries its OWN separate absolute reserve — a timed-out run still cleans up
# within a bounded window (an exhausted work budget can never hide inside an
# unbounded cleanup, and cleanup never depends on the work deadline).
WORK_BUDGET_SECS="${GATEWAY_E2E_WORK_BUDGET_SECS:-3600}"
CLEANUP_BUDGET_SECS="${GATEWAY_E2E_CLEANUP_BUDGET_SECS:-300}"
for _b in "$WORK_BUDGET_SECS" "$CLEANUP_BUDGET_SECS"; do
  [[ "$_b" =~ ^[1-9][0-9]*$ ]] || { echo "REFUSING: budgets must be positive integers (got '$_b')" >&2; exit 1; }
done
command -v setsid > /dev/null || { echo "REFUSING: setsid is required for owned process-group containment" >&2; exit 1; }
WORK_DEADLINE=$(( $(printf '%(%s)T' -1) + WORK_BUDGET_SECS ))

parse_marker_sha() { # <file> — the FIRST LINE must be EXACTLY one 40-char
  # lowercase hex SHA (the canonical marker line). A line that merely
  # CONTAINS a SHA, carries 41+ hex chars, carries TWO SHAs, uppercase hex
  # or any surrounding text is REFUSED — ambiguity in the acceptance marker
  # is a refusal, never a parse. Refusal diagnostics describe the SHAPE only
  # (line length, exact-40-hex substring count): the marker line itself is
  # never echoed — it may carry credential-shaped text.
  local line len subs
  line="$(head -n 1 "$1")"
  len="${#line}"
  subs="$(printf '%s\n' "$line" | grep -oE '[0-9a-f]{40}' | wc -l || true)"
  if [[ "$len" -eq 40 && "$line" =~ ^[0-9a-f]{40}$ ]]; then
    printf '%s\n' "$line"
    return 0
  fi
  echo "REFUSING: the root acceptance marker's FIRST LINE is not exactly one 40-char lowercase hex SHA (line length: $len; exact 40-hex substrings inside: $subs) — longer, ambiguous or non-hex first lines refuse" >&2
  return 1
}

# Offline control: drive the ACTUAL parser above against the honest canonical
# line and the poisoned variants (41-hex, two SHAs, surrounding text,
# uppercase, whitespace, garbage, credential-shaped), and assert the refusal
# diagnostics never echo marker content. No marker file, repo, network or
# Docker is touched. NOT a run and not an acceptance.
if [[ "${GATEWAY_E2E_MARKER_CONTROL:-0}" == "1" ]]; then
  marker_control() {
    local dir rc=0 sha out
    dir="$(mktemp -d /tmp/psgw-marker-control.XXXXXX)"
    local good="a31e733027424fe77b217f0d5c551956be12d60f"
    accept() { # <exact 40-hex line>
      printf '%s\n' "$1" > "$dir/marker"
      if sha="$(parse_marker_sha "$dir/marker")" && [[ "$sha" == "$1" ]]; then
        echo "  accepted (exact full line): OK"
      else
        echo "  FAIL: the honest canonical first line was refused (got: ${sha:-<none>})"; rc=1
      fi
    }
    refuse() { # <line> <what>
      printf '%s\n' "$1" > "$dir/marker"
      if out="$(parse_marker_sha "$dir/marker" 2>&1)"; then
        echo "  FAIL: $1 was ACCEPTED — a full-line contract must refuse it"; rc=1
        return 0
      fi
      if [[ -n "$1" && "${#1}" -ge 8 && "$out" == *"$1"* ]]; then
        echo "  FAIL: the refusal diagnostics ECHOED the marker line ($2)"; rc=1
        return 0
      fi
      echo "  refused: $2 (shape-only diagnostics)"
    }
    echo "marker-parser control (the ACTUAL parse_marker_sha):"
    accept "$good"
    refuse "${good}0" "a 41-hex first line"
    refuse "$good $good" "a first line carrying TWO 40-hex SHAs (ambiguous)"
    refuse "approved release token $good countersigned" "a SHA surrounded by arbitrary text"
    refuse "A31E733027424FE77B217F0D5C551956BE12D60F" "an UPPERCASE hex line (canonical is lowercase)"
    refuse " $good" "leading whitespace"
    refuse "$good " "trailing whitespace"
    refuse "$(printf '%039d' 0)" "a 39-hex first line"
    refuse "zz-garbage-zz" "garbage with no SHA"
    refuse "" "an EMPTY first line"
    refuse "Bearer xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" "a credential-shaped line"
    rm -rf "$dir"
    if [[ $rc -eq 0 ]]; then echo "MARKER CONTROL PASS"; else echo "MARKER CONTROL FAIL"; fi
    return "$rc"
  }
  marker_control
  exit $?
fi

kill_and_wait() { # pid name — EXACT owned process, awaited to absence
  local pid="$1" name="$2" i
  [[ -n "$pid" ]] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for i in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || return 0
      sleep 0.25
    done
    kill -9 "$pid" 2>/dev/null || true
    sleep 0.5
    kill -0 "$pid" 2>/dev/null && CLEANUP_FAILURES+=("$name pid $pid still alive after SIGKILL")
  fi
}

now_epoch() { printf '%(%s)T' -1; }

seconds_left() { # <deadline-epoch> — seconds remaining (negative once past)
  local now
  now="$(now_epoch)"
  echo $(( $1 - now ))
}

assert_work_time_left() { # <what> — a PHASE GATE: refuse to START major work
  # past the work deadline; the run fails closed (nonzero) and cleanup
  # proceeds on its own separate reserve.
  local left
  left="$(seconds_left "$WORK_DEADLINE")"
  if (( left <= 60 )); then
    echo "WORK DEADLINE EXHAUSTED (${left}s left of ${WORK_BUDGET_SECS}s): refusing to start $1 — stopping with the bounded cleanup reserve intact" >&2
    exit 124
  fi
}

run_bounded() { # <deadline-epoch> <label> <cmd...> — run an OWNED command
  # bounded by an ABSOLUTE deadline. The command gets its own session
  # (setsid: pgid == pid), so expiry signals exactly THIS run's process
  # group — never a foreign pid, never a foreign group — first TERM, then
  # KILL after a bounded grace, and the emptiness of the group is verified
  # afterwards: an operation that was "stopped" but left descendants alive
  # is a FAILURE, not success. 124 names the timeout; the caller's normal
  # status handling (set -e, if/||) stays intact.
  local deadline="$1" label="$2"; shift 2
  local now left pid i status
  now="$(now_epoch)"
  left=$(( deadline - now ))
  if (( left <= 0 )); then
    echo "TIMEOUT: $label not started — its deadline has already passed" >&2
    return 124
  fi
  setsid "$@" &
  pid=$!
  status=0
  while kill -0 "$pid" 2>/dev/null; do
    now="$(now_epoch)"
    if (( now >= deadline )); then
      echo "TIMEOUT: $label exceeded its deadline — stopping owned process group $pid (TERM, then KILL)" >&2
      kill -TERM -"$pid" 2>/dev/null || true
      for i in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.25
      done
      kill -KILL -"$pid" 2>/dev/null || true
      sleep 0.5
      wait "$pid" 2>/dev/null || true
      if kill -0 -"$pid" 2>/dev/null; then
        echo "CONTAINMENT INCOMPLETE: owned process group $pid still has members after KILL ($label)" >&2
      fi
      return 124
    fi
    sleep 0.5
  done
  wait "$pid" || status=$?
  # Containment on the SUCCESS path too: a leader that exited while leaving
  # owned descendants behind does not outlive the run's business silently.
  sleep 0.2
  if kill -0 -"$pid" 2>/dev/null; then
    echo "CONTAINMENT: owned process group $pid outlived $label — KILLing the owned group" >&2
    kill -KILL -"$pid" 2>/dev/null || true
    sleep 0.3
    if kill -0 -"$pid" 2>/dev/null; then
      echo "CONTAINMENT INCOMPLETE: group $pid members survived KILL ($label)" >&2
      return 125
    fi
  fi
  return "$status"
}

# Offline control: drive the ACTUAL bounded-execution helpers with real
# processes and real signals — an honest command's exit code is preserved; an
# expired deadline refuses to start work; a hung command is stopped at its
# deadline and reaped; a TERM-ignoring command is KILLed; stray descendants
# are contained in the owned process group; and the cleanup reserve stays
# usable after the work deadline has passed. NOT a run and not an acceptance.
if [[ "${GATEWAY_E2E_BUDGET_CONTROL:-0}" == "1" ]]; then
  budget_control() {
    local dir rc=0 t0 t1 pid
    dir="$(mktemp -d /tmp/psgw-budget-control.XXXXXX)"
    echo "bounded-execution control (the ACTUAL run_bounded/kill_and_wait/assert_work_time_left):"

    if run_bounded "$(( $(now_epoch) + 30 ))" "control-true" true; then
      echo "  honest fast command: exit code preserved"
    else
      echo "  FAIL: an honest fast command did not exit 0"; rc=1
    fi

    rm -f "$dir/should-not-exist"
    if run_bounded "$(( $(now_epoch) - 1 ))" "control-past" touch "$dir/should-not-exist"; then
      echo "  FAIL: a command was started PAST its deadline"; rc=1
    elif [[ -e "$dir/should-not-exist" ]]; then
      echo "  FAIL: the refused command ran anyway"; rc=1
    else
      echo "  expired deadline: the command was refused before starting (nothing executed)"
    fi

    t0="$(now_epoch)"
    run_bounded "$(( $(now_epoch) + 2 ))" "control-hang" \
      bash -c "echo \$\$ > '$dir/leader'; sleep 60" || true
    t1="$(now_epoch)"
    if kill -0 "$(cat "$dir/leader")" 2>/dev/null; then
      echo "  FAIL: the hung leader SURVIVED its deadline"; rc=1
    elif (( t1 - t0 >= 40 )); then
      echo "  FAIL: stopping the hung leader took $((t1 - t0))s — far past the deadline"; rc=1
    else
      echo "  hung leader: stopped at the deadline (wall $((t1 - t0))s) and reaped"
    fi

    t0="$(now_epoch)"
    run_bounded "$(( $(now_epoch) + 2 ))" "control-term-ignore" \
      bash -c "trap '' TERM; echo \$\$ > '$dir/leader2'; sleep 60" || true
    t1="$(now_epoch)"
    if kill -0 "$(cat "$dir/leader2")" 2>/dev/null; then
      echo "  FAIL: a TERM-ignoring leader survived the KILL escalation"; rc=1
    else
      echo "  TERM-ignoring leader: KILL escalation stopped it (wall $((t1 - t0))s)"
    fi

    run_bounded "$(( $(now_epoch) + 2 ))" "control-descendant" \
      bash -c "echo \$\$ > '$dir/leader3'; sleep 60 & echo \$! > '$dir/child3'; wait" || true
    if kill -0 "$(cat "$dir/child3")" 2>/dev/null; then
      echo "  FAIL: a stray DESCENDANT survived the owned group's stop"; rc=1
    else
      echo "  descendant containment: the stray sleep died with the owned process group"
    fi

    if run_bounded "$(( $(now_epoch) - 1000 ))" "control-expired" true; then
      echo "  FAIL: an expired deadline accepted work"; rc=1
    fi
    if run_bounded "$(( $(now_epoch) + 30 ))" "control-reserve" true; then
      echo "  separation: a freshly computed cleanup reserve runs even with the work deadline long past"
    else
      echo "  FAIL: the cleanup reserve was not independently usable"; rc=1
    fi

    sleep 60 & pid=$!
    kill_and_wait "$pid" "control-kill"
    if kill -0 "$pid" 2>/dev/null; then
      echo "  FAIL: kill_and_wait left its owned pid alive"; rc=1
    else
      echo "  kill_and_wait: the owned pid was stopped and awaited"
    fi

    rm -rf "$dir"
    if [[ $rc -eq 0 ]]; then echo "BUDGET CONTROL PASS"; else echo "BUDGET CONTROL FAIL"; fi
    return "$rc"
  }
  budget_control
  exit $?
fi

WORK="$(mktemp -d /tmp/ps-gw-e2e.XXXXXX)"
echo "e2e workdir: $WORK"
RUNID="psgwe2e-$$"
FAIL_MARKER="$WORK/FAILED"
CLEANUP_FAILURES=()
GW_WORKTREE=""
GWA_PIDFILE="$WORK/gateway-a.pid"

# --- 0. the root-accepted gateway revision (FIRST among the acceptance
#        checks — everything below is unreachable without it; no old runtime,
#        no hybrid substitution) --------------------------------------------
if [[ ! -r "$MARKER_FILE" ]]; then
  echo "PENDING: root acceptance marker $MARKER_FILE does not exist — the composed browser+Go run stays pending; refusing to substitute any other gateway revision" >&2
  exit 3
fi
MARKER_SHA="$(parse_marker_sha "$MARKER_FILE")" || exit 1
git -C "$GATEWAY_REPO" cat-file -e "$MARKER_SHA^{commit}" 2>/dev/null || {
  echo "REFUSING: marker SHA $MARKER_SHA is not a commit of $GATEWAY_REPO" >&2
  exit 1
}
GW_COMMIT="$(git -C "$GATEWAY_REPO" rev-parse HEAD)"
[[ "$GW_COMMIT" == "$MARKER_SHA" ]] || {
  echo "REFUSING: gateway repo HEAD $GW_COMMIT != root-accepted marker SHA $MARKER_SHA — check out the accepted revision first (root may point GATEWAY_REPO at a clean detached checkout of the accepted revision)" >&2
  exit 1
}

WEB_COMMIT="$(git rev-parse HEAD)"
# The shipping bundle is built from the COMMITTED tree: no tracked dirt, and
# no untracked build inputs — the one tolerated untracked path is the python
# bytecode cache the fixture harness itself generates under tests/e2e/.
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || {
  echo "REFUSING: the web worktree has uncommitted tracked changes — the shipping bundle must be built from the committed accepted tree" >&2
  exit 1
}
WEB_UNTRACKED="$(git ls-files --others --exclude-standard | grep -v '^tests/e2e/__pycache__/' || true)"
[[ -z "$WEB_UNTRACKED" ]] || {
  echo "REFUSING: untracked build inputs are present in the web tree:" >&2
  echo "$WEB_UNTRACKED" | head -10 >&2
  exit 1
}

# The pinned core dependency: exact accepted revision, clean, and the
# checkout the production web build ACTUALLY resolves.
CORE_COMMIT="$(git -C "$CORE_DIR" rev-parse HEAD)"
[[ "$CORE_COMMIT" == "$CORE_PIN" ]] || {
  echo "REFUSING: core checkout $CORE_DIR is at $CORE_COMMIT, the accepted published pin is $CORE_PIN" >&2
  exit 1
}
[[ -z "$(git -C "$CORE_DIR" status --porcelain)" ]] || {
  echo "REFUSING: core checkout $CORE_DIR is dirty" >&2
  exit 1
}
RESOLVED_CORE="$(/usr/bin/python3 -c "import os; print(os.path.realpath('node_modules/@pocketshell/core'))")"
[[ "$RESOLVED_CORE" == "$(readlink -f "$CORE_DIR")" ]] || {
  echo "REFUSING: the web build resolves @pocketshell/core from $RESOLVED_CORE, not the pinned checkout $CORE_DIR" >&2
  exit 1
}

cleanup() {
  local code=$?
  # The SEPARATE cleanup reserve: computed HERE, never from the work
  # deadline — a run that timed out still owns a full bounded cleanup window.
  local CLEANUP_DEADLINE
  CLEANUP_DEADLINE=$(( $(now_epoch) + CLEANUP_BUDGET_SECS ))
  if [[ $code -ne 0 ]]; then echo "FAILED" > "$FAIL_MARKER"; fi
  # The advisory-tamper leg may have restarted gateway A — its EXACT new PID
  # is in this run's pid file (never a command-line regex sweep).
  if [[ -n "${GWA_PIDFILE:-}" && -f "$GWA_PIDFILE" ]]; then
    kill_and_wait "$(cat "$GWA_PIDFILE" 2>/dev/null || true)" "restarted gateway A"
  fi
  kill_and_wait "${PREVIEW_PID:-}" "vite preview"
  kill_and_wait "${BROKER_PID:-}" "broker fixture"
  kill_and_wait "${GWA_PID:-}" "gateway A"
  kill_and_wait "${GWB_PID:-}" "gateway B"
  local agentpid
  for agentpid in ${AGENT_PIDS[@]+"${AGENT_PIDS[@]}"}; do kill_and_wait "$agentpid" "home agent"; done
  # Preserve the sshd fleet's view (accepted/failed userauth lines) BEFORE
  # the containers go away — userauth failures are diagnosed from these.
  # (The @+ idiom: an EMPTY owned set must iterate ZERO names, never one
  # empty name — a bogus failure entry would be its own kind of lie.)
  # Every docker call is bounded by the CLEANUP deadline and every status is
  # checked — a timed-out cleanup step is a FAILURE entry, never silence.
  local cname
  for cname in ${CONTAINERS[@]+"${CONTAINERS[@]}"}; do
    # (docker's merged output goes to the file via the inner 2>&1; the outer
    # redirect moves only stdout, so run_bounded's own diagnostics stay on
    # the runner's stderr)
    run_bounded "$CLEANUP_DEADLINE" "save sshd logs of $cname" \
      bash -c 'docker logs "$0" 2>&1' "$cname" > "${WORK:-/tmp}/sshd-${cname}.log" \
      || CLEANUP_FAILURES+=("could not save sshd logs of $cname")
  done
  for cname in ${CONTAINERS[@]+"${CONTAINERS[@]}"}; do
    run_bounded "$CLEANUP_DEADLINE" "remove container $cname" \
      docker rm -f "$cname" > /dev/null 2>&1 \
      || CLEANUP_FAILURES+=("could not remove container $cname")
  done
  for cname in ${CONTAINERS[@]+"${CONTAINERS[@]}"}; do
    # Independent absence proof: a REMOVED container must fail inspect — an
    # unreadable/bounded-out check is a failure entry, never absence.
    if run_bounded "$CLEANUP_DEADLINE" "verify container $cname absent" \
        docker inspect "$cname" > /dev/null 2>&1; then
      CLEANUP_FAILURES+=("container $cname still present after removal")
    fi
  done
  if [[ -n "${REGISTRY_FILE:-}" ]]; then
    rm -f "$REGISTRY_FILE" 2>/dev/null || true
    [[ -e "$REGISTRY_FILE" ]] && CLEANUP_FAILURES+=("registry file $REGISTRY_FILE still present")
  fi
  if [[ -n "$GW_WORKTREE" ]]; then
    run_bounded "$CLEANUP_DEADLINE" "remove gateway build worktree" \
      git -C "$GATEWAY_REPO" worktree remove --force "$GW_WORKTREE" > /dev/null 2>&1 \
      || CLEANUP_FAILURES+=("could not remove gateway build worktree $GW_WORKTREE")
    # Deregistration is verified from an INVENTORY READ that must itself be
    # readable — an unreadable inventory is a FAILURE entry, never absence —
    # and the directory's disappearance from the filesystem is verified TOO
    # (errors never mean absent).
    local inv="${WORK:-/tmp}/worktree-inventory.txt"
    if run_bounded "$CLEANUP_DEADLINE" "read worktree inventory" \
        git -C "$GATEWAY_REPO" worktree list --porcelain > "$inv" 2>/dev/null; then
      if grep -Fxq "worktree $GW_WORKTREE" "$inv"; then
        CLEANUP_FAILURES+=("gateway build worktree $GW_WORKTREE still registered")
      fi
    else
      CLEANUP_FAILURES+=("worktree inventory unreadable — deregistration of $GW_WORKTREE UNVERIFIED")
    fi
    [[ -e "$GW_WORKTREE" ]] && CLEANUP_FAILURES+=("gateway build worktree directory $GW_WORKTREE still on disk")
  fi
  if [[ ${#CLEANUP_FAILURES[@]} -gt 0 ]]; then
    local f
    echo "CLEANUP FAILURES (${#CLEANUP_FAILURES[@]}) — the run's own objects did not all go away:" >&2
    for f in "${CLEANUP_FAILURES[@]}"; do echo "  - $f" >&2; done
    [[ $code -eq 0 ]] && code=1
  fi
  exit "$code"
}
trap cleanup EXIT
# TERM/INT route through `exit` so the EXIT cleanup (and its aggregation)
# runs on signals too — with the bounded cleanup reserve, never unbounded.
trap 'exit 143' TERM
trap 'exit 130' INT

free_ports() {
  /usr/bin/python3 - "$1" << 'PY'
import socket, sys
need = int(sys.argv[1]); ports = []; socks = []
for _ in range(need):
    s = socket.socket(); s.bind(('127.0.0.1', 0)); ports.append(s.getsockname()[1]); socks.append(s)
for s in socks: s.close()
print(' '.join(map(str, ports)))
PY
}
read -r BROKER_PORT BROKER_HTTPS_PORT GW_PORT GWB_PORT BASE_PORT SSH_MULTI SSH_REVERSE SSH_RSAONLY SSH_SSHRSA SSH_ECDSAONLY SSH_EDRSA \
  < <(free_ports 11)
CONTAINERS=()
AGENT_PIDS=()

# --- receipts: exactly what is under test -----------------------------------
GW_SUBJECT="$(git -C "$GATEWAY_REPO" log -1 --format=%s "$MARKER_SHA" | head -c 80)"
{
  echo "run: $RUNID"
  echo "web commit: $WEB_COMMIT (branch gateway-browser-integrated; includes crypto eb9a6c8 series; worktree clean)"
  echo "core pin commit: $CORE_COMMIT at $CORE_DIR (clean; web build resolves node_modules/@pocketshell/core -> $RESOLVED_CORE)"
  echo "gateway ACCEPTED revision: $MARKER_SHA (root marker: $MARKER_FILE, first line EXACTLY one 40-hex SHA; == HEAD at start: yes)"
  echo "gateway accepted revision subject: $GW_SUBJECT"
  echo "ports: broker-http=$BROKER_PORT broker-https=$BROKER_HTTPS_PORT gateway=$GW_PORT legacy=$GWB_PORT preview=$BASE_PORT sshd=$SSH_MULTI,$SSH_REVERSE,$SSH_RSAONLY,$SSH_SSHRSA,$SSH_ECDSAONLY,$SSH_EDRSA"
  echo "budgets: work=${WORK_BUDGET_SECS}s (deadline epoch $WORK_DEADLINE); cleanup reserve=${CLEANUP_BUDGET_SECS}s (computed at cleanup entry)"
  echo "harness self-hash (sha256 at run start):"
  sha256sum tests/e2e/e2e_gateway_prod.py tests/e2e/gateway_fixture_broker.py tests/e2e/run-gateway-e2e.sh
} > "$WORK/receipt.env"
run_bounded "$WORK_DEADLINE" "go version" /usr/local/go/bin/go version > "$WORK/go-version.txt" 2>&1

# --- 1. the Go gateway archive + home agent from the ACCEPTED revision ------
# A fresh DETACHED checkout of exactly the marker's committed bytes — never
# the mutable worktree. `go build -buildvcs=true` fails the build if the
# embedded VCS stamps cannot be produced; the validation below pins them.
assert_work_time_left "materializing the accepted gateway revision"
mkdir -p "$WORK/bin"
GW_WORKTREE="$WORK/gateway-src"
run_bounded "$WORK_DEADLINE" "materialize accepted revision" \
  git -C "$GATEWAY_REPO" worktree add --detach "$GW_WORKTREE" "$MARKER_SHA" > "$WORK/gateway-worktree.log" 2>&1 || {
  echo "could not materialize the accepted gateway revision $MARKER_SHA:"; tail -5 "$WORK/gateway-worktree.log"; exit 1
}
[[ -z "$(git -C "$GW_WORKTREE" status --porcelain)" ]] || {
  echo "REFUSING: the detached accepted-source checkout at $GW_WORKTREE is dirty"; exit 1
}
GW_VCS_TIME="$(date -u -d "$(git -C "$GATEWAY_REPO" show -s --format=%cI "$MARKER_SHA")" +%Y-%m-%dT%H:%M:%SZ)"
validate_vcs_stamp() { # binary
  local bin="$1" meta
  meta="$(run_bounded "$WORK_DEADLINE" "go version -m $(basename "$bin")" /usr/local/go/bin/go version -m "$bin")"
  grep -Eq "vcs.revision=$MARKER_SHA$" <<< "$meta" || {
    echo "REFUSING: $bin embedded vcs.revision != accepted $MARKER_SHA:"; grep -E 'vcs' <<< "$meta"; exit 1
  }
  grep -Eq 'vcs.modified=false$' <<< "$meta" || {
    echo "REFUSING: $bin embedded vcs.modified is not false (built from dirty source?):"; grep -E 'vcs' <<< "$meta"; exit 1
  }
  grep -Eq "vcs.time=$GW_VCS_TIME$" <<< "$meta" || {
    echo "REFUSING: $bin embedded vcs.time != the accepted commit time ($GW_VCS_TIME):"; grep -E 'vcs' <<< "$meta"; exit 1
  }
}
assert_work_time_left "the accepted-source Go builds"
run_bounded "$WORK_DEADLINE" "go build relay" \
  /usr/local/go/bin/go build -C "$GW_WORKTREE" -trimpath -buildvcs=true -o "$WORK/bin/relay" . \
  || { echo "gateway build (relay) from the accepted revision FAILED"; exit 1; }
run_bounded "$WORK_DEADLINE" "go build pocketshell-link" \
  /usr/local/go/bin/go build -C "$GW_WORKTREE" -trimpath -buildvcs=true -o "$WORK/bin/pocketshell-link" ./cmd/pocketshell-link \
  || { echo "gateway build (pocketshell-link) from the accepted revision FAILED"; exit 1; }
validate_vcs_stamp "$WORK/bin/relay"
validate_vcs_stamp "$WORK/bin/pocketshell-link"
sha256sum "$WORK/bin/relay" "$WORK/bin/pocketshell-link" > "$WORK/gateway-binaries.sha256"
{
  echo "gateway binaries: embedded vcs.revision=$MARKER_SHA vcs.modified=false vcs.time=$GW_VCS_TIME (both validated)"
} >> "$WORK/receipt.env"

if [[ "${GATEWAY_E2E_PREFLIGHT_ONLY:-0}" == "1" ]]; then
  echo "PREFLIGHT OK: marker FIRST LINE parsed under the exact full-line 40-hex contract ($MARKER_SHA), HEAD equality, "
  echo "web/core cleanliness, core resolution, detached committed accepted-source checkout, both binaries' embedded"
  echo "VCS stamps, all under bounded execution — all validated."
  echo "This was the plumbing rehearsal ONLY — NOT the composed acceptance run."
  exit 0
fi

# --- 2. the broker fixture (owned, local; the authorizer stand-in) ----------
# Plain-http listener for the GATEWAY's JWKS fetch (its shipped
# -broker-allow-insecure-dev lab flag) and a TLS listener for the BROWSER's
# exchange: the production guard in gatewayToken.ts mints ONLY from an https
# account-service origin, so the fixture serves TLS with an owned
# self-signed cert. The ISSUER pinned into tokens is the https origin.
/usr/bin/python3 tests/e2e/gateway_fixture_broker.py "$BROKER_PORT" "$WORK/broker.jsonl" "$BROKER_HTTPS_PORT" > "$WORK/broker.log" 2>&1 &
BROKER_PID=$!
BROKER_ISSUER="https://127.0.0.1:$BROKER_HTTPS_PORT"
for _ in $(seq 1 40); do
  run_bounded "$WORK_DEADLINE" "broker jwks probe" \
    curl -sk -o "$WORK/jwks.json" "https://127.0.0.1:$BROKER_HTTPS_PORT/gateway/jwks" \
    && grep -q '"kty"' "$WORK/jwks.json" && break
  sleep 0.25
done
grep -q '"kty": "RSA"' "$WORK/jwks.json" || { echo "broker JWKS never came up"; exit 1; }

# --- 3. the sshd fixture fleet (six host-key modes, helper image) -----------
COMPOSE="docker compose -f $DESKTOP_REPO/tests-docker/docker-compose.yml"
assert_work_time_left "the fixture image build"
# The shared image is a FIXTURE PREREQUISITE: the build must succeed (it is
# never papered over with a stale image), and the receipt records whether
# this run's build produced a new image id or reused the existing one.
HELPER_IMAGE_BEFORE="$(run_bounded "$WORK_DEADLINE" "list helper images" docker images --format '{{.ID}}' pocketshell-test:helper 2>/dev/null || true)"
run_bounded "$WORK_DEADLINE" "fixture image build" \
  $COMPOSE build ssh tmux helper > "$WORK/compose-build.log" 2>&1 || {
  echo "fixture image build FAILED (a prerequisite, not optional):"; tail -20 "$WORK/compose-build.log"; exit 1
}
run_bounded "$WORK_DEADLINE" "inspect helper image" docker image inspect pocketshell-test:helper > /dev/null || { echo "helper image missing after build"; exit 1; }
HELPER_IMAGE_AFTER="$(run_bounded "$WORK_DEADLINE" "list helper images" docker images --format '{{.ID}}' pocketshell-test:helper)"
{
  if [[ -n "$HELPER_IMAGE_BEFORE" && "$HELPER_IMAGE_BEFORE" == "$HELPER_IMAGE_AFTER" ]]; then
    echo "helper image: $HELPER_IMAGE_AFTER (unchanged by this run's build)"
  else
    echo "helper image: $HELPER_IMAGE_AFTER (built by this run; before: ${HELPER_IMAGE_BEFORE:-absent})"
  fi
} >> "$WORK/receipt.env"

# The run's SSH user keys (all owned, ephemeral): plain Ed25519, RSA (SHA2),
# passphrase-encrypted Ed25519 — plus the fleet's committed plain key.
KEY_PASSPHRASE='e2e-key-passphrase'
ssh-keygen -t ed25519 -N '' -C "$RUNID-plain" -f "$WORK/key_plain" -q
ssh-keygen -t rsa -b 2048 -N '' -C "$RUNID-rsa" -f "$WORK/key_rsa" -q
ssh-keygen -t ed25519 -N "$KEY_PASSPHRASE" -C "$RUNID-enc" -f "$WORK/key_enc" -q
chmod 600 "$WORK"/key_plain "$WORK"/key_rsa "$WORK"/key_enc
cat "$DESKTOP_REPO/tests-docker/test_key.pub" "$WORK/key_plain.pub" "$WORK/key_rsa.pub" "$WORK/key_enc.pub" > "$WORK/authorized_keys"

mode_config() { # name hostkeys... — writes $WORK/mode/<name>/sshd_config
  local name="$1"; shift
  mkdir -p "$WORK/mode/$name"
  {
    echo "Port 22"
    for hk in "$@"; do echo "HostKey /etc/ssh/ssh_host_${hk}_key"; done
    if [[ "${name}" == "sshrsa" ]]; then echo "HostKeyAlgorithms ssh-rsa"; fi
    cat << 'CFG'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
Subsystem sftp internal-sftp
LogLevel VERBOSE
CFG
  } > "$WORK/mode/$name/sshd_config"
  for hk in ed25519 rsa ecdsa; do
    if [[ " $* " == *" $hk "* ]]; then
      ssh-keygen -t "$hk" -N '' -f "$WORK/mode/$name/ssh_host_${hk}_key" -q
    fi
  done
}

start_mode() { # name port
  local name="$1" port="$2"
  local cname="$RUNID-$name"
  local args=()
  args+=(-v "$WORK/mode/$name/sshd_config:/etc/ssh/sshd_config:ro")
  for hk in ed25519 rsa ecdsa; do
    [[ -f "$WORK/mode/$name/ssh_host_${hk}_key" ]] || continue
    args+=(-v "$WORK/mode/$name/ssh_host_${hk}_key:/etc/ssh/ssh_host_${hk}_key:ro")
    args+=(-v "$WORK/mode/$name/ssh_host_${hk}_key.pub:/etc/ssh/ssh_host_${hk}_key.pub:ro")
  done
  # REGISTERED BEFORE the create attempt: a partially created container (or a
  # create that failed mid-way) is already in cleanup scope; cleanup then
  # verifies its absence independently, so an error never means absent.
  CONTAINERS+=("$cname")
  run_bounded "$WORK_DEADLINE" "start $cname" \
    docker run -d --rm --name "$cname" -p "127.0.0.1:$port:22" "${args[@]}" pocketshell-test:helper > /dev/null \
    || { echo "container $cname failed to start (registered for cleanup regardless)"; exit 1; }
  # The readiness probe APPENDS ssh-rsa to the client's accepted host keys:
  # the sshrsa mode's sshd offers ONLY the legacy ssh-rsa algorithm, which a
  # default OpenSSH >=8.8 client does not propose (the browser and the home
  # agent both list it explicitly; this probe must meet them there). Every
  # ssh attempt is bounded.
  for _ in $(seq 1 60); do
    if run_bounded "$WORK_DEADLINE" "readiness ssh $cname" \
      ssh -i "$DESKTOP_REPO/tests-docker/test_key" -p "$port" -o BatchMode=yes -o StrictHostKeyChecking=no \
        -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedAlgorithms=+ssh-rsa \
        -o UserKnownHostsFile=/dev/null -o ConnectTimeout=2 testuser@127.0.0.1 true 2>/dev/null; then
      break
    fi
    sleep 0.5
  done
  run_bounded "$WORK_DEADLINE" "final readiness $cname" \
    ssh -i "$DESKTOP_REPO/tests-docker/test_key" -p "$port" -o BatchMode=yes -o StrictHostKeyChecking=no \
      -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedAlgorithms=+ssh-rsa \
      -o UserKnownHostsFile=/dev/null testuser@127.0.0.1 true 2>/dev/null || {
    echo "mode $name sshd never came up on :$port"; run_bounded "$WORK_DEADLINE" "logs of $cname" docker logs "$cname" 2>&1 | tail -6; exit 1
  }
  # -i is LOAD-BEARING: without it docker exec does not forward stdin, the
  # append reads EOF and silently writes NOTHING (exit 0) — the browser then
  # dials with a key the server has never seen.
  run_bounded "$WORK_DEADLINE" "append run keys to $cname" \
    docker exec -i "$cname" sh -c 'cat >> /home/testuser/.ssh/authorized_keys && chmod 600 /home/testuser/.ssh/authorized_keys' < "$WORK/authorized_keys"
  # Post-conditions: every run key MUST be found in the container now.
  while read -r line; do
    fp="$(echo "$line" | awk '{print $2}')"
    run_bounded "$WORK_DEADLINE" "verify a run key landed in $cname" \
      docker exec "$cname" grep -qF "$(echo "$line" | awk '{print $1" "$2}')" /home/testuser/.ssh/authorized_keys || {
      echo "authorized_keys append missing a run key ($fp) in $cname"; exit 1
    }
  done < "$WORK/authorized_keys"
  run_bounded "$WORK_DEADLINE" "prepare workspace in $cname" \
    docker exec "$cname" sh -lc 'mkdir -p ~testuser/git/osc-demo && chown -R testuser:testuser ~testuser/git'
}

mode_config multi ed25519 rsa ecdsa
mode_config reverse ecdsa rsa ed25519
mode_config rsaonly rsa
mode_config sshrsa rsa
mode_config ecdsaonly ecdsa
mode_config edrsa ed25519 rsa
start_mode multi "$SSH_MULTI"
start_mode reverse "$SSH_REVERSE"
start_mode rsaonly "$SSH_RSAONLY"
start_mode sshrsa "$SSH_SSHRSA"
start_mode ecdsaonly "$SSH_ECDSAONLY"
start_mode edrsa "$SSH_EDRSA"

# Out-of-band fingerprints — the pairing source the browser pins (the gateway
# is never the trust anchor).
fp_of() { ssh-keygen -lf "$1" | awk '{print $2}'; }
line_of() { awk '{print $1" "$2}' "$1"; }
{
  echo "multi ed25519 $(fp_of "$WORK/mode/multi/ssh_host_ed25519_key.pub") $(line_of "$WORK/mode/multi/ssh_host_ed25519_key.pub")"
  echo "multi ecdsa $(fp_of "$WORK/mode/multi/ssh_host_ecdsa_key.pub") $(line_of "$WORK/mode/multi/ssh_host_ecdsa_key.pub")"
  echo "reverse ed25519 $(fp_of "$WORK/mode/reverse/ssh_host_ed25519_key.pub") $(line_of "$WORK/mode/reverse/ssh_host_ed25519_key.pub")"
  echo "rsaonly rsa $(fp_of "$WORK/mode/rsaonly/ssh_host_rsa_key.pub") $(line_of "$WORK/mode/rsaonly/ssh_host_rsa_key.pub")"
  echo "sshrsa rsa $(fp_of "$WORK/mode/sshrsa/ssh_host_rsa_key.pub") $(line_of "$WORK/mode/sshrsa/ssh_host_rsa_key.pub")"
  echo "ecdsaonly ecdsa $(fp_of "$WORK/mode/ecdsaonly/ssh_host_ecdsa_key.pub") $(line_of "$WORK/mode/ecdsaonly/ssh_host_ecdsa_key.pub")"
  echo "edrsa ed25519 $(fp_of "$WORK/mode/edrsa/ssh_host_ed25519_key.pub") $(line_of "$WORK/mode/edrsa/ssh_host_ed25519_key.pub")"
} > "$WORK/hostkeys.txt"

# --- 4. the gateway instances ------------------------------------------------
REGISTRY_FILE="/var/lib/pocketshell-relay/${RUNID}-registry.json"
rm -f "$REGISTRY_FILE"
"$WORK/bin/relay" -listen "127.0.0.1:$GW_PORT" -registry "$REGISTRY_FILE" \
  -broker-issuer "$BROKER_ISSUER" \
  -broker-jwks "http://127.0.0.1:$BROKER_PORT/gateway/jwks" \
  -broker-allow-insecure-dev \
  -allow e2e-gateway@pocketshell.test \
  -origins "http://127.0.0.1:$BASE_PORT" > "$WORK/gateway-a.log" 2>&1 &
GWA_PID=$!
# The LEGACY direct relay under its documented DEV posture (no registry; the
# fixture sign-in cannot pass a real Google JWKS check — see header).
"$WORK/bin/relay" -listen "127.0.0.1:$GWB_PORT" \
  -dev-allow-any-token -dev-allow-private-hosts \
  -allow e2e-gateway@pocketshell.test \
  -origins "http://127.0.0.1:$BASE_PORT" > "$WORK/gateway-b.log" 2>&1 &
GWB_PID=$!
assert_work_time_left "the gateway health checks"
for _ in $(seq 1 40); do
  run_bounded "$WORK_DEADLINE" "gateway A health probe" curl -sf "http://127.0.0.1:$GW_PORT/healthz" | grep -q '"registry":"enabled"' && break
  sleep 0.25
done
run_bounded "$WORK_DEADLINE" "gateway A registry check" curl -sf "http://127.0.0.1:$GW_PORT/healthz" | grep -q '"registry":"enabled"' || { echo "gateway A registry never enabled"; tail -5 "$WORK/gateway-a.log"; exit 1; }
run_bounded "$WORK_DEADLINE" "gateway B posture check" curl -sf "http://127.0.0.1:$GWB_PORT/healthz" | grep -q '"registry":"disabled"' || { echo "gateway B wrong posture"; exit 1; }

# --- 5. enroll + run the home agents per dial-able mode ----------------------
assert_work_time_left "the home-agent enrollments"
mint_token() {
  local token raw
  raw="$(run_bounded "$WORK_DEADLINE" "mint token" curl -sf -X POST "http://127.0.0.1:$BROKER_PORT/gateway/token" \
    -H "Authorization: Bearer $(/usr/bin/python3 -c "import sys; sys.path.insert(0, 'tests/e2e'); from gateway_fixture_broker import GOOGLE_TOKEN; print(GOOGLE_TOKEN)")")" \
    || { echo "broker token mint failed"; exit 1; }
  token="$(printf '%s' "$raw" | /usr/bin/python3 -c 'import json, sys; print(json.load(sys.stdin)["token"])')" \
    || { echo "broker token mint returned unparsable output"; exit 1; }
  [[ -n "$token" ]] || { echo "broker token mint returned nothing"; exit 1; }
  printf '%s' "$token"
}

expect_enroll() { # device sshhost expectkeyfile  — enrollment MUST succeed
  local device="$1" sshhost="$2" keyfile="$3"
  local dir="$WORK/agent-$device"
  mkdir -p "$dir"
  local token; token="$(mint_token)"
  run_bounded "$WORK_DEADLINE" "enroll $device" \
    "$WORK/bin/pocketshell-link" enroll --token-stdin \
    --server "http://127.0.0.1:$GW_PORT" --insecure-dev \
    --dev-broker-issuer "$BROKER_ISSUER" \
    --device-id "$device" --ssh-host "$sshhost" --config-dir "$dir" \
    --expect-host-key "$(fp_of "$keyfile")" <<< "$token" > "$WORK/enroll-$device.log" 2>&1 || {
    echo "enroll $device FAILED (it must succeed):"; cat "$WORK/enroll-$device.log"; exit 1
  }
  grep -q "host key matches --expect-host-key" "$WORK/enroll-$device.log" || {
    echo "enroll $device did not pin the out-of-band host key:"; cat "$WORK/enroll-$device.log"; exit 1
  }
  grep -q "^enrolled" "$WORK/enroll-$device.log" || {
    echo "enroll $device did not report success:"; cat "$WORK/enroll-$device.log"; exit 1
  }
  "$WORK/bin/pocketshell-link" run --server "http://127.0.0.1:$GW_PORT" --insecure-dev --config-dir "$dir" \
    > "$WORK/agent-$device.log" 2>&1 &
  local pid=$!
  AGENT_PIDS+=("$pid")
  for _ in $(seq 1 40); do
    grep -q "host connected device=$device" "$WORK/gateway-a.log" 2>/dev/null && return 0
    sleep 0.5
  done
  echo "agent $device never connected"; tail -5 "$WORK/agent-$device.log"; return 1
}

expect_enroll gwmulti "127.0.0.1:$SSH_MULTI" "$WORK/mode/multi/ssh_host_ed25519_key.pub"
expect_enroll gwreverse "127.0.0.1:$SSH_REVERSE" "$WORK/mode/reverse/ssh_host_ed25519_key.pub"
expect_enroll gwrsa "127.0.0.1:$SSH_RSAONLY" "$WORK/mode/rsaonly/ssh_host_rsa_key.pub"
expect_enroll gwsshrsa "127.0.0.1:$SSH_SSHRSA" "$WORK/mode/sshrsa/ssh_host_rsa_key.pub"
expect_enroll gwedrsa "127.0.0.1:$SSH_EDRSA" "$WORK/mode/edrsa/ssh_host_ed25519_key.pub"

# The ECDSA-only mode must REFUSE enrollment honestly — asserted against the
# run's OWN fixtures: zero broker requests on record from the attempt, no
# registry device record, no agent state (negative mode 5).
mkdir -p "$WORK/agent-gwecdsa"
ECDSA_TOKEN="$(mint_token)"
BROKER_LINES_BEFORE="$(wc -l < "$WORK/broker.jsonl")"
if run_bounded "$WORK_DEADLINE" "enroll gwecdsa (must refuse)" "$WORK/bin/pocketshell-link" enroll --token-stdin \
    --server "http://127.0.0.1:$GW_PORT" --insecure-dev \
    --dev-broker-issuer "$BROKER_ISSUER" \
    --device-id gwecdsa --ssh-host "127.0.0.1:$SSH_ECDSAONLY" --config-dir "$WORK/agent-gwecdsa" \
    <<< "$ECDSA_TOKEN" > "$WORK/enroll-gwecdsa.log" 2>&1; then
  echo "ECDSA-only enrollment unexpectedly SUCCEEDED"; exit 1
fi
grep -q "offers none of the enrollment host key algorithms" "$WORK/enroll-gwecdsa.log" || {
  echo "ECDSA-only enrollment failed for the wrong reason:"; cat "$WORK/enroll-gwecdsa.log"; exit 1
}
BROKER_LINES_AFTER="$(wc -l < "$WORK/broker.jsonl")"
[[ "$BROKER_LINES_AFTER" == "$BROKER_LINES_BEFORE" ]] || {
  echo "ECDSA-only enrollment refusal hit the BROKER ($((BROKER_LINES_AFTER - BROKER_LINES_BEFORE)) new request records):"
  tail -n +"$((BROKER_LINES_BEFORE + 1))" "$WORK/broker.jsonl"; exit 1
}
if [[ -f "$REGISTRY_FILE" ]] && grep -q 'gwecdsa' "$REGISTRY_FILE"; then
  echo "ECDSA-only refusal left a device record in the registry"; exit 1
fi
if [[ -f "$WORK/agent-gwecdsa/config.json" || -f "$WORK/agent-gwecdsa/device.key" ]]; then
  echo "ECDSA-only refusal wrote agent state anyway"; ls -la "$WORK/agent-gwecdsa"; exit 1
fi
echo "ecdsa-only refusal: zero broker requests on record, no registry device record, no agent state" >> "$WORK/receipt.env"

# --- 6. the production browser bundle ----------------------------------------
assert_work_time_left "the shipping-bundle typecheck + build"
# Direct .bin paths (npx could otherwise block on an install prompt) — and
# every build step is bounded by the work deadline.
run_bounded "$WORK_DEADLINE" "vue-tsc typecheck" node_modules/.bin/vue-tsc --noEmit
run_bounded "$WORK_DEADLINE" "vite build" node_modules/.bin/vite build --outDir "$WORK/dist" --emptyOutDir > "$WORK/vite-build.log" 2>&1
node_modules/.bin/vite preview --outDir "$WORK/dist" --port "$BASE_PORT" --strictPort > "$WORK/preview.log" 2>&1 &
PREVIEW_PID=$!
for _ in $(seq 1 50); do
  run_bounded "$WORK_DEADLINE" "preview readiness probe" curl -sf -o /dev/null "http://127.0.0.1:$BASE_PORT/" && break
  sleep 0.2
done

# --- 7a. fixtures for the proof -----------------------------------------------
cat > "$WORK/fixtures.json" << EOF
{
  "runId": "$RUNID",
  "googleEmail": "e2e-gateway@pocketshell.test",
  "keyPassphrase": "$KEY_PASSPHRASE",
  "brokerUrl": "$BROKER_ISSUER",
  "gatewayUrl": "ws://127.0.0.1:$GW_PORT",
  "legacyUrl": "ws://127.0.0.1:$GWB_PORT",
  "syncUrl": "https://sync.e2e.test",
  "directHost": "127.0.0.1",
  "directPort": $SSH_MULTI,
  "gatewayRestart": "$WORK/gateway-restart.sh",
  "gatewayRegistry": "$REGISTRY_FILE",
  "modes": {
    "multi":    {"device": "gwmulti",   "port": $SSH_MULTI,    "userKey": "key_plain"},
    "reverse":  {"device": "gwreverse", "port": $SSH_REVERSE,  "userKey": "key_enc"},
    "rsaonly":  {"device": "gwrsa",     "port": $SSH_RSAONLY,  "userKey": "key_rsa"},
    "sshrsa":   {"device": "gwsshrsa",  "port": $SSH_SSHRSA,   "userKey": "key_plain"},
    "edrsa":    {"device": "gwedrsa",   "port": $SSH_EDRSA,    "userKey": "key_plain"}
  }
}
EOF
# The advisory-tamper leg restarts gateway A over the SAME registry state
# after the harness edits the device record's advertised ssh_host_key. It
# kills ONLY this run's exact gateway PID and records the EXACT new PID for
# the cleanup (no command-line pattern sweeps — another actor's process is
# never a match target).
cat > "$WORK/gateway-restart.sh" << EOF
#!/bin/bash
kill -9 "$GWA_PID" 2>/dev/null
sleep 1
nohup "$WORK/bin/relay" -listen "127.0.0.1:$GW_PORT" -registry "$REGISTRY_FILE" \
  -broker-issuer "$BROKER_ISSUER" \
  -broker-jwks "http://127.0.0.1:$BROKER_PORT/gateway/jwks" \
  -broker-allow-insecure-dev \
  -allow e2e-gateway@pocketshell.test \
  -origins "http://127.0.0.1:$BASE_PORT" >> "$WORK/gateway-a.log" 2>&1 &
echo \$! > "$GWA_PIDFILE"
for _ in \$(seq 1 40); do
  curl -sf "http://127.0.0.1:$GW_PORT/healthz" | grep -q '"registry":"enabled"' && exit 0
  sleep 0.25
done
echo "gateway A never came back"; exit 1
EOF
chmod +x "$WORK/gateway-restart.sh"

# --- 7. the browser + wire proof ----------------------------------------------
# The composed proof runs under the ACTUAL bounded executor with the work
# deadline as its hard bound (setsid: on expiry the OWNED process group —
# browser included — is stopped, then EXIT cleanup proceeds on its own
# reserve; the lane is never wrapped in a kill that would skip cleanup). The
# harness ALSO enforces the same deadline gracefully 90s earlier (exported
# below): phase gates, an asyncio umbrella over the whole flow, and bounded
# context closes — the hard bound exists only for a wedged harness.
assert_work_time_left "the composed browser+Go proof"
GW_LEFT="$(seconds_left "$WORK_DEADLINE")"
if (( GW_LEFT <= 120 )); then
  echo "WORK DEADLINE EXHAUSTED (${GW_LEFT}s left): refusing to start the composed browser+Go proof" >&2
  exit 124
fi
export GW_E2E_DEADLINE_SECS=$(( GW_LEFT - 90 ))
if run_bounded "$WORK_DEADLINE" "the composed browser+Go proof" \
    /usr/bin/python3 -u tests/e2e/e2e_gateway_prod.py \
    "http://127.0.0.1:$BASE_PORT" "$WORK" "$WORK/fixtures.json"; then
  status=0
else
  status=$?
fi

# --- 8. receipts --------------------------------------------------------------
# Produced for BOTH outcomes (a failed proof still leaves its receipts).
RECEIPTS_DEADLINE=$(( $(now_epoch) + 60 ))
run_bounded "$RECEIPTS_DEADLINE" "helper image receipt" \
  docker images --format "{{.Repository}}:{{.Tag}} {{.ID}}" | grep '^pocketshell-test:helper' >> "$WORK/receipt.env" || true
run_bounded "$RECEIPTS_DEADLINE" "container inventory receipt" \
  docker inspect --format '{{.Name}} {{.Image}} {{.Config.Image}}' ${CONTAINERS[@]+"${CONTAINERS[@]}"} > "$WORK/containers.txt" || true
echo "artifacts in $WORK"
exit "$status"
