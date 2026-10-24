import type { ProfileView } from "../contract";
import { formatUp } from "../format";

/** Whether a profile's receiver is up: a green or red dot + word (pid and port as a tooltip). `long` says "receiver up/down". */
export function ReceiverStatus({ p, long = false }: { p: Pick<ProfileView, "up" | "pid" | "port">; long?: boolean }) {
  const up = formatUp(p);
  return (
    <span data-receiver={p.up ? "up" : "down"} title={up.title} className={`inline-flex items-center gap-1.5 text-label ${p.up ? "text-success" : "text-status-failed"}`}>
      <span aria-hidden="true" className="size-2 rounded-full bg-current" />
      {long ? `receiver ${up.text}` : up.text}
    </span>
  );
}
