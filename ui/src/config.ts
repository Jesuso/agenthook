import type { ProfileView, UiEvent } from "./contract";
import { sensitiveChanges } from "./contract";
import type { InstructionsEvent } from "./instructions";
import { translate } from "./i18n";

export type ConfigEvent = Extract<UiEvent, { type: "config" }>;
/** What the Config view's sink receives: config-file changes and feed events (restart lifecycle). */
export type ConfigSinkEvent = ConfigEvent | Extract<UiEvent, { type: "event" }>;

export const CONFIG_DISCARD_PROMPT = "Discard unsaved changes to the open config?";
/** `CONFIG_DISCARD_PROMPT` in `lang`. */
export const configDiscardPrompt = (lang = "en"): string => translate(lang, "configHelp.discardPrompt");

export function configUrl(profile: string): string {
  return `/api/config?${new URLSearchParams({ profile })}`;
}

/** The v3 write-guard chain (`src/ui/server.js`): JSON content type + `X-AH-UI: 1`; the browser adds Origin. */
function guarded(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json", "X-AH-UI": "1" }, body: JSON.stringify(body) };
}

export function configSaveRequest(profile: string, baseHash: string, text: string): { url: string; init: RequestInit } {
  return { url: "/api/config", init: guarded("PUT", { profile, baseHash, text }) };
}

/** `moveTo` = `rename --move`: the receiver also moves its state dir to that key at idle. */
export function restartRequest(profile: string, moveTo?: string): { url: string; init: RequestInit } {
  return { url: "/api/restart", init: guarded("POST", moveTo === undefined ? { profile } : { profile, moveTo }) };
}

/** The dashboard row's operator pause / resume: `POST /api/pause` or `/api/resume` with `{profile}`. */
export function queueToggleRequest(cmd: "pause" | "resume", profile: string): { url: string; init: RequestInit } {
  return { url: `/api/${cmd}`, init: guarded("POST", { profile }) };
}

/** Acknowledge a failed/cancelled ticket: the receiver records a `dismissed` event for it. */
export function dismissRequest(profile: string, ref: string): { url: string; init: RequestInit } {
  return { url: "/api/dismiss", init: guarded("POST", { profile, ref }) };
}

/** Answer a held ticket: the receiver re-runs its held step, `comment` (optional) added to the agent's prompt. */
export function releaseRequest(profile: string, ref: string, comment: string): { url: string; init: RequestInit } {
  const body = comment.trim() ? { profile, ref, comment } : { profile, ref };
  return { url: "/api/release", init: guarded("POST", body) };
}

/** What a release attempt means for the UI: `ok` closes the panel, otherwise `error` is shown beside it. */
export type ReleaseOutcome = { ok: true; text: string } | { ok: false; error: string };

/** Map `POST /api/release`'s status + body (0 = network error) to its outcome. */
export function releaseOutcome(label: string, status: number, body: any, lang = "en"): ReleaseOutcome {
  if (status === 200) {
    const text = typeof body?.step === "string" ? translate(lang, "release.outcome.releasedStep", { label, step: body.step }) : translate(lang, "release.outcome.released", { label });
    return { ok: true, text };
  }
  return { ok: false, error: refusal("release.outcome.failed", status, body, lang) };
}

/** Re-run a failed ticket's failed step: the receiver moves it back into that step's source stage. */
export function retryRequest(profile: string, ref: string): { url: string; init: RequestInit } {
  return { url: "/api/retry", init: guarded("POST", { profile, ref }) };
}

/** Map `POST /api/retry`'s status + body (0 = network error) to its outcome. */
export function retryOutcome(label: string, status: number, body: any, lang = "en"): ReleaseOutcome {
  if (status === 200) {
    const text = typeof body?.step === "string" ? translate(lang, "retry.rerunningStep", { label, step: body.step }) : translate(lang, "retry.rerunning", { label });
    return { ok: true, text };
  }
  return { ok: false, error: refusal("retry.failed", status, body, lang) };
}

/** Why a release / re-run did not happen, from a non-200 status (0 = network error). */
function refusal(failed: "release.outcome.failed" | "retry.failed", status: number, body: any, lang: string): string {
  if (status === 502) return typeof body?.error === "string" ? body.error : translate(lang, "release.outcome.refused");
  if (status === 503) return translate(lang, "release.outcome.notRunning");
  if (status === 504) return translate(lang, "release.outcome.timeout");
  if (status === 0) return translate(lang, "release.outcome.network");
  return translate(lang, failed, { status });
}

/**
 * The state key a "Move state dir to match name" would move to: the loaded config's label when it
 * differs from the open profile's state key, else null (nothing to move; unparseable config too).
 */
export function moveTarget(raw: unknown, stateKey: string): string | null {
  const name = raw && typeof raw === "object" ? (raw as { name?: unknown }).name : undefined;
  return typeof name === "string" && name !== "" && name !== stateKey ? name : null;
}

/** The browser's own JSON.parse — Save waits on it (and on the client checks); the server stays the authority for the rest. */
export function parseCheck(text: string, lang = "en"): { ok: true; raw: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, raw: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: translate(lang, "configHelp.invalidJson", { error: e instanceof Error ? e.message : String(e) }) };
  }
}

/**
 * `amber` = every problem is a pristine card's "incomplete" hint (a just-added row); `summary` = the
 * row is a count because every problem sits on a card the open pane shows.
 */
export type BannerStatus = { ok: true } | { ok: false; first: string; fullFirst: string; moreCount: number; amber: boolean; summary: boolean };

/** How the open pane shows each problem: on a card it renders (`onCard`), and whether that card is still pristine (`incomplete`). */
export type BannerContext = { onCard: (error: string) => boolean; incomplete: (error: string) => boolean };

const BANNER_FIRST_MAX = 100;
const NO_CARDS: BannerContext = { onCard: () => false, incomplete: () => false };

const truncate = (s: string): string => (s.length > BANNER_FIRST_MAX ? `${s.slice(0, BANNER_FIRST_MAX - 1)}…` : s);

/**
 * The validation banner's fixed-height single-line summary: a parse error wins the row (fix the
 * JSON first), but `moreCount` still counts the client checks and server errors — the overlay
 * renders all three sections regardless, so the row's count must match what it can open.
 * A problem a card on the open pane already shows (`ctx.onCard`) is not repeated in the row: the
 * first other one leads it, or, with none left, the row reads "N problem(s) — see the highlighted
 * cards". The row is amber when every problem is a pristine card's (`ctx.incomplete`).
 * `fullFirst` is the untruncated text, for the row's `title`.
 */
export function bannerStatus(parseError: string | null, checks: string[], serverErrors: string[], ctx: BannerContext = NO_CARDS, lang = "en"): BannerStatus {
  if (parseError !== null) {
    return { ok: false, first: truncate(parseError), fullFirst: parseError, moreCount: checks.length + serverErrors.length, amber: false, summary: false };
  }
  const problems = [...checks, ...serverErrors];
  if (problems.length === 0) return { ok: true };
  const amber = problems.every(ctx.incomplete);
  const listed = problems.filter((e) => !ctx.onCard(e));
  if (listed.length === 0) {
    const count = translate(lang, "banner.seeCards", { count: problems.length });
    return { ok: false, first: count, fullFirst: count, moreCount: 0, amber, summary: true };
  }
  const first = listed[0];
  return { ok: false, first: truncate(first), fullFirst: first, moreCount: problems.length - 1, amber, summary: false };
}

// SENSITIVE_FIELDS that aren't secrets: their values are shown as is (a step's `bin` too).
const CLEAR_FIELDS = new Set(["name", "fullAuto", "claudeBin", "tracker.userGid", "tracker.assigneeFilter", "tracker.email"]);
const isClear = (path: string) => CLEAR_FIELDS.has(path) || /^tracker\.pipeline\[\d+\]\.bin$/.test(path);
// A step's or a service's `env` may hold literal secrets: the confirm names its variables, never their values.
const isStepEnv = (path: string) => /^(tracker\.pipeline\[\d+\]|sandbox\.services\.[^.]+)\.env$/.test(path);
const envShown = (v: unknown, lang: string) =>
  v === undefined
    ? translate(lang, "configHelp.unset")
    : v && typeof v === "object" && !Array.isArray(v)
      ? `{${Object.keys(v).join(", ")}}`
      : translate(lang, "configHelp.set");
// Same rule as src/config.js literalSecrets: a non-empty string that is not exactly one `${VAR}` ref.
const isLiteralSecret = (v: unknown) => typeof v === "string" && v !== "" && !/^\$\{[A-Z0-9_]+\}$/.test(v);

/** The value at a concrete path like "sinks[1].botToken"; undefined when any step is missing. */
function valueAt(raw: unknown, path: string): unknown {
  let node: any = raw;
  for (const seg of path.split(".")) {
    const m = /^(.*)\[(\d+)\]$/.exec(seg);
    const key = m ? m[1] : seg;
    node = node && typeof node === "object" && Object.hasOwn(node, key) ? node[key] : undefined;
    if (m) node = Array.isArray(node) ? node[Number(m[2])] : undefined;
  }
  return node;
}

export type SensitiveChange = { path: string; from: string; to: string };

/**
 * The SENSITIVE_FIELDS paths that change between the loaded text and the buffer, for the save
 * confirm. A secret path never renders a literal value: it shows as `(set)`/`(unset)`/`(changed)`;
 * a `${VAR}` ref, a non-string, and the non-secret fields are shown as JSON. An unparseable old
 * text reports every sensitive path present in the new one; an unparseable new text reports none
 * (Save is disabled then anyway).
 */
export function sensitiveDiff(oldText: string, newText: string, lang = "en"): SensitiveChange[] {
  const next = parseCheck(newText);
  if (!next.ok) return [];
  const prev = parseCheck(oldText);
  const oldRaw = prev.ok ? prev.raw : undefined;
  const set = translate(lang, "configHelp.set");
  const changed = translate(lang, "configHelp.changed");
  const shown = (v: unknown) => (v === undefined ? translate(lang, "configHelp.unset") : JSON.stringify(v));
  return sensitiveChanges(oldRaw, next.raw).map((path: string) => {
    const a = valueAt(oldRaw, path);
    const b = valueAt(next.raw, path);
    if (isClear(path)) return { path, from: shown(a), to: shown(b) };
    if (isStepEnv(path)) {
      const from = envShown(a, lang);
      const to = envShown(b, lang);
      return { path, from, to: to === from ? changed : to };
    }
    return {
      path,
      from: isLiteralSecret(a) ? set : shown(a),
      to: isLiteralSecret(b) ? (a === undefined ? set : changed) : shown(b),
    };
  });
}

/** `name`'s confirm-dialog path reads as "label" (the UI's term for it), not the raw JSON key. */
export const sensitiveLabel = (path: string, lang = "en"): string => (path === "name" ? translate(lang, "configHelp.nameLabel") : path);

/** An SSE `config` event as the `instructions` shape `saveReducer` keys on (`path` = the open config's). */
export function configEventAsFile(ev: ConfigEvent, path: string): InstructionsEvent {
  return { type: "instructions", profile: ev.profile, path, hash: ev.hash, source: ev.source };
}

/**
 * The "Restart when idle" banner. `pid` is the receiver's pid when the restart was requested —
 * only a different live pid counts as `up`. Driven by the POST reply and SSE only (no polling).
 */
export type RestartState =
  | { kind: "idle" }
  | { kind: "requesting"; pid: number | null }
  | { kind: "pending"; pid: number | null; active: number }
  | { kind: "restarting"; pid: number | null }
  | { kind: "up" }
  | { kind: "error"; message: string };

export type RestartAction =
  | { type: "request"; pid: number | null }
  // `lang`: the language the error line is written in (default English).
  | { type: "response"; status: number; body: any; lang?: string }
  // A feed event (`restart_requested` / `restarting`) already filtered to this profile.
  | { type: "event"; event: Record<string, any> }
  | { type: "profile"; profile: ProfileView }
  | { type: "reset" };

export const RESTART_IDLE: RestartState = { kind: "idle" };

export const restartInFlight = (s: RestartState): s is Extract<RestartState, { kind: "requesting" | "pending" | "restarting" }> =>
  s.kind === "requesting" || s.kind === "pending" || s.kind === "restarting";

/** Pure transition; an action that doesn't apply returns `s` unchanged. */
export function restartReducer(s: RestartState, a: RestartAction): RestartState {
  switch (a.type) {
    case "request":
      return restartInFlight(s) ? s : { kind: "requesting", pid: a.pid };
    case "response":
      // SSE can beat the reply (an idle receiver fires at once): only `requesting` takes it.
      if (s.kind !== "requesting") return s;
      if (a.status === 200) return { kind: "pending", pid: s.pid, active: Number(a.body?.active) || 0 };
      return { kind: "error", message: restartErrorText(a.status, a.body, a.lang) };
    case "event": {
      if (s.kind !== "requesting" && s.kind !== "pending") return s;
      if (a.event.event === "restarting") return { kind: "restarting", pid: s.pid };
      if (a.event.event === "restart_requested") return { kind: "pending", pid: s.pid, active: Number(a.event.active) || 0 };
      return s;
    }
    case "profile": {
      if (!restartInFlight(s)) return s;
      const p = a.profile;
      if (p.up && p.pid !== null && p.pid !== s.pid) return { kind: "up" };
      if (!p.up && s.kind !== "restarting") return { kind: "restarting", pid: s.pid };
      if (p.up && s.kind === "pending" && p.active !== null && p.active !== s.active) return { ...s, active: p.active };
      return s;
    }
    case "reset":
      return RESTART_IDLE;
  }
}

/** 503 down / 504 timeout / 502 the receiver's own refusal (e.g. a config it won't boot on). */
export function restartErrorText(status: number, body: any, lang = "en"): string {
  if (status === 503) return translate(lang, "restart.error.notRunning");
  if (status === 504) return translate(lang, "restart.error.timeout");
  if (status === 502) return translate(lang, "restart.error.refused", { error: typeof body?.error === "string" ? body.error : translate(lang, "restart.error.unknown") });
  if (status === 0) return translate(lang, "restart.error.network");
  return translate(lang, "restart.error.status", { status });
}

/**
 * `upText` is the `up` line: the Config view's default (`restart.up` in `lang`), or e.g. "restarted"
 * (`restart.restarted`) on the dashboard. The `error` line is the reducer's, in its response action's `lang`.
 */
export function restartText(s: RestartState, upText?: string, lang = "en"): string | null {
  switch (s.kind) {
    case "idle":
      return null;
    case "requesting":
      return translate(lang, "restart.requesting");
    case "pending":
      return translate(lang, "restart.pending", { count: s.active });
    case "restarting":
      return translate(lang, "restart.restarting");
    case "up":
      return upText ?? translate(lang, "restart.up");
    case "error":
      return s.message;
  }
}
