import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { tags } from "@lezer/highlight";

// Colours come from the index.css tokens, so dark/light follows prefers-color-scheme with no
// second theme.
export const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--color-fg)", backgroundColor: "var(--color-bg)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono)", lineHeight: "1.5" },
  ".cm-content": { caretColor: "var(--color-fg)", padding: "8px 0" },
  ".cm-line": { padding: "0 8px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-fg)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--color-accent) 30%, transparent)",
  },
});

export const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "bold", color: "var(--color-accent)" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--color-accent)", textDecoration: "underline" },
  { tag: tags.monospace, color: "var(--color-warn)" },
  { tag: tags.quote, color: "var(--color-muted)" },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: "var(--color-muted)" },
  // JSON (the Config view).
  { tag: tags.propertyName, color: "var(--color-accent)" },
  { tag: tags.string, color: "var(--color-ok)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--color-warn)" },
]);

/**
 * CodeMirror 6 markdown editor, uncontrolled: `initial` seeds the document once. The parent
 * remounts it (`key`) to load new content, which also resets undo history. `Mod-s` calls
 * `onSave` and always swallows the browser's "save page". `language` defaults to markdown (the
 * Config view passes `json()`).
 */
export function MarkdownEditor(props: { initial: string; onChange: (doc: string) => void; onSave?: () => void; language?: Extension }) {
  const host = useRef<HTMLDivElement>(null);
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;
  const onSave = useRef(props.onSave);
  onSave.current = props.onSave;

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.initial,
        extensions: [
          history(),
          drawSelection(),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              // The view's window-level Mod-s would otherwise see the same keydown.
              stopPropagation: true,
              run: () => {
                onSave.current?.();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          props.language ?? markdown(),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChange.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    return () => view.destroy();
    // Seeded once per mount by design — see the doc comment.
  }, []);

  return <div ref={host} className="h-full min-h-0 overflow-hidden rounded border border-[var(--color-border)] text-sm" />;
}
