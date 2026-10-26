// @vitest-environment happy-dom
// Read aloud placements (#560): the digest, each Needs you row, the drawer's plain lines, and
// auto-read of new Needs you entries. The units (speechText, SpeakButton) have their own tests.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { Overview } from "./Overview";
import type { OverviewProps } from "./Overview";
import { TicketDrawer } from "./TicketDrawer";
import { DigestPanel } from "./DigestPanel";
import type { ReleaseOutcome } from "./config";
import type { ProfileView, RunView, TicketRow } from "./contract";
import { click, mount, until } from "./domHarness";
import type { Mounted } from "./domHarness";
import { readingDefaults, setReading } from "./reading";
import { stopSpeech } from "./speech";
import { installSpeech, uninstallSpeech } from "./speechMock";

const prof = (name: string) =>
  ({ name, label: name, up: true, pid: 1, port: null, tracker: "github", ingress: null, fullAuto: null, color: "teal", emoji: "🚀", forge: null, maxConcurrent: 3,
    startedAt: null, updatedAt: null, active: 0, queued: 0, paused: false, restartPending: false, lastEvent: null, configPath: null, createdAt: null,
    lastSeenAt: null, ghost: false, configMissing: false, recentCosts: [], recentRuns: [], quotaPaused: null, quota: null }) as ProfileView;
const t = (profile: string, ref: string, status: TicketRow["status"], extra: Partial<TicketRow> = {}): TicketRow => ({
  profile, ref, displayId: `#${ref}`, title: `Title ${ref}`, step: "code", status, model: null, startedAt: null, costUsd: 0, estUsd: 0, trackerUrl: null,
  prUrl: null, summary: null, plain: null, heldReason: status === "held" ? "Which **API**?" : null, heldAt: null, failReason: status === "failed" ? "x" : null, prState: null, finishedAt: null, queuePos: null, epic: null,
  ...extra,
});

const speakButtons = (root: ParentNode = document) => [...root.querySelectorAll<HTMLButtonElement>("[data-speak]")];
const on = (values: Record<string, string> = {}) => act(async () => setReading({ ...readingDefaults(), readaloud: "on", ...values }));

let synth: ReturnType<typeof installSpeech>;
let m: Mounted | null = null;

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
  vi.unstubAllGlobals();
});

function overview(profile: string, tickets: TicketRow[], extra: Partial<OverviewProps> = {}) {
  const p = prof(profile);
  return createElement(Overview, {
    profile: p, snapshot: { profiles: [p], tickets }, now: Date.now(), feed: [], statusFilter: "", setStatusFilter: () => {}, epicFilter: "", setEpicFilter: () => {}, showAll: false, setShowAll: () => {},
    open: null, onOpen: () => {}, displayIdFor: () => null, menuItems: [], note: "", onDismiss: () => {}, onRelease: async (): Promise<ReleaseOutcome> => ({ ok: true, text: "" }), onRetry: async (): Promise<ReleaseOutcome> => ({ ok: true, text: "" }),
    ...extra,
  });
}

describe("Needs you rows", () => {
  it("get no 🔊 by default; with Read aloud on, one per row right after its id, reading the title and the full second line", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const long = "The agent wants to know which of the two public APIs the new endpoint should extend before it writes any code at all.";
    m = await mount(overview("rows", [t("rows", "1", "held", { plain: long }), t("rows", "2", "held")]));
    expect(speakButtons()).toEqual([]);
    await on();
    const rows = [...document.querySelectorAll("[data-needs-row]")];
    expect(rows.map((r) => speakButtons(r).map((b) => b.getAttribute("aria-label")))).toEqual([["Read aloud #1"], ["Read aloud #2"]]);
    expect(speakButtons(rows[0])[0].previousElementSibling?.textContent).toBe("#1");
    await click(speakButtons(rows[0])[0]);
    await click(speakButtons(rows[1])[0]);
    expect(synth.calls).toEqual(["cancel", `speak:Title 1. ${long}`, "cancel", "speak:Title 2. Which API?"]);
  });
});

describe("auto-read", () => {
  const render = async (profile: string, tickets: TicketRow[], dismissing?: Set<string>) => {
    const el = overview(profile, tickets, { dismissing });
    if (m) await m.rerender(el);
    else m = await mount(el);
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
  });

  it("speaks only entries new since the first list, queued behind playing speech, and never one twice", async () => {
    await on({ autoread: "on" });
    synth.calls.length = 0;
    await render("auto", [t("auto", "1", "held"), t("auto", "2", "failed")]);
    expect(synth.calls).toEqual([]); // the baseline backlog

    await render("auto", [t("auto", "1", "held"), t("auto", "2", "failed"), t("auto", "3", "held")]);
    expect(synth.calls).toEqual(["speak:Title 3. Which API?"]);
    await render("auto", [t("auto", "1", "held"), t("auto", "2", "failed"), t("auto", "3", "held"), t("auto", "4", "held")]);
    expect(synth.calls).toEqual(["speak:Title 3. Which API?", "speak:Title 4. Which API?"]); // queued: no cancel

    // Dismissed, then undone: back in the list, but not read again.
    await render("auto", [t("auto", "1", "held"), t("auto", "2", "failed"), t("auto", "3", "held"), t("auto", "4", "held")], new Set(["auto\u00003"]));
    await render("auto", [t("auto", "1", "held"), t("auto", "2", "failed"), t("auto", "3", "held"), t("auto", "4", "held")]);
    expect(synth.calls).toHaveLength(2);
  });

  it("stays silent unless both Read aloud and Read new Needs you are on, and an entry seen while off is never read later", async () => {
    await render("quiet", [t("quiet", "1", "held")]);
    await render("quiet", [t("quiet", "1", "held"), t("quiet", "2", "held")]);
    await on();
    await render("quiet", [t("quiet", "1", "held"), t("quiet", "2", "held"), t("quiet", "3", "held")]);
    await on({ autoread: "on" });
    await render("quiet", [t("quiet", "1", "held"), t("quiet", "2", "held"), t("quiet", "3", "held")]);
    expect(synth.calls.filter((c) => c.startsWith("speak"))).toEqual([]);
    await render("quiet", [t("quiet", "2", "held"), t("quiet", "3", "held"), t("quiet", "4", "held")]);
    expect(synth.calls.filter((c) => c.startsWith("speak"))).toEqual(["speak:Title 4. Which API?"]);
  });
});

describe("drawer", () => {
  const RUNS: RunView[] = [
    { run: "2026-10-25T17:28:30Z-step-review-1.log", step: "review", startedAt: "2026-10-25T17:28:30Z", endedAt: "2026-10-25T17:31:12Z", outcome: "changes", costUsd: 0.25, unpriced: false, estUsd: null, costBasis: "reported", running: false, bytes: 10, plain: "Two doc links are broken." },
  ];

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ runs: RUNS }) })));
    vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  });

  const open = async (onClose = () => {}) => {
    const ticket = t("d", "9", "failed", { plain: "The tests failed.", summary: "Adds a **flag**.", failReason: "exit 1: raw log line" });
    m = await mount(createElement(TicketDrawer, { profile: "d", ticketRef: "9", ticket, runsNonce: 0, onClose }));
    await until(() => document.querySelector("[data-run-plain]"));
  };

  it("reads the plain reason, the summary and the run's plain line, never the raw reason or the log", async () => {
    await open();
    expect(speakButtons()).toEqual([]);
    await on();
    const where = speakButtons().map((b) => b.parentElement!.getAttribute("data-drawer-plain") !== null ? "plain" : b.parentElement!.hasAttribute("data-drawer-summary") ? "summary" : b.parentElement!.hasAttribute("data-run-plain") ? "run" : "elsewhere");
    expect(where).toEqual(["plain", "summary", "run"]);
    expect(document.querySelector("[data-drawer-reason] .font-mono [data-speak]")).toBeNull();
    for (const b of speakButtons()) await click(b);
    expect(synth.calls.filter((c) => c.startsWith("speak"))).toEqual(["speak:The tests failed.", "speak:Adds a flag.", "speak:Two doc links are broken."]);
  });

  it("Escape while speaking stops the speech and keeps the drawer open; the next Escape closes it", async () => {
    let closed = 0;
    await open(() => closed++);
    await on();
    await click(speakButtons()[0]);
    const esc = () => act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await esc();
    expect(closed).toBe(0);
    expect(synth.calls.at(-1)).toBe("cancel");
    await esc();
    expect(closed).toBe(1);
  });
});

describe("digest", () => {
  it("gets a 🔊 beside Refresh once a digest is shown, reading its markdown as speech", async () => {
    const digest = { text: "## Today\n- Two PRs [merged](https://x/1)\n```\nlog\n```", generatedAt: new Date().toISOString(), costUsd: 0.01 };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ digest }) })));
    m = await mount(createElement(DigestPanel, { profile: "g", up: true, feed: [], now: Date.now() }));
    await until(() => document.querySelector("[data-digest-meta]"));
    expect(speakButtons()).toEqual([]);
    await on();
    const [b] = speakButtons();
    expect(b.getAttribute("aria-label")).toBe("Read the digest aloud");
    expect(b.parentElement!.textContent).toContain("Refresh digest");
    await click(b);
    expect(synth.calls).toEqual(["cancel", "speak:Today. Two PRs merged. code block."]);
  });
});
