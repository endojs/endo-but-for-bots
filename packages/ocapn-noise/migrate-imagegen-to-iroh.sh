#!/usr/bin/env bash
# migrate-imagegen-to-iroh.sh — flip the GPU image-gen capability (imagegen-noise) off its open TCP :8930 onto
# Iroh (dial-by-EndpointId, no open TCP port), keeping the SAME identity (same seed → same keyId/EndpointId).
# This is the GPU capability GpuLease's lease facets ride on. OPERATOR-RUN: flipping a live shared service is
# a gated infra change — the agent does NOT run it autonomously (the auto-mode classifier denies that). Reversible.
#
#   bash migrate-imagegen-to-iroh.sh --apply     # serve over iroh; verify no :8930 + an EndpointId
#   bash migrate-imagegen-to-iroh.sh --revert     # back to TCP :8930
#   bash migrate-imagegen-to-iroh.sh --status
set -euo pipefail
SVC=imagegen-noise
OVR_DIR="$HOME/.config/systemd/user/${SVC}.service.d"
OVR="$OVR_DIR/iroh.conf"
SEED=/home/dan/.local/state/endo/imagegen.seed
SERVER=/home/dan/endo-bfb-llm/packages/ocapn-noise/imagegen-server-iroh.mjs

apply() {
  mkdir -p "$OVR_DIR"
  cat > "$OVR" <<EOF
# Reversible Iroh migration of the GPU imageGen capability (see migrate-imagegen-to-iroh.sh).
[Service]
WorkingDirectory=/home/dan/endo-bfb-llm/packages/ocapn-noise
ExecStart=
ExecStart=/usr/bin/node ${SERVER} --seed ${SEED} --secret imageGen --preset minimal
EOF
  systemctl --user daemon-reload
  systemctl --user restart "$SVC"
  sleep 4
  echo "active: $(systemctl --user is-active "$SVC")"
  if ss -tlnp 2>/dev/null | grep -q ':8930'; then echo "✗ STILL listening on TCP :8930"; exit 1; else echo "✅ no TCP :8930 listener"; fi
  local pid; pid=$(systemctl --user show "$SVC" -p MainPID --value)
  echo "TCP listeners for PID $pid: $(ss -tlnp 2>/dev/null | grep -c "pid=$pid,")"
  journalctl --user -u "$SVC" --no-pager -n 8 2>/dev/null | grep -iE 'imagegen .iroh|iroh:id|error|fail' | tail -3 || true
}
revert() {
  rm -f "$OVR"; rmdir "$OVR_DIR" 2>/dev/null || true
  systemctl --user daemon-reload
  systemctl --user restart "$SVC"
  sleep 4
  echo "active: $(systemctl --user is-active "$SVC")"
  ss -tlnp 2>/dev/null | grep -q ':8930' && echo "✅ back on TCP :8930" || echo "(no :8930 yet — check the journal)"
}
case "${1:-}" in
  --apply) apply ;;
  --revert) revert ;;
  --status) systemctl --user show "$SVC" -p ExecStart --value; echo "override: $([ -f "$OVR" ] && echo present || echo absent)"; ss -tlnp 2>/dev/null | grep ':8930' || echo "(no TCP :8930)";;
  *) echo "usage: $0 --apply | --revert | --status"; exit 2 ;;
esac
