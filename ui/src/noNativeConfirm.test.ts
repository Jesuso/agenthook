import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #370: every "are you sure?" goes through the in-app ConfirmModal (Modal.tsx); `beforeunload` is
// the only native prompt left.
describe("no native confirm", () => {
  it("the Config, Instructions and App views never call window.confirm", () => {
    for (const f of ["ConfigView.tsx", "ConfigForms.tsx", "App.tsx", "InstructionsView.tsx", "leaveGuard.tsx"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/window\.confirm|(?<![\w.$])confirm\(/);
    }
  });
});
