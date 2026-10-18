// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationsForm, isSecretPath } from "./ConfigForms";
import { addSink, moveSink, removeSink, sinkEvents } from "./configEdit";
import { answerConfirm, click, confirmDialog, mount } from "./domHarness";
import { ConfirmProvider } from "./Modal";
import type { Mounted } from "./domHarness";

// The Integrations tab (#342): sinks, digest, overlapGuard — every edit a minimal text edit.

let m: Mounted | null = null;
afterEach(async () => {
  await m?.unmount();
  m = null;
  vi.unstubAllGlobals();
});

/** Mount the form over a live buffer (each edit re-renders, like ConfigView); `texts` records every edit. */
async function live(initial: unknown) {
  const texts: string[] = [];
  const start = typeof initial === "string" ? initial : JSON.stringify(initial, null, 2);
  function Host() {
    const [text, setText] = useState(start);
    return createElement(
      ConfirmProvider,
      null,
      createElement(IntegrationsForm, {
        text,
        raw: JSON.parse(text),
        onEdit: (next: string) => {
          texts.push(next);
          setText(next);
        },
      }),
    );
  }
  m = await mount(createElement(Host));
  return { root: m.root, texts, text: () => texts.at(-1) ?? start, last: () => JSON.parse(texts.at(-1) ?? start) };
}

const field = <T extends Element = HTMLInputElement>(root: Element, name: string) => root.querySelector<T>(`[name="${name}"]`)!;
const card = (root: Element, i: number) => root.querySelector<HTMLElement>(`[data-sink-card="${i}"]`)!;
const box = (root: Element, i: number, ev: string) => card(root, i).querySelector<HTMLInputElement>(`[data-sink-event="${ev}"]`)!;

const setInput = (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

const pick = (el: HTMLSelectElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });

describe("sinks: add / edit / remove / reorder", () => {
  it("+ Add sink appends a slack sink (creating the array), then each type's fields edit the right keys", async () => {
    const { root, last } = await live({ name: "p" });
    await click(root.querySelector("[data-add-sink]")!);
    expect(last().sinks).toEqual([{ type: "slack", url: "" }]);
    await setInput(field(root, "sinks.0.url"), "${SLACK_URL}");
    expect(last().sinks[0]).toEqual({ type: "slack", url: "${SLACK_URL}" });

    await click(root.querySelector("[data-add-sink]")!);
    await pick(field<HTMLSelectElement>(root, "sinks.1.type"), "telegram");
    expect(field(root, "sinks.1.url")).toBeNull();
    await setInput(field(root, "sinks.1.botToken"), "${TG_TOKEN}");
    await setInput(field(root, "sinks.1.chatId"), "-1001");
    // Switching type leaves the other type's key in the file.
    expect(last().sinks[1]).toEqual({ type: "telegram", url: "", botToken: "${TG_TOKEN}", chatId: "-1001" });

    await click(root.querySelector("[data-add-sink]")!);
    await pick(field<HTMLSelectElement>(root, "sinks.2.type"), "webhook");
    await setInput(field(root, "sinks.2.url"), "${HOOK_URL}");
    expect(last().sinks[2]).toEqual({ type: "webhook", url: "${HOOK_URL}" });
    expect(last().name).toBe("p");
  });

  it("a numeric chatId is shown as-is and only rewritten when edited", async () => {
    const { root, texts, last } = await live({ sinks: [{ type: "telegram", botToken: "${T}", chatId: 12345 }] });
    expect(field(root, "sinks.0.chatId").value).toBe("12345");
    expect(texts).toEqual([]);
    await setInput(field(root, "sinks.0.chatId"), "123456");
    expect(last().sinks[0].chatId).toBe("123456");
  });

  it("remove only after the confirm; ↑/↓ swap cards with every key (comments included)", async () => {
    const a = { "//": "ops channel", type: "slack", url: "${A}" };
    const b = { type: "webhook", url: "${B}", futureKey: 1, events: ["blocked"] };
    const { root, texts, last } = await live({ sinks: [a, b] });
    await click(card(root, 0).querySelector("[data-remove-sink]")!);
    expect(confirmDialog()?.textContent).toContain("Remove sink #1 (slack)?");
    await answerConfirm(false);
    expect(texts).toEqual([]);
    await click(card(root, 1).querySelector('[aria-label="move sink up"]')!);
    expect(last().sinks).toEqual([b, a]);
    await click(card(root, 1).querySelector('[aria-label="move sink up"]')!);
    expect(last().sinks).toEqual([a, b]);
    await click(card(root, 0).querySelector("[data-remove-sink]")!);
    await answerConfirm(true);
    expect(last().sinks).toEqual([b]);
  });

  it("a // comment key and an unknown key inside a sink survive edits byte-for-byte", async () => {
    const text = `{
  "name": "p",
  "sinks": [
    {
      "//": "the ops channel",
      "type": "slack",
      "futureKey": { "x": 1 },
      "url": "\${OLD}"
    }
  ]
}`;
    const { root, text: now } = await live(text);
    await setInput(field(root, "sinks.0.url"), "${NEW_URL}");
    expect(now()).toBe(text.replace("${OLD}", "${NEW_URL}"));
    await click(box(root, 0, "merged"));
    expect(now()).toContain(`"//": "the ops channel",\n      "type": "slack",\n      "futureKey": { "x": 1 },`);
  });

  it("pure helpers: addSink / removeSink / moveSink", () => {
    expect(JSON.parse(addSink(`{"sinks": [{"type": "webhook", "url": "u"}]}`)).sinks).toEqual([{ type: "webhook", url: "u" }, { type: "slack", url: "" }]);
    expect(JSON.parse(removeSink(`{"sinks": [1, 2, 3]}`, 1)).sinks).toEqual([1, 3]);
    expect(moveSink(`{"sinks": [1, 2]}`, 1, 1)).toBe(`{"sinks": [1, 2]}`);
    expect(moveSink(`{"sinks": [{"a": 1}, 2]}`, 0, 1)).toBe(`{"sinks": [2, {"a": 1}]}`);
  });
});

describe("sinks: unknown type", () => {
  it("renders read-only (remove/reorder only) and its JSON stays byte-identical through other edits", async () => {
    const discord = `{ "type": "discord", "hook": "\${D}", "//": "later" }`;
    const text = `{
  "sinks": [
    ${discord},
    {
      "type": "slack",
      "url": "\${S}"
    },
    5
  ]
}`;
    const { root, text: now } = await live(text);
    const c0 = card(root, 0);
    expect(c0.hasAttribute("data-sink-unknown")).toBe(true);
    expect(c0.textContent).toContain('unknown sink type "discord"');
    expect(c0.textContent).toContain("edit in Raw");
    expect(c0.querySelectorAll("input, select")).toHaveLength(0);
    expect(card(root, 2).textContent).toContain("not a sink object");
    expect(c0.textContent).toContain("sinks[0].type must be one of slack, telegram, webhook");

    await setInput(field(root, "sinks.1.url"), "${S2}");
    await click(box(root, 1, "run_end"));
    await setInput(field(root, "digest.soul"), "SOUL2.md");
    await click(field(root, "overlapGuard"));
    expect(now()).toContain(discord);
    expect(now().indexOf(discord)).toBe(text.indexOf(discord));
  });
});

describe("sinks: secrets", () => {
  it("isSecretPath matches sinks[*].url / botToken by index", () => {
    expect(isSecretPath(["sinks", 0, "url"])).toBe(true);
    expect(isSecretPath(["sinks", 3, "botToken"])).toBe(true);
    expect(isSecretPath(["sinks", 0, "chatId"])).toBe(false);
    expect(isSecretPath(["tracker", "token"])).toBe(true);
    expect(isSecretPath(["sinks", "url"])).toBe(false);
  });

  it("a literal url / botToken never reaches innerHTML; the warning names the path; a ${VAR} ref is shown and editable", async () => {
    const { root, last } = await live({
      sinks: [
        { type: "slack", url: "https://hooks.slack.com/services/T000/SECRET" },
        { type: "telegram", botToken: "123:literal-bot-token", chatId: "1" },
        { type: "webhook", url: "${HOOK_URL}" },
      ],
    });
    expect(root.innerHTML).not.toContain("hooks.slack.com");
    expect(root.innerHTML).not.toContain("literal-bot-token");
    expect(card(root, 1).querySelector('[data-secret-state="literal"]')!.textContent).toContain("literal secret in sinks.1.botToken");
    expect(card(root, 0).querySelector('[data-secret-state="literal"]')!.textContent).toContain("sinks.0.url");
    expect(field(root, "sinks.2.url").value).toBe("${HOOK_URL}");
    await setInput(field(root, "sinks.2.url"), "${OTHER_URL}");
    expect(last().sinks[2].url).toBe("${OTHER_URL}");
  });
});

describe("sinks: events", () => {
  it("absent shows the defaults checked with a 'default' note; a toggle writes an explicit array; Use default removes the key", async () => {
    const { root, last } = await live({ sinks: [{ type: "slack", url: "${U}" }] });
    const c = card(root, 0);
    expect(c.querySelector("[data-sink-events-default-note]")).not.toBeNull();
    const checked = [...c.querySelectorAll<HTMLInputElement>("[data-sink-event]")].filter((b) => b.checked).map((b) => b.dataset.sinkEvent);
    expect(checked).toEqual(["blocked", "failed", "move_refused", "pipeline_done"]);
    await click(box(root, 0, "merged"));
    expect(last().sinks[0].events).toEqual(["blocked", "failed", "move_refused", "pipeline_done", "merged"]);
    await click(box(root, 0, "failed"));
    expect(last().sinks[0].events).toEqual(["blocked", "move_refused", "pipeline_done", "merged"]);
    await click(card(root, 0).querySelector("[data-sink-events-default]")!);
    expect(last().sinks[0]).toEqual({ type: "slack", url: "${U}" });
  });

  it("an event name not on the list is shown checked and kept through other toggles", async () => {
    const { root, last } = await live({ sinks: [{ type: "webhook", url: "${U}", events: ["future_event", "blocked"] }] });
    expect(box(root, 0, "future_event").checked).toBe(true);
    await click(box(root, 0, "ci_red"));
    expect(last().sinks[0].events).toEqual(["future_event", "blocked", "ci_red"]);
    expect(sinkEvents(["x"]).names.at(-1)).toBe("x");
  });

  it("an empty array shows nothing checked (no default note); a non-array is left to Raw", async () => {
    const { root } = await live({ sinks: [{ type: "slack", url: "${U}", events: [] }, { type: "slack", url: "${U}", events: "run_end" }] });
    expect([...card(root, 0).querySelectorAll<HTMLInputElement>("[data-sink-event]")].some((b) => b.checked)).toBe(false);
    expect(card(root, 0).querySelector("[data-sink-events-default-note]")).toBeNull();
    expect(card(root, 1).querySelector("[data-sink-event]")).toBeNull();
    expect(card(root, 1).textContent).toContain("edit it in Raw");
  });
});

describe("digest", () => {
  it("soul / access / model / maxBudgetUsd edit the right keys; emptying every field removes the block", async () => {
    const { root, last } = await live({ name: "p" });
    await setInput(field(root, "digest.soul"), "./SOUL.md");
    expect(last().digest).toEqual({ soul: "./SOUL.md" });
    await pick(field<HTMLSelectElement>(root, "digest.access"), "snapshot");
    await pick(field<HTMLSelectElement>(root, "digest.model"), "claude-sonnet-5-5");
    await setInput(field(root, "digest.maxBudgetUsd"), "0.5");
    expect(last().digest).toEqual({ soul: "./SOUL.md", access: "snapshot", model: "claude-sonnet-5-5", maxBudgetUsd: 0.5 });
    expect(root.textContent).not.toContain("digest.maxBudgetUsd must be");

    await setInput(field(root, "digest.soul"), "");
    await pick(field<HTMLSelectElement>(root, "digest.access"), "");
    await pick(field<HTMLSelectElement>(root, "digest.model"), "");
    await setInput(field(root, "digest.maxBudgetUsd"), "");
    expect(last()).toEqual({ name: "p" });
  });

  it("maxBudgetUsd 0 / -1 shows the client error; 0.5 doesn't", async () => {
    const { root } = await live({ digest: { soul: "SOUL.md" } });
    for (const v of ["0", "-1"]) {
      await setInput(field(root, "digest.maxBudgetUsd"), v);
      expect(root.textContent).toContain("config: digest.maxBudgetUsd must be a number > 0.");
    }
    await setInput(field(root, "digest.maxBudgetUsd"), "0.5");
    expect(root.textContent).not.toContain("digest.maxBudgetUsd must be");
  });
});

describe("overlapGuard", () => {
  it("absent is unchecked; checking writes true; unchecking removes the key", async () => {
    const { root, last } = await live({ name: "p" });
    expect(field(root, "overlapGuard").checked).toBe(false);
    expect(root.textContent).toContain("overlap_released");
    await click(field(root, "overlapGuard"));
    expect(last().overlapGuard).toBe(true);
    await click(field(root, "overlapGuard"));
    expect(last()).toEqual({ name: "p" });
  });
});

const blur = (el: HTMLInputElement) =>
  act(async () => {
    el.focus();
    el.blur();
  });

describe("pricing", () => {
  it("add model → pattern + rates commit on blur as numbers (blank optional rates unset); remove drops the block", async () => {
    const { root, last } = await live({ name: "p" });
    const panel = () => root.querySelector<HTMLElement>("[data-pricing]")!;
    await click(root.querySelector<HTMLButtonElement>("[data-add-pricing]")!);
    const row = () => panel().querySelector<HTMLElement>('[data-pricing-row="0"]')!;
    const input = (label: string) => row().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    await setInput(input("model pattern"), "qwen3.8*");
    await setInput(input("Input $/Mtok"), "2");
    await setInput(input("Output $/Mtok"), "10");
    await blur(input("Output $/Mtok"));
    expect(last().pricing).toEqual({ "qwen3.8*": { input: 2, output: 10 } });
    await click(row().querySelector<HTMLButtonElement>('[aria-label="remove model"]')!);
    expect(last()).toEqual({ name: "p" });
  });

  it("shows pricingErrors for an invalid rate", async () => {
    const { root } = await live({ name: "p", pricing: { "qwen*": { input: -1 } } });
    const text = root.querySelector("[data-pricing-panel]")!.textContent ?? "";
    expect(text).toContain('pricing["qwen*"].input must be a finite number');
    expect(text).toContain('pricing["qwen*"].output is required');
  });
});
