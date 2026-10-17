// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmModal, Modal, useConfirm } from "./Modal";
import type { Ask } from "./Modal";
import { answerConfirm, click, confirmDialog, mount } from "./domHarness";
import type { Mounted } from "./domHarness";

// The in-app confirm that replaces every native window.confirm (#370).

let m: Mounted | null = null;
afterEach(async () => {
  await m?.unmount();
  m = null;
});

const key = (target: EventTarget, k: string, shiftKey = false) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true }));
  });

const confirmProps = { title: "Remove it?", body: "It goes away.", confirmLabel: "Remove" };

describe("ConfirmModal", () => {
  it("is an alertdialog labelled by its title and described by its body, focused on Cancel", async () => {
    m = await mount(createElement(ConfirmModal, { ...confirmProps, onConfirm: () => {}, onCancel: () => {} }));
    const dialog = confirmDialog()!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Remove it?");
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe("It goes away.");
    expect(document.activeElement).toBe(dialog.querySelector("[data-confirm-cancel]"));
    expect(dialog.querySelector("[data-confirm-cancel]")!.textContent).toBe("Cancel");
  });

  it("traps Tab: from the last button wraps to the first, Shift-Tab from the first wraps to the last", async () => {
    m = await mount(createElement(ConfirmModal, { ...confirmProps, onConfirm: () => {}, onCancel: () => {} }));
    const cancel = confirmDialog()!.querySelector<HTMLElement>("[data-confirm-cancel]")!;
    const ok = confirmDialog()!.querySelector<HTMLElement>("[data-confirm-ok]")!;
    ok.focus();
    await key(ok, "Tab");
    expect(document.activeElement).toBe(cancel);
    await key(cancel, "Tab", true);
    expect(document.activeElement).toBe(ok);
  });

  it("Escape and a backdrop click call onCancel, never onConfirm", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    m = await mount(createElement(ConfirmModal, { ...confirmProps, onConfirm, onCancel }));
    await key(document.body, "Escape");
    expect(onCancel).toHaveBeenCalledTimes(1);
    await click(confirmDialog()!.parentElement!);
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("the destructive variant uses the failure styling, the default the accent", async () => {
    m = await mount(createElement(ConfirmModal, { ...confirmProps, destructive: true, onConfirm: () => {}, onCancel: () => {} }));
    expect(confirmDialog()!.querySelector("[data-confirm-ok]")!.className).toContain("border-status-failed text-status-failed");
    await m.rerender(createElement(ConfirmModal, { ...confirmProps, onConfirm: () => {}, onCancel: () => {} }));
    expect(confirmDialog()!.querySelector("[data-confirm-ok]")!.className).toContain("text-[var(--color-accent)]");
  });

  it("opened over a Modal, one Escape closes only the confirm; the next closes the Modal", async () => {
    const onClose = vi.fn();
    function Host() {
      const [confirming, setConfirming] = useState(true);
      return createElement(
        "div",
        null,
        createElement(Modal, { title: "Diff", onClose, children: "body" }),
        confirming && createElement(ConfirmModal, { ...confirmProps, onConfirm: () => {}, onCancel: () => setConfirming(false) }),
      );
    }
    m = await mount(createElement(Host));
    await key(document.body, "Escape");
    expect(confirmDialog()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await key(document.body, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("useConfirm", () => {
  function Host(props: { onAsk: (ask: Ask) => void }) {
    const [ask, element] = useConfirm();
    return createElement("div", null, createElement("button", { "data-open": "", onClick: () => props.onAsk(ask) }, "open"), element);
  }

  it("resolves true on confirm, false on cancel, and gives focus back to the opener", async () => {
    const answers: boolean[] = [];
    m = await mount(createElement(Host, { onAsk: (ask) => void ask(confirmProps).then((ok) => answers.push(ok)) }));
    const opener = m.root.querySelector<HTMLElement>("[data-open]")!;
    opener.focus();
    await click(opener);
    expect(document.activeElement).toBe(confirmDialog()!.querySelector("[data-confirm-cancel]"));
    await answerConfirm(false);
    expect(confirmDialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
    await click(opener);
    await answerConfirm(true);
    expect(answers).toEqual([false, true]);
  });

  it("a second ask while one is open replaces it (the first resolves false)", async () => {
    const answers: string[] = [];
    let n = 0;
    m = await mount(
      createElement(Host, {
        onAsk: (ask) => {
          const tag = `#${++n}`;
          void ask({ ...confirmProps, title: tag }).then((ok) => answers.push(`${tag}:${ok}`));
        },
      }),
    );
    await click(m.root.querySelector("[data-open]")!);
    await click(m.root.querySelector("[data-open]")!);
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    expect(confirmDialog()!.textContent).toContain("#2");
    await answerConfirm(true);
    expect(answers).toEqual(["#1:false", "#2:true"]);
  });
});
