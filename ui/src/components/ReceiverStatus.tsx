import type { ProfileView } from "../contract";
import { formatUp } from "../format";
import { useT } from "../i18n/react";

/**
 * Whether a profile's receiver is up: a green or amber dot + word (pid and port as a tooltip). Down
 * is amber, not red: nothing failed, the work is waiting on a restart (DESIGN.md, held = "waiting on
 * a human or a restart"), the same tone as the stopped banner. `long` says "receiver up/down".
 */
export function ReceiverStatus({ p, long = false }: { p: Pick<ProfileView, "up" | "pid" | "port">; long?: boolean }) {
  const { t, lang } = useT();
  const up = formatUp(p, lang);
  return (
    <span data-receiver={p.up ? "up" : "down"} title={up.title} className={`inline-flex items-center gap-1.5 text-label ${p.up ? "text-success" : "text-status-held"}`}>
      <span aria-hidden="true" className="size-2 rounded-full bg-current" />
      {long ? t("receiver.long", { state: up.text }) : up.text}
    </span>
  );
}
