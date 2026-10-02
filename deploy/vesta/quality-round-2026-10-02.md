# Quality round — what the harness spends, measured (2026-10-02)

Hugo's next topic: "system prompts, memory consumption and saving, agentic skills and flows, presets and many other actual important things on vesta harness". This is the measured state before changing anything, the first cuts made on staging, and the questions that are his. Sources: production session logs (`~/.vesta-harness/sessions`, last 14 days, 43 sessions, 2,700 model steps) and the LiteLLM spend logs on the same box (ground truth for prompt sizes, since the harness's `inputTokens` leaves out the gateway's cache hits). Nothing here is read from upstream documentation alone.

## What a step costs

| Fixed part of every request | Median | Notes |
|---|---|---|
| Tool catalogue (JSON schemas) | 28.6k chars (~7k tokens) over 38 tools (min 26, max 79 with dormant groups woken) | the largest fixed cost; `bash` alone 3.3k chars, the five search MCP tools 3.9k, three `schedule_*` 1.9k, six memory tools 2.4k |
| System prompt | 10.4k chars (~2.6k tokens), min 5.7k, max 15.6k | mode text + the card about Hugo + working rules + upstream guidance paragraphs + MCP server descriptions |
| Memory notes recalled per turn | 1.85k chars (~460 tokens), 29 of 45 turns in the 12 newest sessions | `vesta-memory-notes` splice |
| Time reading | 250 chars, superseded in place | `time-context`, one live copy |
| Runtime context snapshot | 390 chars, superseded in place | mode / file policy |

LiteLLM, 14 days, every client on the lane (harness, voice, recon, routines, titles): 15,454 requests, 174.5M prompt tokens, 6.9M completion tokens, prompt median 1,036 (the small voice and title calls), harness prompts a median ~36–47k.

## Where the tokens went

| Finding | Measured | Cut |
|---|---|---|
| **Compaction churn.** Every preset compacts at `thresholdRatio 0.5` of the 114,688-token window with `maxTokens 16384` checkpoints. After a compaction the context is ~10k fixed + a ~9k checkpoint + 16 % retained (~18k) = ~37k, so the next ~20k of tool output triggers the next one. | 344 compactions in 40 sessions (one 28-turn session: 94); checkpoint output a median 9,135 tokens (18.4k chars) from a ~36k-token replay; 329 checkpoint calls = 2.94M output tokens. LiteLLM: the 325 requests with ≥ 6k completion tokens were 3.1M of the lane's 6.9M completion tokens (45 %) and 14M prompt tokens — roughly nine hours of decode in 14 days spent writing checkpoints that the next compaction replaces. 6 checkpoints truncated at the 16k cap, 5 "not smaller than the shadowed content". | Staging: `thresholdRatio 0.7` (80k; a full 32k reply still fits), `maxTokens 6144`, in all 11 presets. Expected (not yet measured): ~2.4× fewer compactions, each ≤ ⅓ the output; the effect is read from production logs after promotion with the same script. |
| **Effort drift.** Mode table says Auto runs `xhigh`. | Auto sessions started with `off` 12×, `medium` 9×, `xhigh` 16× — the picker rewrote the default (`settings.yaml` read `off` from 25 Sep, `medium` today). | Done (P24): `pinned` on `agent-default-model`, file back at `xhigh`. |
| **Dead tool in the catalogue.** `tool-web`'s `web_search` needs `dsh-web`'s search provider = DeepSeek's API (no key, and the egress gate refuses it) — composed in Companion, Build, Incognito, Orch, with a 330-char guidance paragraph in the prompt. | 1 call, 1 error in 14 days; the working path (`mcp__search__web_search` 224 calls, `fetch_url` 208) is the search MCP. | Staging: row `disabled: true` in the four presets (deferred, one-line flip back); Companion verified at 32 tools without it. |
| **Stale model-facing text in shared MCP servers.** Vision: "Use this instead of the built-in read_image tool, which does not work with the harness's text-only model" (`/srv/ai/compose/vision-mcp/app/server.py:57`) — false since 30 Sep and contradicts the working rules. Search: "for Hugo's Hermes" (`/srv/ai/compose/search-stack/search-mcp/server.py:30`). | In every prompt that lists those servers. | **Fixed 17:08 on Hugo's word:** both servers rebuilt with the corrected sentences (vision: "The harness model reads images itself with the built-in read_image tool; use this only when read_image fails or for a second opinion"; search: "for Vesta"); backups of both files and the previous images (`…:before-text-20261002-1708`) kept. Each harness shows the new text once its MCP client reconnects (next restart at the latest). |
| **Title generation on every prompt.** `session-title-all-prompts` re-titles after each user prompt. | 9 title calls in a 14-turn session, ~2.4k chars each. | Left as is (small); flag only. |
| **Upstream guidance paragraphs.** The checkout-location paragraph (`app-boot`) and the Web GUI / HMR paragraph (`web-app`) are developer notes, ~1.3k chars in every Vesta prompt; `includeHarnessIdentity` adds "You are an AI agent powered by DeepSeek Harness." | ~330 tokens per step. | Hugo chose both. Built on staging `9d156a9776`: `includeHarnessIdentity: false` on the system-prompt row; `vesta-modes` gained `shadowSections` — an empty section registered from each agent's own scope shadows a global section of the same name at assembly (upstream's own override mechanism), so `harness:source` and `app:web-surface` leave the prompt with no upstream edit. Awaiting the staging restart Hugo allows. |

## Flows and presets, as used

- Presets in 14 days: Auto 37 sessions, Ops 1, Companion 1, Routine 1 (routine threads), 3 without a preset (verify runs). Build, Research, Orch, Batch, Mac, Incognito, Default: not used in the window.
- Tools called: bash 1,822, edit 377, write 268, read 230, search MCP 449 (web 224, fetch 208, news 17), job_output 111, memory MCP 183 (read 67, write 62, search 39, list 15), todo 26, grep 23. Memory tool results are heavy: `memory_search` a median 23k chars, `memory_list` 18k.
- Steps per turn: median 2, p90 28, max 288. Background jobs are used (51 `background job` notices in 12 sessions).
- Skills: none existed — no `skills/` in either home (the presets compose `skill`, `skill-filesystem` and `tool-skill`, so the machinery was there). Hugo picked **research brief** first: `deploy/vesta/skills/research-brief/SKILL.md`, installed in the staging home; a staging session saw the catalog and loaded it with the `skill` tool (verified). User form `/research-brief`.

## Questions for Hugo (product, not plumbing)

1. Promote P25/P26 (gate, compaction retune, `web_search` deferred, prompt trims, the skill)? Hugo: "Not yet" (2026-10-02 evening); staging first for a while. The next 14-day read of the same script then shows the real effect.
2. The two stale MCP sentences: fixed (above).
3. Prompt trims: built on staging (above); production with the rest.
4. Skills: research brief done first (Hugo's pick). Next candidates: "verify and report" (the stop-at-milestone status format), "server change" (backup, change, check, log).
5. Memory: the recall side is the memory session's (Phase 1); the saving side (what `memory_write` captures, 62 writes in 14 days) and the 23k-char `memory_search` results are open — trim results server-side or in the plugin?

## How to re-measure

`session-usage.py` and `quality-measure.py` (kept in `deploy/vesta/verify/measure/`) over `~/.vesta-harness/sessions`; the compaction query is the `compaction/summary` events' `usage` and `shadowedTokenCount`; LiteLLM: `select count(*), sum(prompt_tokens), sum(completion_tokens) ... where completion_tokens >= 6000` on `LiteLLM_SpendLogs`.
