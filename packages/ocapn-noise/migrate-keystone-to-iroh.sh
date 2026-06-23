#!/usr/bin/env bash
# migrate-keystone-to-iroh.sh — flip the keystone proof node (endo-noise-root) off its open TCP :8920 onto
# Iroh (dial-by-EndpointId, no open TCP port), keeping the SAME identity (same seed → same keyId
# a4f54167…4848). OPERATOR-RUN: this reconfigures + restarts a live shared service, so the agent does NOT run
# it autonomously (it's gated). Fully reversible.
#
#   bash migrate-keystone-to-iroh.sh --apply     # serve over iroh; verify no :8920 + an EndpointId
#   bash migrate-keystone-to-iroh.sh --revert     # back to TCP :8920
#   bash migrate-keystone-to-iroh.sh --status
#
# Smoke-proven: iroh-root.mjs with keystone's seed yields keyId==EndpointId
# a4f54167f4a3d6193a5b65fb24c7973d8dafcba68666f3569bd3720329184848, binds iroh QUIC (UDP), zero TCP.
set -euo pipefail
SVC=endo-noise-root
OVR_DIR="$HOME/.config/systemd/user/${SVC}.service.d"
OVR="$OVR_DIR/iroh.conf"
SEED=/home/dan/.local/state/endo/noise-root.seed
ROOT=/home/dan/endo-bfb-llm/packages/ocapn-noise/iroh-root.mjs

apply() {
  mkdir -p "$OVR_DIR"
  cat > "$OVR" <<EOF
# Reversible Iroh migration of the keystone proof node (see migrate-keystone-to-iroh.sh).
[Service]
WorkingDirectory=/home/dan/endo-bfb-llm/packages/ocapn-noise
ExecStart=
ExecStart=/usr/bin/node ${ROOT} --seed ${SEED} --preset minimal
EOF
  systemctl --user daemon-reload
  systemctl --user restart "$SVC"
  sleep 3
  echo "active: $(systemctl --user is-active "$SVC")"
  if ss -tlnp 2>/dev/null | grep -q ':8920'; then echo "✗ STILL listening on TCP :8920"; exit 1; else echo "✅ no TCP :8920 listener"; fi
  journalctl --user -u "$SVC" --no-pager -n 8 2>/dev/null | grep -iE 'iroh-root up|a4f54167' | tail -2 || true
}
revert() {
  rm -f "$OVR"; rmdir "$OVR_DIR" 2>/dev/null || true
  systemctl --user daemon-reload
  systemctl --user restart "$SVC"
  sleep 3
  echo "active: $(systemctl --user is-active "$SVC")"
  ss -tlnp 2>/dev/null | grep -q ':8920' && echo "✅ back on TCP :8920" || echo "(no :8920 yet — check the journal)"
}
case "${1:-}" in
  --apply) apply ;;
  --revert) revert ;;
  --status) systemctl --user show "$SVC" -p ExecStart --value; echo "override: $([ -f "$OVR" ] && echo present || echo absent)"; ss -tlnp 2>/dev/null | grep ':8920' || echo "(no TCP :8920)";;
  *) echo "usage: $0 --apply | --revert | --status"; exit 2 ;;
esac
