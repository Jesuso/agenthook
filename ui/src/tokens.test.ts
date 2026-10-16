import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Parses index.css's tokens (the `@theme` block = dark, the light media query = overrides) and
// holds every text tier and status foreground to WCAG AA on every surface it can sit on.
// Comments are stripped first: they mention `@theme` too.
const css = readFileSync(new URL("./index.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The `{…}` body that follows `head`, brace-matched. */
function block(head: string): string {
  const at = css.indexOf(head);
  if (at === -1) throw new Error(`no ${head} in index.css`);
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unbalanced ${head}`);
}

function vars(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const dark = vars(block("@theme"));
const light = { ...dark, ...vars(block("@media (prefers-color-scheme: light)")) };
const SCHEMES = { dark, light };

function color(tokens: Record<string, string>, name: string): string {
  let v = tokens[name];
  for (let i = 0; v && i < 5; i++) {
    const ref = /^var\((--[\w-]+)\)$/.exec(v);
    if (!ref) break;
    v = tokens[ref[1]];
  }
  if (!v || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`${name} is not a 6-digit hex (${v})`);
  return v;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ["--color-bg", "--color-surface", "--color-surface-raised", "--color-overlay"];
const STATUSES = ["running", "queued", "held", "failed", "done", "idle"];

describe("design tokens", () => {
  it("define spacing, radii and the 13/12/11 type scale", () => {
    expect(dark["--spacing"]).toBe("4px");
    for (const r of ["sm", "md", "lg"]) expect(dark[`--radius-${r}`]).toBeTruthy();
    expect(dark["--text-body"]).toBe("13px");
    expect(dark["--text-label"]).toBe("12px");
    expect(dark["--text-meta"]).toBe("11px");
    for (const t of ["body", "label", "meta"]) expect(dark[`--text-${t}--line-height`]).toBeTruthy();
  });

  it("keep the legacy --color-* names resolving", () => {
    for (const [scheme, tokens] of Object.entries(SCHEMES))
      for (const n of ["bg", "fg", "muted", "border", "accent", "ok", "warn", "err"])
        expect(() => color(tokens, `--color-${n}`), `${scheme} --color-${n}`).not.toThrow();
  });

  it("override every colour for light", () => {
    const lightOnly = vars(block("@media (prefers-color-scheme: light)"));
    for (const name of Object.keys(dark).filter((n) => n.startsWith("--color-") && !dark[n].startsWith("var(")))
      expect(lightOnly[name], name).toBeTruthy();
  });

  for (const [scheme, tokens] of Object.entries(SCHEMES)) {
    describe(scheme, () => {
      for (const surface of SURFACES) {
        it(`fg / muted / accent ≥ 4.5 and faint ≥ 3 on ${surface}`, () => {
          const bg = color(tokens, surface);
          for (const t of ["--color-fg", "--color-muted", "--color-accent"])
            expect(contrast(color(tokens, t), bg), `${t} on ${surface}`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(color(tokens, "--color-faint"), bg), `--color-faint on ${surface}`).toBeGreaterThanOrEqual(3);
        });

        it(`every status foreground ≥ 4.5 on ${surface}`, () => {
          const bg = color(tokens, surface);
          for (const s of STATUSES) {
            const fg = color(tokens, `--color-status-${s}`);
            expect(contrast(fg, bg), `status-${s} on ${surface}`).toBeGreaterThanOrEqual(4.5);
          }
        });
      }

      it("every status foreground ≥ 4.5 on its own subtle background", () => {
        for (const s of STATUSES) {
          const fg = color(tokens, `--color-status-${s}`);
          const bg = color(tokens, `--color-status-${s}-bg`);
          expect(contrast(fg, bg), `status-${s} on status-${s}-bg`).toBeGreaterThanOrEqual(4.5);
        }
      });
    });
  }

  it("turn the running pulse off under reduced motion", () => {
    expect(dark["--animate-status-pulse"]).toMatch(/status-pulse/);
    expect(block("@media (prefers-reduced-motion: reduce)")).toMatch(/\.animate-status-pulse\s*\{\s*animation:\s*none/);
  });

  it("declare color-scheme per theme so native widgets (selects) match it", () => {
    expect(block("@media (prefers-color-scheme: light)")).toMatch(/color-scheme:\s*light/);
    const outsideLightMedia = css.replace(block("@media (prefers-color-scheme: light)"), "");
    expect(outsideLightMedia).toMatch(/:root\s*\{[^}]*color-scheme:\s*dark/);
  });
});

// The profile identity palette (src/identity.js): every id has a token, readable as a non-text
// mark on every surface in both schemes, and never mistakable for a status hue.
import { PROFILE_COLORS } from "../../src/identity.js";

function hsv(hex: string): { h: number; s: number } {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: ((h * 60) + 360) % 360, s: max ? d / max : 0 };
}

describe("profile palette", () => {
  for (const [scheme, tokens] of Object.entries(SCHEMES)) {
    it(`holds 3:1 on every surface in ${scheme}`, () => {
      for (const id of PROFILE_COLORS)
        for (const surface of SURFACES) expect(contrast(color(tokens, `--color-profile-${id}`), color(tokens, surface)), `${id} on ${surface}`).toBeGreaterThanOrEqual(3);
    });

    it(`keeps every saturated colour 20° of hue away from held / failed / done in ${scheme}`, () => {
      const status = ["held", "failed", "done"].map((n) => hsv(color(tokens, `--color-status-${n}`)).h).concat(hsv(color(tokens, "--color-success")).h);
      for (const id of PROFILE_COLORS) {
        const { h, s } = hsv(color(tokens, `--color-profile-${id}`));
        if (s < 0.35) continue; // slate / stone are near-neutral: no hue to confuse
        for (const sh of status) {
          const diff = Math.abs(h - sh);
          expect(Math.min(diff, 360 - diff), `${id} vs status hue ${Math.round(sh)}`).toBeGreaterThanOrEqual(20);
        }
      }
    });
  }
});
