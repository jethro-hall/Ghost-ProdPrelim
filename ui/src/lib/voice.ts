export type BrowserVoiceCapabilities = {
  speechRecognition: boolean;
  speechSynthesis: boolean;
  mediaDevices: boolean;
};

export type SpeechRecognitionResultLike = {
  transcript: string;
  isFinal: boolean;
};

export type SpeechRecognitionLike = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
};

export type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: {
      transcript: string;
    };
  }>;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechWindow = Window &
  typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };

export function getBrowserVoiceCapabilities(): BrowserVoiceCapabilities {
  if (typeof window === "undefined") {
    return { speechRecognition: false, speechSynthesis: false, mediaDevices: false };
  }
  const speechWindow = window as SpeechWindow;
  return {
    speechRecognition: Boolean(speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition),
    speechSynthesis: "speechSynthesis" in window && typeof window.speechSynthesis?.speak === "function",
    mediaDevices: Boolean(navigator.mediaDevices?.getUserMedia),
  };
}

export function createSpeechRecognition(lang = "en-AU"): SpeechRecognitionLike | null {
  if (typeof window === "undefined") return null;
  const speechWindow = window as SpeechWindow;
  const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
  if (!Recognition) return null;
  const recognition = new Recognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = lang;
  return recognition;
}

export function getBrowserSpeechVoices(): SpeechSynthesisVoice[] {
  if (typeof window === "undefined" || !window.speechSynthesis) return [];
  return window.speechSynthesis.getVoices();
}

export function speakText(text: string, options: { voiceURI?: string; lang?: string; rate?: number } = {}) {
  if (typeof window === "undefined" || !window.speechSynthesis || !text.trim()) return false;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.trim());
  utterance.lang = options.lang ?? "en-AU";
  utterance.rate = options.rate ?? 1;
  if (options.voiceURI) {
    const voice = getBrowserSpeechVoices().find((candidate) => candidate.voiceURI === options.voiceURI);
    if (voice) utterance.voice = voice;
  }
  window.speechSynthesis.speak(utterance);
  return true;
}

export function stopSpeaking() {
  if (typeof window !== "undefined" && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}
