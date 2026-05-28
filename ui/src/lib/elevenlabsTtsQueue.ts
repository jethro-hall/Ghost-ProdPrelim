import { buildVoiceTtsStreamUrl, fetchElevenLabsPreviewMpeg, type ElevenLabsMasteringPayload } from "../api";

/** Take leading complete clauses; keep trailing fragment in `rest`. */
export function splitClausesFromStream(buffer: string): { complete: string[]; rest: string } {
  const complete: string[] = [];
  let s = buffer;
  while (s.length) {
    const m = s.match(/^[\s]*(.+?[.!?;:])(?=\s|$)/);
    if (m) {
      const chunk = m[1]?.trim();
      if (chunk) complete.push(chunk);
      s = s.slice(m[0].length);
    } else {
      break;
    }
  }
  const rest = s.trimStart();
  if (rest.length > 220) {
    const breakAt = Math.max(rest.lastIndexOf(","), rest.lastIndexOf(" "), 120);
    const at = breakAt > 60 ? breakAt : 180;
    const head = rest.slice(0, at).trim();
    if (head) complete.push(head);
    return { complete, rest: rest.slice(at).trimStart() };
  }
  return { complete, rest };
}

type Options = {
  getVoiceId: () => string;
  getEnabled: () => boolean;
  getMastering?: () => ElevenLabsMasteringPayload | null;
  onStatus?: (message: string) => void;
};

function decodeBase64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Streams assistant speech through one ElevenLabs websocket session per turn.
 * Falls back to preview MP3 chunks only if stream socket fails.
 */
export function createElevenLabsTtsQueue(options: Options) {
  let textBuffer = "";
  let websocket: WebSocket | null = null;
  let wsConnected = false;
  let pendingText: string[] = [];
  let fallbackQueue: string[] = [];
  let fallbackPlaying = false;
  let fallbackAudio: HTMLAudioElement | null = null;
  let streamFailed = false;
  let speaking = false;
  let generation = 0;
  let audioContext: AudioContext | null = null;
  let nextPlaybackTime = 0;
  const activeSources = new Set<AudioBufferSourceNode>();

  async function ensureAudioContext(token: number): Promise<AudioContext> {
    if (!audioContext || audioContext.state === "closed") {
      audioContext = new AudioContext({ sampleRate: 44100, latencyHint: "interactive" });
      nextPlaybackTime = 0;
    }
    if (audioContext.state === "suspended") {
      try {
        await audioContext.resume();
      } catch {
        // resume can fail before user gesture; we keep trying.
      }
    }
    if (token !== generation) {
      throw new Error("TTS cancelled");
    }
    return audioContext;
  }

  function stopAudioSources() {
    for (const source of activeSources) {
      try {
        source.stop(0);
      } catch {
        // no-op
      }
    }
    activeSources.clear();
    speaking = false;
    nextPlaybackTime = audioContext ? audioContext.currentTime : 0;
  }

  async function scheduleStreamChunk(audioBase64: string, token: number) {
    const ctx = await ensureAudioContext(token);
    const raw = decodeBase64ToArrayBuffer(audioBase64);
    const decoded = await ctx.decodeAudioData(raw.slice(0));
    if (token !== generation || !options.getEnabled()) return;
    const source = ctx.createBufferSource();
    source.buffer = decoded;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.02, nextPlaybackTime);
    nextPlaybackTime = startAt + decoded.duration;
    speaking = true;
    activeSources.add(source);
    source.onended = () => {
      activeSources.delete(source);
      if (!activeSources.size && !fallbackPlaying) speaking = false;
    };
    source.start(startAt);
  }

  function teardownSocket(sendStop: boolean) {
    if (!websocket) return;
    const ws = websocket;
    websocket = null;
    wsConnected = false;
    if (sendStop && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "stop" }));
      } catch {
        // no-op
      }
    }
    try {
      ws.close(1000, "cancelled");
    } catch {
      // no-op
    }
  }

  function stopFallbackAudio() {
    if (fallbackAudio) {
      fallbackAudio.pause();
      fallbackAudio = null;
    }
    fallbackQueue = [];
    fallbackPlaying = false;
  }

  async function playFallbackQueue(token: number) {
    if (fallbackPlaying) return;
    fallbackPlaying = true;
    while (fallbackQueue.length && token === generation && options.getEnabled()) {
      const text = fallbackQueue.shift() ?? "";
      if (!text) continue;
      try {
        const blob = await fetchElevenLabsPreviewMpeg({
          voiceId: options.getVoiceId(),
          text,
          mastering: options.getMastering?.() ?? null,
        });
        if (token !== generation || !options.getEnabled()) break;
        const objectUrl = URL.createObjectURL(blob);
        const audio = new Audio(objectUrl);
        fallbackAudio = audio;
        speaking = true;
        await new Promise<void>((resolve) => {
          const done = () => {
            audio.removeEventListener("ended", done);
            audio.removeEventListener("error", done);
            resolve();
          };
          audio.addEventListener("ended", done);
          audio.addEventListener("error", done);
          void audio.play().catch(() => done());
        });
        URL.revokeObjectURL(objectUrl);
      } catch (error) {
        options.onStatus?.(`TTS fallback failed: ${String(error)}`);
      } finally {
        fallbackAudio = null;
      }
    }
    fallbackPlaying = false;
    if (!activeSources.size) speaking = false;
  }

  function sendTextToStream(text: string, token: number) {
    if (!text.trim() || token !== generation || !options.getEnabled()) return;
    if (streamFailed || !websocket || websocket.readyState !== WebSocket.OPEN || !wsConnected) {
      fallbackQueue.push(text);
      void playFallbackQueue(token);
      return;
    }
    websocket.send(JSON.stringify({ type: "text", text, try_trigger_generation: true }));
  }

  function drainPendingText(token: number) {
    if (!pendingText.length) return;
    const chunks = pendingText;
    pendingText = [];
    for (const chunk of chunks) sendTextToStream(chunk, token);
  }

  function ensureStreamSocket(token: number) {
    if (streamFailed || websocket || !options.getEnabled()) return;
    const voiceId = options.getVoiceId();
    if (!voiceId) {
      options.onStatus?.("No ElevenLabs voice selected.");
      return;
    }
    const ws = new WebSocket(
      buildVoiceTtsStreamUrl({
        voiceId,
        mastering: options.getMastering?.() ?? null,
      }),
    );
    websocket = ws;
    ws.onopen = () => {
      if (token !== generation) return;
      wsConnected = true;
      drainPendingText(token);
    };
    ws.onmessage = (event) => {
      if (token !== generation) return;
      try {
        const payload = JSON.parse(String(event.data)) as {
          type?: string;
          status?: string;
          message?: string;
          audio?: string;
        };
        if (payload.type === "error") {
          streamFailed = true;
          options.onStatus?.(`TTS stream error: ${payload.message ?? "unknown"}`);
          teardownSocket(false);
          stopAudioSources();
          drainPendingText(token);
          return;
        }
        if (payload.type === "audio" && payload.audio) {
          void scheduleStreamChunk(payload.audio, token).catch((error) => {
            options.onStatus?.(`TTS decode error: ${String(error)}`);
          });
        }
      } catch {
        // ignore malformed payload
      }
    };
    ws.onerror = () => {
      if (token !== generation) return;
      streamFailed = true;
      teardownSocket(false);
      stopAudioSources();
      drainPendingText(token);
    };
    ws.onclose = () => {
      if (token !== generation) return;
      websocket = null;
      wsConnected = false;
    };
  }

  function enqueueClauses(clauses: string[], token: number) {
    for (const clause of clauses) {
      const text = clause.trim();
      if (!text) continue;
      pendingText.push(text);
    }
    ensureStreamSocket(token);
    if (wsConnected) {
      drainPendingText(token);
    }
  }

  function stopAll() {
    generation += 1;
    textBuffer = "";
    pendingText = [];
    streamFailed = false;
    teardownSocket(true);
    stopAudioSources();
    stopFallbackAudio();
  }

  function flushCurrent(token: number) {
    if (!options.getEnabled()) return;
    const tail = textBuffer.trim();
    textBuffer = "";
    if (tail) enqueueClauses([tail], token);
    if (websocket && websocket.readyState === WebSocket.OPEN && wsConnected) {
      try {
        websocket.send(JSON.stringify({ type: "flush" }));
        websocket.send(JSON.stringify({ type: "end" }));
      } catch {
        // if stream closes unexpectedly, fallback chain still finishes.
      }
    }
  }

  return {
    pushDelta(delta: string) {
      if (!options.getEnabled() || !delta) return;
      const token = generation;
      textBuffer += delta;
      const { complete, rest } = splitClausesFromStream(textBuffer);
      textBuffer = rest;
      if (complete.length) enqueueClauses(complete, token);
    },
    /** Call when the assistant turn is complete to speak any trailing text. */
    flush() {
      flushCurrent(generation);
    },
    stop: stopAll,
    isSpeaking: () => speaking || fallbackPlaying || Boolean(pendingText.length),
  };
}

export type ElevenLabsTtsQueue = ReturnType<typeof createElevenLabsTtsQueue>;
