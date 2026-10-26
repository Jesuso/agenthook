import { useRef } from "react";

/**
 * A small mutually-exclusive control: one `aria-checked` button per option in a radiogroup. One
 * tab stop (the checked option); arrow keys and Home/End move and select, as the ARIA radio
 * pattern expects.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T;
  options: { value: T; label: React.ReactNode }[];
  onChange: (v: T) => void;
  /** The group's accessible name, where no surrounding text already names it. */
  label?: string;
  /** Disables every option. */
  disabled?: boolean;
}) {
  const group = useRef<HTMLDivElement>(null);
  const move = (e: React.KeyboardEvent, i: number) => {
    const last = options.length - 1;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? (i === last ? 0 : i + 1)
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i === 0 ? last : i - 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : null;
    if (next === null || disabled) return;
    e.preventDefault();
    onChange(options[next].value);
    group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };
  // A value matching no option still leaves the first one tabbable.
  const tabbable = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div ref={group} role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} className={`inline-flex rounded-md border border-border p-0.5 ${disabled ? "opacity-50" : ""}`}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={i === tabbable ? 0 : -1}
          onKeyDown={(e) => move(e, i)}
          disabled={disabled}
          className={`rounded-[calc(var(--radius-md)-2px)] px-2 py-0.5 text-label font-medium ${
            o.value === value ? "bg-accent text-accent-fg" : `text-muted ${disabled ? "" : "hover:text-fg"}`
          }`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
