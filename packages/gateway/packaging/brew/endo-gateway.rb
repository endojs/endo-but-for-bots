# Homebrew formula for the Endo Gateway.
#
# Installs the gateway as a Node package under HOMEBREW_PREFIX,
# wires the `endo` CLI's `gateway` subcommand into the formula's
# bin, and registers a launchd service via Homebrew's
# `service.run` declaration. The service runs under the calling
# user's account (Homebrew's convention; `brew services start` and
# `brew services start --all` use the LaunchAgent shape rather
# than the LaunchDaemon shape #410's plist documents).
#
# This formula targets the personal-laptop / developer-machine
# deployment shape, not a per-host system service. For the latter,
# install the LaunchDaemon plist by hand per
# packages/gateway/docs/system-service.md or use the system .pkg
# the Familiar app installer ships (see designs/gateway-package.md
# § Feature 5 Familiar app packaging impact).

class EndoGateway < Formula
  desc "HTTP/WebSocket + virtual hosting + OCapN bridge for the Endo daemon"
  homepage "https://github.com/endojs/endo/tree/master/packages/gateway"
  url "https://github.com/endojs/endo/archive/refs/tags/v0.1.0.tar.gz"
  # The sha256 is computed by the release script at tag time;
  # SKIP is a placeholder for the initial recipe.
  sha256 "SKIP"
  license "Apache-2.0"

  depends_on "node@22"
  depends_on "git"
  depends_on "yarn" => :build

  def install
    # 1. Install workspace dependencies.
    system "corepack", "enable"
    system "yarn", "install", "--immutable"

    # 2. Build sibling packages the gateway depends on.
    system "yarn", "workspaces", "foreach", "--all", "--topological", "run", "build"

    # 3. Stage the application payload under libexec so we do not
    #    pollute the prefix's bin / lib / share with workspace
    #    layout.
    libexec.install Dir["*"]

    # 4. Wire a `endo` shim. The actual CLI is the workspace's
    #    packages/cli/src/endo.js; the shim points node at it with
    #    the workspace's node_modules resolved.
    (bin/"endo").write <<~SH
      #!/bin/bash
      exec "#{Formula["node@22"].opt_bin}/node" "#{libexec}/packages/cli/src/endo.js" "$@"
    SH
    chmod 0755, bin/"endo"

    # 5. Documentation under share/doc.
    doc.install libexec/"packages/gateway/docs/system-service.md"
    doc.install libexec/"packages/gateway/docs/packaging.md"
    doc.install libexec/"packages/gateway/README.md" => "gateway-README.md"
  end

  service do
    run [opt_bin/"endo", "gateway", "run"]
    keep_alive successful_exit: false
    log_path var/"log/endo-gateway/gateway.log"
    error_log_path var/"log/endo-gateway/gateway.log"
    working_dir var/"lib/endo-gateway"
    environment_variables \
      ENDO_GATEWAY_STATE_DIR: var/"lib/endo-gateway",
      ENDO_GATEWAY_LOG_DIR: var/"log/endo-gateway",
      ENDO_GATEWAY_CACHE_DIR: var/"cache/endo-gateway",
      ENDO_GATEWAY_RUNTIME_DIR: var/"run/endo-gateway",
      ENDO_GATEWAY_CONFIG_FILE: etc/"endo-gateway/config.toml"
  end

  def post_install
    # Create the per-user managed directories under HOMEBREW_PREFIX/var.
    %w[lib log cache run].each do |kind|
      mkdir_p(var/"#{kind}/endo-gateway") unless (var/"#{kind}/endo-gateway").exist?
    end
    mkdir_p(etc/"endo-gateway") unless (etc/"endo-gateway").exist?
  end

  def caveats
    <<~EOS
      The Homebrew formula installs the Endo Gateway as a
      per-user LaunchAgent, not as a per-host LaunchDaemon. To
      start the gateway under your account:

          brew services start endo-gateway

      To run a per-host system service that survives logout, follow
      the LaunchDaemon procedure at:

          #{doc}/system-service.md

      The LaunchDaemon plist is at
      packages/gateway/systemd/com.endojs.endo-gateway.plist in
      the source tree.

      Gateway state lives under:
          #{var}/lib/endo-gateway      (CapTP graph; do not delete)
          #{var}/log/endo-gateway      (log file)
          #{var}/cache/endo-gateway    (CAS read-through cache)
          #{var}/run/endo-gateway      (UDS sockets)
          #{etc}/endo-gateway          (config; optional)

      The gateway binds to 0.0.0.0:3469 by default. Override with:
          ENDO_HTTP_ADDR=127.0.0.1:3469 endo gateway run
    EOS
  end

  test do
    # The CLI prints help with --help and the gateway subcommand
    # is listed under the Gateway grouping.
    output = shell_output("#{bin}/endo gateway where --json --system")
    assert_match(/state/, output)
    assert_match(/runtime/, output)
    assert_match(/log/, output)
  end
end
