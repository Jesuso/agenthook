// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { SpeakButton } from "./SpeakButton";
import { mount, click } from "../domHarness";
import type { Mounted } from "../domHarness";
import { readingDefaults, setReading } from "../reading";
import { stopSpeech } from "../speech";
import { installSpeech, uninstallSpeech } from "../speechMock";

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("[data-speak]")];
const on = async (values: Record<string, string> = {}) => act(async () => setReading({ ...readingDefaults(), readaloud: "on", ...values }));

let m: Mounted | null = null;
let synth: ReturnType<typeof installSpeech>;

const both = () =>
  createElement("div", null, createElement(SpeakButton, { text: "## One\n`code`", label: "Read one" }), createElement(SpeakButton, { text: "Two", label: "Read two" }));

beforeEach(() => {
  localStorage.removeItem("ah-reading");
  synth = installSpeech();
});

afterEach(async () => {
  stopSpeech();
  await m?.unmount();
  m = null;
  await act(async () => setReading(readingDefaults()));
  uninstallSpeech();
});

describe("SpeakButton", () => {
  it("renders nothing while Read aloud is off, and appears and goes the moment it is toggled", async () => {
    m = await mount(both());
    expect(m.root.innerHTML).toBe("<div></div>");
    await on();
    expect(buttons().map((b) => b.getAttribute("aria-label"))).toEqual(["Read one", "Read two"]);
    expect(buttons()[0].getAttribute("aria-pressed")).toBe("false");
    await act(async () => setReading(readingDefaults()));
    expect(buttons()).toEqual([]);
  });

  it("renders nothing where the browser can't speak, even with Read aloud on", async () => {
    uninstallSpeech();
    localStorage.setItem("ah-reading", JSON.stringify({ readaloud: "on" }));
    m = await mount(both());
    expect(buttons()).toEqual([]);
  });

  it("a press cancels other speech and reads its own text at the chosen speed; a second press stops it", async () => {
    m = await mount(both());
    await on({ rate: "1.5" });
    await click(buttons()[1]);
    expect(buttons()[1].getAttribute("aria-pressed")).toBe("true");
    await click(buttons()[0]);
    expect(synth.calls).toEqual(["cancel", "speak:Two.", "cancel", "speak:One. code."]);
    expect(synth.queue[0].rate).toBe(1.5);
    expect(buttons().map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    await click(buttons()[0]);
    expect(synth.calls.at(-1)).toBe("cancel");
    expect(synth.calls.filter((c) => c.startsWith("speak")).length).toBe(2);
    expect(buttons()[0].getAttribute("aria-pressed")).toBe("false");
  });

  it("goes back to unpressed when its utterance ends", async () => {
    m = await mount(both());
    await on();
    await click(buttons()[0]);
    await act(async () => synth.finish());
    expect(buttons()[0].getAttribute("aria-pressed")).toBe("false");
  });

  it("Escape while speaking stops the speech without reaching other Escape handlers; otherwise it is unchanged", async () => {
    let closed = 0;
    const drawer = (e: KeyboardEvent) => e.key === "Escape" && closed++;
    window.addEventListener("keydown", drawer);
    try {
      m = await mount(both());
      await on();
      await click(buttons()[0]);
      await act(async () => {
        buttons()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(closed).toBe(0);
      expect(synth.calls.at(-1)).toBe("cancel");
      expect(buttons()[0].getAttribute("aria-pressed")).toBe("false");
      await act(async () => {
        buttons()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(closed).toBe(1);
    } finally {
      window.removeEventListener("keydown", drawer);
    }
  });
});
