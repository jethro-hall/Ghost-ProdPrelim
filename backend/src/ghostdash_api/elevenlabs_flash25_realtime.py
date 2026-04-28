"""
GhostDash ElevenLabs Flash v2.5 Realtime WebSocket Adapter

Best-practice low-latency path:
    LLM streaming deltas
    -> GhostDash backend WebSocket
    -> ElevenLabs stream-input WebSocket using eleven_flash_v2_5
    -> PCM audio chunks
    -> browser AudioContext queue

Why this exists:
- HTTP /stream is good fallback/admin preview.
- Per-sentence MP3 preview calls sound stitched/jumpy.
- WebSocket stream-input is the correct path for live LLM text deltas.
- PCM output avoids browser MP3 chunk decode/MSE problems and gives lower playback latency.

Backend-only. Do not expose ELEVENLABS_API_KEY to the browser.

FastAPI integration:
    from ghostdash_elevenlabs_flash25_realtime import router as elevenlabs_realtime_router
    app.include_router(elevenlabs_realtime_router)

Environment:
    ELEVENLABS_API_KEY=...

Client route:
    ws://<host>/api/voice/elevenlabs/flash25/realtime
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal, Optional
from urllib.parse import urlencode

import websockets
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field, ValidationError

from .settings import get_settings


ELEVENLABS_WS_BASE = "wss://api.elevenlabs.io/v1/text-to-speech"
DEFAULT_MODEL_ID = "eleven_flash_v2_5"

# For browser low-latency playback, prefer PCM. MP3 chunks can sound gappy unless you
# implement a proper MediaSource pipeline. For Twilio/phone, use ulaw_8000 intentionally.
DEFAULT_OUTPUT_FORMAT = "pcm_24000"
DEFAULT_SAMPLE_RATE_HZ = 24000

router = APIRouter(prefix="/api/voice/elevenlabs", tags=["voice-elevenlabs-realtime"])
settings = get_settings()


class CustomReplacement(BaseModel):
    key: str = Field(..., min_length=1, max_length=120)
    value: str = Field(..., max_length=240)


class PronunciationDictionaryLocator(BaseModel):
    pronunciation_dictionary_id: str = Field(..., min_length=1)
    version_id: str = Field(..., min_length=1)


class VoiceSettings(BaseModel):
    stability: float = Field(0.50, ge=0.0, le=1.0)
    similarity_boost: float = Field(0.75, ge=0.0, le=1.0)
    style: float = Field(0.00, ge=0.0, le=1.0)
    use_speaker_boost: bool = True
    speed: float = Field(1.00, ge=0.70, le=1.20)


class StartMessage(BaseModel):
    type: Literal["start"] = "start"
    voice_id: str = Field(..., min_length=1)
    model_id: str = DEFAULT_MODEL_ID
    output_format: str = DEFAULT_OUTPUT_FORMAT
    language_code: Optional[str] = Field("en", min_length=2, max_length=12)
    seed: Optional[int] = Field(None, ge=0, le=4294967295)

    previous_text: Optional[str] = Field(None, max_length=2000)
    next_text: Optional[str] = Field(None, max_length=2000)

    apply_text_normalization: Literal["auto", "on", "off"] = "auto"
    pronunciation_dictionary_locators: list[PronunciationDictionaryLocator] = Field(default_factory=list, max_length=3)
    custom_replacements: list[CustomReplacement] = Field(default_factory=list, max_length=50)
    voice_settings: VoiceSettings = Field(default_factory=VoiceSettings)

    # Lowest-latency defaults.
    auto_mode: bool = True
    sync_alignment: bool = False
    enable_logging: bool = True
    enable_ssml_parsing: bool = False
    inactivity_timeout: int = Field(180, ge=20, le=180)

    # Natural chunking controls. These stop "one character at a time" delivery,
    # while still getting first audio out fast.
    first_chunk_min_chars: int = Field(24, ge=8, le=120)
    clause_min_chars: int = Field(36, ge=12, le=160)
    hard_max_chars: int = Field(180, ge=60, le=420)


class TextDeltaMessage(BaseModel):
    type: Literal["text_delta"]
    text: str = Field(..., min_length=1, max_length=4000)


class ControlMessage(BaseModel):
    type: Literal["flush", "finish", "cancel", "ping"]


def _api_key() -> str:
    key = (settings.elevenlabs_api_key or os.getenv("ELEVENLABS_API_KEY", "")).strip()
    if not key:
        raise RuntimeError("ELEVENLABS_API_KEY is not configured")
    return key


def _allowed_voice_ids() -> set[str]:
    raw = settings.elevenlabs_allowed_voice_ids or ""
    return {item.strip() for item in raw.split(",") if item.strip()}


def _safe_output_format(output_format: str) -> str:
    allowed = {
        "pcm_16000",
        "pcm_22050",
        "pcm_24000",
        "pcm_44100",
        "mp3_44100_128",
        "mp3_44100_192",
        "mp3_22050_32",
        "ulaw_8000",
    }
    if output_format not in allowed:
        raise ValueError(f"Unsupported output_format: {output_format}")
    return output_format


def _sample_rate_for_format(output_format: str) -> int:
    if output_format.startswith("pcm_16000") or output_format == "ulaw_8000":
        return 16000 if output_format.startswith("pcm_16000") else 8000
    if output_format.startswith("pcm_22050") or output_format.startswith("mp3_22050"):
        return 22050
    if output_format.startswith("pcm_44100") or output_format.startswith("mp3_44100"):
        return 44100
    return 24000


def apply_replacements(text: Optional[str], replacements: list[CustomReplacement]) -> Optional[str]:
    if text is None:
        return None
    out = text
    for item in replacements:
        out = out.replace(item.key, item.value)
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out


class NaturalTextChunker:
    """
    Converts LLM token/delta fragments into natural TTS chunks.

    Goal:
    - send the first useful phrase quickly
    - avoid one-word or one-character audio stutter
    - preserve prosody by flushing on clause/sentence boundaries
    """

    _boundary_re = re.compile(r"([.!?。！？]\s+|[,;:]\s+|\n+)")

    def __init__(self, first_min: int, clause_min: int, hard_max: int):
        self.first_min = first_min
        self.clause_min = clause_min
        self.hard_max = hard_max
        self.buffer = ""
        self.sent_first = False

    def add(self, text: str) -> list[str]:
        self.buffer += text
        return self._drain(force=False)

    def flush(self) -> list[str]:
        return self._drain(force=True)

    def _drain(self, force: bool) -> list[str]:
        chunks: list[str] = []

        while self.buffer:
            min_len = self.first_min if not self.sent_first else self.clause_min

            if len(self.buffer) >= self.hard_max:
                cut = self._best_cut_before(self.hard_max) or self.hard_max
                chunks.append(self._take(cut))
                self.sent_first = True
                continue

            if len(self.buffer) >= min_len:
                cut = self._first_boundary_after(min_len)
                if cut is not None:
                    chunks.append(self._take(cut))
                    self.sent_first = True
                    continue

            if force:
                stripped = self.buffer.strip()
                self.buffer = ""
                if stripped:
                    chunks.append(stripped + " ")
                    self.sent_first = True
                break

            break

        return chunks

    def _take(self, cut: int) -> str:
        chunk = self.buffer[:cut].strip()
        self.buffer = self.buffer[cut:]
        return chunk + " "

    def _first_boundary_after(self, min_len: int) -> Optional[int]:
        for match in self._boundary_re.finditer(self.buffer):
            if match.end() >= min_len:
                return match.end()
        return None

    def _best_cut_before(self, max_len: int) -> Optional[int]:
        window = self.buffer[:max_len]
        for sep in [". ", "? ", "! ", ", ", "; ", ": ", " "]:
            idx = window.rfind(sep)
            if idx > 24:
                return idx + len(sep)
        return None


@dataclass
class RealtimeMetrics:
    session_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    started_at: float = field(default_factory=time.perf_counter)
    eleven_connect_ms: Optional[int] = None
    first_text_sent_ms: Optional[int] = None
    first_audio_chunk_ms: Optional[int] = None
    text_chunks_sent: int = 0
    audio_chunks_received: int = 0
    audio_bytes_received: int = 0
    interrupted: bool = False
    status: str = "starting"

    def mark_ms(self) -> int:
        return int((time.perf_counter() - self.started_at) * 1000)

    def public(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "eleven_connect_ms": self.eleven_connect_ms,
            "first_text_sent_ms": self.first_text_sent_ms,
            "first_audio_chunk_ms": self.first_audio_chunk_ms,
            "text_chunks_sent": self.text_chunks_sent,
            "audio_chunks_received": self.audio_chunks_received,
            "audio_bytes_received": self.audio_bytes_received,
            "interrupted": self.interrupted,
            "status": self.status,
            "elapsed_ms": self.mark_ms(),
        }


async def _ws_connect(url: str, headers: dict[str, str]):
    """
    websockets changed extra_headers -> additional_headers in newer versions.
    This wrapper supports both.
    """
    try:
        return await websockets.connect(
            url,
            additional_headers=headers,
            max_size=None,
            ping_interval=10,
            ping_timeout=10,
            close_timeout=2,
        )
    except TypeError:
        return await websockets.connect(
            url,
            extra_headers=headers,
            max_size=None,
            ping_interval=10,
            ping_timeout=10,
            close_timeout=2,
        )


def _build_elevenlabs_url(start: StartMessage) -> tuple[str, int]:
    output_format = _safe_output_format(start.output_format)
    sample_rate = _sample_rate_for_format(output_format)

    params: dict[str, Any] = {
        "model_id": start.model_id or DEFAULT_MODEL_ID,
        "output_format": output_format,
        "auto_mode": "true" if start.auto_mode else "false",
        "sync_alignment": "true" if start.sync_alignment else "false",
        "enable_logging": "true" if start.enable_logging else "false",
        "enable_ssml_parsing": "true" if start.enable_ssml_parsing else "false",
        "apply_text_normalization": start.apply_text_normalization,
        "inactivity_timeout": str(start.inactivity_timeout),
    }

    if start.language_code:
        params["language_code"] = start.language_code

    if start.seed is not None:
        params["seed"] = str(start.seed)

    query = urlencode(params)
    url = f"{ELEVENLABS_WS_BASE}/{start.voice_id}/stream-input?{query}"
    return url, sample_rate


def _build_initial_payload(start: StartMessage) -> dict[str, Any]:
    payload: dict[str, Any] = {
        # A single space initializes the stream without ending it.
        "text": " ",
        "voice_settings": {
            "stability": start.voice_settings.stability,
            "similarity_boost": start.voice_settings.similarity_boost,
            "style": start.voice_settings.style,
            "use_speaker_boost": start.voice_settings.use_speaker_boost,
            "speed": start.voice_settings.speed,
        },
    }

    previous_text = apply_replacements(start.previous_text, start.custom_replacements)
    next_text = apply_replacements(start.next_text, start.custom_replacements)

    if previous_text:
        payload["previous_text"] = previous_text

    if next_text:
        payload["next_text"] = next_text

    if start.pronunciation_dictionary_locators:
        payload["pronunciation_dictionary_locators"] = [
            locator.model_dump() for locator in start.pronunciation_dictionary_locators
        ]

    return payload


async def _send_json_safe(client_ws: WebSocket, payload: dict[str, Any]) -> None:
    try:
        await client_ws.send_json(payload)
    except (RuntimeError, WebSocketDisconnect):
        pass


@router.websocket("/flash25/realtime")
async def flash25_realtime(client_ws: WebSocket) -> None:
    """
    Browser/UI <-> GhostDash <-> ElevenLabs realtime bridge.

    Client protocol:
      1. send {"type":"start", "voice_id":"...", ...settings}
      2. send {"type":"text_delta", "text":"..."} repeatedly as LLM deltas arrive
      3. send {"type":"finish"} to flush and close the ElevenLabs generation
      4. send {"type":"cancel"} to interrupt immediately

    Server protocol:
      - {"type":"ready", ...}
      - {"type":"audio", "audio":"base64...", "format":"pcm_24000", "sample_rate_hz":24000}
      - {"type":"alignment", ...} if sync_alignment=true
      - {"type":"metrics", ...}
      - {"type":"final", ...}
      - {"type":"error", ...}
    """
    await client_ws.accept()
    metrics = RealtimeMetrics()

    eleven_ws = None
    receive_task: Optional[asyncio.Task] = None
    client_task: Optional[asyncio.Task] = None
    keepalive_task: Optional[asyncio.Task] = None

    try:
        raw_start = await client_ws.receive_json()
        start = StartMessage.model_validate(raw_start)
        allowed_voice_ids = _allowed_voice_ids()
        if allowed_voice_ids and start.voice_id not in allowed_voice_ids:
            metrics.status = "voice_not_allowed"
            await _send_json_safe(client_ws, {
                "type": "error",
                "error": "Selected voice is not available for this workspace.",
                "metrics": metrics.public(),
            })
            await client_ws.close(code=1008)
            return

        url, sample_rate = _build_elevenlabs_url(start)
        headers = {"xi-api-key": _api_key()}

        connect_started = time.perf_counter()
        eleven_ws = await _ws_connect(url, headers)
        metrics.eleven_connect_ms = int((time.perf_counter() - connect_started) * 1000)
        metrics.status = "connected"

        await eleven_ws.send(json.dumps(_build_initial_payload(start)))

        chunker = NaturalTextChunker(
            first_min=start.first_chunk_min_chars,
            clause_min=start.clause_min_chars,
            hard_max=start.hard_max_chars,
        )

        await client_ws.send_json({
            "type": "ready",
            "session_id": metrics.session_id,
            "format": start.output_format,
            "sample_rate_hz": sample_rate,
            "metrics": metrics.public(),
        })

        async def send_text_to_eleven(text: str, *, flush: bool = False) -> None:
            clean_text = apply_replacements(text, start.custom_replacements) or ""
            if not clean_text.strip():
                return

            payload: dict[str, Any] = {"text": clean_text}
            # Some ElevenLabs websocket variants accept flush. If ignored, harmless.
            if flush:
                payload["flush"] = True

            await eleven_ws.send(json.dumps(payload))
            metrics.text_chunks_sent += 1

            if metrics.first_text_sent_ms is None:
                metrics.first_text_sent_ms = metrics.mark_ms()
                await _send_json_safe(client_ws, {
                    "type": "metrics",
                    "event": "first_text_sent",
                    "metrics": metrics.public(),
                })

        async def receive_from_eleven() -> None:
            async for raw in eleven_ws:
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                audio_b64 = data.get("audio")
                if audio_b64:
                    if metrics.first_audio_chunk_ms is None:
                        metrics.first_audio_chunk_ms = metrics.mark_ms()

                    try:
                        audio_len = len(base64.b64decode(audio_b64))
                    except Exception:
                        audio_len = 0

                    metrics.audio_chunks_received += 1
                    metrics.audio_bytes_received += audio_len

                    await client_ws.send_json({
                        "type": "audio",
                        "audio": audio_b64,
                        "format": start.output_format,
                        "sample_rate_hz": sample_rate,
                        "metrics": metrics.public(),
                    })

                alignment = data.get("alignment") or data.get("normalizedAlignment")
                if alignment and start.sync_alignment:
                    await client_ws.send_json({
                        "type": "alignment",
                        "alignment": alignment,
                        "metrics": metrics.public(),
                    })

                if data.get("isFinal") or data.get("final"):
                    metrics.status = "final"
                    await client_ws.send_json({
                        "type": "final",
                        "metrics": metrics.public(),
                    })
                    break

        async def receive_from_client() -> None:
            nonlocal eleven_ws
            while True:
                msg = await client_ws.receive_json()
                msg_type = msg.get("type")

                if msg_type == "text_delta":
                    delta = TextDeltaMessage.model_validate(msg)
                    for chunk in chunker.add(delta.text):
                        await send_text_to_eleven(chunk)

                elif msg_type == "flush":
                    for chunk in chunker.flush():
                        await send_text_to_eleven(chunk, flush=True)

                elif msg_type == "finish":
                    for chunk in chunker.flush():
                        await send_text_to_eleven(chunk, flush=True)

                    # Empty string is EOS and closes generation.
                    await eleven_ws.send(json.dumps({"text": ""}))
                    metrics.status = "finishing"
                    break

                elif msg_type == "cancel":
                    metrics.interrupted = True
                    metrics.status = "cancelled"
                    await client_ws.send_json({
                        "type": "cancelled",
                        "metrics": metrics.public(),
                    })
                    await eleven_ws.close()
                    break

                elif msg_type == "ping":
                    await client_ws.send_json({
                        "type": "pong",
                        "metrics": metrics.public(),
                    })

        async def keepalive() -> None:
            # ElevenLabs closes after inactivity; a single space keeps it alive.
            # Do not use empty string; empty string is EOS.
            while True:
                await asyncio.sleep(15)
                if eleven_ws.closed:
                    return
                await eleven_ws.send(json.dumps({"text": " "}))

        receive_task = asyncio.create_task(receive_from_eleven())
        client_task = asyncio.create_task(receive_from_client())
        keepalive_task = asyncio.create_task(keepalive())

        done, pending = await asyncio.wait(
            {receive_task, client_task},
            return_when=asyncio.FIRST_COMPLETED,
        )

        if client_task in done and not receive_task.done():
            # Client has finished / cancelled; ElevenLabs may still be sending PCM. Do
            # not cancel receive_from_eleven immediately or the browser will get
            # WebSocket "ready" + early close with zero "audio" frames.
            try:
                await asyncio.wait_for(receive_task, timeout=120.0)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                if not receive_task.done():
                    receive_task.cancel()
                    await asyncio.gather(receive_task, return_exceptions=True)
        else:
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)

        if keepalive_task:
            keepalive_task.cancel()
            await asyncio.gather(keepalive_task, return_exceptions=True)

        # Surface exceptions from completed task.
        for task in done:
            if task.cancelled():
                continue
            try:
                exc = task.exception()
            except asyncio.CancelledError:
                continue
            if exc:
                raise exc

    except WebSocketDisconnect:
        metrics.status = "client_disconnected"
        metrics.interrupted = True

    except ValidationError:
        metrics.status = "bad_request"
        await _send_json_safe(client_ws, {
            "type": "error",
            "error": "Invalid realtime voice request.",
            "metrics": metrics.public(),
        })

    except Exception:
        metrics.status = "failed"
        await _send_json_safe(client_ws, {
            "type": "error",
            "error": "Realtime voice is unavailable right now.",
            "metrics": metrics.public(),
        })

    finally:
        tasks_to_cancel = [task for task in [receive_task, client_task, keepalive_task] if task and not task.done()]
        for task in tasks_to_cancel:
            task.cancel()
        if tasks_to_cancel:
            await asyncio.gather(*tasks_to_cancel, return_exceptions=True)

        if eleven_ws:
            try:
                await eleven_ws.close()
            except Exception:
                pass

        await _send_json_safe(client_ws, {"type": "final", "metrics": metrics.public()})
