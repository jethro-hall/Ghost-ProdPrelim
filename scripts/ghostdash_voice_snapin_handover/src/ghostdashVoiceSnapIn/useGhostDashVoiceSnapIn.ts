import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ElevenFlash25RealtimeClient,
  type ElevenFlashRealtimeConfig,
  type ElevenRealtimeEvent
} from "./ghostDashVoiceRealtimeClient";

type SpeechRecognitionCtor = new () => SpeechRecognition;

type SpeechRecognition = EventTarget & {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
};

type SpeechRecognitionEvent = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string; confidence: number };
  }>;
};

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

export type VoiceSnapInState =
  | "idle"
  | "mic_permission_needed"
  | "listening"
  | "transcribing"
  | "tts_connecting"
  | "tts_ready"
  | "speaking"
  | "stopped"
  | "error";

export type UseGhostDashVoiceSnapInOptions = {
  ttsWsUrl: string;
  voiceId: string | null;
  enabled?: boolean;
  languageCode?: string;
  onTranscriptFinal?: (text: string) => void;
  onTranscriptInterim?: (text: string) => void;
  onError?: (message: string) => void;
  onRealtimeEvent?: (event: ElevenRealtimeEvent) => void;
  voiceSettings?: ElevenFlashRealtimeConfig["voiceSettings"];
  customReplacements?: ElevenFlashRealtimeConfig["customReplacements"];
};

export type GhostDashVoiceSnapInApi = ReturnType<typeof useGhostDashVoiceSnapIn>;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function emptyBars(count = 14): number[] {
  return Array.from({ length: count }, () => 0.05);
}

export function useGhostDashVoiceSnapIn(options: UseGhostDashVoiceSnapInOptions) {
  const {
    ttsWsUrl,
    voiceId,
    enabled = true,
    languageCode = "en-AU",
    onTranscriptFinal,
    onTranscriptInterim,
    onError,
    onRealtimeEvent,
    voiceSettings,
    customReplacements
  } = options;

  const [state, setState] = useState<VoiceSnapInState>("idle");
  const [micPermission, setMicPermission] = useState<PermissionState | "unknown">("unknown");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [lastFinalTranscript, setLastFinalTranscript] = useState("");
  const [bars, setBars] = useState<number[]>(() => emptyBars());
  const [streamingMetrics, setStreamingMetrics] = useState<Record<string, unknown> | null>(null);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const meterAudioContextRef = useRef<AudioContext | null>(null);
  const meterFrameRef = useRef<number | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const ttsClientRef = useRef<ElevenFlash25RealtimeClient | null>(null);
  const finalTranscriptBufferRef = useRef("");

  const speechSupported = useMemo(() => !!getSpeechRecognitionCtor(), []);

  const stopMeter = useCallback(() => {
    if (meterFrameRef.current) {
      window.cancelAnimationFrame(meterFrameRef.current);
      meterFrameRef.current = null;
    }

    setBars(emptyBars());
  }, []);

  const cleanupMicStream = useCallback(() => {
    stopMeter();

    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        track.stop();
      }
      mediaStreamRef.current = null;
    }

    if (meterAudioContextRef.current) {
      void meterAudioContextRef.current.close();
      meterAudioContextRef.current = null;
    }

    analyserRef.current = null;
  }, [stopMeter]);

  const startMeter = useCallback(async () => {
    cleanupMicStream();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    mediaStreamRef.current = stream;

    const audioContext = new AudioContext({ latencyHint: "interactive" });
    meterAudioContextRef.current = audioContext;

    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);
    analyserRef.current = analyser;

    const data = new Uint8Array(analyser.frequencyBinCount);
    const barCount = 14;

    const tick = () => {
      analyser.getByteFrequencyData(data);

      const values: number[] = [];
      const bucketSize = Math.floor(data.length / barCount);

      for (let i = 0; i < barCount; i += 1) {
        const start = i * bucketSize;
        const end = start + bucketSize;
        let sum = 0;

        for (let j = start; j < end; j += 1) {
          sum += data[j] ?? 0;
        }

        const avg = sum / bucketSize;
        values.push(Math.max(0.05, Math.min(1, avg / 180)));
      }

      setBars(values);
      meterFrameRef.current = window.requestAnimationFrame(tick);
    };

    tick();
    setMicPermission("granted");
  }, [cleanupMicStream]);

  const requestMicPermission = useCallback(async (): Promise<boolean> => {
    try {
      await startMeter();
      setState("mic_permission_needed");
      return true;
    } catch (error) {
      setMicPermission("denied");
      setState("error");
      onError?.("Microphone permission was denied or no microphone was found.");
      return false;
    }
  }, [onError, startMeter]);

  const startDictation = useCallback(async () => {
    if (!enabled) return;

    if (!speechSupported) {
      const ok = await requestMicPermission();
      if (ok) {
        setState("error");
        onError?.("Browser speech recognition is not available. Use Chrome/Edge or wire a backend STT endpoint.");
      }
      return;
    }

    try {
      await startMeter();

      const Ctor = getSpeechRecognitionCtor();
      if (!Ctor) return;

      finalTranscriptBufferRef.current = "";
      setInterimTranscript("");
      setLastFinalTranscript("");

      const recognition = new Ctor();
      recognition.lang = languageCode;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        setState("listening");
      };

      recognition.onerror = (event) => {
        setState("error");
        onError?.(`Speech recognition failed: ${event.error}`);
      };

      recognition.onend = () => {
        cleanupMicStream();
        setState((current) => current === "listening" || current === "transcribing" ? "idle" : current);

        const finalText = finalTranscriptBufferRef.current.trim();
        if (finalText) {
          setLastFinalTranscript(finalText);
          onTranscriptFinal?.(finalText);
        }
      };

      recognition.onresult = (event) => {
        setState("transcribing");

        let interim = "";

        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const text = result[0]?.transcript ?? "";

          if (result.isFinal) {
            finalTranscriptBufferRef.current = `${finalTranscriptBufferRef.current} ${text}`.trim();
          } else {
            interim += text;
          }
        }

        setInterimTranscript(interim.trim());
        if (interim.trim()) {
          onTranscriptInterim?.(interim.trim());
        }
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (error) {
      cleanupMicStream();
      setState("error");
      onError?.(error instanceof Error ? error.message : "Could not start microphone dictation.");
    }
  }, [
    cleanupMicStream,
    enabled,
    languageCode,
    onError,
    onTranscriptFinal,
    onTranscriptInterim,
    requestMicPermission,
    speechSupported,
    startMeter
  ]);

  const stopDictation = useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch {
      // ignored
    }

    cleanupMicStream();
    setState("idle");
  }, [cleanupMicStream]);

  const prepareAssistantSpeech = useCallback(async (args?: { previousText?: string; nextText?: string }) => {
    if (!enabled || !voiceId) return;

    setState("tts_connecting");

    const client = new ElevenFlash25RealtimeClient();
    ttsClientRef.current = client;

    client.onEvent((event) => {
      onRealtimeEvent?.(event);

      if ("metrics" in event && typeof event.metrics === "object") {
        setStreamingMetrics(event.metrics as Record<string, unknown>);
      }

      if (event.type === "ready") setState("tts_ready");
      if (event.type === "audio") setState("speaking");
      if (event.type === "final") setState("idle");
      if (event.type === "cancelled") setState("stopped");
      if (event.type === "error") {
        setState("error");
        onError?.(String(event.error ?? "Realtime TTS failed"));
      }
    });

    await client.connect({
      wsUrl: ttsWsUrl,
      voiceId,
      modelId: "eleven_flash_v2_5",
      outputFormat: "pcm_24000",
      languageCode: "en",
      previousText: args?.previousText ?? "",
      nextText: args?.nextText ?? "",
      applyTextNormalization: "auto",
      autoMode: true,
      syncAlignment: false,
      enableLogging: true,
      voiceSettings,
      customReplacements
    });
  }, [customReplacements, enabled, onError, onRealtimeEvent, ttsWsUrl, voiceId, voiceSettings]);

  const speakAssistantDelta = useCallback((delta: string) => {
    if (!enabled || !voiceId || !delta) return;
    ttsClientRef.current?.sendDelta(delta);
  }, [enabled, voiceId]);

  const finishAssistantSpeech = useCallback(() => {
    ttsClientRef.current?.finish();
  }, []);

  const stopSpeaking = useCallback(() => {
    ttsClientRef.current?.cancel();
    ttsClientRef.current = null;
    setState("stopped");
  }, []);

  const reset = useCallback(() => {
    stopDictation();
    stopSpeaking();
    setInterimTranscript("");
    setLastFinalTranscript("");
    setStreamingMetrics(null);
    setState("idle");
  }, [stopDictation, stopSpeaking]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      cleanupMicStream();
      ttsClientRef.current?.close();
    };
  }, [cleanupMicStream]);

  return {
    state,
    micPermission,
    speechSupported,
    interimTranscript,
    lastFinalTranscript,
    bars,
    streamingMetrics,
    requestMicPermission,
    startDictation,
    stopDictation,
    prepareAssistantSpeech,
    speakAssistantDelta,
    finishAssistantSpeech,
    stopSpeaking,
    reset
  };
}
