# Vesta Harness on vesta — ops runbook

Everything here runs as `hugo` on vesta from the source checkout `~/code/vesta-harness` (branch `vesta`), with a **fresh Harness home** `~/.vesta-harness`. The rc.7 install (`~/code/dsh`, `~/.dsh`, unit `dsh-web`, serve `:8790`) is left untouched as the rollback until cutover.

## Layout

| What | Where |
|---|---|
| Source checkout | `~/code/vesta-harness` (origin `hugoacfs/vesta-harness`, upstream `deepseek-ai/deepseek-harness`) |
| Harness home | `~/.vesta-harness` — `profiles/vesta/`, `settings.yaml`, `.credentials.yaml` (chmod 600), `.agent-presets/vesta-orch/` |
| Service | systemd `--user` unit `vesta-harness` → `node apps/cli/lib/bin.js --profile vesta --host 127.0.0.1 --port 3081 --trusted-host vesta.tail22b555.ts.net --no-open` |
| Tailnet URL | `https://vesta.tail22b555.ts.net:8791` (tailscale serve → `127.0.0.1:3081`); `:8790` stays on the old install until cutover |
| Templates | this directory: `profiles/vesta/*`, `settings.yaml`, `agent-presets/vesta-orch/*`, `vesta-harness.service` |

## Prerequisites (once)

Node ≥ 22.19 and pnpm are installed (`/usr/local/bin`). The Landlock sandbox launcher is a native binary built per architecture; without it only the `danger-full-access` permission preset works (`read-only` / `workspace-write` fail closed).

```bash
sudo apt-get install -y musl-tools
```

## Build

```bash
cd ~/code/vesta-harness
pnpm install --frozen-lockfile
pnpm --filter @deepseek-ai/node-addon-landlock-run-workspace run build:native   # sandbox binary (needs musl-tools)
pnpm run build                                                        # host + client + frontend
```

## Home

```bash
mkdir -p ~/.vesta-harness/profiles ~/.vesta-harness/.agent-presets
cp -r ~/code/vesta-harness/deploy/vesta/profiles/vesta ~/.vesta-harness/profiles/
cp ~/code/vesta-harness/deploy/vesta/settings.yaml ~/.vesta-harness/settings.yaml
cp -r ~/code/vesta-harness/deploy/vesta/agent-presets/vesta-orch ~/.vesta-harness/.agent-presets/
install -m 600 ~/.dsh/.credentials.yaml ~/.vesta-harness/.credentials.yaml   # VESTA_API_KEY; never in git
```

Check the composed tree before booting:

```bash
cd ~/code/vesta-harness && DSH_HOME=~/.vesta-harness node apps/cli/lib/bin.js --profile vesta --dump-config | grep -E 'vesta|mcp-'
```

## Service and tailnet

```bash
install -m 644 ~/code/vesta-harness/deploy/vesta/vesta-harness.service ~/.config/systemd/user/vesta-harness.service
systemctl --user daemon-reload && systemctl --user enable --now vesta-harness
systemctl --user status vesta-harness --no-pager
tailscale serve --bg --https=8791 http://127.0.0.1:3081
```

## Verify

- `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3081/` → `200`
- `https://vesta.tail22b555.ts.net:8791` shows the Vesta brand (ember orb, "Vesta Harness") and the ember theme.
- A new session answers through Qwen (`default`); `mcp__memory__*` / `mcp__search__*` appear in the tool list; the hero shows `vesta-orch`; `/permission` lists `read-only`, `workspace-write`, `danger-full-access`.
- `:8790` still serves the old install.

## Update

```bash
cd ~/code/vesta-harness && git pull --ff-only origin vesta && pnpm install --frozen-lockfile && pnpm run build && systemctl --user restart vesta-harness
```

## Rollback

`systemctl --user stop vesta-harness` — `:8790` never moved. After cutover (Phase C), `tailscale serve --bg --https=8790 http://127.0.0.1:3080` and `systemctl --user start dsh-web` restore the rc.7 install.
