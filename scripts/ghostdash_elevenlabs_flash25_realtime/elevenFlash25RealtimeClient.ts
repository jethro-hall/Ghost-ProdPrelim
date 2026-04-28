/**
 * GhostDash ElevenLabs Flash v2.5 Realtime Client
 *
 * Browser client for:
 *   GhostDash backend WS -> ElevenLabs Flash v2.5 WS -> PCM audio chunks
 *
 * Recommended output_format: pcm_24000
 * Reason: lower latency and smoother playback than stitched MP3 chunks.
 */

export type ElevenFlashRealtimeConfig = {
  wsUrl: string;
  voiceId: string;
  modelId?: string;
  outputFormat?: "pcm_24000" | "pcm_16000" | "pcm_44100" | "mp3_44100_128" | "ulaw_8000";
  languageCode?: string;
  seed?: number | null;
  previousText?: string;
  nextText?: string;
  applyTextNormalization?: "auto" | "on" | "off";
  autoMode?: boolean;
  syncAlignment?: boolean;
  enableLogging?: boolean;
  inactivityTimeout?: number;
  voiceSettings?: {
    stability?: number;
    similarity_boost?: number;
    style?: number;
    use_speaker_boost?: boolean;
    speed?: number;
  };
  customReplacements?: Array<{ key: string; value: string }>;
};

export type RealtimeEvent =
  | { type: "ready"; [key: string]: unknown }
  | { type: "audio"; audio: string; format: string; sample_rate_hz: number; [key: string]: unknown }
  | { type: "alignment"; alignment: unknown; [key: string]: unknown }
  | { type: "metrics"; [key: string]: unknown }
  | { type: "final"; [key: string]: unknown }
  | { type: "error"; error: unknown; [key: string]: unknown };

type EventHandler = (event: RealtimeEvent) => void;

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);

  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

function pcm16ToFloat32(buffer: ArrayBuffer): Float32Array {
  const view = new DataView(buffer);
  const samples = new Float32Array(buffer.byteLength / 2);

  for (let i = 0; i < samples.length; i += 1) {
    const sample = view.getInt16(i * 2, true);
    samples[i] = Math.max(-1, Math.min(1, sample / 32768));
  }

  return samples;
}

export class Pcm16AudioQueue {
  private audioContext: AudioContext | null = null;
  private nextStartTime = 0;
  private activeSources = new Set<AudioBufferSourceNode>();
  private gainNode: GainNode | null = null;

  async ensureStarted(): Promise<void> {
    if (!this.audioContext) {
      this.audioContext = new AudioContext({ latencyHint: "interactive" });
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = 1;
      this.gainNode.connect(this.audioContext.destination);
    }

    if (this.audioContext.state !== "running") {
      await this.audioContext.resume();
    }

    this.nextStartTime = Math.max(this.nextStartTime, this.audioContext.currentTime + 0.02);
  }

  async pushPcm16(base64Audio: string, sampleRateHz: number): Promise<void> {
    await this.ensureStarted();

    if (!this.audioContext || !this.gainNode) return;

    const pcm = pcm16ToFloat32(base64ToArrayBuffer(base64Audio));
    const audioBuffer = this.audioContext.createBuffer(1, pcm.length, sampleRateHz);
    audioBuffer.copyToChannel(pcm, 0);

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gainNode);

    const startAt = Math.max(this.audioContext.currentTime + 0.01, this.nextStartTime);
    source.start(startAt);

    this.nextStartTime = startAt + audioBuffer.duration;
    this.activeSources.add(source);

    source.onended = () => {
      this.activeSources.delete(source);
    };
  }

  stop(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }

    this.activeSources.clear();

    if (this.audioContext) {
      this.nextStartTime = this.audioContext.currentTime + 0.02;
    }
  }

  async close(): Promise<void> {
    this.stop();
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
      this.gainNode = null;
    }
  }
}

export class ElevenFlash25RealtimeClient {
  private socket: WebSocket | null = null;
  private player = new Pcm16AudioQueue();
  private handlers = new Set<EventHandler>();
  private opened = false;

  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(event: RealtimeEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  async connect(config: ElevenFlashRealtimeConfig): Promise<void> {
    if (this.socket) {
      this.close();
    }

    await this.player.ensureStarted();

    this.socket = new WebSocket(config.wsUrl);

    await new Promise<void>((resolve, reject) => {
      if (!this.socket) return reject(new Error("Socket was not created"));

      const timeout = window.setTimeout(() => {
        reject(new Error("Timed out connecting to GhostDash voice websocket"));
      }, 8000);

      this.socket.onopen = () => {
        window.clearTimeout(timeout);
        this.opened = true;

        this.socket?.send(JSON.stringify({
          type: "start",
          voice_id: config.voiceId,
          model_id: config.modelId ?? "eleven_flash_v2_5",
          output_format: config.outputFormat ?? "pcm_24000",
          language_code: config.languageCode ?? "en",
          seed: config.seed ?? null,
          previous_text: config.previousText ?? "",
          next_text: config.nextText ?? "",
          apply_text_normalization: config.applyTextNormalization ?? "auto",
          auto_mode: config.autoMode ?? true,
          sync_alignment: config.syncAlignment ?? false,
          enable_logging: config.enableLogging ?? true,
          inactivity_timeout: config.inactivityTimeout ?? 180,
          voice_settings: {
            stability: config.voiceSettings?.stability ?? 0.5,
            similarity_boost: config.voiceSettings?.similarity_boost ?? 0.75,
            style: config.voiceSettings?.style ?? 0,
            use_speaker_boost: config.voiceSettings?.use_speaker_boost ?? true,
            speed: config.voiceSettings?.speed ?? 1
          },
          custom_replacements: config.customReplacements ?? []
        }));

        resolve();
      };

      this.socket.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("GhostDash voice websocket connection failed"));
      };

      this.socket.onmessage = async (message) => {
        const event = JSON.parse(message.data) as RealtimeEvent;

        if (event.type === "audio") {
          if (event.format?.startsWith("pcm")) {
            await this.player.pushPcm16(event.audio, event.sample_rate_hz);
          } else {
            // For MP3, use a separate MediaSource/Blob fallback in production.
            // PCM is the recommended low-latency mode.
            console.warn("Received non-PCM audio from realtime path", event.format);
          }
        }

        this.emit(event);
      };

      this.socket.onclose = () => {
        this.opened = false;
      };
    });
  }

  sendDelta(text: string): void {
    if (!this.socket || !this.opened || !text) return;
    this.socket.send(JSON.stringify({ type: "text_delta", text }));
  }

  flush(): void {
    if (!this.socket || !this.opened) return;
    this.socket.send(JSON.stringify({ type: "flush" }));
  }

  finish(): void {
    if (!this.socket || !this.opened) return;
    this.socket.send(JSON.stringify({ type: "finish" }));
  }

  cancel(): void {
    this.player.stop();

    if (this.socket && this.opened) {
      this.socket.send(JSON.stringify({ type: "cancel" }));
    }

    this.close();
  }

  close(): void {
    this.player.stop();

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.opened = false;
  }
}

/**
 * Example usage:
 *
 * const client = new ElevenFlash25RealtimeClient();
 * await client.connect({
 *   wsUrl: "wss://ghoststack.rideai.com.au/api/voice/elevenlabs/flash25/realtime",
 *   voiceId: selectedVoiceId,
 *   outputFormat: "pcm_24000"
 * });
 *
 * llmStream.onDelta((delta) => client.sendDelta(delta));
 * llmStream.onDone(() => client.finish());
 * stopButton.onclick = () => client.cancel();
 */
