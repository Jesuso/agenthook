import { useId, useSyncExternalStore } from "react";
import { IconButton } from "./IconButton";
import { speak, speakingId, speechSupported, speechText, stopSpeech, subscribeSpeaking } from "../speech";
import { useReading } from "../useReading";

/**
 * A 🔊 that reads `text` (markdown is fine) aloud (#560). Renders nothing unless the reading
 * panel's Read aloud is on and the browser can speak, so the default UI is unchanged. A press
 * cancels any other speech and starts this one; pressing it again while it plays stops it.
 */
export function SpeakButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const reading = useReading();
  const id = useId();
  const pressed = useSyncExternalStore(subscribeSpeaking, speakingId, speakingId) === id;
  if (reading.readaloud !== "on" || !speechSupported()) return null;
  return (
    <IconButton
      label={label}
      aria-pressed={pressed}
      data-speak
      className={className}
      onClick={() => (pressed ? stopSpeech() : speak(speechText(text), { rate: Number(reading.rate) || 1, interrupt: true, id }))}
    >
      <span aria-hidden="true">🔊</span>
    </IconButton>
  );
}
