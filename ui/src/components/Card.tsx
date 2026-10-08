/** A bordered surface panel with an optional title row (actions sit at its right). */
export function Card({ title, actions, className = "", children }: { title?: React.ReactNode; actions?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <section className={`rounded-lg border border-border bg-surface ${className}`}>
      {(title || actions) && (
        <header className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
          {title && <h2 className="text-label font-semibold uppercase tracking-wide text-muted">{title}</h2>}
          {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
        </header>
      )}
      <div className="p-3">{children}</div>
    </section>
  );
}
