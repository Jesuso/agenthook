import { useRef } from "react";

/**
 * A small mutually-exclusive control: one `aria-checked` button per option in a radiogroup.
 *
 * Keyboard (the radio-group pattern): the group is a single Tab stop — the selected option has
 * `tabIndex={0}`, every other option `tabIndex={-1}` (if no option is selected, the first one, so
 * the group is never unreachable). On the group, ArrowRight/ArrowDown move to the next option,
 * ArrowLeft/ArrowUp to the previous (both wrap at the ends), Home to the first and End to the
 * last: each calls `onChange` with the new value and moves DOM focus there, so selection follows
 * focus. `disabled` disables every option and the keys do nothing; other keys pass through.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  tone = "accent",
}: {
  value: T;
  options: { value: T; label: React.ReactNode }[];
  onChange: (v: T) => void;
  /** The group's accessible name, where no surrounding text already names it. */
  label?: string;
  /** `neutral`: the selection is a raised surface, for a group that sits beside a filled primary button. */
  tone?: "accent" | "neutral";
  /** Disables every option. */
  disabled?: boolean;
}) {
  const group = useRef<HTMLDivElement>(null);
  // The roving `tabIndex={0}` sits on the selected option, or the first one if `value` matches none.
  const active = options.some((o) => o.value === value) ? value : options[0]?.value;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key !== "ArrowRight" && e.key !== "ArrowDown" && e.key !== "ArrowLeft" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const list = [...(group.current?.querySelectorAll<HTMLButtonElement>("[role=radio]:not(:disabled)") ?? [])];
    const n = list.length;
    if (!n) return;
    const at0 = list.indexOf(document.activeElement as HTMLButtonElement);
    const at = at0 >= 0 ? at0 : Math.max(0, options.findIndex((o) => o.value === value));
    let next: number;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (at + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (at - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else next = n - 1;
    onChange(options[next].value);
    list[next].focus();
  };

  return (
    <div ref={group} role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} onKeyDown={onKeyDown} className={`inline-flex rounded-md border border-border p-0.5 ${disabled ? "opacity-50" : ""}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={disabled}
          tabIndex={o.value === active ? 0 : -1}
          className={`rounded-[calc(var(--radius-md)-2px)] px-2 py-0.5 text-label font-medium ${
            o.value === value ? (tone === "neutral" ? "bg-surface-raised text-fg" : "bg-accent text-accent-fg") : `text-muted ${disabled ? "" : "hover:text-fg"}`
          }`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
