import { useT } from "../i18n/react";

/** A ticket's display id: a link to the ticket on its tracker when it has a URL, plain text otherwise. */
export function TicketId({ id, url }: { id: string; url: string | null }) {
  const { t } = useT();
  if (!url)
    return <span className="shrink-0 font-mono text-label text-muted">{id}</span>;
  return (
    <a className="shrink-0 font-mono text-label text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent" href={url} target="_blank" rel="noopener noreferrer" title={t("ticketId.title")}>
      {id}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}
