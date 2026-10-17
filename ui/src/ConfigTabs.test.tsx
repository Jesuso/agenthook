// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForgeForm, IngressForm, TrackerForm } from "./ConfigForms";
import { answerConfirm, click, confirmDialog, mount } from "./domHarness";
import { ConfirmProvider } from "./Modal";
import type { Mounted } from "./domHarness";

// The Tracker / Forge / Ingress tabs (#341): schema-driven fields, default-true checkboxes, secret fields.

let m: Mounted | null = null;
afterEach(async () => {
  await m?.unmount();
  m = null;
  vi.unstubAllGlobals();
});

type Form = typeof TrackerForm;

/** Mount `form` over a live buffer (each edit re-renders, like ConfigView); `texts` records every edit. */
async function live(form: Form, raw: unknown) {
  const texts: string[] = [];
  function Host() {
    const [text, setText] = useState(JSON.stringify(raw, null, 2));
    return createElement(
      ConfirmProvider,
      null,
      createElement(form, {
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
  return { root: m.root, texts, last: () => JSON.parse(texts.at(-1)!) };
}

const names = (root: Element) => [...root.querySelectorAll("[name]")].map((e) => e.getAttribute("name")!).sort();
const field = <T extends Element = HTMLInputElement>(root: Element, name: string) => root.querySelector<T>(`[name="${name}"]`)!;

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

const t = (k: string) => `tracker.${k}`;

describe("TrackerForm fields per tracker type (from the schema's scope)", () => {
  const cases: [string, string[], string[]][] = [
    ["asana", ["token", "userGid", "assigneeFilter", "workspaceGid", "projectGid"], ["displayIdField", "routeField", "epicType"]],
    ["jira", ["token", "assigneeFilter", "site", "baseUrl", "email", "projectKey", "assigneeAccountId"], ["webhookSecret", "routeField", "epicType"]],
    ["github", ["token", "assigneeFilter", "repository", "assigneeLogin"], ["webhookSecret", "owner", "repo", "routeField", "epicType", "epicLabel"]],
    ["github-projects", ["token", "assigneeFilter", "repository", "assigneeLogin", "project"], ["webhookSecret", "routeField", "epicType", "epicLabel"]],
    ["local", ["assigneeFilter"], ["routeField"]],
  ];
  for (const [type, common, advanced] of cases) {
    it(type, async () => {
      const { root } = await live(TrackerForm, { tracker: { type, pipeline: [] } });
      expect(names(root)).toEqual([...common, ...advanced, "type"].map(t).sort());
      const adv = root.querySelector<HTMLDetailsElement>("[data-advanced]")!;
      expect(adv.open).toBe(false);
      expect(names(adv)).toEqual(advanced.map(t).sort());
    });
  }

  it("the Advanced summary counts the advanced keys set (a default value doesn't count)", async () => {
    const { root } = await live(TrackerForm, { tracker: { type: "asana", displayIdField: "ID", routeField: "Repo" } });
    expect(root.querySelector("[data-advanced] summary")!.textContent).toBe("Advanced · 1 set");
  });
});

describe("TrackerForm type", () => {
  it("is read-only once set, with the 'do it in Raw' note", async () => {
    const { root, texts } = await live(TrackerForm, { tracker: { type: "github" } });
    const input = field(root, "tracker.type");
    expect(input.tagName).toBe("INPUT");
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe("github");
    expect(root.textContent).toContain("do it in Raw");
    await setInput(input, "jira");
    expect(texts).toEqual([]);
  });

  it("is a select only while absent; picking one writes it", async () => {
    const { root, last } = await live(TrackerForm, { name: "p", tracker: { pipeline: [] } });
    const select = field<HTMLSelectElement>(root, "tracker.type");
    expect(select.tagName).toBe("SELECT");
    await pick(select, "jira");
    expect(last().tracker).toEqual({ pipeline: [], type: "jira" });
    // Now set: read-only, and jira's fields show.
    expect(field(root, "tracker.type").tagName).toBe("INPUT");
    expect(field(root, "tracker.projectKey")).not.toBeNull();
  });
});

describe("default-true checkboxes (assigneeFilter, redCi, greenCi)", () => {
  it("assigneeFilter: absent renders checked; unchecking writes false; checking removes the key", async () => {
    const { root, last } = await live(TrackerForm, { tracker: { type: "github" } });
    expect(field(root, "tracker.assigneeFilter").checked).toBe(true);
    expect(root.textContent).toContain("not only the ones assigned to you");
    await click(field(root, "tracker.assigneeFilter"));
    expect(last().tracker.assigneeFilter).toBe(false);
    expect(field(root, "tracker.assigneeFilter").checked).toBe(false);
    await click(field(root, "tracker.assigneeFilter"));
    expect(Object.hasOwn(last().tracker, "assigneeFilter")).toBe(false);
    expect(field(root, "tracker.assigneeFilter").checked).toBe(true);
  });

  for (const key of ["redCi", "greenCi"]) {
    it(`forge.${key}: both directions`, async () => {
      const { root, last } = await live(ForgeForm, { forge: { type: "github" } });
      expect(field(root, `forge.${key}`).checked).toBe(true);
      await click(field(root, `forge.${key}`));
      expect(last().forge[key]).toBe(false);
      await click(field(root, `forge.${key}`));
      expect(last().forge).toEqual({ type: "github" });
    });
  }

  it("an explicit false renders unchecked", async () => {
    const { root } = await live(ForgeForm, { forge: { type: "github", redCi: false } });
    expect(field(root, "forge.redCi").checked).toBe(false);
    expect(field(root, "forge.greenCi").checked).toBe(true);
  });
});

describe("SecretField", () => {
  it("never puts a literal in the DOM; warns naming the path; Clear removes the key", async () => {
    const { root, last } = await live(TrackerForm, { tracker: { type: "github", token: "ghp_secret123" } });
    expect(root.innerHTML).not.toContain("ghp_secret123");
    expect(field(root, "tracker.token").value).toBe("");
    const warn = root.querySelector('[data-secret-state="literal"]')!;
    expect(warn.textContent).toContain("literal secret in tracker.token");
    await click(warn.querySelector("[data-secret-clear]")!);
    expect(last().tracker).toEqual({ type: "github" });
    expect(root.querySelector("[data-secret-state]")).toBeNull();
  });

  it("typing a ${VAR} ref over a literal writes it, shown in clear text", async () => {
    const { root, last } = await live(ForgeForm, { forge: { type: "github", token: "ghp_secret123" } });
    const input = field(root, "forge.token");
    await setInput(input, "${GITHUB_TOKEN}");
    expect(last().forge.token).toBe("${GITHUB_TOKEN}");
    expect(input.type).toBe("text");
    expect(input.value).toBe("${GITHUB_TOKEN}");
    expect(root.querySelector("[data-secret-state]")).toBeNull();
  });

  it("an existing ${VAR} ref is shown; absent shows the .env hint", async () => {
    const { root } = await live(ForgeForm, { forge: { type: "github", token: "${GITHUB_TOKEN}" } });
    expect(field(root, "forge.token").value).toBe("${GITHUB_TOKEN}");
    const secret = field(root, "forge.webhookSecret");
    expect(secret.value).toBe("");
    expect(secret.placeholder).toBe("${ENV_VAR}");
    expect(root.textContent).toContain("Put the value in the .env beside the config");
  });

  it("typing a literal masks the input and shows the warning live (saving it stays possible)", async () => {
    const { root, last } = await live(IngressForm, { ingress: { type: "ngrok" } });
    const input = field(root, "ingress.authtoken");
    await setInput(input, "${NG");
    expect(input.type).toBe("text");
    await setInput(input, "2abcLiteral");
    expect(last().ingress.authtoken).toBe("2abcLiteral");
    expect(input.type).toBe("password");
    expect(root.querySelector('[data-secret-state="literal"]')!.textContent).toContain("ingress.authtoken");
  });

  it("webhookSecret false reads 'verification disabled' and is not rewritten until the user acts", async () => {
    const { root, texts, last } = await live(TrackerForm, { tracker: { type: "jira", webhookSecret: false } });
    expect(texts).toEqual([]);
    const state = root.querySelector('[data-secret-state="disabled"]')!;
    expect(state.textContent).toContain("verification disabled (false)");
    expect(field(root, "tracker.webhookSecret").value).toBe("");
    await click(state.querySelector("[data-secret-clear]")!);
    expect(last().tracker).toEqual({ type: "jira" });
  });
});

describe("ForgeForm", () => {
  const pipeline = [
    { id: "triage", kind: "triage" },
    { id: "code", createsWorktree: true },
    { id: "merge", manual: true },
    { id: "review", kind: "review" },
  ];

  it("absent → 'No forge configured' + Add writes {type: github}", async () => {
    const { root, last } = await live(ForgeForm, { tracker: { type: "github", pipeline } });
    expect(root.textContent).toContain("No forge configured");
    await click(root.querySelector("[data-add-forge]")!);
    expect(last().forge).toEqual({ type: "github" });
    expect(field<HTMLSelectElement>(root, "forge.type").value).toBe("github");
  });

  it("Remove deletes the block only after the confirm", async () => {
    const { root, texts, last } = await live(ForgeForm, { name: "p", forge: { type: "github", repository: "o/r" } });
    await click(root.querySelector("[data-remove-forge]")!);
    expect(confirmDialog()?.textContent).toContain("Remove the forge block?");
    await answerConfirm(false);
    expect(texts).toEqual([]);
    await click(root.querySelector("[data-remove-forge]")!);
    await answerConfirm(true);
    expect(last()).toEqual({ name: "p" });
    expect(root.textContent).toContain("No forge configured");
  });

  it("ciTarget options are exactly the non-manual step ids, after the createsWorktree default", async () => {
    const { root, last } = await live(ForgeForm, { tracker: { type: "github", pipeline }, forge: { type: "github" } });
    const select = field<HTMLSelectElement>(root, "forge.ciTarget");
    const opts = [...select.options].map((o) => [o.value, o.textContent]);
    expect(opts).toEqual([
      ["", "(default — the createsWorktree step: code)"],
      ["triage", "triage"],
      ["code", "code"],
      ["review", "review"],
    ]);
    await pick(select, "review");
    expect(last().forge.ciTarget).toBe("review");
    await pick(field<HTMLSelectElement>(root, "forge.ciTarget"), "");
    expect(last().forge).toEqual({ type: "github" });
  });

  it("a manual or unknown ciTarget stays selectable and is flagged with the rule", async () => {
    for (const cur of ["merge", "gone"]) {
      const { root } = await live(ForgeForm, { tracker: { type: "github", pipeline: [{ id: "merge", manual: true }] }, forge: { type: "github", ciTarget: cur } });
      const select = field<HTMLSelectElement>(root, "forge.ciTarget");
      expect(select.value).toBe(cur);
      expect([...select.options].map((o) => o.textContent)).toEqual(["(default — no createsWorktree step)", `${cur} (not an agent step)`]);
      expect(root.textContent).toContain(`"${cur}" must be an agent (non-manual) pipeline step id`);
      await m!.unmount();
      m = null;
    }
  });

  it("an edit keeps comment keys, unknown keys and key order in the forge block", async () => {
    const text = `{
  "name": "p",
  "forge": {
    "//": "PR awareness",
    "type": "github",
    "futureKey": 1,
    "repository": "o/r"
  }
}`;
    const onEdit = vi.fn();
    m = await mount(createElement(ForgeForm, { text, raw: JSON.parse(text), onEdit }));
    await setInput(field(m.root, "forge.repository"), "o/r2");
    expect(onEdit.mock.calls[0][0]).toBe(text.replace('"o/r"', '"o/r2"'));
  });
});

describe("IngressForm", () => {
  it("absent reads as manual and shows url", async () => {
    const { root, texts } = await live(IngressForm, { name: "p" });
    expect(field<HTMLSelectElement>(root, "ingress.type").value).toBe("manual");
    expect(root.textContent).toContain("absent = manual");
    expect(names(root)).toEqual(["ingress.type", "ingress.url"]);
    expect(texts).toEqual([]);
  });

  it("ngrok shows authtoken / domain (+ advanced webAddr); hosted shows url", async () => {
    const ngrok = await live(IngressForm, { ingress: { type: "ngrok" } });
    expect(names(ngrok.root)).toEqual(["ingress.authtoken", "ingress.domain", "ingress.type", "ingress.webAddr"]);
    expect(names(ngrok.root.querySelector("[data-advanced]")!)).toEqual(["ingress.webAddr"]);
    expect(ngrok.root.textContent).toContain("Unset = a new public URL on every start");
    await m!.unmount();
    const hosted = await live(IngressForm, { ingress: { type: "hosted" } });
    expect(names(hosted.root)).toEqual(["ingress.type", "ingress.url"]);
  });

  it("switching type writes ingress.type (creating the block) and leaves the other type's keys", async () => {
    const { root, last } = await live(IngressForm, { name: "p" });
    await setInput(field(root, "ingress.url"), "https://x.example");
    await pick(field<HTMLSelectElement>(root, "ingress.type"), "ngrok");
    expect(last().ingress).toEqual({ url: "https://x.example", type: "ngrok" });
    await setInput(field(root, "ingress.domain"), "me.ngrok.app");
    await pick(field<HTMLSelectElement>(root, "ingress.type"), "manual");
    expect(last().ingress).toEqual({ url: "https://x.example", type: "manual", domain: "me.ngrok.app" });
    expect(field(root, "ingress.url").value).toBe("https://x.example");
  });
});
