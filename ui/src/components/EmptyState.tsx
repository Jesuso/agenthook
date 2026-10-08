/** What an empty list/panel says instead of nothing: a title, an optional hint and action. */
export function EmptyState({ title, hint, action }: { title: string; hint?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
      <p className="font-medium text-fg">{title}</p>
      {hint && <p className="text-label text-muted">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
