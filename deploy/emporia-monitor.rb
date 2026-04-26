# Homebrew formula for emporia-monitor.
# Place this in Tom-xyz/homebrew-tap/Formula/emporia-monitor.rb after a release tag.
# Update `url` and `sha256` to point at the GitHub release tarball.

class EmporiaMonitor < Formula
  desc "Real-time, liquid-glass energy dashboard for Emporia Vue"
  homepage "https://github.com/Tom-xyz/emporia-energy-monitor"
  url "https://github.com/Tom-xyz/emporia-energy-monitor/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "6afc6f85681b133112287111adda6f247d7e91385757248f3f175d740a83ace1"
  license "MIT"
  head "https://github.com/Tom-xyz/emporia-energy-monitor.git", branch: "main"

  depends_on "node"

  def install
    # Install all source (Dir["*"] excludes dotfiles by default; explicitly include .env.example).
    libexec.install Dir["*"], ".env.example"
    cd libexec do
      system "npm", "install", "--omit=dev", "--no-audit", "--no-fund"
    end

    # Wrapper script that points node at the bundled bin/
    (bin/"emporia-monitor").write <<~SH
      #!/bin/bash
      exec node "#{libexec}/bin/emporia-monitor.mjs" "$@"
    SH

    # Default config example for users
    (etc/"emporia-monitor").mkpath
    cp libexec/".env.example", etc/"emporia-monitor/.env.example"
  end

  def caveats
    <<~EOS
      Set up your Emporia credentials before starting:

        mkdir -p #{etc}/emporia-monitor
        cp #{etc}/emporia-monitor/.env.example #{etc}/emporia-monitor/.env
        $EDITOR #{etc}/emporia-monitor/.env

      Then start the dashboard as a background service:

        brew services start emporia-monitor

      Or run it in the foreground for testing:

        cd #{etc}/emporia-monitor && emporia-monitor

      Dashboard:  http://localhost:3030
    EOS
  end

  service do
    run [opt_bin/"emporia-monitor"]
    keep_alive true
    log_path     var/"log/emporia-monitor.log"
    error_log_path var/"log/emporia-monitor.error.log"
    working_dir  etc/"emporia-monitor"
    environment_variables PATH: std_service_path_env
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/emporia-monitor --version")
    assert_match "Usage:", shell_output("#{bin}/emporia-monitor --help")
  end
end
