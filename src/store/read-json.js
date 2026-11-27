import fs from "node:fs";

/** @param {string} f @param {any} fallback */
export const readJson = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return fallback;
  }
};
