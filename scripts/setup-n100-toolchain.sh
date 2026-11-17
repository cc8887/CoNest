#!/usr/bin/env bash
# Install pinned Linux x64 tools under the current user's CoNest directory.
# Does not alter system Node, shell startup files, WSL settings or credentials.
set -euo pipefail
umask 077

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  printf '%s\n' 'Run this script in the N100 Ubuntu WSL2 terminal (Linux x86_64).' >&2
  exit 1
fi
for conest_command in curl tar sha256sum flock; do
  if ! command -v "$conest_command" >/dev/null 2>&1; then
    printf 'Missing prerequisite: %s. Install it in Ubuntu, then rerun.\n' "$conest_command" >&2
    exit 1
  fi
done

conest_tools_root="$HOME/.local/share/conest/toolchains"
conest_node_name=node-v24.22.3-linux-x64
conest_node_home="$conest_tools_root/$conest_node_name"
conest_pnpm_home="$conest_tools_root/pnpm-11.7.0"
mkdir -p "$conest_tools_root"
exec 9>"$conest_tools_root/.setup.lock"
flock -n 9 || { printf '%s\n' 'Another toolchain setup is running.' >&2; exit 1; }
conest_temporary=$(mktemp -d "$conest_tools_root/.setup.XXXXXXXX")
trap 'rm -rf -- "$conest_temporary"' EXIT

if [[ ! -e "$conest_node_home" ]]; then
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --connect-timeout 20 --max-time 600 --retry 2 \
    "https://nodejs.org/dist/v24.22.3/$conest_node_name.tar.gz" \
    --output "$conest_temporary/node.tar.gz"
  # From https://nodejs.org/dist/v24.22.3/SHASUMS256.txt, checked 2026-11-17.
  printf '061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2  %s\n' \
    "$conest_temporary/node.tar.gz" | sha256sum --check --status
  tar -xzf "$conest_temporary/node.tar.gz" -C "$conest_temporary"
  mv "$conest_temporary/$conest_node_name" "$conest_node_home"
fi
if [[ ! -x "$conest_node_home/bin/node" ]] || [[ "$("$conest_node_home/bin/node" --version)" != v24.22.3 ]]; then
  printf '%s\n' 'The private Node installation is incomplete or has an unexpected version; no existing tools were replaced.' >&2
  exit 1
fi
export PATH="$conest_node_home/bin:$PATH"
if [[ ! -e "$conest_pnpm_home" ]]; then
  "$conest_node_home/bin/npm" install --global --prefix "$conest_temporary/pnpm" \
    --registry=https://registry.npmjs.org --ignore-scripts --no-audit --no-fund pnpm@11.7.0
  mv "$conest_temporary/pnpm" "$conest_pnpm_home"
fi
if [[ ! -x "$conest_pnpm_home/bin/pnpm" ]] || [[ "$("$conest_pnpm_home/bin/pnpm" --version)" != 11.7.0 ]]; then
  printf '%s\n' 'The private pnpm installation is incomplete or has an unexpected version; no existing tools were replaced.' >&2
  exit 1
fi

mkdir -p "$HOME/.config/conest"
cat > "$conest_temporary/toolchain.env" <<'ENV'
export PATH="$HOME/.local/share/conest/toolchains/pnpm-11.7.0/bin:$HOME/.local/share/conest/toolchains/node-v24.22.3-linux-x64/bin:$PATH"
ENV
install -m 600 "$conest_temporary/toolchain.env" "$HOME/.config/conest/toolchain.env"
printf '%s\n' 'Installed private Node v24.22.3 and pnpm 11.7.0.' \
  'In this terminal, run: source "$HOME/.config/conest/toolchain.env"' \
  'Then run: node --version; pnpm --version'
