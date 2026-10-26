// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isSpeaking, newEntries, pickVoice, speak, speakingId, speechSupported, speechText, stopSpeech } from "./speech";
import { installSpeech, uninstallSpeech } from "./speechMock";
import type { FakeUtterance } from "./speechMock";

describe("speechText", () => {
  it("reads a fenced code block (``` or ~~~, closed or not) as the words 'code block'", () => {
    expect(speechText("Before\n\n```js\nconst a = 1;\n```\n\nAfter")).toBe("Before. code block. After.");
    expect(speechText("~~~\nrm -rf /\n~~~")).toBe("code block.");
    expect(speechText("Look:\n```\nnever closed\nstill code")).toBe("Look: code block.");
  });

  it("keeps inline code's text without the backticks, untouched by the syntax stripping", () => {
    expect(speechText("Run `npm test` now")).toBe("Run npm test now.");
    expect(speechText("set `a * b` and ``x `y` z``")).toBe("set a * b and x `y` z.");
  });

  it("reads a link and an image by their text, a bare URL as 'link'", () => {
    expect(speechText("See [the PR](https://github.com/x/y/pull/1) and ![a chart](c.png)")).toBe("See the PR and a chart.");
    expect(speechText("Logs at https://example.com/a?b=1 and <https://example.com>")).toBe("Logs at link and link.");
  });

  it("drops HTML tags and markdown syntax: headings, emphasis, lists, quotes, tables", () => {
    expect(speechText("## What happened\n**Two** tickets _failed_ and *one* held")).toBe("What happened. Two tickets failed and one held.");
    expect(speechText("- first\n* second\n1. third\n- [x] done")).toBe("first. second. third. done.");
    expect(speechText("> quoted line")).toBe("quoted line.");
    expect(speechText("| id | state |\n|---|:--:|\n| #1 | held |")).toBe("id, state. #1, held.");
    expect(speechText("a <b>bold</b> word<br/>")).toBe("a bold word.");
    expect(speechText("snake_case_name stays")).toBe("snake_case_name stays.");
    expect(speechText("---\n# Title #")).toBe("Title.");
  });

  it("ends each line that has no stop with a period, and collapses whitespace", () => {
    expect(speechText("Done!\nWhy?\nNote:\nplain")).toBe("Done! Why? Note: plain.");
    expect(speechText("  lots   of\tspace  \n\n\n")).toBe("lots of space.");
    expect(speechText("")).toBe("");
  });
});

describe("pickVoice", () => {
  const v = (lang: string, extra: { default?: boolean; localService?: boolean } = {}) => ({ lang, default: false, localService: false, ...extra });

  it("matches the primary language subtag, any case", () => {
    const fr = v("fr-FR");
    expect(pickVoice([v("en-US"), fr], "FR")).toBe(fr);
    expect(pickVoice([v("EN_gb")], "en-US")?.lang).toBe("EN_gb");
  });

  it("prefers the default voice, then an on-device one, then the first match", () => {
    const a = v("en-US");
    const local = v("en-GB", { localService: true });
    const def = v("en-AU", { default: true });
    expect(pickVoice([a, local, def], "en")).toBe(def);
    expect(pickVoice([a, local], "en")).toBe(local);
    expect(pickVoice([a, v("en-GB")], "en")).toBe(a);
  });

  it("is undefined with no voices yet or none in the language", () => {
    expect(pickVoice([], "en")).toBeUndefined();
    expect(pickVoice([v("de-DE", { default: true })], "en")).toBeUndefined();
  });
});

describe("newEntries", () => {
  it("returns the keys not yet seen, in order, and remembers them", () => {
    const seen = new Set(["a"]);
    expect(newEntries(seen, ["a", "b", "c"])).toEqual(["b", "c"]);
    expect([...seen]).toEqual(["a", "b", "c"]);
    expect(newEntries(seen, ["c", "b"])).toEqual([]);
    expect(newEntries(seen, ["d", "d"])).toEqual(["d"]);
  });
});

describe("speak", () => {
  let synth: ReturnType<typeof installSpeech>;
  const last = () => synth.queue[synth.queue.length - 1] as FakeUtterance;

  beforeEach(() => {
    document.documentElement.lang = "en";
    synth = installSpeech([
      { lang: "fr-FR", default: false, localService: true, name: "Amélie" },
      { lang: "en-US", default: true, localService: false, name: "Sam" },
    ]);
  });
  afterEach(() => {
    stopSpeech();
    uninstallSpeech();
  });

  it("is supported only with both the synth and the utterance constructor", () => {
    expect(speechSupported()).toBe(true);
    delete (globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
    expect(speechSupported()).toBe(false);
    uninstallSpeech();
    expect(speechSupported()).toBe(false);
    expect(() => speak("hi", { interrupt: true })).not.toThrow();
  });

  it("sets rate, the page's lang and a matching voice", () => {
    document.documentElement.lang = "fr-CA";
    speak("bonjour", { rate: 1.25, interrupt: true });
    expect(last().rate).toBe(1.25);
    expect(last().lang).toBe("fr-CA");
    expect((last().voice as { name: string }).name).toBe("Amélie");
    document.documentElement.removeAttribute("lang");
    speak("hello", { interrupt: true });
    expect(last().lang).toBe("en");
    expect((last().voice as { name: string }).name).toBe("Sam");
  });

  it("an interrupting speak cancels first; a queued one never cancels", () => {
    speak("one", { interrupt: true, id: "a" });
    speak("two", { interrupt: false });
    speak("three", { interrupt: false });
    expect(synth.calls).toEqual(["cancel", "speak:one", "speak:two", "speak:three"]);
    expect(speakingId()).toBe("a");
    synth.finish();
    expect(isSpeaking()).toBe(true);
    expect(speakingId()).toBeNull();
    speak("four", { interrupt: true, id: "b" });
    expect(synth.calls.slice(-2)).toEqual(["cancel", "speak:four"]);
    expect(speakingId()).toBe("b");
    synth.finish();
    expect(isSpeaking()).toBe(false);
  });

  it("while speech plays, Escape stops it and goes no further; otherwise Escape passes through", () => {
    let reached = 0;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && reached++;
    window.addEventListener("keydown", onKey);
    try {
      speak("one", { interrupt: true, id: "a" });
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(reached).toBe(0);
      expect(isSpeaking()).toBe(false);
      expect(synth.calls.at(-1)).toBe("cancel");
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(reached).toBe(1);
    } finally {
      window.removeEventListener("keydown", onKey);
    }
  });
});
