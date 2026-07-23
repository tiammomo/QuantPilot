#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 5 ]]; then
  echo "usage: run-generated-project-sandbox.sh <workspace> <node_modules> <node_runtime> -- <command> [args...]" >&2
  exit 64
fi

workspace="$1"
node_modules="$2"
node_runtime="$3"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
preview_bridge="$script_dir/preview-network-bridge.mjs"
market_bridge="$script_dir/market-network-bridge.mjs"
shift 3
if [[ "$1" != "--" ]]; then
  echo "sandbox command separator is required" >&2
  exit 64
fi
shift

for required_path in "$workspace" "$node_modules" "$node_runtime"; do
  if [[ ! -e "$required_path" ]]; then
    echo "sandbox input does not exist: $required_path" >&2
    exit 66
  fi
done

mount --make-rprivate /
sandbox_root="$(mktemp -d "${TMPDIR:-/tmp}/quantpilot-generated-sandbox.XXXXXX")"
cleanup() {
  cd /
  umount -R "$sandbox_root" 2>/dev/null || true
  rm -rf "$sandbox_root"
}
trap cleanup EXIT INT TERM

mount -t tmpfs -o size=256m,nosuid,nodev tmpfs "$sandbox_root"

make_target() {
  local source="$1"
  local target="$sandbox_root$source"
  if [[ -d "$source" ]]; then
    mkdir -p "$target"
  else
    mkdir -p "$(dirname "$target")"
    : > "$target"
  fi
}

bind_read_only() {
  local source="$1"
  [[ -e "$source" ]] || return 0
  local target="$sandbox_root$source"
  make_target "$source"
  mount --bind "$source" "$target"
  mount -o remount,bind,ro,nosuid,nodev "$target"
}

bind_workspace() {
  local target="$sandbox_root$workspace"
  mkdir -p "$workspace/.next"
  mkdir -p "$target"
  mount --bind "$workspace" "$target"
  mount -o remount,bind,ro,nosuid,nodev,noexec "$target"
  mount --bind "$workspace/.next" "$target/.next"
  mount -o remount,bind,rw,nosuid,nodev,noexec "$target/.next"
}

bind_device() {
  local source="$1"
  local target="$sandbox_root$source"
  make_target "$source"
  mount --bind "$source" "$target"
  # `nodev` would make even the explicitly allowlisted character device
  # unusable. Keep only these four devices and never bind the host /dev tree.
  mount -o remount,bind,rw,nosuid,noexec "$target"
}

for system_path in \
  /usr/bin \
  /usr/lib/x86_64-linux-gnu \
  /usr/lib/locale \
  /usr/lib/ssl \
  /usr/lib64 \
  /usr/share \
  /usr/local; do
  bind_read_only "$system_path"
done
ln -s usr/bin "$sandbox_root/bin"
ln -s usr/lib "$sandbox_root/lib"
ln -s usr/lib64 "$sandbox_root/lib64"
bind_read_only "$node_runtime"
bind_read_only "$node_modules"
bind_read_only "$preview_bridge"
bind_read_only "$market_bridge"
bind_workspace

mkdir -p "$sandbox_root/dev" "$sandbox_root/proc" "$sandbox_root/tmp"
mount -t tmpfs -o size=128m,nosuid,nodev,noexec tmpfs "$sandbox_root/tmp"
mount -t proc -o nosuid,nodev,noexec proc "$sandbox_root/proc"
for device in /dev/null /dev/zero /dev/random /dev/urandom; do
  bind_device "$device"
done
ln -s /proc/self/fd "$sandbox_root/dev/fd"
ln -s /proc/self/fd/0 "$sandbox_root/dev/stdin"
ln -s /proc/self/fd/1 "$sandbox_root/dev/stdout"
ln -s /proc/self/fd/2 "$sandbox_root/dev/stderr"

# Unix-domain socket paths are limited to roughly 108 bytes on Linux, while a
# generated workspace path can be much longer. PreviewManager therefore owns a
# short, per-preview runtime directory under /tmp. Bind only that empty runtime
# directory into the chroot so the two narrow loopback bridges can rendezvous;
# do not expose the host /tmp tree.
if [[ -n "${QUANTPILOT_SANDBOX_PREVIEW_SOCKET:-}" || -n "${QUANTPILOT_SANDBOX_MARKET_SOCKET:-}" ]]; then
  if [[ -z "${QUANTPILOT_SANDBOX_PREVIEW_SOCKET:-}" || -z "${QUANTPILOT_SANDBOX_MARKET_SOCKET:-}" ]]; then
    echo "sandbox preview and market sockets must be configured together" >&2
    exit 64
  fi
  preview_socket_dir="$(dirname "$QUANTPILOT_SANDBOX_PREVIEW_SOCKET")"
  market_socket_dir="$(dirname "$QUANTPILOT_SANDBOX_MARKET_SOCKET")"
  if [[ "$preview_socket_dir" != "$market_socket_dir" || ! -d "$preview_socket_dir" ]]; then
    echo "sandbox sockets must share an existing runtime directory" >&2
    exit 64
  fi
  case "$preview_socket_dir" in
    /tmp/qp-preview/*) ;;
    *)
      echo "sandbox runtime directory must be under /tmp/qp-preview" >&2
      exit 64
      ;;
  esac
  runtime_target="$sandbox_root$preview_socket_dir"
  mkdir -p "$runtime_target"
  mount --bind "$preview_socket_dir" "$runtime_target"
  mount -o remount,bind,rw,nosuid,nodev,noexec "$runtime_target"
fi

for config_path in \
  /etc/ca-certificates \
  /etc/ssl \
  /etc/fonts \
  /etc/hosts \
  /etc/resolv.conf \
  /etc/nsswitch.conf \
  /etc/passwd \
  /etc/group \
  /etc/localtime \
  /etc/ld.so.cache; do
  bind_read_only "$config_path"
done

# Project-local credentials are never part of a generated runtime. Mask common
# files without modifying the user's workspace on the host.
for secret_name in .env .env.local .env.development .env.production .npmrc .yarnrc; do
  secret_path="$sandbox_root$workspace/$secret_name"
  if [[ -e "$secret_path" ]]; then
    mount --bind /dev/null "$secret_path"
    mount -o remount,bind,ro,nosuid,nodev,noexec "$secret_path"
  fi
done

mkdir -p "$sandbox_root/tmp/home"
export HOME=/tmp/home
export TMPDIR=/tmp
sandbox_env=(
  "PATH=${PATH:-$node_runtime/bin:/usr/bin:/bin}"
  "HOME=/tmp/home"
  "TMPDIR=/tmp"
  "CI=${CI:-1}"
  "NODE_OPTIONS=--max-old-space-size=2048"
  "NEXT_TELEMETRY_DISABLED=1"
  "QUANTPILOT_WORKSPACE_ROOT=$(dirname "$node_modules")"
)
for env_name in LANG LC_ALL LC_CTYPE TERM TZ PORT WEB_PORT NEXT_PUBLIC_APP_URL NODE_ENV NEXT_PRIVATE_BUILD_WORKER; do
  if [[ -n "${!env_name:-}" ]]; then
    sandbox_env+=("$env_name=${!env_name}")
  fi
done

# A fresh network namespace starts with loopback disabled. Only loopback is
# enabled; no host or external interface is attached to generated code.
/usr/sbin/ip link set lo up

ulimit -c 0
ulimit -n 1024
ulimit -u 512
ulimit -f 2097152
# V8/WebAssembly reserve a very large sparse virtual address range before the
# Next.js compiler starts. RLIMIT_AS therefore rejects a healthy build even
# when resident memory is small. Actual JavaScript memory remains bounded by
# NODE_OPTIONS above; production deployments should additionally apply a
# cgroup/container memory limit to the whole process tree.

# The process remains UID 0 only inside the one-ID user namespace so workspace
# ownership stays writable. Removing all capabilities prevents further mounts,
# chroot changes, ptrace, or namespace administration by generated code.
chroot_command=(
  /usr/sbin/chroot "$sandbox_root"
  /usr/bin/env -i "${sandbox_env[@]}"
  /usr/bin/setpriv
  --no-new-privs
  --bounding-set=-all
  --inh-caps=-all
  --ambient-caps=-all
  --
)

if [[ -n "${QUANTPILOT_SANDBOX_PREVIEW_SOCKET:-}" && -n "${QUANTPILOT_SANDBOX_PREVIEW_PORT:-}" ]]; then
  "${chroot_command[@]}" /bin/sh -c '
    set -eu
    workspace="$1"
    bridge="$2"
    socket_path="$3"
    target_port="$4"
    market_bridge="$5"
    market_socket="$6"
    market_port="$7"
    shift 7

    node "$bridge" "$socket_path" "$target_port" &
    bridge_pid=$!
    market_bridge_pid=""
    if [ -n "$market_socket" ] && [ -n "$market_port" ]; then
      node "$market_bridge" "$market_socket" "$market_port" &
      market_bridge_pid=$!
    fi
    cleanup_bridge() {
      kill "$bridge_pid" 2>/dev/null || true
      if [ -n "$market_bridge_pid" ]; then
        kill "$market_bridge_pid" 2>/dev/null || true
      fi
      wait "$bridge_pid" 2>/dev/null || true
      if [ -n "$market_bridge_pid" ]; then
        wait "$market_bridge_pid" 2>/dev/null || true
      fi
      rm -f "$socket_path"
    }
    trap cleanup_bridge EXIT INT TERM

    cd "$workspace"
    "$@"
  ' quantpilot-sandbox \
    "$workspace" \
    "$preview_bridge" \
    "$QUANTPILOT_SANDBOX_PREVIEW_SOCKET" \
    "$QUANTPILOT_SANDBOX_PREVIEW_PORT" \
    "$market_bridge" \
    "${QUANTPILOT_SANDBOX_MARKET_SOCKET:-}" \
    "${QUANTPILOT_SANDBOX_MARKET_PORT:-}" \
    "$@"
else
  "${chroot_command[@]}" \
    /bin/sh -c 'cd "$1" && shift && exec "$@"' quantpilot-sandbox "$workspace" "$@"
fi
