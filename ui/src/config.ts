import type { ProfileView, UiEvent } from "./contract";
import { sensitiveChanges } from "./contract";
import type { InstructionsEvent } from "./instructions";

export type ConfigEvent = Extract<UiEvent, { type: "config" }>;
/** What the Config view's sink receives: config-file changes and feed events (restart lifecycle). */
export type ConfigSinkEvent = ConfigEvent | Extract<UiEvent, { type: "event" }>;

export const CONFIG_DISCARD_PROMPT = "Discard unsaved changes to the open config?";

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

export function restartRequest(profile: string): { url: string; init: RequestInit } {
  return { url: "/api/restart", init: guarded("POST", { profile }) };
}

/** The browser's own JSON.parse — the only check Save waits on; the server stays the authority for the rest. */
export function parseCheck(text: string): { ok: true; raw: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, raw: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// SENSITIVE_FIELDS that aren't secrets: their values are shown as is.
const CLEAR_FIELDS = new Set(["name", "fullAuto", "claudeBin", "tracker.userGid", "tracker.assigneeFilter", "tracker.email"]);
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
export function sensitiveDiff(oldText: string, newText: string): SensitiveChange[] {
  const next = parseCheck(newText);
  if (!next.ok) return [];
  const prev = parseCheck(oldText);
  const oldRaw = prev.ok ? prev.raw : undefined;
  return sensitiveChanges(oldRaw, next.raw).map((path: string) => {
    const a = valueAt(oldRaw, path);
    const b = valueAt(next.raw, path);
    if (CLEAR_FIELDS.has(path)) return { path, from: shown(a), to: shown(b) };
    return {
      path,
      from: isLiteralSecret(a) ? "(set)" : shown(a),
      to: isLiteralSecret(b) ? (a === undefined ? "(set)" : "(changed)") : shown(b),
    };
  });
}

const shown = (v: unknown) => (v === undefined ? "(unset)" : JSON.stringify(v));

/** `name`'s confirm-dialog path reads as "label" (the UI's term for it), not the raw JSON key. */
export const sensitiveLabel = (path: string): string => (path === "name" ? "label (name)" : path);

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
  | { type: "response"; status: number; body: any }
  // A feed event (`restart_requested` / `restarting`) already filtered to this profile.
  | { type: "event"; event: Record<string, any> }
  | { type: "profile"; profile: ProfileView }
  | { type: "reset" };

export const RESTART_IDLE: RestartState = { kind: "idle" };

const inFlight = (s: RestartState): s is Extract<RestartState, { kind: "requesting" | "pending" | "restarting" }> =>
  s.kind === "requesting" || s.kind === "pending" || s.kind === "restarting";

/** Pure transition; an action that doesn't apply returns `s` unchanged. */
export function restartReducer(s: RestartState, a: RestartAction): RestartState {
  switch (a.type) {
    case "request":
      return inFlight(s) ? s : { kind: "requesting", pid: a.pid };
    case "response":
      // SSE can beat the reply (an idle receiver fires at once): only `requesting` takes it.
      if (s.kind !== "requesting") return s;
      if (a.status === 200) return { kind: "pending", pid: s.pid, active: Number(a.body?.active) || 0 };
      return { kind: "error", message: restartErrorText(a.status, a.body) };
    case "event": {
      if (s.kind !== "requesting" && s.kind !== "pending") return s;
      if (a.event.event === "restarting") return { kind: "restarting", pid: s.pid };
      if (a.event.event === "restart_requested") return { kind: "pending", pid: s.pid, active: Number(a.event.active) || 0 };
      return s;
    }
    case "profile": {
      if (!inFlight(s)) return s;
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
export function restartErrorText(status: number, body: any): string {
  if (status === 503) return "Restart failed: receiver not running — start it to apply the config.";
  if (status === 504) return "Restart failed: the receiver didn't answer in time.";
  if (status === 502) return `Restart refused by the receiver: ${typeof body?.error === "string" ? body.error : "unknown error"}`;
  if (status === 0) return "Restart failed (network error)";
  return `Restart failed (status ${status})`;
}

export function restartText(s: RestartState): string | null {
  switch (s.kind) {
    case "idle":
      return null;
    case "requesting":
      return "requesting restart…";
    case "pending":
      return `restart pending (${s.active === 1 ? "1 agent" : `${s.active} agents`} running)`;
    case "restarting":
      return "restarting…";
    case "up":
      return "up — the new config is live";
    case "error":
      return s.message;
  }
}
