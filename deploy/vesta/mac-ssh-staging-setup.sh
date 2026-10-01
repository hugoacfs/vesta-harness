#!/usr/bin/env bash
# One-time setup for the Vesta staging Mac SSH target. Run from the Mac with:
# ssh vesta 'cat ~/code/vesta-harness-staging/deploy/vesta/mac-ssh-staging-setup.sh' | bash
set -euo pipefail

readonly VESTA_ALIAS="vesta"
readonly TARGET_TAILNET_IP="100.93.103.19"
readonly VESTA_TAILNET_IP="100.120.132.105"
readonly HELPER_VERSION="0.1.6-alpha.2"
readonly HELPER_SHA256="bd0020c9f27544af1179dadcd16047b70ec565dfdf6e5d26b87aca95c06027a9"
readonly MAC_SSH_ALIAS="vesta-mac-staging"

printf '%s\n' "Checking Vesta staging access..."
staging_key="$(ssh "$VESTA_ALIAS" 'cat ~/.vesta-harness-staging/mac-ssh/id_ed25519.pub')"
case "$staging_key" in
  ssh-ed25519\ *) ;;
  *) printf '%s\n' "Staging public key is missing or has an unexpected format." >&2; exit 1 ;;
esac

tailscale_cli="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
if [[ ! -x "$tailscale_cli" ]]; then
  printf '%s\n' "Tailscale.app is required. Install it, sign in to the Vesta tailnet, then rerun this command." >&2
  exit 1
fi
mac_ip="$("$tailscale_cli" ip -4 | head -n 1)"
if [[ "$mac_ip" != "$TARGET_TAILNET_IP" ]]; then
  printf 'This setup is pinned to Mac tailnet address %s; this Mac reports %s.\n' "$TARGET_TAILNET_IP" "$mac_ip" >&2
  exit 1
fi

node_path="$(command -v node || true)"
npm_path="$(command -v npm || true)"
if [[ -z "$node_path" || -z "$npm_path" ]]; then
  printf '%s\n' "Install Node.js 22.19+ or 24+ with npm, then rerun this command." >&2
  exit 1
fi
if ! "$node_path" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (!(major === 22 && minor >= 19 || major >= 24)) process.exit(1)'; then
  printf '%s\n' "The SSH helper requires Node.js 22.19+ or 24+." >&2
  exit 1
fi
helper_dir="$HOME/.vesta-harness-staging/mac-ssh"
umask 077
mkdir -p "$helper_dir"
chmod 700 "$HOME/.vesta-harness-staging" "$helper_dir"
printf '%s\n' "Installing the version-matched SSH helper..."
"$npm_path" install --prefix "$helper_dir" --no-save --ignore-scripts --no-audit --no-fund "@deepseek-ai/dsh-ssh@$HELPER_VERSION"
helper="$helper_dir/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js"
actual_hash="$(shasum -a 256 "$helper" | awk '{print $1}')"
if [[ "$actual_hash" != "$HELPER_SHA256" ]]; then
  printf '%s\n' "Installed helper digest does not match the staging Harness; refusing setup." >&2
  exit 1
fi
ln -sfn "$node_path" "$helper_dir/node"
chmod 700 "$helper_dir/node_modules"

ssh_dir="$HOME/.ssh"
mkdir -p "$ssh_dir"
chmod 700 "$ssh_dir"
authorized_keys="$ssh_dir/authorized_keys"
touch "$authorized_keys"
chmod 600 "$authorized_keys"
if ! grep -Fq -- "$staging_key" "$authorized_keys"; then
  printf 'from="%s",no-agent-forwarding,no-X11-forwarding,no-pty %s vesta-harness-staging\n' "$VESTA_TAILNET_IP" "$staging_key" >> "$authorized_keys"
fi

remote_login_state="$(sudo /usr/sbin/systemsetup -getremotelogin)"
if ! grep -q 'On' <<< "$remote_login_state"; then
  printf '%s\n' "Enabling macOS Remote Login..."
  sudo /usr/sbin/systemsetup -setremotelogin on
fi

host_key="/etc/ssh/ssh_host_ed25519_key.pub"
if [[ ! -r "$host_key" ]]; then
  printf '%s\n' "macOS did not provide its SSH host key after Remote Login was enabled." >&2
  exit 1
fi
known_hosts_record="$MAC_SSH_ALIAS $(cat "$host_key")"
printf '%s\n' "$known_hosts_record" | ssh "$VESTA_ALIAS" 'umask 077; mkdir -p ~/.vesta-harness-staging/mac-ssh; cat > ~/.vesta-harness-staging/mac-ssh/known_hosts; chmod 600 ~/.vesta-harness-staging/mac-ssh/known_hosts'

printf '%s\n' "Setup complete. Mac SSH is pinned to its host key and the staging Vesta key is limited to Vesta's tailnet address."
printf '%s\n' "Start a new staging session and select the Vesta Mac preset."
