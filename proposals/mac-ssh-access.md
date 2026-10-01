# Mac shell and filesystem access from Vesta Harness

**Status:** staging prototype installed; Mac enrollment awaits approval of Remote Login setup.

## Goal

Keep the Harness, model calls, and session history on Vesta. Let a user explicitly start a session with the first target machine—their Mac—and use that Mac's shell and filesystem. The initial setup should take no more than four terminal commands, ideally one command copied from the Harness.

The initial target is this Mac. Access runs as the signed-in macOS account, with the user's full account permissions. It does not use `sudo` for session commands. Setup may ask for an administrator password once to enable macOS Remote Login.

## Connection proposal

Assume every device that participates in Harness must be connected to the tailnet whenever Harness is expected to be available. Use on-demand OpenSSH connections from Vesta to the Mac over Tailscale. The Mac is already an online peer visible to Vesta. Setup should enable Remote Login, install a staging-only public key, and register a staging-specific SSH alias with strict host-key checking. The public key should be restricted to connections from Vesta's tailnet address. The server's private key and known-hosts entry stay under the staging Harness home; no key material enters the repository or session log.

The preset's SSH service starts when the first Vesta Mac session is created and is shared by later Mac sessions until the staging process restarts. The Mac must be awake and connected to Tailscale before that first session. The SSH provider does not reconnect after transport loss; staging must restart after a lost connection. An interrupted operation remains unconfirmed and is never replayed.

If direct tailnet SSH setup proves awkward, a Mac-initiated reverse SSH tunnel bound to Vesta loopback is a viable fallback. A temporary check confirmed that Vesta accepts loopback-only remote forwarding; no persistent port or configuration was left behind.

## Session composition

Add a dedicated `Vesta Mac` agent preset on staging. Selecting it attaches the Mac to that session; other staging sessions retain their current local tools. The preset composes the remote filesystem, subprocess, sandbox, and shell/file tools in its own agent scope. It uses the existing SSH provider family and the selected session permission preset.

The first milestone is a dedicated Vesta Mac agent preset with the existing SSH providers scoped to that session. The Vesta workspace record and file pane remain local. Because Web sessions retain their Vesta cwd, the preset instructs Bash calls to pass an absolute Mac workdir and filesystem calls to use absolute Mac paths. A later milestone can add remote-workspace UI integration.

## Setup flow

The current staging prototype uses a one-command Mac setup script, rather than a Harness Connect button. The user runs it on the Mac over the existing authenticated ssh vesta connection. It installs the pinned helper version, adds a Vesta staging key restricted to Vesta's tailnet IP, enables macOS Remote Login if it is off, and sends the Mac host key back to staging for strict pinning. The script does not alter unrelated SSH authentication settings. macOS Remote Login is a system SSH service, so the user must approve enabling it before the first connection.

The staging service keeps the private key, SSH alias, and pinned host key under the staging Harness home. The Vesta Mac preset uses absolute Mac paths because the Web session cwd and file pane remain on Vesta. Revoke support and a Harness setup button remain follow-up work.

## Staging acceptance criteria

- Setup uses at most four user-entered terminal commands, including the command to launch the installer.
- The SSH connection uses the Mac's Tailscale address, a staging-only key, strict host-key checking, and a helper digest check.
- A `Vesta Mac` session runs `pwd`, reads a known file, and creates/removes a temporary file on the Mac through the normal session tools.
- A normal staging session continues to use Vesta's local filesystem and shell.
- Mac disconnects produce an explicit unavailable/unknown-operation result; commands are never automatically replayed. The preset needs a staging restart after transport loss.
- No production checkout, service, or home is changed during this work.

## Known limits

The current SSH providers support Linux and macOS endpoints; Windows is outside the first version. The preset connection is shared and non-reconnecting; the Vesta web workspace tree, previews, and changed-files presentation need separate remote-path integration. Setup currently has no Harness button or revoke command. `danger-full-access` means the session can use the Mac account's accessible files and commands; it does not grant root access.
