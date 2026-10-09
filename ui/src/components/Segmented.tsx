/** A small mutually-exclusive control: one `aria-checked` button per option in a radiogroup. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: React.ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" className="inline-flex rounded-md border border-border p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={`rounded-[calc(var(--radius-md)-2px)] px-2 py-0.5 text-label font-medium ${
            o.value === value ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"
          }`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
