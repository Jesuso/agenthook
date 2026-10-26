// @vitest-environment happy-dom
import { afterEach, describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { canConfirmRemove, classifyRemoveResponse, pendingText, removeErrorText, removeRequest } from "./remove";
import { clearRemovedProfile } from "./state";
import { RemoveProfileForm } from "./RemoveProfile";
import type { RemovePreview } from "./contract";
import { I18nProvider } from "./i18n/react";
import { setLangSetting } from "./i18n";
import { mount } from "./domHarness";

describe("canConfirmRemove", () => {
  it("accepts only the exact label", () => {
    expect(canConfirmRemove("My Bot", "My Bot")).toBe(true);
    expect(canConfirmRemove("my bot", "My Bot")).toBe(false);
    expect(canConfirmRemove("My Bot ", "My Bot")).toBe(false);
    expect(canConfirmRemove(" My Bot", "My Bot")).toBe(false);
    expect(canConfirmRemove("", "My Bot")).toBe(false);
    expect(canConfirmRemove("", "")).toBe(false);
  });
});

describe("removeRequest", () => {
  it("is the guarded JSON POST with X-AH-UI", () => {
    const { url, init } = removeRequest("p", false);
    expect(url).toBe("/api/profile/remove");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json", "X-AH-UI": "1" });
    expect(JSON.parse(String(init.body))).toEqual({ profile: "p", unregister: false });
  });
});

describe("classifyRemoveResponse / removeErrorText", () => {
  it("maps statuses", () => {
    expect(classifyRemoveResponse(200)).toBe("archived");
    expect(classifyRemoveResponse(202)).toBe("pending");
    expect(classifyRemoveResponse(409)).toBe("refused");
    expect(classifyRemoveResponse(502)).toBe("refused");
    for (const s of [0, 400, 401, 403, 404, 500, 503, 504]) expect(classifyRemoveResponse(s)).toBe("error");
  });

  it("includes the receiver's error", () => {
    expect(removeErrorText(502, { error: "decommission: a restart is pending" })).toBe("Remove refused: decommission: a restart is pending");
    expect(removeErrorText(409, null)).toBe("Remove refused: status 409");
    expect(removeErrorText(0, null)).toMatch(/network error/);
    expect(removeErrorText(500, { error: "boom" })).toBe("Remove failed (status 500): boom");
  });
});

describe("pendingText", () => {
  it("counts live agents while up, then reports the archive once stopped", () => {
    expect(pendingText({ up: true, active: 2 })).toBe("removing when idle (2 agents running)…");
    expect(pendingText({ up: true, active: 1 })).toBe("removing when idle (1 agent running)…");
    expect(pendingText({ up: true, active: null })).toBe("removing when idle (0 agents running)…");
    expect(pendingText({ up: false, active: null })).toBe("receiver stopped — archiving… (if this stays, the archive failed — see receiver.log)");
  });
});

describe("clearRemovedProfile", () => {
  const open = { profile: "a", ref: "1" };
  it("clears open + profileFilter naming the removed key", () => {
    expect(clearRemovedProfile({ open, profileFilter: "a" }, "a")).toEqual({ open: null, profileFilter: "" });
  });
  it("keeps picks naming another profile", () => {
    expect(clearRemovedProfile({ open, profileFilter: "a" }, "b")).toEqual({ open, profileFilter: "a" });
    expect(clearRemovedProfile({ open: null, profileFilter: "" }, "a")).toEqual({ open: null, profileFilter: "" });
  });
});

describe("RemoveProfileForm", () => {
  afterEach(() => setLangSetting("en", []));
  const preview: RemovePreview = {
    profile: "key",
    label: "My Bot",
    up: true,
    configPath: "~/proj/agenthook.config.json",
    archivePattern: "~/.agenthook-archive/key-<YYYY-MM-DDTHH-MM-SS>/",
    webhookHint: "agenthook unregister --config ~/proj/agenthook.config.json",
  };
  const render = (o: { typed?: string; preview?: Partial<RemovePreview> } = {}) =>
    renderToStaticMarkup(
      createElement(RemoveProfileForm, {
        preview: { ...preview, ...o.preview },
        typed: o.typed ?? "",
        onType: () => {},
        unregister: true,
        onUnregister: () => {},
        busy: false,
        error: null,
        onSubmit: () => {},
        onCancel: () => {},
      }),
    );
  const removeButton = (html: string) => /<button[^>]*>Remove<\/button>/.exec(html)![0];

  it("disables Remove until the label is typed exactly", () => {
    expect(removeButton(render())).toMatch(/ disabled=""/);
    expect(removeButton(render({ typed: "my bot" }))).toMatch(/ disabled=""/);
    expect(removeButton(render({ typed: "My Bot" }))).not.toMatch(/ disabled=""/);
  });

  it("shows the unregister checkbox only when up; the hint only when stopped", () => {
    const up = render();
    expect(up).toMatch(/type="checkbox"/);
    expect(up).toContain("Unregister webhooks");
    const down = render({ preview: { up: false } });
    expect(down).not.toMatch(/type="checkbox"/);
    expect(down).toContain("agenthook unregister --config ~/proj/agenthook.config.json");
  });

  it("renders in Spanish under the provider", async () => {
    setLangSetting("es", []);
    const m = await mount(createElement(I18nProvider, null, createElement(RemoveProfileForm, {
      preview: { ...preview, configPath: null },
      typed: "",
      onType: () => {},
      unregister: true,
      onUnregister: () => {},
      busy: false,
      error: null,
      onSubmit: () => {},
      onCancel: () => {},
    })));
    expect([...m.root.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Cancelar", "Quitar"]);
    expect(m.root.textContent).toContain("Dar de baja los webhooks");
    expect(m.root.textContent).toContain("El archivo de configuración no se modifica: desconocido.");
    await m.unmount();
  });

  it("names the archive pattern and the untouched config (unknown for a legacy dir)", () => {
    expect(render()).toContain("~/.agenthook-archive/key-&lt;YYYY-MM-DDTHH-MM-SS&gt;/");
    expect(render({ preview: { configPath: null, webhookHint: null } })).toContain("unknown");
  });
});
