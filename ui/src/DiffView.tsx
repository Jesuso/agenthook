import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { MergeView } from "@codemirror/merge";
import { highlight, theme } from "./MarkdownEditor";

// Each side sizes to its content (the outer box scrolls); listed before `theme` so it wins over its `height: 100%`.
const autoHeight = EditorView.theme({ "&": { height: "auto" } });
const readOnly = (language: Extension) => [EditorState.readOnly.of(true), EditorView.editable.of(false), language, syntaxHighlighting(highlight), EditorView.lineWrapping, autoHeight, theme];

/** Read-only side-by-side diff: `a` (on disk) left, `b` (the buffer) right. Rebuilt when either changes. `language` defaults to markdown. */
export function DiffView(props: { a: string; b: string; language?: Extension }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const extensions = readOnly(props.language ?? markdown());
    const view = new MergeView({
      parent: host.current!,
      a: { doc: props.a, extensions },
      b: { doc: props.b, extensions },
      collapseUnchanged: { margin: 3, minSize: 4 },
    });
    return () => view.destroy();
  }, [props.a, props.b]);

  return <div ref={host} className="min-h-0 flex-1 overflow-auto rounded border border-[var(--color-border)] text-sm" />;
}
