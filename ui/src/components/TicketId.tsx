/** A ticket's display id: a link to the ticket on its tracker when it has a URL, plain text otherwise. */
export function TicketId({ id, url }: { id: string; url: string | null }) {
  if (!url)
    return <span className="shrink-0 font-mono text-label text-muted">{id}</span>;
  return (
    <a className="shrink-0 font-mono text-label text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent" href={url} target="_blank" rel="noopener noreferrer" title="open on the tracker">
      {id}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}
