import { beforeEach } from "vitest";
import { setLangSetting } from "./i18n";

// Vitest setup (vite.config.ts `test.setupFiles`, #562): every test renders in English. Spanish is
// complete, so Auto would follow a Spanish host's languages; a test that switches language resets
// it itself.
beforeEach(() => {
  setLangSetting("en", []);
});
