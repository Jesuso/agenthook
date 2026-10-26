import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// #562: every word a view shows goes through `t` (docs/web-ui.md § Languages). This parses each
// non-test `ui/src/**/*.tsx` (outside i18n/) and fails on hard-coded UI text: JSX text with a
// letter in it, and a string literal (or a template with no substitutions) with a letter in it
// that is the value of one of ATTRS — directly, or as a branch of `a ? "x" : "y"` / `a ?? "x"` —
// or a `{"…"}` child. Known limit: string literals outside JSX (plain `.ts` helpers, `ask({…})`
// objects, a `const LABEL = "…"` passed in later) aren't caught; review those by hand.

const ATTRS = new Set(["title", "aria-label", "placeholder", "label", "alt", "confirmLabel", "cancelLabel", "body"]);

// Exact text that is never translated: product and tool names, key caps, ids, code, config keys,
// copyable commands and the readout examples shown in monospace.
const ALLOW = new Set<string>([
  ...["agenthook", "PR", "PR #", "CI", "SOUL", "Docker", "Podman", "Aa", "English", "Español", "v", "p10", "· p90"],
  ...["j", "k", "⌘Z", "Ctrl+Z", "=== TICKET ==="],
  ...["ah ui", "agenthook init", "agenthook doctor --fix", "agenthook rename --move", "claude setup-token"],
  ...["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", ".env", "docs/sandbox.md", "~/.agenthook/", "stateId", "${ENV_VAR}", "${VAR}"],
  ...["false", "default", "repos", "energy", "overlap_held", "overlap_released", "qwen3.8*", "worktreePrefix/&lt;id&gt;/"],
  ...["~$x est.", "energy $x (y Wh)"],
]);

const SRC = fileURLToPath(new URL("..", import.meta.url));
const LETTER = /\p{L}/u;

function sources(): string[] {
  return (readdirSync(SRC, { recursive: true }) as string[])
    .map((f) => f.split("\\").join("/"))
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx") && !f.startsWith("i18n/"))
    .sort();
}

/** The literal strings an attribute value or `{…}` child can render: through `?:`, `??`, `||` and `&&`. */
function literals(e: ts.Expression | undefined): ts.StringLiteralLike[] {
  if (!e) return [];
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e];
  if (ts.isParenthesizedExpression(e)) return literals(e.expression);
  if (ts.isConditionalExpression(e)) return [...literals(e.whenTrue), ...literals(e.whenFalse)];
  if (ts.isBinaryExpression(e) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(e.operatorToken.kind)) {
    return [...literals(e.left), ...literals(e.right)];
  }
  return [];
}

/** `file:line: text` for every hard-coded UI string in one source file. */
export function hardcoded(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const flag = (node: ts.Node, s: string) => {
    const v = s.replace(/\s+/g, " ").trim();
    if (LETTER.test(v) && !ALLOW.has(v)) out.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${JSON.stringify(v)}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) flag(node, node.text);
    else if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      for (const l of literals(node.expression)) flag(l, l.text);
    } else if (ts.isJsxAttribute(node) && ATTRS.has(node.name.getText(sf))) {
      const init = node.initializer;
      if (init && ts.isStringLiteral(init)) flag(init, init.text);
      else if (init && ts.isJsxExpression(init)) for (const l of literals(init.expression)) flag(l, l.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("no hard-coded UI text", () => {
  it("every .tsx view renders its words through t()", () => {
    const found = sources().flatMap((f) => hardcoded(f, readFileSync(SRC + f, "utf8")));
    expect(found).toEqual([]);
  });

  it("catches JSX text and a literal title, but not ids, code or allowlisted names", () => {
    expect(hardcoded("x.tsx", `const A = () => <p>Hello</p>;`)).toEqual(['x.tsx:1: "Hello"']);
    expect(hardcoded("x.tsx", `const A = () => <a title="Open log" />;`)).toEqual(['x.tsx:1: "Open log"']);
    expect(hardcoded("x.tsx", "const A = () => <a aria-label={`Open log`} />;")).toEqual(['x.tsx:1: "Open log"']);
    expect(hardcoded("x.tsx", `const A = (p) => <a title={p.x ? "Open" : t("k")}>{p.y ?? "none"}</a>;`)).toEqual(['x.tsx:1: "Open"', 'x.tsx:1: "none"']);
    expect(hardcoded("x.tsx", `const A = () => <p className="text-xs" data-id="a1" title={t("k")}>{t("k")} · 42 <code>PR</code></p>;`)).toEqual([]);
  });
});
