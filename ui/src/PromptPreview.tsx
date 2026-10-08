import { useEffect, useState } from "react";
import type { InstructionFileView, PromptPreview as PromptPreviewBody } from "./contract";
import { formatRelative } from "./format";
import { instructionFileUrl } from "./instructions";
import { TICKET_MARKER, composePrompt, promptPreviewUrl, repoFiles, runStartedAt, stepFileFor, stepIds } from "./promptPreview";

type DiskState = { kind: "none" } | { kind: "loading" } | { kind: "ok"; content: string } | { kind: "error" };
type PreviewState = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; body: PromptPreviewBody };

/**
 * "What the agent sees": recomposes dispatch's standing-instructions join live from the open
 * editor buffer (+ the sibling file's on-disk content) and appends the step's last real ticket.
 * Plain text, never markdown/HTML — this mirrors a literal prompt, not a rendered document.
 */
export function PromptPreview(props: {
  profile: string;
  files: InstructionFileView[];
  openScope: InstructionFileView["scope"];
  buffer: string;
}) {
  const { profile, files, openScope, buffer } = props;
  const steps = stepIds(files);
  const repos = repoFiles(files);

  const [stepId, setStepId] = useState(steps[0] ?? "");
  useEffect(() => {
    if (!steps.includes(stepId)) setStepId(steps[0] ?? "");
  }, [steps.join(",")]);

  const [repoPath, setRepoPath] = useState(repos[0]?.path ?? "");
  useEffect(() => {
    if (!repos.some((f) => f.path === repoPath)) setRepoPath(repos[0]?.path ?? "");
  }, [repos.map((f) => f.path).join(",")]);

  // The sibling file's on-disk content: whichever half of the standing instructions the open
  // buffer isn't currently providing.
  const siblingPath = openScope === "repo" ? stepFileFor(files, stepId)?.path ?? null : repoPath || null;
  const [disk, setDisk] = useState<DiskState>({ kind: "none" });
  useEffect(() => {
    if (!siblingPath) return setDisk({ kind: "none" });
    let live = true;
    setDisk({ kind: "loading" });
    fetch(instructionFileUrl(profile, siblingPath))
      .then((res) => (res.ok ? res.json().then((b: { content: string }) => live && setDisk({ kind: "ok", content: b.content })) : live && setDisk({ kind: "error" })))
      .catch(() => live && setDisk({ kind: "error" }));
    return () => {
      live = false;
    };
  }, [profile, siblingPath]);

  const [preview, setPreview] = useState<PreviewState>({ kind: "loading" });
  useEffect(() => {
    if (!stepId) return setPreview({ kind: "error", status: 404 });
    let live = true;
    setPreview({ kind: "loading" });
    fetch(promptPreviewUrl(profile, stepId))
      .then((res) => (res.ok ? res.json().then((b: PromptPreviewBody) => live && setPreview({ kind: "ok", body: b })) : live && setPreview({ kind: "error", status: res.status })))
      .catch(() => live && setPreview({ kind: "error", status: 0 }));
    return () => {
      live = false;
    };
  }, [profile, stepId]);

  const repo = openScope === "repo" ? buffer : disk.kind === "ok" ? disk.content : "";
  const step = openScope === "repo" ? (disk.kind === "ok" ? disk.content : "") : buffer;
  const ticket = preview.kind === "ok" && preview.body.run !== null ? preview.body.ticket : null;
  const text = composePrompt({ repo, step, ticket });
  const markerAt = ticket !== null ? text.indexOf(TICKET_MARKER) : -1;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-[var(--color-muted)]">
        {steps.length > 1 && (
          <label className="flex items-center gap-1">
            step
            <select className="border border-[var(--color-border)] rounded bg-transparent px-1" value={stepId} onChange={(e) => setStepId(e.target.value)}>
              {steps.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        )}
        {openScope !== "repo" && repos.length > 1 && (
          <label className="flex items-center gap-1">
            repo
            <select className="border border-[var(--color-border)] rounded bg-transparent px-1" value={repoPath} onChange={(e) => setRepoPath(e.target.value)}>
              {repos.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.path}
                </option>
              ))}
            </select>
          </label>
        )}
        <span>
          {preview.kind === "ok" && preview.body.run !== null
            ? `from run ${preview.body.run} (${formatRelative(runStartedAt(preview.body.run), Date.now())})`
            : preview.kind === "ok"
              ? "no run yet — standing part only"
              : preview.kind === "error"
                ? preview.status === 404
                  ? "no preview for this step"
                  : `couldn't load the prompt preview (status ${preview.status})`
                : "loading…"}
        </span>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded border border-[var(--color-border)] px-4 py-2 font-mono text-sm">
        {markerAt === -1 ? (
          text
        ) : (
          <>
            {text.slice(0, markerAt)}
            <div className="my-2 border-t border-dashed border-[var(--color-border)] text-center text-xs text-[var(--color-muted)]">=== TICKET ===</div>
            {text.slice(markerAt + TICKET_MARKER.length)}
          </>
        )}
      </pre>
    </div>
  );
}
