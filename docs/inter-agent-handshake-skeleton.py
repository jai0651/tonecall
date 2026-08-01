"""
Inter-Agent Voice Handshake — runnable middleware skeleton.

A single FastAPI service that:
  - Answers Plivo calls and attaches a <Stream> audio WebSocket.
  - Emits a DTMF preamble and listens for a peer preamble.
  - On peer detection: pairs via the broker and switches to JSON over WebSocket.
  - On timeout: falls back to a normal STT -> LLM -> TTS voice loop.

This file stubs out Plivo, LLM, STT, and TTS calls. Wire your real clients in
the marked places. Layout deliberately keeps everything in one process so a
hackathon team can run it with `uvicorn skeleton:app --reload`.

Run:
    pip install fastapi uvicorn websockets plivo
    uvicorn inter_agent_handshake_skeleton:app --host 0.0.0.0 --port 8000

Point both Plivo numbers' answer_url at:
    https://<your-public-host>/answer/<number>
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import random
import re
import secrets
from dataclasses import dataclass, field
from typing import Optional

from fastapi import FastAPI, Form, WebSocket, WebSocketDisconnect
from fastapi.responses import Response

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------

PUBLIC_HOST = os.environ.get("PUBLIC_HOST", "middleware.example.com")
HANDSHAKE_TIMEOUT_S = 1.5
PREAMBLE_PREFIX = "*0*"

AGENT_CONFIGS = {
    "+1AAA": {
        "name": "vegetable_vendor",
        "prompt": "You are a vegetable vendor in Mumbai. Greet briefly, "
                  "take orders, confirm totals, no chit-chat.",
        "capabilities": ["produce_order_v1"],
    },
    "+1BBB": {
        "name": "pizza_shop",
        "prompt": "You are a pizza shop taking orders. Confirm size, "
                  "toppings, address, ETA, total.",
        "capabilities": ["pizza_order_v1"],
    },
}

# -----------------------------------------------------------------------------
# In-memory state (hackathon-grade — replace with Redis if scaling)
# -----------------------------------------------------------------------------

# call_uuid -> phone number this leg belongs to
CALL_TO_NUMBER: dict[str, str] = {}


@dataclass
class PairRequest:
    agent_number: str
    call_uuid: str
    my_nonce: str
    peer_nonce: str
    websocket: Optional[WebSocket] = None
    session_id: Optional[str] = None
    paired_event: asyncio.Event = field(default_factory=asyncio.Event)


# Keyed by my_nonce — first POST inserts, second POST matches via peer_nonce
PENDING_PAIRS: dict[str, PairRequest] = {}
# session_id -> set of two WebSockets in the data plane
DATA_SESSIONS: dict[str, list[WebSocket]] = {}


# -----------------------------------------------------------------------------
# Stubs you will replace with real clients
# -----------------------------------------------------------------------------

class PlivoStub:
    """Replace with `plivo.RestClient(auth_id, auth_token).calls`."""

    @staticmethod
    async def send_digits(call_uuid: str, digits: str) -> None:
        # Real: plivo_client.calls.send_digits(call_uuid, digits=digits, leg="aleg")
        print(f"[plivo] send_digits call={call_uuid} digits={digits}")

    @staticmethod
    async def hangup(call_uuid: str) -> None:
        # Real: plivo_client.calls.delete(call_uuid)
        print(f"[plivo] hangup call={call_uuid}")


class LLMStub:
    """Replace with Claude/OpenAI SDK calls. Same signature works for both."""

    @staticmethod
    async def respond_json(system: str, peer_msg: dict) -> dict:
        # Real: anthropic.messages.create(...) with structured output
        await asyncio.sleep(0.4)
        return {"type": "reply", "text": f"(stub reply to {peer_msg.get('type')})"}

    @staticmethod
    async def respond_text(system: str, user_text: str) -> str:
        # Real: anthropic.messages.create(...) plain text
        await asyncio.sleep(0.4)
        return f"(stub voice reply to: {user_text})"


class STTStub:
    """Replace with Deepgram / Plivo Speech streaming client."""

    def __init__(self) -> None:
        self.buffer = b""

    async def feed(self, audio_chunk: bytes) -> Optional[str]:
        self.buffer += audio_chunk
        # Real STT yields transcripts incrementally; here we fake it.
        if len(self.buffer) > 16000:  # ~2s of 8kHz mu-law
            self.buffer = b""
            return "hello, I want to order"
        return None


class TTSStub:
    """Replace with ElevenLabs / Plivo TTS. Returns mu-law 8kHz bytes."""

    @staticmethod
    async def synthesize(text: str) -> bytes:
        await asyncio.sleep(0.1)
        # 1 second of silence-shaped bytes as a placeholder
        return b"\xff" * 8000


# -----------------------------------------------------------------------------
# FastAPI app
# -----------------------------------------------------------------------------

app = FastAPI(title="Inter-Agent Voice Handshake Middleware")


# ----- 1. Answer URL: returns <Stream> XML --------------------------------

@app.post("/answer/{number}")
async def answer(number: str, CallUUID: str = Form(...)) -> Response:
    """Plivo POSTs here when a call lands. We tell Plivo to open a Stream."""
    CALL_TO_NUMBER[CallUUID] = number

    stream_url = f"wss://{PUBLIC_HOST}/voice/{CallUUID}"
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" streamTimeout="3600" keepCallAlive="true">
    {stream_url}
  </Stream>
</Response>"""
    return Response(content=xml, media_type="application/xml")


# ----- 2. Voice WebSocket: bidirectional audio with Plivo -----------------

@app.websocket("/voice/{call_uuid}")
async def voice_socket(ws: WebSocket, call_uuid: str) -> None:
    await ws.accept()
    number = CALL_TO_NUMBER.get(call_uuid)
    config = AGENT_CONFIGS.get(number)
    if not config:
        await ws.close()
        return

    print(f"[voice] open call={call_uuid} agent={config['name']}")
    my_nonce = f"{secrets.randbelow(10**8):08d}"

    try:
        # Phase 1: emit preamble (light jitter so concurrent senders don't collide)
        await asyncio.sleep(random.uniform(0.05, 0.2))
        await PlivoStub.send_digits(call_uuid, f"{PREAMBLE_PREFIX}{my_nonce}#")

        # Phase 2: listen for peer preamble
        peer_nonce = await listen_for_peer_preamble(ws, HANDSHAKE_TIMEOUT_S)

        if peer_nonce:
            print(f"[voice] paired call={call_uuid} peer={peer_nonce}")
            await paired_mode(ws, call_uuid, config, my_nonce, peer_nonce)
        else:
            print(f"[voice] human-mode call={call_uuid}")
            await voice_mode(ws, call_uuid, config)
    except WebSocketDisconnect:
        print(f"[voice] disconnect call={call_uuid}")
    finally:
        CALL_TO_NUMBER.pop(call_uuid, None)


async def listen_for_peer_preamble(ws: WebSocket, timeout: float) -> Optional[str]:
    """Read DTMF events from Plivo's voice stream until we see *0*NONCE#."""
    buf = ""
    pattern = re.compile(rf"\{PREAMBLE_PREFIX[0]}0\{PREAMBLE_PREFIX[2]}(\d{{8}})#")

    try:
        async with asyncio.timeout(timeout):
            while True:
                raw = await ws.receive_text()
                msg = json.loads(raw)
                if msg.get("event") == "dtmf":
                    buf += str(msg["digit"])
                    if m := pattern.search(buf):
                        return m.group(1)
                # During handshake we ignore media frames.
    except (asyncio.TimeoutError, TimeoutError):
        return None


# ----- 3. PAIRED mode: JSON over data WS, cosmetic audio on voice WS ------

async def paired_mode(
    voice_ws: WebSocket,
    call_uuid: str,
    config: dict,
    my_nonce: str,
    peer_nonce: str,
) -> None:
    data_ws = await pair_with_broker(
        agent_number=CALL_TO_NUMBER[call_uuid],
        call_uuid=call_uuid,
        my_nonce=my_nonce,
        peer_nonce=peer_nonce,
    )

    if data_ws is None:
        print(f"[paired] broker pair failed call={call_uuid}")
        await voice_mode(voice_ws, call_uuid, config)
        return

    try:
        await asyncio.gather(
            run_agent_over_json(data_ws, config),
            pump_modem_audio(voice_ws),
        )
    finally:
        await PlivoStub.hangup(call_uuid)


async def run_agent_over_json(data_ws: WebSocket, config: dict) -> None:
    await data_ws.send_text(json.dumps({"type": "hello", "from": config["name"]}))

    try:
        async for raw in data_ws.iter_text():
            peer_msg = json.loads(raw)
            if peer_msg.get("type") == "bye":
                return
            reply = await LLMStub.respond_json(config["prompt"], peer_msg)
            await data_ws.send_text(json.dumps(reply))
            if reply.get("done"):
                await data_ws.send_text(json.dumps({"type": "bye"}))
                return
    except WebSocketDisconnect:
        return


async def pump_modem_audio(voice_ws: WebSocket) -> None:
    """Loop a short modem-like audio clip so humans listening hear 'data flowing'."""
    # Real impl: load a pre-rendered mu-law clip of FSK/fax-style tones from disk.
    chirp = base64.b64encode(b"\xaa" * 160).decode()  # 20ms of fake audio
    try:
        while True:
            await voice_ws.send_text(json.dumps({"event": "media",
                                                 "media": {"payload": chirp}}))
            await asyncio.sleep(0.02)
    except WebSocketDisconnect:
        return


# ----- 4. VOICE mode (human fallback) -------------------------------------

async def voice_mode(voice_ws: WebSocket, call_uuid: str, config: dict) -> None:
    stt = STTStub()

    # greet
    greeting_audio = await TTSStub.synthesize(
        f"Hi, this is {config['name']}. How can I help?"
    )
    await send_audio_frames(voice_ws, greeting_audio)

    try:
        async for raw in voice_ws.iter_text():
            msg = json.loads(raw)
            if msg.get("event") != "media":
                continue
            audio = base64.b64decode(msg["media"]["payload"])
            transcript = await stt.feed(audio)
            if transcript:
                reply_text = await LLMStub.respond_text(config["prompt"], transcript)
                reply_audio = await TTSStub.synthesize(reply_text)
                await send_audio_frames(voice_ws, reply_audio)
    except WebSocketDisconnect:
        return
    finally:
        await PlivoStub.hangup(call_uuid)


async def send_audio_frames(voice_ws: WebSocket, audio: bytes,
                            frame_bytes: int = 160) -> None:
    """Plivo expects ~20ms mu-law frames (160 bytes at 8kHz)."""
    for i in range(0, len(audio), frame_bytes):
        chunk = audio[i:i + frame_bytes]
        b64 = base64.b64encode(chunk).decode()
        await voice_ws.send_text(json.dumps({"event": "media",
                                              "media": {"payload": b64}}))
        await asyncio.sleep(0.02)


# -----------------------------------------------------------------------------
# 5. Broker — same process for hackathon. Pull this out later if you scale.
# -----------------------------------------------------------------------------

async def pair_with_broker(agent_number: str, call_uuid: str,
                           my_nonce: str, peer_nonce: str) -> Optional[WebSocket]:
    """In-process pair. Returns the data-plane WS once both sides arrive."""
    me = PairRequest(agent_number, call_uuid, my_nonce, peer_nonce)
    PENDING_PAIRS[my_nonce] = me

    # Is the peer already waiting?
    peer = PENDING_PAIRS.get(peer_nonce)
    if peer and peer.peer_nonce == my_nonce:
        session_id = secrets.token_hex(8)
        me.session_id = peer.session_id = session_id
        DATA_SESSIONS[session_id] = []
        peer.paired_event.set()
        me.paired_event.set()
    else:
        try:
            await asyncio.wait_for(me.paired_event.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            PENDING_PAIRS.pop(my_nonce, None)
            return None

    PENDING_PAIRS.pop(my_nonce, None)
    return await connect_data_session(me.session_id)


async def connect_data_session(session_id: str) -> WebSocket:
    """Each handler opens its own data WS to the broker endpoint below."""
    # In a real deployment, this is an outbound `websockets.connect(...)` call
    # to wss://broker/data/<session_id>. For the in-process hackathon version,
    # we let the broker WS endpoint pair the two incoming sockets.
    # Simplest path: spin up an internal client.
    import websockets
    ws_url = f"ws://localhost:8000/data/{session_id}"
    return await websockets.connect(ws_url)  # type: ignore[return-value]


@app.websocket("/data/{session_id}")
async def data_socket(ws: WebSocket, session_id: str) -> None:
    """Two clients connect with the same session_id. We relay between them."""
    await ws.accept()
    peers = DATA_SESSIONS.setdefault(session_id, [])
    peers.append(ws)
    me_index = len(peers) - 1
    print(f"[data] session={session_id} side={me_index} connected")

    try:
        async for raw in ws.iter_text():
            for i, peer in enumerate(peers):
                if i != me_index:
                    await peer.send_text(raw)
    except WebSocketDisconnect:
        pass
    finally:
        if ws in peers:
            peers.remove(ws)
        if not peers:
            DATA_SESSIONS.pop(session_id, None)
            print(f"[data] session={session_id} closed")
