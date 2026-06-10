import { fetchElevenLabsPreviewMpeg } from "../api";
import type { WorkbenchChatTurn } from "../components/TestWorkbenchStepPanel";

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function playBlob(blob: Blob) {
  const url = URL.createObjectURL(blob);
  try {
    const audio = new Audio(url);
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("Audio playback failed."));
      void audio.play().catch(reject);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function speakWithBrowser(text: string) {
  const trimmed = text.trim();
  if (!trimmed || !("speechSynthesis" in window)) return;
  await new Promise<void>((resolve) => {
    const utterance = new SpeechSynthesisUtterance(trimmed);
    utterance.rate = 1;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    window.speechSynthesis.speak(utterance);
  });
}

export async function playWorkbenchTurns(args: {
  turns: WorkbenchChatTurn[];
  agentVoiceId?: string | null;
  onHighlight?: (index: number | null) => void;
}) {
  const { turns, agentVoiceId, onHighlight } = args;
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    const text = turn.message?.trim();
    if (!text) continue;
    onHighlight?.(index);
    try {
      if (turn.role === "agent" && agentVoiceId) {
        const blob = await fetchElevenLabsPreviewMpeg({ voiceId: agentVoiceId, text });
        await playBlob(blob);
      } else {
        await speakWithBrowser(text);
      }
    } catch {
      await speakWithBrowser(text);
    }
    await sleep(180);
  }
  onHighlight?.(null);
}
