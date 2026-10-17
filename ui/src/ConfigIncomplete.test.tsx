// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import ConfigView from "./ConfigView";
import { click, mount, until } from "./domHarness";
import type { Mounted } from "./domHarness";
import type { ProfileView } from "./contract";

// #373: a just-added sink / repo / step is "incomplete" (amber, on its card only) until touched; the
// banner doesn't repeat what a visible card shows; client checks block Save.
const config = {
  name: "demo",
  repoPath: "/repo",
  tracker: {
    type: "github",
    pipeline: [
      { id: "code", kind: "implement", sourceLabel: "agent:code", successLabel: "agent:review" },
      { id: "review", kind: "review", sourceLabel: "agent:review", successLabel: "agent:done" },
    ],
  },
};
const profiles = [{ name: "demo", label: "demo", up: false }] as unknown as ProfileView[];
const SINK_ERR = 'config: sinks[0] (slack) requires "url".';

let m: Mounted | null = null;
let fileText = "";
let fileErrors: string[] = [];
let putReply: { status: number; body: unknown } = { status: 200, body: { hash: "h2" } };
const puts: string[] = [];

beforeEach(() => {
  fileText = JSON.stringify(config, null, 2);
  fileErrors = [];
  putReply = { status: 200, body: { hash: "h2" } };
  puts.length = 0;
  (Element.prototype as any).scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts.push(url);
        return new Response(JSON.stringify(putReply.body), { status: putReply.status });
      }
      if (url.startsWith("/api/config")) {
        return new Response(JSON.stringify({ path: "/cfg/agenthook.config.json", text: fileText, hash: "h", errors: fileErrors, literalSecrets: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "down" }), { status: 503 });
    }),
  );
});

afterEach(async () => {
  await m?.unmount();
  m = null;
  vi.unstubAllGlobals();
});

const view = () => createElement(ConfigView, { profiles, eventSink: { current: null }, onDirtyChange: () => {} });
const tab = (name: string) => m!.root.querySelector<HTMLButtonElement>(`[data-config-pane="${name}"]`)!;
const banner = () => m!.root.querySelector<HTMLElement>("[data-config-banner]")!;
const save = () => m!.root.querySelector<HTMLButtonElement>("[data-save]")!;
const modal = () => [...document.querySelectorAll("h2, h3")].some((h) => h.textContent === "Save agenthook.config.json?");
const blur = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
const setInput = (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const pressModS = () =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
  });

async function openOn(pane: string) {
  m = await mount(view());
  await until(() => m!.root.querySelector("[data-step-card]"));
  await click(tab(pane));
}

describe("+ Add sink: incomplete until touched", () => {
  it("amber count in the banner, the message only on the card as an incomplete hint", async () => {
    await openOn("integrations");
    await click(m!.root.querySelector("[data-add-sink]")!);
    const card = m!.root.querySelector<HTMLElement>('[data-sink-card="0"]')!;
    expect(card.hasAttribute("data-incomplete")).toBe(true);
    expect(card.textContent).toContain(SINK_ERR);
    expect(card.className).toContain("border-status-held");
    expect(banner().textContent).not.toContain(SINK_ERR);
    expect(banner().textContent).toContain("1 problem — see the highlighted cards");
    expect(banner().dataset.tone).toBe("held");
    expect(save().getAttribute("aria-disabled")).toBe("true");
    expect(save().title).toBe("Fix 1 problem first");
  });

  it("a blurred field turns it into a normal red card error; the banner turns red but still only counts", async () => {
    await openOn("integrations");
    await click(m!.root.querySelector("[data-add-sink]")!);
    await blur(m!.root.querySelector('input[name="sinks.0.url"]')!);
    const card = m!.root.querySelector<HTMLElement>('[data-sink-card="0"]')!;
    expect(card.hasAttribute("data-incomplete")).toBe(false);
    expect(card.className).toContain("border-status-failed");
    expect(card.textContent).toContain(SINK_ERR);
    expect(banner().dataset.tone).toBe("failed");
    expect(banner().textContent).not.toContain(SINK_ERR);
    expect(save().getAttribute("aria-disabled")).toBe("true");
  });

  it("a Save attempt (click or Mod-s) opens no confirm, sends no PUT and ends the incomplete grace", async () => {
    await openOn("integrations");
    await click(m!.root.querySelector("[data-add-sink]")!);
    await click(save());
    expect(modal()).toBe(false);
    expect(puts).toEqual([]);
    expect(m!.root.querySelector("[data-incomplete]")).toBeNull();
    expect(banner().dataset.tone).toBe("failed");

    await click(m!.root.querySelector("[data-add-sink]")!);
    expect(m!.root.querySelector('[data-sink-card="1"]')!.hasAttribute("data-incomplete")).toBe(true);
    await pressModS();
    expect(modal()).toBe(false);
    expect(puts).toEqual([]);
    expect(m!.root.querySelector("[data-incomplete]")).toBeNull();
  });

  it("filling the field unblocks Save", async () => {
    await openOn("integrations");
    await click(m!.root.querySelector("[data-add-sink]")!);
    await setInput(m!.root.querySelector<HTMLInputElement>('input[name="sinks.0.url"]')!, "${HOOK}");
    expect(save().hasAttribute("aria-disabled")).toBe(false);
    expect(banner().dataset.tone).toBe("ok");
    await click(save());
    expect(modal()).toBe(true);
  });

  it("on Raw, or another form pane, the banner still lists the card error text", async () => {
    await openOn("integrations");
    await click(m!.root.querySelector("[data-add-sink]")!);
    await click(tab("raw"));
    expect(banner().textContent).toContain(SINK_ERR);
    await click(tab("basics"));
    expect(banner().textContent).toContain(SINK_ERR);
  });
});

describe("+ Add repo (2nd repo)", () => {
  it("is incomplete on its card, counted (amber) in the banner on Repos, listed elsewhere", async () => {
    fileText = JSON.stringify({ ...config, repos: [{ id: "default", path: "/repo", default: true }] }, null, 2);
    await openOn("repos");
    await click(m!.root.querySelector("[data-add-repo]")!);
    const card = m!.root.querySelector<HTMLElement>('[data-repo-card="1"]')!;
    expect(card.hasAttribute("data-incomplete")).toBe(true);
    expect(card.textContent).toContain("repos[1].id is required");
    expect(banner().textContent).not.toContain("repos[1].id is required");
    expect(banner().dataset.tone).toBe("held");
    await click(tab("pipeline"));
    expect(banner().textContent).toContain("repos[1].id is required");
  });
});

describe("unattributed and server errors", () => {
  it("a digest error stays in the banner row on every pane, red", async () => {
    fileText = JSON.stringify({ ...config, digest: { access: "everything" } }, null, 2);
    await openOn("integrations");
    const text = banner().textContent!;
    expect(text).toContain("digest");
    expect(banner().dataset.tone).toBe("failed");
    await click(tab("pipeline"));
    expect(banner().textContent).toBe(text);
  });

  it("server errors alone don't block Save", async () => {
    fileErrors = ["config: something only the server checks."];
    await openOn("basics");
    await setInput(m!.root.querySelector<HTMLInputElement>('[name="name"]')!, "renamed");
    expect(save().hasAttribute("aria-disabled")).toBe(false);
    await click(save());
    expect(modal()).toBe(true);
  });

  it("a new step rejected by the server: the error sits on its card, the banner only counts it", async () => {
    await openOn("pipeline");
    const add = [...m!.root.querySelectorAll("button")].find((b) => b.textContent === "+ Add step")!;
    await click(add);
    const err = 'config: pipeline step "step-3" needs a sourceLabel.';
    putReply = { status: 422, body: { errors: [err] } };
    await click(save());
    expect(modal()).toBe(true);
    const ok = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent === "Save").pop()!;
    await click(ok);
    await until(() => puts.length === 1 && m!.root.querySelector('[data-step-card="step-3"] [data-step-error]'));
    const card = m!.root.querySelector<HTMLElement>('[data-step-card="step-3"]')!;
    expect(card.hasAttribute("data-incomplete")).toBe(false);
    expect(card.textContent).toContain(err);
    expect(banner().textContent).toContain("1 problem — see the highlighted cards");
    expect(banner().dataset.tone).toBe("failed");
    // Server errors don't gate: Save is still live.
    expect(save().hasAttribute("aria-disabled")).toBe(false);
  });
});
