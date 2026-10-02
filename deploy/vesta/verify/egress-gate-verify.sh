#!/usr/bin/env bash
# Egress gate check (D26). Runs the preload in a standalone node on the machine named by VESTA_TARGET (vesta or local),
# then reads the staging/production journal for the gate's startup line. No harness traffic is generated.
#   deploy/vesta/verify/egress-gate-verify.sh            # vesta, staging unit
#   VESTA_TARGET=prod deploy/vesta/verify/egress-gate-verify.sh
set -uo pipefail
if [ "${VESTA_TARGET:-staging}" = "prod" ]; then UNIT=vesta-harness; REPO=/home/hugo/code/vesta-harness; else UNIT=vesta-harness-staging; REPO=/home/hugo/code/vesta-harness-staging; fi
GATE=$REPO/deploy/vesta/egress-gate.mjs
ssh vesta "NODE_OPTIONS='--import=$GATE' node --input-type=module -e '
import net from \"node:net\"
import { isAllowed } from \"$GATE\"
import { spawnSync } from \"node:child_process\"
import http from \"node:http\"
const results = []
const expect = (name, ok) => results.push(\`\${ok ? \"ok  \" : \"FAIL\"} \${name}\`)
expect(\"child env has no gate\", !(process.env.NODE_OPTIONS ?? \"\").includes(\"egress-gate\"))
expect(\"allow loopback\", isAllowed(\"127.0.0.1\") && isAllowed(\"localhost\") && isAllowed(\"::1\"))
expect(\"allow LAN + tailnet\", isAllowed(\"192.168.0.2\") && isAllowed(\"100.120.132.105\") && isAllowed(\"fd7a:115c:a1e0::1\"))
expect(\"allow push services\", isAllowed(\"web.push.apple.com\") && isAllowed(\"fcm.googleapis.com\") && isAllowed(\"updates.push.services.mozilla.com\") && isAllowed(\"db5p.notify.windows.com\"))
expect(\"deny public IP + names\", !isAllowed(\"203.0.113.1\") && !isAllowed(\"example.com\") && !isAllowed(\"harness-telemetry.deepseeksvc.com\") && !isAllowed(\"2001:db8::1\"))
expect(\"deny look-alikes\", !isAllowed(\"push.apple.com.evil.example\") && !isAllowed(\"notpush.apple.com\"))
const attempt = (host, port) => new Promise((resolve) => { const s = net.connect({ host, port }); s.on(\"error\", (e) => resolve(e.code)); s.on(\"connect\", () => { s.destroy(); resolve(\"CONNECTED\") }) })
const denied = await attempt(\"203.0.113.1\", 443)
expect(\`public IP connect -> \${denied}\`, denied === \"EGRESS_DENIED\")
const byName = await attempt(\"example.com\", 443)
expect(\`hostname connect -> \${byName}\`, byName === \"EGRESS_DENIED\")
const local = await attempt(\"127.0.0.1\", 1)
expect(\`loopback connect reaches the stack -> \${local}\`, local === \"ECONNREFUSED\" || local === \"CONNECTED\")
const viaFetch = await fetch(\"https://example.com/\").then(() => \"CONNECTED\", (e) => e.cause?.code ?? e.code ?? String(e))
expect(\`fetch() -> \${viaFetch}\`, viaFetch === \"EGRESS_DENIED\")
const viaHttp = await new Promise((resolve) => { const r = http.get(\"http://203.0.113.2/\", () => resolve(\"CONNECTED\")); r.on(\"error\", (e) => resolve(e.code)) })
expect(\`http.get() -> \${viaHttp}\`, viaHttp === \"EGRESS_DENIED\")
const child = spawnSync(process.execPath, [\"-e\", \"process.stdout.write(String(require(\\\"net\\\").Socket.prototype.connect.name))\"], { encoding: \"utf8\" })
expect(\`child process ungated (connect is \${child.stdout.trim()})\`, child.stdout.trim() !== \"gatedConnect\")
console.log(results.join(\"\\n\"))
process.exit(results.some((r) => r.startsWith(\"FAIL\")) ? 1 : 0)
' 2> >(grep -v '^vesta-egress-gate: active' >&2)"
rc=$?
echo "--- $UNIT journal: gate startup line"
ssh vesta "journalctl --user -u $UNIT --no-pager -o cat 2>/dev/null | grep -E '^vesta-egress-gate: (active|OFF|denied)' | tail -3"
echo "RESULT: $([ $rc = 0 ] && echo PASS || echo FAIL)"
exit $rc
