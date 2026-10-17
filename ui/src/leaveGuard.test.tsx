// @vitest-environment happy-dom
import { act, createElement, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useLeaveGuard } from "./leaveGuard";
import { CONFIG_DISCARD_PROMPT } from "./config";
import { answerConfirm, confirmDialog, mount } from "./domHarness";
import type { Mounted } from "./domHarness";
import { hashFor, parseHash } from "./route";
import type { Route } from "./route";

// App's leave guard (#370): a hash change away from a dirty Config view asks in the in-app modal.

let m: Mounted | null = null;
let dirty = true;
let current: () => Route = () => ({ kind: "home" });

beforeEach(() => {
  dirty = true;
  window.history.replaceState(null, "", "#/p/demo/config");
});
afterEach(async () => {
  await m?.unmount();
  m = null;
});

function Host() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const ref = useRef(route);
  ref.current = route;
  current = () => ref.current;
  const modal = useLeaveGuard({
    route: () => ref.current,
    prompt: (r) => (r.kind === "profile" && r.view === "config" && dirty ? CONFIG_DISCARD_PROMPT : null),
    go: setRoute,
  });
  return createElement("div", null, modal);
}

/** What the browser does on a link / back: the URL changes, then hashchange fires. */
const navigate = (hash: string) =>
  act(async () => {
    window.history.pushState(null, "", hash);
    window.dispatchEvent(new Event("hashchange"));
  });

const config: Route = { kind: "profile", profile: "demo", view: "config" };
const overview: Route = { kind: "profile", profile: "demo", view: "overview" };

describe("useLeaveGuard", () => {
  it("a clean view navigates with no modal", async () => {
    dirty = false;
    m = await mount(createElement(Host));
    await navigate("#/p/demo");
    expect(confirmDialog()).toBeNull();
    expect(current()).toEqual(overview);
  });

  it("leaving a dirty Config view puts the old hash back and asks; Stay keeps the route and the hash", async () => {
    m = await mount(createElement(Host));
    const entries = window.history.length;
    await navigate("#/p/demo");
    expect(window.location.hash).toBe(hashFor(config));
    expect(confirmDialog()?.textContent).toContain(CONFIG_DISCARD_PROMPT);
    await answerConfirm(false);
    expect(confirmDialog()).toBeNull();
    expect(current()).toEqual(config);
    expect(window.location.hash).toBe(hashFor(config));
    expect(window.history.length).toBe(entries + 1); // only the browser's own entry, rewritten in place
  });

  it("Discard lands on the target route and hash without asking again", async () => {
    m = await mount(createElement(Host));
    await navigate("#/p/demo");
    await answerConfirm(true);
    expect(confirmDialog()).toBeNull();
    expect(current()).toEqual(overview);
    expect(window.location.hash).toBe(hashFor(overview));
  });

  it("a second hash change while asking replaces the target instead of stacking a modal", async () => {
    m = await mount(createElement(Host));
    await navigate("#/p/demo");
    await navigate("#/");
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    expect(window.location.hash).toBe(hashFor(config));
    await answerConfirm(true);
    expect(current()).toEqual({ kind: "home" });
    expect(window.location.hash).toBe("#/");
  });
});
