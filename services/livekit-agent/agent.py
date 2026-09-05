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
MAX_RESULTS = int(os.environ.get("MAX_RESULTS", "5"))

# Vesta Harness bridge. Empty URL = direct mode for every room.
DSH_BRIDGE_URL = os.environ.get("DSH_BRIDGE_URL", "").strip()
DSH_BRIDGE_SECRET = os.environ.get("DSH_BRIDGE_SECRET") or os.environ.get("LIVEKIT_API_SECRET", "")
DSH_ROOM_PREFIX = os.environ.get("DSH_ROOM_PREFIX", "dsh-")
GREETING = os.environ.get("GREETING", "")                       # spoken once on join when set
BRIDGE_GREETING = os.environ.get("BRIDGE_GREETING", "")         # bridge-mode variant (default: silent)
TURN_TIMEOUT_S = float(os.environ.get("DSH_TURN_TIMEOUT_S", "600"))  # a long tool turn may take minutes
COMMAND_TIMEOUT_S = float(os.environ.get("DSH_COMMAND_TIMEOUT_S", "10"))  # host reply to a spoken command

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
_ESCALATION = re.compile(r"^escalate sandbox to (\S+):\s*(.*)$", re.DOTALL)
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
            if self._turn is not None:
                # The open stream speaks the question and ends; the turn's later text is spoken passively.
                self._turn.put_nowait({"type": "ask", "text": question})
            else:
                self._end_passive()
                self._say(question)
        elif kind == "approval-done":
            if self.pending_approval is not None and self.pending_approval["id"] == str(frame.get("id")):
                log.info("harness approval settled: %s", frame.get("outcome"))
                self.pending_approval = None
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
                self._session.say(spoken())
            except Exception as e:  # noqa: BLE001
                log.warning("passive say failed: %s", e)
                self._passive = None
                return
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
        if is_stop(text):
            await self._bridge.interrupt()
            self._reply(request_id, "Okay, stopped.")
            return
        preset = permission_request(text)
        if preset is not None:
            self._reply(request_id, await self._bridge.request_permission(preset))
            return
        queue = await self._bridge.send_turn(text)
        spoken = SpokenTextFilter()
        interrupted = False
        try:
            while True:
                frame = await asyncio.wait_for(queue.get(), TURN_TIMEOUT_S)
                kind = frame.get("type")
                if kind == "speak":
                    piece = spoken.feed(str(frame.get("text", "")))
                    if piece:
                        self._event_ch.send_nowait(llm.ChatChunk(
                            id=request_id, delta=llm.ChoiceDelta(role="assistant", content=piece)))
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

    session = AgentSession(
        stt=openai.STT(model="whisper-1", language="en", base_url=MEDIA_URL, api_key="not-needed"),
        llm=brain,
        tts=openai.TTS(
            model=TTS_MODEL, voice=TTS_VOICE, speed=TTS_SPEED,
            base_url=KYUTAI_URL, api_key="not-needed", response_format="wav",
        ),
        vad=silero.VAD.load(),
        turn_detection=EnglishModel(),
        allow_interruptions=True,          # barge-in: user speech cuts off the reply
        min_interruption_duration=0.5,
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
