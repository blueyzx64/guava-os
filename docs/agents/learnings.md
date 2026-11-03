# Learnings (the compounding log)

> Read this before you start. One entry per lesson that cost someone time. Newest first. Only the
> orchestrator writes here (agents propose entries as `LEARN:` lines in their memory file).
> Format: **Context** · what worked / what failed · **Do instead**.

## Test environment

- **Fedora's `/etc/ssl/certs` is an absolute symlink** to `/etc/pki/tls/certs`. Writing through
  it from the host lands outside the root (or fails with "File exists"). `build-f44-root.sh`
  writes the proxy CA to `etc/pki/tls/certs/ccr.pem` and into `ca-trust/source/anchors` (dnf
  ignores `CURL_CA_BUNDLE`; it needs `update-ca-trust`).
- **Cisco's openh264 repo is outside Fedora's mirrors** and blocked behind most proxies. The
  root build disables `fedora-cisco-openh264`; Fedora's `noopenh264` satisfies the dependency.
- **The harness runs inside a Claude Code cloud container** (root, chroot, no Docker daemon
  needed): `X2=/tmp/claude-0/x2`. A baseline `run-f44.sh 3` takes about 3 minutes. Copies of
  the root (`f44b`…) let agents run in parallel; `run-f44.sh` queues when all are busy.
