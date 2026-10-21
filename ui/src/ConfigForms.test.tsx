// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BasicsForm, ModelField, modelSelectState, openAfterMove, openAfterRemove, summarizeStep } from "./ConfigForms";
import type { SandboxReadiness } from "./contract";
import { click, mount, until } from "./domHarness";
import type { Mounted } from "./domHarness";

// The Sandbox group's readiness card fetches on mount; no test here reaches a real server.
let readiness: { status: number; body: SandboxReadiness | null } = { status: 200, body: { enabled: false, rows: [] } };
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(readiness.body), { status: readiness.status })),
  );
});
afterEach(() => vi.unstubAllGlobals());

/** Depth-first search of a React element tree for a node whose `props[key] === value`. */
function findByProp(node: any, key: string, value: string): any {
  if (!node || typeof node !== "object") return null;
  if (node.props?.[key] === value) return node;
  const children = node.props?.children;
  for (const c of Array.isArray(children) ? children : [children]) {
    const found = findByProp(c, key, value);
    if (found) return found;
  }
  return null;
}

// A rename now keeps the state dir in place by inserting "stateId" (src/ui/config.js guards the
// save server-side), so the Basics form's `name` field is editable again — unlike the #192
// read-only stopgap this replaces.
describe("BasicsForm", () => {
  it("renders the name input as editable (not read-only)", () => {
    const raw = { name: "p", repoPath: "/repo", tracker: { type: "github" } };
    const html = renderToStaticMarkup(createElement(BasicsForm, { text: JSON.stringify(raw), onEdit: () => {}, raw, stateKey: "p" }));
    const m = /<input[^>]*name="name"[^>]*>/.exec(html);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/value="p"/);
    expect(m![0]).not.toMatch(/readonly/i);
  });

  it("editing the name field emits a buffer with stateId set to the passed state key", () => {
    const text = JSON.stringify({ name: "p", repoPath: "/repo" });
    const onEdit = vi.fn();
    const el: any = BasicsForm({ text, onEdit, raw: JSON.parse(text), stateKey: "p" });
    const input = findByProp(el, "name", "name");
    input.props.onChange({ target: { value: "renamed" } });

    expect(onEdit).toHaveBeenCalledTimes(1);
    const next = JSON.parse(onEdit.mock.calls[0][0]);
    expect(next).toEqual({ name: "renamed", repoPath: "/repo", stateId: "p" });
  });

  it("does not insert a second stateId when one is already present", () => {
    const text = JSON.stringify({ name: "p", repoPath: "/repo", stateId: "p" });
    const onEdit = vi.fn();
    const el: any = BasicsForm({ text, onEdit, raw: JSON.parse(text), stateKey: "p" });
    const input = findByProp(el, "name", "name");
    input.props.onChange({ target: { value: "renamed" } });

    const next = JSON.parse(onEdit.mock.calls[0][0]);
    expect(next).toEqual({ name: "renamed", repoPath: "/repo", stateId: "p" });
  });

  it("renders instructionsFile editable, and claudeBin/stateId under Advanced with stateId read-only", () => {
    const raw = { name: "p", repoPath: "/repo", instructionsFile: "./INSTRUCTIONS.md", claudeBin: "claude", stateId: "p" };
    const html = renderToStaticMarkup(createElement(BasicsForm, { text: JSON.stringify(raw), onEdit: () => {}, raw, stateKey: "p" }));
    const instructions = /<input[^>]*name="instructionsFile"[^>]*>/.exec(html);
    expect(instructions).not.toBeNull();
    expect(instructions![0]).toMatch(/value="\.\/INSTRUCTIONS\.md"/);
    expect(instructions![0]).not.toMatch(/readonly/i);

    const claudeBin = /<input[^>]*name="claudeBin"[^>]*>/.exec(html);
    expect(claudeBin).not.toBeNull();
    expect(claudeBin![0]).not.toMatch(/readonly/i);

    const stateId = /<input[^>]*name="stateId"[^>]*>/.exec(html);
    expect(stateId).not.toBeNull();
    expect(stateId![0]).toMatch(/readonly/i);
    expect(stateId![0]).toMatch(/value="p"/);
    expect(html).toContain("agenthook rename --move");
  });

  it("renders agentProvider editable under Advanced", () => {
    const raw = { name: "p", repoPath: "/repo", agentProvider: "ollama-launch", stateId: "p" };
    const html = renderToStaticMarkup(createElement(BasicsForm, { text: JSON.stringify(raw), onEdit: () => {}, raw, stateKey: "p" }));
    const m = /<input[^>]*name="agentProvider"[^>]*>/.exec(html);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/value="ollama-launch"/);
    expect(m![0]).not.toMatch(/readonly/i);
  });
});

describe("BasicsForm Sandbox group (#494)", () => {
  const render = (raw: object) => renderToStaticMarkup(createElement(BasicsForm, { text: JSON.stringify(raw), onEdit: () => {}, raw, stateKey: "p" }));

  it("hides image/memory/cpus/egress when the backend is Off", () => {
    const html = render({ name: "p" });
    expect(html).not.toMatch(/name="sandbox\.image"/);
    expect(html).not.toMatch(/name="sandbox\.memory"/);
    expect(html).not.toMatch(/name="sandbox\.cpus"/);
    expect(html).not.toMatch(/name="sandbox\.egress\.mode"/);
  });

  it("shows image/memory/cpus/egress once a backend is set", () => {
    const html = render({ name: "p", sandbox: { type: "docker" } });
    expect(html).toMatch(/name="sandbox\.image"/);
    expect(html).toMatch(/name="sandbox\.memory"/);
    expect(html).toMatch(/name="sandbox\.cpus"/);
    expect(html).toMatch(/name="sandbox\.egress\.mode"/);
    expect(html).toMatch(/name="sandbox\.egress\.allow"/);
    expect(html).toMatch(/name="sandbox\.egress\.deny"/);
  });

  it('shows the open-egress warning only when egress.mode is "open"', () => {
    const open = render({ name: "p", sandbox: { type: "docker", egress: { mode: "open" } } });
    expect(open).toContain("unrestricted network: a hijacked agent can send data anywhere");
    const allowlist = render({ name: "p", sandbox: { type: "docker", egress: { mode: "allowlist" } } });
    expect(allowlist).not.toContain("unrestricted network");
    const none = render({ name: "p", sandbox: { type: "docker", egress: { mode: "none" } } });
    expect(none).not.toContain("unrestricted network");
  });

  it("shows the fullAuto-without-sandbox warning only when fullAuto is true and no sandbox block is set", () => {
    const warned = render({ name: "p", fullAuto: true });
    expect(warned).toContain("fullAuto without a sandbox");

    const withSandbox = render({ name: "p", fullAuto: true, sandbox: { type: "docker" } });
    expect(withSandbox).not.toContain("fullAuto without a sandbox");

    const fullAutoOff = render({ name: "p", fullAuto: false });
    expect(fullAutoOff).not.toContain("fullAuto without a sandbox");
  });

  it("renders the readiness card only when a sandbox block is set (saved or just toggled on)", () => {
    expect(render({ name: "p" })).not.toContain("Sandbox readiness");
    expect(render({ name: "p", sandbox: { type: "docker" } })).toContain("Sandbox readiness");
  });

  describe("readiness card", () => {
    let m: Mounted | null = null;
    afterEach(async () => {
      await m?.unmount();
      m = null;
    });
    const mountBasics = (raw: object) => mount(createElement(BasicsForm, { text: JSON.stringify(raw), onEdit: () => {}, raw, stateKey: "p q" }));
    const rows = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>("[data-readiness-row]")];

    it("fetches for the form's backend and shows ✓/✗, the note and the remedy per row — never a value", async () => {
      readiness = {
        status: 200,
        body: {
          enabled: true,
          type: "podman",
          image: "agenthook-agent:1",
          rows: [
            { id: "runtime", ok: true, label: "sandbox: `podman info` succeeds" },
            { id: "image", ok: false, label: "sandbox image present: agenthook-agent:1", note: "missing", remedy: "agenthook doctor --fix" },
            { id: "credential", ok: false, label: "claude credential in the profile's .env", remedy: "claude setup-token, then add CLAUDE_CODE_OAUTH_TOKEN=… to ~/p/.env (or ANTHROPIC_API_KEY)" },
          ],
        },
      };
      m = await mountBasics({ name: "p", sandbox: { type: "podman" } });
      await until(() => rows(m!.root).length === 3);
      expect((fetch as any).mock.calls[0][0]).toBe("/api/sandbox-readiness?profile=p+q&type=podman");
      const [runtime, image, cred] = rows(m.root);
      expect(runtime.dataset.ok).toBe("true");
      expect(runtime.textContent).toContain("✓");
      expect(image.textContent).toContain("✗");
      expect(image.textContent).toContain("missing");
      expect(image.querySelector(".font-mono")?.textContent).toBe("agenthook doctor --fix");
      expect(cred.querySelector(".font-mono")?.textContent).toMatch(/^claude setup-token/);
      expect(m.root.textContent).not.toContain("secret");
    });

    it("Refresh re-fetches; a failed request shows why", async () => {
      readiness = { status: 404, body: null };
      m = await mountBasics({ name: "p", sandbox: { type: "docker" } });
      await until(() => m!.root.textContent?.includes("couldn't check"));
      expect(m.root.textContent).toContain("no config published for this profile");
      const refresh = [...m.root.querySelectorAll("button")].find((b) => b.textContent === "Refresh")!;
      await click(refresh);
      expect((fetch as any).mock.calls.length).toBe(2);
    });
  });

  it("renders the doctor --fix help text", () => {
    const html = render({ name: "p" });
    expect(html).toContain("agenthook doctor --fix");
    expect(html).toContain("docs/sandbox.md");
  });
});

describe("modelSelectState", () => {
  it("selects a known model directly", () => {
    expect(modelSelectState("claude-opus-5-5")).toEqual({ selectValue: "claude-opus-5-5", showCustom: false });
  });

  it("selects (default) for an empty value", () => {
    expect(modelSelectState("")).toEqual({ selectValue: "", showCustom: false });
  });

  it("routes an unknown value to the custom input without altering it", () => {
    expect(modelSelectState("sonnet")).toEqual({ selectValue: "__custom__", showCustom: true });
    expect(modelSelectState("claude-opus-4-8")).toEqual({ selectValue: "__custom__", showCustom: true });
  });
});

describe("ModelField", () => {
  it("renders a known value as the selected option, no custom input", () => {
    const onEdit = vi.fn();
    const html = renderToStaticMarkup(createElement(ModelField, { text: "{}", onEdit, path: ["tracker", "pipeline", 0, "model"], value: "claude-sonnet-5" }));
    expect(html).toMatch(/<option value="claude-sonnet-5"[^>]*selected[^>]*>/);
    expect(html).not.toContain('placeholder="model name"');
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("renders an unrecognized value in the custom input, unchanged, without editing on render", () => {
    const onEdit = vi.fn();
    const html = renderToStaticMarkup(createElement(ModelField, { text: "{}", onEdit, path: ["tracker", "pipeline", 0, "model"], value: "sonnet" }));
    expect(html).toMatch(/<input[^>]*placeholder="model name"[^>]*value="sonnet"[^>]*>/);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("(default) is the select's empty-value option, which removes the key via textEdit", () => {
    const onEdit = vi.fn();
    const el: any = createElement(ModelField, { text: '{"model":"claude-sonnet-5"}', onEdit, path: ["tracker", "pipeline", 0, "model"], value: "claude-sonnet-5" });
    // The rendered <select>'s first option is always "(default)" at value="".
    const html = renderToStaticMarkup(el);
    expect(html).toMatch(/<option value="">\(default\)<\/option>/);
  });
});

describe("summarizeStep", () => {
  const asana = { source: "sourceSectionGid", success: "successSectionGid", failure: "failureSectionGid", hold: "holdSectionGid", queue: "queueSectionGid" };
  const jira = { source: "sourceStatus", success: "successStatus", failure: "failureStatus", hold: "holdStatus", queue: "queueStatus" };
  const github = { source: "sourceLabel", success: "successLabel", failure: "failureLabel", hold: "holdLabel", queue: "queueLabel" };

  it("returns empty string when nothing is set", () => {
    expect(summarizeStep({}, null, null)).toBe("");
    expect(summarizeStep({}, github, null)).toBe("");
  });

  it("asana: resolves section gids to their names through the stage list", () => {
    const stageList = [
      { id: "1201", label: "Ready" },
      { id: "1202", label: "In review" },
      { id: "1203", label: "Blocked" },
    ];
    const s = { kind: "implement", sourceSectionGid: "1201", successSectionGid: "1202", failureSectionGid: "1203" };
    expect(summarizeStep(s, asana, stageList)).toBe("implement · Ready → In review / Blocked");
  });

  it("jira: statuses, with the failure lane only when set", () => {
    const stageList = [
      { id: "To Do", label: "To Do" },
      { id: "In Review", label: "In Review" },
    ];
    expect(summarizeStep({ kind: "review", sourceStatus: "In Review", successStatus: "Done" }, jira, stageList)).toBe("review · In Review → Done");
    expect(summarizeStep({ sourceStatus: "To Do", successStatus: "In Review", failureStatus: "Failed" }, jira, stageList)).toBe("To Do → In Review / Failed");
  });

  it("github: labels, raw values when there is no stage list", () => {
    const s = { kind: "implement", sourceLabel: "agent:code", successLabel: "agent:review", failureLabel: "agent:failed" };
    expect(summarizeStep(s, github, null)).toBe("implement · agent:code → agent:review / agent:failed");
    expect(summarizeStep({ sourceLabel: "agent:code" }, github, null)).toBe("agent:code");
    expect(summarizeStep({ successLabel: "agent:review" }, github, null)).toBe("→ agent:review");
    expect(summarizeStep({ failureLabel: "agent:failed" }, github, null)).toBe("→ — / agent:failed");
  });

  it("uses the discovered label when known and the raw value otherwise", () => {
    const stageList = [{ id: "agent:code", label: "Code" }];
    expect(summarizeStep({ sourceLabel: "agent:code", successLabel: "agent:review" }, github, stageList)).toBe("Code → agent:review");
  });

  it("flags follow the lanes; model / effort only when the step overrides them", () => {
    const s = { kind: "triage", sourceLabel: "a", successLabel: "b", manual: true, createsWorktree: true, drainWorktree: true, model: "claude-opus-5-5", effort: "high" };
    expect(summarizeStep(s, github, null)).toBe("triage · a → b · manual · worktree · drain · claude-opus-5-5 · high");
    expect(summarizeStep({ kind: "implement", manual: false, createsWorktree: false }, github, null)).toBe("implement");
    expect(summarizeStep({ kind: "implement", effort: "low" }, null, null)).toBe("implement · low");
  });

  it("does not repeat the step id", () => {
    expect(summarizeStep({ id: "code", kind: "implement" }, null, null)).toBe("implement");
  });

  it("appends +N advanced only when N > 0; leaves the summary unchanged when N is 0 or omitted", () => {
    expect(summarizeStep({ kind: "implement" }, null, null, 0)).toBe("implement");
    expect(summarizeStep({ kind: "implement" }, null, null)).toBe("implement");
    expect(summarizeStep({ kind: "implement" }, null, null, 2)).toBe("implement · +2 advanced");
  });
});

describe("openAfterMove / openAfterRemove", () => {
  it("swaps the two moved cards' open state", () => {
    expect([...openAfterMove(new Set([0, 3]), 0, 1)].sort()).toEqual([1, 3]);
    expect([...openAfterMove(new Set([1, 2]), 2, -1)].sort()).toEqual([1, 2]);
  });

  it("drops the removed card and shifts the later ones up", () => {
    expect([...openAfterRemove(new Set([0, 2, 4]), 2)].sort()).toEqual([0, 3]);
  });
});

describe("AppearanceFields (in BasicsForm)", () => {
  const render = (raw: object) => renderToStaticMarkup(createElement(BasicsForm, { text: JSON.stringify(raw), onEdit: () => {}, raw, stateKey: "p" }));

  it("renders the palette, marks 'automatic' when no colour is set and the chosen swatch when one is", () => {
    const auto = render({ name: "p", repoPath: "/r" });
    expect(auto).toContain("data-appearance");
    expect(auto.match(/data-color="/g)).toHaveLength(8);
    expect(auto).toMatch(/aria-checked="true"[^>]*>automatic</);
    expect(auto).toContain("automatic · shows on Home");
    const set = render({ name: "p", repoPath: "/r", ui: { color: "teal" } });
    expect(set).toMatch(/aria-checked="true"[^>]*aria-label="teal"/);
    expect(set).toContain("custom · shows on Home");
  });

  it("previews the configured emoji, else the derived one", () => {
    expect(render({ name: "p", repoPath: "/r", ui: { emoji: "🦊" } })).toContain(">🦊</span>");
  });
});
