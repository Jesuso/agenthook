import { act } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * A tiny DOM harness for component tests that need effects and clicks. Use it from a test file
 * that opts in with `// @vitest-environment happy-dom` — every other test stays on plain node.
 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

export type Mounted = { root: HTMLElement; rerender: (el: ReactElement) => Promise<void>; unmount: () => Promise<void> };

export async function mount(el: ReactElement): Promise<Mounted> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(el));
  return {
    root: host,
    rerender: (next) => act(async () => r.render(next)),
    unmount: async () => {
      await act(async () => r.unmount());
      host.remove();
    },
  };
}

/** Dispatch a bubbling click (or an Enter keydown) inside `act`, then let effects settle. */
export async function click(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

export async function pressEnter(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

/** The open in-app confirm (Modal.tsx `ConfirmModal`), or null. */
export const confirmDialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');

/** Answer the open confirm: its confirm button (`true`) or Cancel (`false`). */
export async function answerConfirm(ok: boolean): Promise<void> {
  const dialog = confirmDialog();
  if (!dialog) throw new Error("answerConfirm: no confirm dialog open");
  await click(dialog.querySelector(ok ? "[data-confirm-ok]" : "[data-confirm-cancel]")!);
}

/** Wait (inside `act`) until `check` returns truthy — for fetch-driven renders. */
export async function until<T>(check: () => T, tries = 50): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = check();
    if (v) return v;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  throw new Error("until: condition never held");
}
