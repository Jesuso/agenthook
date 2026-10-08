/** A native (title-based) tooltip around inline content — no portal, no positioning. */
export function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  return <span title={text}>{children}</span>;
}
