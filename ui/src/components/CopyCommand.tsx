import { useEffect, useState } from "react";

/**
 * A shell command in a code box with a Copy button inside it, docs-style. The "$" prompt is
 * decoration (not selected, not copied). The button says "Copied" (or why not) for 2 s, and screen
 * readers hear it.
 */
export function CopyCommand({ command }: { command: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(t);
  }, [state]);
  const copy = () => navigator.clipboard.writeText(command).then(() => setState("ok"), () => setState("fail"));
  return (
    <div data-copy-command className="flex items-center gap-3 rounded-md border border-border bg-bg py-1 pr-1 pl-3">
      {/* One line that scrolls sideways when narrow, docs-style: wrapping mid-path ("/tm|p/") reads as two commands. */}
      <code className="min-w-0 flex-1 overflow-x-auto py-1 font-mono text-label whitespace-nowrap text-fg">
        <span aria-hidden="true" className="mr-2 select-none text-muted">$</span>
        {command}
      </code>
      <button
        type="button"
        aria-label={`Copy command: ${command}`}
        onClick={() => void copy()}
        className="min-w-16 shrink-0 rounded-md border border-border px-2 py-0.5 text-label font-medium hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span aria-live="polite">{state === "ok" ? "Copied" : state === "fail" ? "Copy failed" : "Copy"}</span>
      </button>
    </div>
  );
}
