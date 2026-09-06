"""
Vesta voice — LiveKit agent worker.

Semantic turn-taking (LiveKit turn-detector) + Silero VAD + real barge-in, with:
  STT : SenseVoice (via the livekit-media sidecar, OpenAI-compatible, on the 3060)
        — transcripts may end with a perception note like "[tone: happy; laughing]"
  TTS : Kyutai (via the kyutai-tts sidecar, OpenAI-compatible, on the 3060)
  LLM : two modes, chosen per room at job start —
        * bridge mode (DSH_BRIDGE_URL set and the room is `dsh-<sessionId>`):
          the brain is the Vesta Harness Session behind that id. Each finished
          utterance is sent over a WebSocket to the Harness, which runs it as a
          normal user turn with the Session's tools and autonomy level and
          streams the assistant's text back to be spoken. Approval questions
          from the Harness are asked aloud and answered with a spoken yes/no
          (racing the on-screen card); "stop" and "switch to … mode" are
          handled here as commands and never reach the model.
        * direct mode (no bridge, or the room is not a Harness room): Qwen
          through LiteLLM with thinking disabled, plus a native web_search tool.

The agent itself is CPU-only; all GPU work is in the sidecars.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
import uuid
from typing import Any

import aiohttp
import httpx
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    RoomInputOptions,
    RunContext,
    WorkerOptions,
    cli,
    function_tool,
    llm,
)
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS, APIConnectOptions
from livekit.plugins import openai, silero
from livekit.plugins.turn_detector.english import EnglishModel

log = logging.getLogger("vesta-voice")

# ---------------------------------------------------------------- config
LITELLM_URL = os.environ.get("LITELLM_URL", "http://ai-litellm:4000/v1")
LITELLM_KEY = os.environ.get("LITELLM_KEY", "") or "EMPTY"
BRAIN_MODEL = os.environ.get("BRAIN_MODEL", "default")
MEDIA_URL = os.environ.get("MEDIA_URL", "http://livekit-media:8000/v1")        # SenseVoice STT sidecar
KYUTAI_URL = os.environ.get("KYUTAI_URL", "http://kyutai-tts:8000/v1")         # Kyutai TTS
SEARXNG_URL = os.environ.get("SEARXNG_URL", "http://ai-searxng:8080").rstrip("/")
TTS_MODEL = os.environ.get("TTS_MODEL", "kyutai/tts-1.6b-en_fr")
TTS_VOICE = os.environ.get("TTS_VOICE", "expresso/ex03-ex01_calm_001_channel1_1143s.wav")  # "calm"
TTS_SPEED = float(os.environ.get("TTS_SPEED", "1.2"))
# Voice backends. "moshi" = Kyutai moshi-server (streaming text in, streaming words out, see
# kyutai.py); "openai" / "sensevoice" = the OpenAI-compatible sidecars (batch, with tone notes).
TTS_BACKEND = os.environ.get("TTS_BACKEND", "openai").strip().lower()
STT_BACKEND = os.environ.get("STT_BACKEND", "sensevoice").strip().lower()
KYUTAI_WS_URL = os.environ.get("KYUTAI_WS_URL", "ws://127.0.0.1:8090")
KYUTAI_API_KEY = os.environ.get("KYUTAI_API_KEY", "public_token")
MAX_RESULTS = int(os.environ.get("MAX_RESULTS", "5"))

# Vesta Harness bridge. Empty URL = direct mode for every room.
DSH_BRIDGE_URL = os.environ.get("DSH_BRIDGE_URL", "").strip()
DSH_BRIDGE_SECRET = os.environ.get("DSH_BRIDGE_SECRET") or os.environ.get("LIVEKIT_API_SECRET", "")
DSH_ROOM_PREFIX = os.environ.get("DSH_ROOM_PREFIX", "dsh-")
GREETING = os.environ.get("GREETING", "")                       # spoken once on join when set
BRIDGE_GREETING = os.environ.get("BRIDGE_GREETING", "")         # bridge-mode variant (default: silent)
TURN_TIMEOUT_S = float(os.environ.get("DSH_TURN_TIMEOUT_S", "600"))  # a long tool turn may take minutes
COMMAND_TIMEOUT_S = float(os.environ.get("DSH_COMMAND_TIMEOUT_S", "10"))  # host reply to a spoken command
# No dead air: spoken as soon as the first tool call starts if the model has not said anything yet
# (empty disables), then a short progress line every PROGRESS_INTERVAL_S of silent tool work.
TOOL_ACK = os.environ.get("DSH_TOOL_ACK", "Let me check.").strip()
PROGRESS_INTERVAL_S = float(os.environ.get("DSH_PROGRESS_INTERVAL_S", "25"))
PROGRESS_PHRASES = [p.strip() for p in os.environ.get("DSH_PROGRESS_PHRASES", "Still on it.|Working on it.|Almost there.").split("|") if p.strip()]
# Turn-taking: how long after you stop before the agent takes the turn, and how long you must
# speak over it before it yields. LiveKit defaults are 0.5 / 6.0 / 0.5.
MIN_ENDPOINTING_S = float(os.environ.get("MIN_ENDPOINTING_S", "0.4"))
MAX_ENDPOINTING_S = float(os.environ.get("MAX_ENDPOINTING_S", "3.0"))
MIN_INTERRUPTION_S = float(os.environ.get("MIN_INTERRUPTION_S", "0.4"))

SYSTEM_PROMPT = os.environ.get("SYSTEM_PROMPT", (
    "You are Vesta's voice assistant. You are speaking out loud, so keep replies "
    "short, natural and easy to say — usually one to three sentences. Never use "
    "markdown, bullet points, emojis, headings or code blocks. If a question needs "
    "current facts, news, prices, or anything that may have changed, use the "
    "web_search tool, then answer from the results in one or two sentences. For "
    "small talk, just answer directly. "
    "You can also hear HOW the user sounds: some user messages end with a bracketed "
    "note like '[tone: happy; laughing]' describing their emotion and any sounds such "
    "as laughter. Use it to respond with matching warmth or empathy — share the laugh, "
    "soften if they sound frustrated, match their energy — but NEVER read the bracket "
    "aloud, repeat it, or say you detected it; just respond naturally as a person would."
))


# ---------------------------------------------------------------- direct-mode tool
@function_tool
async def web_search(context: RunContext, query: str) -> str:
    """Search the web for current, factual or up-to-date information — news, recent
    events, prices, releases, or any fact that may have changed. Not for small talk.

    Args:
        query: The search query.
    """
    try:
        async with httpx.AsyncClient(timeout=25) as h:
            r = await h.get(f"{SEARXNG_URL}/search", params={"q": query, "format": "json"})
            r.raise_for_status()
            data = r.json()
    except Exception as e:  # noqa: BLE001
        return f"Search failed for '{query}': {e}"
    results = (data.get("results") or [])[:MAX_RESULTS]
    if not results:
        return f"No results found for '{query}'."
    out = [f"Search results for '{query}':"]
    for i, res in enumerate(results, 1):
        out.append(
            f"{i}. {(res.get('title') or '').strip()}\n"
            f"   {(res.get('content') or '').strip()}\n"
            f"   ({(res.get('url') or '').strip()})"
        )
    return "\n".join(out)


# ---------------------------------------------------------------- spoken-text filter
_FENCE = "```"
_INLINE_MD = re.compile(r"(\*\*|__|`+|^\s{0,3}#{1,6}\s+|^\s*[-*]\s+|^\s*\d+\.\s+)", re.MULTILINE)
_URL = re.compile(r"https?://\S+")


class SpokenTextFilter:
    """Turns streamed markdown-ish assistant text into something worth reading aloud.

    Fenced code blocks are dropped from speech (they stay on screen in the
    Harness transcript) and replaced once by a short spoken aside; inline
    markdown markers and URLs are stripped. Works delta by delta, so a fence
    that spans deltas is still handled.
    """

    ASIDE = " The code is on screen. "

    def __init__(self) -> None:
        self._in_fence = False
        self._carry = ""

    def feed(self, delta: str) -> str:
        text = self._carry + delta
        self._carry = ""
        out: list[str] = []
        while text:
            idx = text.find(_FENCE)
            if idx < 0:
                # keep a partial fence prefix (` or ``) for the next delta
                tail = len(text) - len(text.rstrip("`"))
                if 0 < tail < 3:
                    self._carry = text[-tail:]
                    text = text[:-tail]
                if not self._in_fence:
                    out.append(text)
                break
            head, text = text[:idx], text[idx + len(_FENCE):]
            if not self._in_fence:
                out.append(head)
                out.append(self.ASIDE)
                self._in_fence = True
                # skip the info string up to end of line
                nl = text.find("\n")
                text = text[nl + 1:] if nl >= 0 else ""
            else:
                self._in_fence = False
        spoken = "".join(out)
        spoken = _URL.sub("a link on screen", spoken)
        spoken = _INLINE_MD.sub("", spoken)
        return spoken

    def flush(self) -> str:
        tail, self._carry = self._carry, ""
        return "" if self._in_fence else tail


# ---------------------------------------------------------------- spoken commands
_PERCEPTION_NOTE = re.compile(r"\s*\[tone:[^\]]*\]\s*$", re.IGNORECASE)
_YES = re.compile(
    r"^\W*(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|allow|allowed|approve|approved|fine|"
    r"please do|go for it|confirm|confirmed|affirmative|absolutely|of course)\b", re.IGNORECASE)
_NO = re.compile(
    r"^\W*(no|nope|nah|don'?t|do not|deny|denied|reject|rejected|cancel|stop|never|negative|"
    r"not now|refuse)\b", re.IGNORECASE)
_STOP = re.compile(
    r"^\W*((stop\W*)+|stop it|stop that|cancel|cancel that|never ?mind|abort|halt|"
    r"that'?s enough|enough)\W*$", re.IGNORECASE)
_PERMISSION_CONTEXT = re.compile(r"\b(mode|permissions?|access( level)?|autonomy)\b", re.IGNORECASE)
_PERMISSION_VERB = re.compile(
    r"\b(switch|change|set|go|put|move|enter|use|turn|activate|enable|give|grant|drop)\b", re.IGNORECASE)
_PRESET_WORDS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\b(read[- ]?only|safe|safest|restricted|locked[- ]down)\b", re.IGNORECASE), "read-only"),
    (re.compile(r"\b(workspace|work ?space|normal|standard|default)\b", re.IGNORECASE), "workspace-write"),
    (re.compile(r"\b(full|danger(ous)?|unrestricted|unsafe|everything|god)\b", re.IGNORECASE), "danger-full-access"),
]
_MODE_QUERY = re.compile(r"\b(what|which)\b.{0,40}\b(mode|permission|permissions|access level|autonomy)\b", re.IGNORECASE)
_ESCALATION = re.compile(r"^escalate sandbox to (\S+):\s*(.*)$", re.DOTALL)
_PRESET_SPOKEN = {"read-only": "read-only mode", "workspace-write": "workspace mode",
                  "danger-full-access": "full access mode", "custom": "a custom permission setup"}
_MODE_SPOKEN = {"read-only": "read-only access", "workspace-write": "workspace write access",
                "danger-full-access": "full access"}


def strip_perception(text: str) -> str:
    """Drop the STT sidecar's trailing '[tone: …]' note before matching commands."""
    return _PERCEPTION_NOTE.sub("", text).strip()


def classify_decision(text: str) -> bool | None:
    """True for a spoken yes, False for a spoken no, None when the utterance is neither."""
    t = strip_perception(text)
    if _NO.match(t):
        return False
    if _YES.match(t):
        return True
    return None


def is_stop(text: str) -> bool:
    return _STOP.match(strip_perception(text)) is not None


def permission_request(text: str) -> str | None:
    """The preset a 'switch to … mode' utterance names, or None when it is not such a command."""
    t = strip_perception(text)
    if len(t.split()) > 12 or not _PERMISSION_CONTEXT.search(t) or not _PERMISSION_VERB.search(t):
        return None
    for pattern, preset in _PRESET_WORDS:
        if pattern.search(t):
            return preset
    return None


def is_mode_query(text: str) -> bool:
    t = strip_perception(text)
    return len(t.split()) <= 12 and _MODE_QUERY.search(t) is not None and permission_request(t) is None


def spoken_preset(preset: str) -> str:
    return _PRESET_SPOKEN.get(preset, f"{preset.replace('-', ' ')} mode")


_APPROVE = re.compile(
    r"^\W*(approve|approved|yes|yeah|yep|go ahead|looks good|ship it|do it|proceed|okay|ok|sure|fine)\b",
    re.IGNORECASE)
_ORDINALS = {"first": 0, "one": 0, "1": 0, "second": 1, "two": 1, "2": 1, "third": 2, "three": 2, "3": 2,
             "fourth": 3, "four": 3, "4": 3, "fifth": 4, "five": 4, "5": 4, "sixth": 5, "six": 5, "6": 5, "last": -1}


def _labels(item: dict[str, Any]) -> list[str]:
    return [str(o.get("label", "")) for o in (item.get("options") or []) if o.get("label")]


def question_prompt(item: dict[str, Any]) -> str:
    """How one ask_user_question item (or a plan review) is spoken."""
    intent = item.get("intent") or {}
    if intent.get("kind") == "plan-review":
        return "The plan is on screen. Say approve to go ahead, or tell me what to change."
    q = str(item.get("question", "")).strip().rstrip(".")
    if q and not q.endswith("?"):
        q += "?"
    labels = _labels(item)
    if not labels:
        return q
    shown = labels[:6]
    joiner = ", and " if item.get("multiSelect") else ", or "
    opts = shown[0] if len(shown) == 1 else ", ".join(shown[:-1]) + joiner + shown[-1]
    more = " There are more options on screen." if len(labels) > 6 else ""
    return f"{q} Options: {opts}.{more}"


def match_options(text: str, item: dict[str, Any]) -> list[str]:
    """Option labels the utterance names, by label text or by ordinal ("the second one")."""
    t = strip_perception(text).lower()
    labels = _labels(item)
    if not labels:
        return []
    hits = [label for label in labels if label.lower().strip() and (label.lower().strip() in t or (len(t) >= 3 and t in label.lower()))]
    if not hits:
        for w in re.findall(r"[a-z0-9]+", t):
            if w in _ORDINALS:
                idx = _ORDINALS[w]
                if idx == -1:
                    hits.append(labels[-1])
                elif idx < len(labels):
                    hits.append(labels[idx])
                break
    return hits if item.get("multiSelect") else hits[:1]


def classify_answer(text: str, item: dict[str, Any]) -> dict[str, Any]:
    """The wire answer for one item: selected labels, or the utterance as free text."""
    raw = strip_perception(text)
    intent = item.get("intent") or {}
    if intent.get("kind") == "plan-review":
        if _APPROVE.match(raw):
            return {"id": item["id"], "selected": [str(intent.get("approve") or "Approve")]}
        return {"id": item["id"], "selected": [], "custom": raw}
    selected = match_options(raw, item)
    if selected:
        return {"id": item["id"], "selected": selected}
    return {"id": item["id"], "selected": [], "custom": raw}


def approval_question(tool: str, reason: str | None) -> str:
    """One spoken sentence for a Harness approval request."""
    name = f"The {tool.replace('_', ' ')} tool"
    m = _ESCALATION.match(reason or "")
    if m:
        mode = _MODE_SPOKEN.get(m.group(1), m.group(1).replace("-", " "))
        why = m.group(2).strip().rstrip(".")
        # The justification is the model's own sentence; keep it whole rather than splicing it.
        return f"{name} wants {mode}. {why[0].upper() + why[1:] + '. ' if why else ''}Allow it?"
    if reason:
        return f"{name} needs approval: {reason.strip().rstrip('.')}. Allow it?"
    return f"{name} needs your approval. Allow it?"


# ---------------------------------------------------------------- bridge
class DshBridge:
    """One WebSocket to the Harness per room/job. Sends utterances, receives the reply stream."""

    def __init__(self, url: str, secret: str, room: str) -> None:
        self._url = url
        self._secret = secret
        self._room = room
        self._http: aiohttp.ClientSession | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._reader: asyncio.Task[None] | None = None
        self._turn: asyncio.Queue[dict[str, Any]] | None = None
        # Assistant text that arrives while no LLM stream is open (a typed turn
        # during the call, the continuation after an approval) is spoken through
        # session.say() from this queue; None ends the utterance.
        self._passive: asyncio.Queue[str | None] | None = None
        self._command_reply: asyncio.Future[str] | None = None
        self._session: AgentSession | None = None
        self.session_id: str | None = None
        self.permission: str = "custom"
        self.pending_approval: dict[str, Any] | None = None
        # ask_user_question / plan review in flight: items asked one at a time, answers collected
        self.pending_question: dict[str, Any] | None = None
        self.closed = asyncio.Event()

    def attach(self, session: AgentSession) -> None:
        self._session = session

    async def connect(self, timeout: float = 10.0) -> None:
        self._http = aiohttp.ClientSession()
        self._ws = await self._http.ws_connect(
            self._url,
            headers={"Authorization": f"Bearer {self._secret}", "X-Vesta-Room": self._room},
            heartbeat=20.0,
            timeout=aiohttp.ClientWSTimeout(ws_close=timeout),
        )
        ready = await asyncio.wait_for(self._ws.receive_json(), timeout)
        if ready.get("type") != "ready":
            raise RuntimeError(f"bridge handshake: unexpected {ready!r}")
        self.session_id = str(ready.get("sessionId"))
        self.permission = str(ready.get("permission") or "custom")
        self._reader = asyncio.create_task(self._read(), name="dsh-bridge-reader")
        log.info("bridge bound: room=%s session=%s permission=%s", self._room, self.session_id, self.permission)

    async def _read(self) -> None:
        assert self._ws is not None
        try:
            async for msg in self._ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    if msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.ERROR):
                        break
                    continue
                try:
                    frame = json.loads(msg.data)
                except ValueError:
                    continue
                self._dispatch(frame)
        finally:
            self.closed.set()
            if self._turn is not None:
                self._turn.put_nowait({"type": "error", "message": "bridge closed"})
            self._end_passive()

    def _dispatch(self, frame: dict[str, Any]) -> None:
        kind = frame.get("type")
        if kind == "approval":
            self.pending_approval = {"id": str(frame.get("id")), "tool": str(frame.get("tool", "a tool")),
                                     "reason": frame.get("reason")}
            question = approval_question(self.pending_approval["tool"], self.pending_approval["reason"])
            log.info("harness approval asked: %s", question)
            self._ask(question)
        elif kind == "question":
            items = [i for i in (frame.get("items") or []) if isinstance(i, dict) and i.get("id")]
            if items:
                self.pending_question = {"id": str(frame.get("id")), "items": items, "index": 0, "answers": []}
                log.info("harness question asked: %s", question_prompt(items[0]))
                self._ask(question_prompt(items[0]))
        elif kind == "question-done":
            if self.pending_question is not None and self.pending_question["id"] == str(frame.get("id")):
                log.info("harness question settled elsewhere")
                self.pending_question = None
        elif kind == "approval-done":
            if self.pending_approval is not None and self.pending_approval["id"] == str(frame.get("id")):
                log.info("harness approval settled: %s", frame.get("outcome"))
                self.pending_approval = None
        elif kind == "permission":
            self.permission = str(frame.get("preset") or "custom")
            log.info("harness permission now %s", self.permission)
        elif kind == "say":
            text = str(frame.get("text", ""))
            if self._command_reply is not None and not self._command_reply.done():
                self._command_reply.set_result(text)
            else:
                self._say(text)
        elif kind == "error" and self._command_reply is not None and not self._command_reply.done():
            self._command_reply.set_result(str(frame.get("message", "That did not work.")))
        elif self._turn is not None:
            if kind in ("speak", "done", "error", "status"):
                self._turn.put_nowait(frame)
        elif kind == "speak":
            self._passive_feed(str(frame.get("text", "")))
        elif kind == "done":
            self._end_passive()
        elif kind == "status":
            log.info("harness tool: %s", frame.get("tool"))
        elif kind == "error":
            log.warning("harness error outside a turn: %s", frame.get("message"))

    def _ask(self, text: str) -> None:
        """Speak a question: through the open reply stream (which then ends so the next
        utterance is judged as the answer) or, with no stream open, by itself."""
        if self._turn is not None:
            self._turn.put_nowait({"type": "ask", "text": text})
        else:
            self._end_passive()
            self._say(text)

    def _say(self, text: str) -> None:
        if self._session is None or not text:
            return
        try:
            self._session.say(text)
        except Exception as e:  # noqa: BLE001
            log.warning("say failed: %s", e)

    def _passive_feed(self, delta: str) -> None:
        if self._session is None:
            return
        if self._passive is None:
            queue: asyncio.Queue[str | None] = asyncio.Queue()
            self._passive = queue

            async def spoken() -> Any:
                text_filter = SpokenTextFilter()
                while True:
                    item = await queue.get()
                    if item is None:
                        tail = text_filter.flush()
                        if tail:
                            yield tail
                        return
                    piece = text_filter.feed(item)
                    if piece:
                        yield piece

            try:
                handle = self._session.say(spoken())
            except Exception as e:  # noqa: BLE001
                log.warning("passive say failed: %s", e)
                self._passive = None
                return

            def _on_done(h: Any, q: asyncio.Queue[str | None] = queue) -> None:
                # Barge-in over unprompted speech: stop the harness turn as well, not only the audio.
                if getattr(h, "interrupted", False) and self._passive is q:
                    self._end_passive()
                    asyncio.get_running_loop().create_task(self.interrupt())

            handle.add_done_callback(_on_done)
        self._passive.put_nowait(delta)

    def _end_passive(self) -> None:
        if self._passive is not None:
            self._passive.put_nowait(None)
            self._passive = None

    async def send_turn(self, text: str) -> asyncio.Queue[dict[str, Any]]:
        if self._ws is None or self._ws.closed:
            raise RuntimeError("bridge is not connected")
        if self._passive is not None:
            # The user spoke over passively spoken text: that turn is over for the ear and the Harness alike.
            self._end_passive()
            await self.interrupt()
        self._turn = asyncio.Queue()
        await self._ws.send_json({"type": "turn", "text": text})
        return self._turn

    async def interrupt(self) -> None:
        if self._ws is not None and not self._ws.closed:
            await self._ws.send_json({"type": "interrupt"})

    async def decide(self, allow: bool) -> str:
        pending, self.pending_approval = self.pending_approval, None
        if pending is None or self._ws is None or self._ws.closed:
            return "There is nothing waiting for approval."
        await self._ws.send_json({"type": "approval-decision", "id": pending["id"], "allow": allow})
        return "Okay, going ahead." if allow else "Okay, denied."

    async def answer_question(self, text: str) -> str:
        """Record the spoken answer to the current item; ask the next item or send the set."""
        pq = self.pending_question
        if pq is None:
            return "There is no question waiting."
        item = pq["items"][pq["index"]]
        pq["answers"].append(classify_answer(text, item))
        pq["index"] += 1
        if pq["index"] < len(pq["items"]):
            return question_prompt(pq["items"][pq["index"]])
        self.pending_question = None
        if self._ws is None or self._ws.closed:
            return "The call is not connected to the harness."
        await self._ws.send_json({"type": "question-answer", "id": pq["id"], "answers": pq["answers"]})
        last = pq["answers"][-1]
        return "Okay." if last.get("selected") else "Okay, passing that on."

    async def request_permission(self, preset: str) -> str:
        if self._ws is None or self._ws.closed:
            raise RuntimeError("bridge is not connected")
        self._command_reply = asyncio.get_running_loop().create_future()
        await self._ws.send_json({"type": "permission", "preset": preset})
        try:
            reply = await asyncio.wait_for(self._command_reply, COMMAND_TIMEOUT_S)
        except asyncio.TimeoutError:
            return "The harness did not answer."
        finally:
            self._command_reply = None
        if reply.startswith("Switched to"):
            self.permission = preset
        return reply

    def end_turn(self) -> None:
        self._turn = None

    async def close(self) -> None:
        if self._reader is not None:
            self._reader.cancel()
        if self._ws is not None and not self._ws.closed:
            await self._ws.close()
        if self._http is not None:
            await self._http.close()


class DshBridgeLLM(llm.LLM):
    """LiveKit LLM whose 'model' is a Vesta Harness Session reached over the bridge."""

    def __init__(self, bridge: DshBridge) -> None:
        super().__init__()
        self._bridge = bridge

    @property
    def model(self) -> str:
        return "vesta-harness"

    @property
    def provider(self) -> str:
        return "dsh"

    def chat(
        self,
        *,
        chat_ctx: llm.ChatContext,
        tools: list[llm.Tool] | None = None,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
        **_: Any,
    ) -> llm.LLMStream:
        # The Harness owns the turn end-to-end; never let LiveKit retry a turn.
        no_retry = APIConnectOptions(max_retry=0, retry_interval=conn_options.retry_interval, timeout=conn_options.timeout)
        return DshBridgeStream(self, self._bridge, chat_ctx=chat_ctx, tools=tools or [], conn_options=no_retry)


class DshBridgeStream(llm.LLMStream):
    def __init__(self, owner: DshBridgeLLM, bridge: DshBridge, *, chat_ctx: llm.ChatContext,
                 tools: list[llm.Tool], conn_options: APIConnectOptions) -> None:
        super().__init__(owner, chat_ctx=chat_ctx, tools=tools, conn_options=conn_options)
        self._bridge = bridge

    @staticmethod
    def _last_user_text(chat_ctx: llm.ChatContext) -> str:
        for item in reversed(chat_ctx.items):
            if getattr(item, "type", None) == "message" and getattr(item, "role", None) == "user":
                parts = [p for p in item.content if isinstance(p, str)]
                return "\n".join(parts).strip()
        return ""

    def _reply(self, request_id: str, text: str) -> None:
        self._event_ch.send_nowait(llm.ChatChunk(
            id=request_id, delta=llm.ChoiceDelta(role="assistant", content=text)))

    async def _run(self) -> None:
        text = self._last_user_text(self._chat_ctx)
        request_id = f"vesta-{uuid.uuid4().hex[:12]}"
        if not text:
            return
        # Spoken approvals and commands are settled here; the model never sees them.
        if self._bridge.pending_approval is not None:
            decision = classify_decision(text)
            if decision is None:
                self._reply(request_id, "Say yes to allow it, or no to deny it. You can also answer on screen.")
            else:
                self._reply(request_id, await self._bridge.decide(decision))
            return
        if self._bridge.pending_question is not None:
            self._reply(request_id, await self._bridge.answer_question(text))
            return
        if is_stop(text):
            await self._bridge.interrupt()
            self._reply(request_id, "Okay, stopped.")
            return
        if is_mode_query(text):
            self._reply(request_id, f"You're in {spoken_preset(self._bridge.permission)}.")
            return
        preset = permission_request(text)
        if preset is not None:
            self._reply(request_id, await self._bridge.request_permission(preset))
            return
        queue = await self._bridge.send_turn(text)
        spoken = SpokenTextFilter()
        interrupted = False
        spoken_any = False
        tool_active = False
        last_speech_at = time.monotonic()
        deadline = last_speech_at + TURN_TIMEOUT_S
        progress_index = 0
        try:
            while True:
                try:
                    frame = await asyncio.wait_for(queue.get(), 1.0)
                except asyncio.TimeoutError:
                    now = time.monotonic()
                    if now > deadline:
                        raise
                    if (tool_active and PROGRESS_INTERVAL_S > 0 and progress_index < len(PROGRESS_PHRASES)
                            and now - last_speech_at >= PROGRESS_INTERVAL_S):
                        self._reply(request_id, " " + PROGRESS_PHRASES[progress_index] + " ")
                        progress_index += 1
                        last_speech_at = now
                    continue
                kind = frame.get("type")
                if kind == "speak":
                    piece = spoken.feed(str(frame.get("text", "")))
                    if piece:
                        self._event_ch.send_nowait(llm.ChatChunk(
                            id=request_id, delta=llm.ChoiceDelta(role="assistant", content=piece)))
                        if piece.strip():
                            spoken_any = True
                            last_speech_at = time.monotonic()
                elif kind == "done":
                    tail = spoken.flush()
                    if tail:
                        self._event_ch.send_nowait(llm.ChatChunk(
                            id=request_id, delta=llm.ChoiceDelta(role="assistant", content=tail)))
                    break
                elif kind == "ask":
                    # An approval question: speak it and close this stream so the
                    # next utterance is judged as the answer. The turn's later
                    # text arrives with no stream open and is spoken passively.
                    tail = spoken.flush()
                    self._reply(request_id, (tail + " " if tail else "") + str(frame.get("text", "")))
                    break
                elif kind == "error":
                    raise RuntimeError(f"harness: {frame.get('message', 'turn failed')}")
                elif kind == "status":
                    log.info("harness tool: %s", frame.get("tool"))
                    tool_active = True
                    if not spoken_any and TOOL_ACK:
                        # The model went straight to tools: fill the silence once.
                        self._reply(request_id, TOOL_ACK + " ")
                        spoken_any = True
                        last_speech_at = time.monotonic()
        except asyncio.CancelledError:
            interrupted = True
            raise
        finally:
            self._bridge.end_turn()
            if interrupted:
                # Barge-in: the user cut the reply off; abort the Harness turn but keep its inbox.
                try:
                    await asyncio.shield(self._bridge.interrupt())
                except Exception:  # noqa: BLE001
                    pass


# ---------------------------------------------------------------- agent
class Assistant(Agent):
    def __init__(self, *, bridged: bool) -> None:
        if bridged:
            # The Harness owns the system prompt and the tools; these instructions are never sent.
            super().__init__(instructions="You are Vesta.", tools=[])
        else:
            super().__init__(instructions=SYSTEM_PROMPT, tools=[web_search])


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    room = ctx.room.name or ""
    bridge: DshBridge | None = None
    brain: llm.LLM
    if DSH_BRIDGE_URL and room.startswith(DSH_ROOM_PREFIX):
        candidate = DshBridge(DSH_BRIDGE_URL, DSH_BRIDGE_SECRET, room)
        try:
            await candidate.connect()
            bridge = candidate
        except Exception as e:  # noqa: BLE001
            log.warning("bridge unavailable for room %s (%s); falling back to direct mode", room, e)
            await candidate.close()
    if bridge is not None:
        brain = DshBridgeLLM(bridge)
        ctx.add_shutdown_callback(bridge.close)
    else:
        brain = openai.LLM(
            model=BRAIN_MODEL, base_url=LITELLM_URL, api_key=LITELLM_KEY,
            temperature=0.4,
            # Qwen `default` is a reasoning model — disable thinking or the whole
            # token budget is spent on hidden <think> tokens.
            extra_body={"chat_template_kwargs": {"enable_thinking": False}},
        )

    if STT_BACKEND == "moshi":
        from kyutai import KyutaiSTT
        stt_engine = KyutaiSTT(url=KYUTAI_WS_URL, api_key=KYUTAI_API_KEY, language="en")
    else:
        stt_engine = openai.STT(model="whisper-1", language="en", base_url=MEDIA_URL, api_key="not-needed")
    if TTS_BACKEND == "moshi":
        from kyutai import KyutaiTTS
        tts_engine = KyutaiTTS(url=KYUTAI_WS_URL, voice=TTS_VOICE, api_key=KYUTAI_API_KEY, speed=TTS_SPEED)
    else:
        # response_format=pcm: the Kyutai sidecar streams raw 24 kHz s16le while it is
        # still generating, and the plugin pushes bytes as they arrive, so playback
        # starts ~200 ms into a sentence instead of after the whole sentence renders.
        tts_engine = openai.TTS(
            model=TTS_MODEL, voice=TTS_VOICE, speed=TTS_SPEED,
            base_url=KYUTAI_URL, api_key="not-needed", response_format="pcm",
        )
    log.info("voice backends: stt=%s tts=%s", STT_BACKEND, TTS_BACKEND)
    session = AgentSession(
        stt=stt_engine,
        llm=brain,
        tts=tts_engine,
        vad=silero.VAD.load(),
        turn_detection=EnglishModel(),
        allow_interruptions=True,          # barge-in: user speech cuts off the reply
        min_interruption_duration=MIN_INTERRUPTION_S,
        min_endpointing_delay=MIN_ENDPOINTING_S,
        max_endpointing_delay=MAX_ENDPOINTING_S,
    )
    # Keep the agent alive across browser reconnects: the default closes the
    # session when the linked participant drops, which left later joins of the
    # same room with no agent at all. RoomIO re-links the next participant; the
    # job ends when LiveKit closes the empty room.
    await session.start(
        agent=Assistant(bridged=bridge is not None),
        room=ctx.room,
        room_input_options=RoomInputOptions(close_on_disconnect=False),
    )
    if bridge is not None:
        bridge.attach(session)   # passive speech and approval questions need the running session
    greeting = BRIDGE_GREETING if bridge is not None else GREETING
    if greeting:
        # A fixed TTS line, NOT an LLM call: a system-only generate_reply 400s on LiteLLM.
        await session.say(greeting)


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
