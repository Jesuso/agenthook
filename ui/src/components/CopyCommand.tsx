import { useEffect, useState } from "react";

/** A shell command on its own line with a Copy button; the button says "Copied" (or why not) for 2 s, and screen readers hear it. */
export function CopyCommand({ command }: { command: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(t);
  }, [state]);
  const copy = () => navigator.clipboard.writeText(command).then(() => setState("ok"), () => setState("fail"));
  return (
    <div data-copy-command className="flex items-start gap-2">
      <code className="min-w-0 font-mono text-label break-all text-fg">{command}</code>
      <button
        type="button"
        aria-label={`Copy command: ${command}`}
        onClick={() => void copy()}
        className="shrink-0 rounded-md border border-border px-2 py-0.5 text-label font-medium hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span aria-live="polite">{state === "ok" ? "Copied" : state === "fail" ? "Copy failed" : "Copy"}</span>
      </button>
    </div>
  );
}
