import type { ProfileView } from "./contract";
import { RESTART_IDLE, restartInFlight, restartReducer } from "./config";
import type { RestartAction, RestartState } from "./config";
import { translate } from "./i18n";
import type { MessageKey, Vars } from "./i18n";

// The dashboard profile row's control actions (Restart when idle, Pause new runs / Resume): the
// enabled/disabled logic, the per-profile restart banner map, and the pause/resume outcome text.
// App.tsx drives them; the requests are config.ts's `restartRequest` / `queueToggleRequest`.

export type RowActions = {
  restartDisabled: boolean;
  /** The pause item's command: "resume" once the operator paused the profile, else "pause". */
  toggle: "pause" | "resume";
  toggleDisabled: boolean;
};

/**
 * Every action needs a live receiver. Restart is also off while one is in flight from this row,
 * while the heartbeat says a restart/decommission/drain already holds the queue, or while this
 * dashboard has a removal pending.
 */
export function rowActions(p: Pick<ProfileView, "up" | "paused" | "restartPending">, restart: RestartState, removalPending: boolean): RowActions {
  return {
    restartDisabled: !p.up || restartInFlight(restart) || p.restartPending === true || removalPending,
    toggle: p.paused === true ? "resume" : "pause",
    toggleDisabled: !p.up,
  };
}

/** Per-profile restart state, keyed by state key; an idle profile has no entry. */
export type Restarts = Record<string, RestartState>;

export type RestartsAction =
  | { type: "one"; profile: string; action: RestartAction }
  // A snapshot / SSE profile update: each tracked profile gets its `profile` action; a gone one is dropped.
  | { type: "profiles"; profiles: ProfileView[] };

export function restartsReducer(m: Restarts, a: RestartsAction): Restarts {
  if (a.type === "one") {
    const cur = m[a.profile] ?? RESTART_IDLE;
    const next = restartReducer(cur, a.action);
    if (next === cur) return m;
    if (next.kind === "idle") {
      const { [a.profile]: _, ...rest } = m;
      return rest;
    }
    return { ...m, [a.profile]: next };
  }
  let out = m;
  for (const [key, cur] of Object.entries(m)) {
    const p = a.profiles.find((x) => x.name === key);
    if (!p) {
      const { [key]: _, ...rest } = out;
      out = rest;
      continue;
    }
    const next = restartReducer(cur, { type: "profile", profile: p });
    if (next !== cur) out = { ...out, [key]: next };
  }
  return out;
}

/**
 * The pause/resume toast, in `lang`. A 200 whose result carries a `note` (a resume while a restart,
 * decommission or shutdown holds the queue) did NOT take effect, so it reads as refused.
 */
export function queueToggleText(cmd: "pause" | "resume", label: string, status: number, body: any, lang = "en"): string {
  const tr = (key: MessageKey, vars?: Vars) => translate(lang, key, vars);
  const verb = tr(cmd === "pause" ? "profileActions.pause" : "profileActions.resume");
  if (status === 200) {
    if (typeof body?.note === "string") return tr("profileActions.refused", { verb, label, note: body.note });
    return tr(cmd === "pause" ? "profileActions.paused" : "profileActions.resumed", { label });
  }
  if (status === 503) return tr("profileActions.down", { verb, label });
  if (status === 504) return tr("profileActions.timeout", { verb, label });
  if (status === 502) return tr("profileActions.refusedByReceiver", { verb, error: typeof body?.error === "string" ? body.error : tr("profileActions.unknownError") });
  if (status === 0) return tr("profileActions.network", { verb });
  return tr("profileActions.status", { verb, status });
}
