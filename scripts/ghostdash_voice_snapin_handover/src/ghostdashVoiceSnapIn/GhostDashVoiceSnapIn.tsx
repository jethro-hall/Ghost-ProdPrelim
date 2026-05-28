import type { GhostDashVoiceSnapInApi } from "./useGhostDashVoiceSnapIn";
import "./ghostDashVoiceSnapIn.css";

type Props = {
  voice: GhostDashVoiceSnapInApi;
  speakResponses: boolean;
  onSpeakResponsesChange: (value: boolean) => void;
  openStreamingLabel?: string;
  className?: string;
};

export function GhostDashVoiceSnapIn({
  voice,
  speakResponses,
  onSpeakResponsesChange,
  openStreamingLabel = "Open Streaming",
  className = ""
}: Props) {
  const isListening = voice.state === "listening" || voice.state === "transcribing";
  const isSpeaking = voice.state === "speaking" || voice.state === "tts_ready" || voice.state === "tts_connecting";

  return (
    <section className={`gd-voice-snapin ${className}`} aria-label="GhostDash voice controls">
      <div className="gd-voice-row gd-voice-row-tight">
        <label className="gd-voice-check">
          <input
            type="checkbox"
            checked={speakResponses}
            onChange={(event) => onSpeakResponsesChange(event.target.checked)}
          />
          <span>Speak response</span>
        </label>

        <button
          type="button"
          className="gd-voice-pill"
          onClick={isListening ? voice.stopDictation : voice.startDictation}
          aria-pressed={isListening}
        >
          {isListening ? "Stop mic" : "Mic"}
        </button>

        <button
          type="button"
          className="gd-voice-pill"
          onClick={voice.stopSpeaking}
          disabled={!isSpeaking}
        >
          Stop speaking
        </button>

        <button
          type="button"
          className="gd-voice-pill gd-voice-pill-hot"
          onClick={() => voice.requestMicPermission()}
        >
          {openStreamingLabel}
        </button>
      </div>

      <div className="gd-voice-meter-wrap">
        <div
          className={`gd-voice-meter ${isListening ? "is-live" : ""}`}
          role="img"
          aria-label={isListening ? "Microphone signal is active" : "Microphone signal is idle"}
        >
          {voice.bars.map((value, index) => (
            <span
              // eslint-disable-next-line react/no-array-index-key
              key={index}
              className="gd-voice-bar"
              style={{ "--bar-scale": String(Math.max(0.08, value)) } as React.CSSProperties}
            />
          ))}
        </div>

        <div className="gd-voice-status">
          <strong>Voice:</strong> {voice.state}
          <span className="gd-voice-dot">•</span>
          <span>STT {voice.speechSupported ? "available" : "not available"}</span>
          <span className="gd-voice-dot">•</span>
          <span>Mic {voice.micPermission}</span>
        </div>
      </div>

      {(voice.interimTranscript || voice.lastFinalTranscript) && (
        <div className="gd-voice-transcript">
          {voice.interimTranscript || voice.lastFinalTranscript}
        </div>
      )}

      {voice.streamingMetrics && (
        <div className="gd-voice-metrics">
          {typeof voice.streamingMetrics.first_audio_chunk_ms === "number" && (
            <span>First audio {voice.streamingMetrics.first_audio_chunk_ms}ms</span>
          )}
          {typeof voice.streamingMetrics.first_text_sent_ms === "number" && (
            <span>First text {voice.streamingMetrics.first_text_sent_ms}ms</span>
          )}
        </div>
      )}
    </section>
  );
}
