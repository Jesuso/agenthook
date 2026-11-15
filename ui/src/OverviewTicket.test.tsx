// @vitest-environment happy-dom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Overview } from "./Overview";
import type { ProfileView, TicketRow } from "./contract";
import type { ReleaseOutcome } from "./config";
import { mount, click, until } from "./domHarness";
import type { Mounted } from "./domHarness";

// The body field is a CodeMirror editor; stand in with a plain textarea so the test drives the
// form's logic (title validation, the POST, the inline error) without a real editor.
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: (p: { initial: string; onChange: (doc: string) => void }) => (
    <textarea data-ticket-body value={p.initial} onChange={(e) => p.onChange(e.target.value)} />
  ),
}));

const local = {
  name: "dev", label: "dev", up: true, pid: 1, port: null, tracker: "local", ingress: null, fullAuto: null, color: "teal", emoji: "🚀",
  forge: null, maxConcurrent: 3, startedAt: null, updatedAt: null, active: 0, queued: 0, paused: false, restartPending: false, lastEvent: null,
  configPath: null, createdAt: null, lastSeenAt: null, ghost: false, configMissing: false, died: false, recentCosts: [], recentRuns: [], quotaPaused: null, quota: null,
  ticketSteps: ["code", "review"],
} as ProfileView;
const github = { ...local, tracker: "github", ticketSteps: null } as ProfileView;
const stoppedLocal = { ...local, up: false, pid: null, active: null, queued: null, paused: null, restartPending: null } as ProfileView;
const t = (ref: string): TicketRow => ({
  profile: "dev", ref, displayId: `#${ref}`, title: `Title ${ref}`, step: "code", status: "running", model: null, startedAt: null, costUsd: 0, estUsd: 0,
  trackerUrl: null, prUrl: null, summary: null, plain: null, options: null, heldReason: null, heldAt: null, failReason: null, prState: null, prNeeds: null,
  finishedAt: null, queuePos: null, queuedAt: null, epic: null,
});

let m: Mounted | null = null;
beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(async () => {
  await m?.unmount();
  m = null;
  vi.unstubAllGlobals();
});

async function render(profile: ProfileView, onCreated: (t: { profile: string; ref: string }) => void = () => {}) {
  m = await mount(
    createElement(Overview, {
      profile, snapshot: { profiles: [profile], tickets: [t("1")] }, now: Date.now(), feed: [], statusFilter: "", setStatusFilter: () => {}, epicFilter: "", setEpicFilter: () => {},
      stepFilter: "", setStepFilter: () => {},
      showAll: false, setShowAll: () => {}, open: null, onOpen: () => {}, onCreated, displayIdFor: () => null, menuItems: [], note: "",
      onDismiss: () => {}, onRelease: async (): Promise<ReleaseOutcome> => ({ ok: true, text: "" }), onRetry: async (): Promise<ReleaseOutcome> => ({ ok: true, text: "" }),
    }),
  );
}

/** Stub `fetch`: `/api/ticket` goes to `ticket`, everything else (the mount-time harness-stats GET) answers 200. Records each call. */
function stubFetch(ticket: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return String(url).includes("/api/ticket") ? ticket(String(url), init) : new Response(JSON.stringify({ by: "harness", groups: [] }), { status: 200 });
    }),
  );
  return calls;
}

const open = async () => click(document.querySelector<HTMLButtonElement>("[data-new-ticket-open]")!);
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const press = (k: string) =>
  act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
const setInput = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

describe("Overview New ticket (local boards)", () => {
  it("hides the button on non-local profiles", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    await render(github);
    expect(document.querySelector("[data-new-ticket-open]")).toBeNull();
  });

  it("shows it on a local board, disabled with a visible reason while the receiver is down", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    await render(local);
    expect(document.querySelector<HTMLButtonElement>("[data-new-ticket-open]")?.disabled).toBe(false);
    expect(document.querySelector("[data-new-ticket-disabled-reason]")).toBeNull();
    await m!.unmount();
    m = null;
    await render(stoppedLocal);
    expect(document.querySelector<HTMLButtonElement>("[data-new-ticket-open]")?.disabled).toBe(true);
    expect(document.querySelector("[data-new-ticket-disabled-reason]")?.textContent).toBe("start the receiver to add tickets");
  });

  it("`n` opens the dialog (and is a no-op off a non-local board, or a disabled button)", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    await render(local);
    await press("n");
    expect(dialog()).not.toBeNull();
    await m!.unmount();
    m = null;
    await render(github);
    await press("n");
    expect(dialog()).toBeNull();
    await m!.unmount();
    m = null;
    await render(stoppedLocal);
    await press("n");
    expect(dialog()).toBeNull();
  });

  it("a blank title is refused client-side, without a ticket request", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ ref: "9" }), { status: 200 }));
    await render(local);
    await open();
    await act(async () => {
      dialog()?.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    });
    await act(async () => {}); // let the validation state settle
    expect(calls.filter((c) => c.url.includes("/api/ticket"))).toEqual([]);
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe("a title is required");
  });

  it("posts the ticket and calls onCreated with the new ref", async () => {
    const calls = stubFetch((url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.title).toBe("Fix the flaky test");
      expect(body.profile).toBe("dev");
      expect(body.step).toBe("code");
      return new Response(JSON.stringify({ ref: "9", step: "code", stage: "agent:code" }), { status: 200 });
    });
    const created: { profile: string; ref: string }[] = [];
    await render(local, (t) => created.push(t));
    await open();
    await setInput(dialog()!.querySelector<HTMLInputElement>("[role='dialog'] input")!, "Fix the flaky test");
    await act(async () => {
      dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    });
    await until(() => created.length === 1);
    expect(created).toEqual([{ profile: "dev", ref: "9" }]);
    expect(calls.some((c) => c.url.includes("/api/ticket"))).toBe(true);
    expect(dialog()).toBeNull(); // closes on success
  });

  it("shows a blocked notice with the new ref and blockers once the dialog closes", async () => {
    stubFetch(() => new Response(JSON.stringify({ ref: "9", step: "code", stage: "agent:code", blockedBy: ["3", "7"] }), { status: 200 }));
    const created: { profile: string; ref: string }[] = [];
    await render(local, (t) => created.push(t));
    await open();
    await setInput(dialog()!.querySelector<HTMLInputElement>("[role='dialog'] input")!, "Fix the flaky test");
    await act(async () => {
      dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    });
    await until(() => created.length === 1);
    expect(dialog()).toBeNull();
    expect(document.querySelector("[data-blocked-notice]")?.textContent).toBe("#9 is blocked by #3, #7 — it runs when they reach done");
  });

  it("shows a server error inline and stays open", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: 'no step "nope" in the pipeline' }), { status: 502 }));
    await render(local);
    await open();
    await setInput(dialog()!.querySelector<HTMLInputElement>("[role='dialog'] input")!, "x");
    await act(async () => {
      dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    });
    await until(() => dialog()?.querySelector('[role="alert"]')?.textContent);
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('no step "nope" in the pipeline');
    expect(dialog()).not.toBeNull();
  });
});
