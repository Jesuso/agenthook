// A `speechSynthesis` stand-in for read-aloud tests (#560): records every call, and `finish()`
// ends the playing utterance the way a browser fires `end`.

export class FakeUtterance {
  text: string;
  rate = 1;
  lang = "";
  voice: unknown = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

export type FakeSynth = ReturnType<typeof installSpeech>;

export function installSpeech(voices: { lang: string; default: boolean; localService: boolean; name?: string }[] = []) {
  const calls: string[] = [];
  const queue: FakeUtterance[] = [];
  const synth = {
    calls,
    queue,
    getVoices: () => voices,
    speak(u: FakeUtterance) {
      calls.push(`speak:${u.text}`);
      queue.push(u);
      if (queue.length === 1) u.onstart?.();
    },
    cancel() {
      calls.push("cancel");
      for (const u of queue.splice(0)) u.onerror?.();
    },
    /** The playing utterance ends; the next queued one starts. */
    finish() {
      queue.shift()?.onend?.();
      queue[0]?.onstart?.();
    },
  };
  Object.assign(globalThis, { speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance });
  return synth;
}

export function uninstallSpeech(): void {
  delete (globalThis as { speechSynthesis?: unknown }).speechSynthesis;
  delete (globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
}
