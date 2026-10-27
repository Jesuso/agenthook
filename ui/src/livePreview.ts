import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";

/**
 * Live markdown: one surface that is both the source and its rendering. Headings, emphasis, inline
 * code, links and quotes are styled in place; their markup (`#`, `**`, backticks, `[](url)`) is
 * hidden except on the lines the selection touches, so editing a line shows its raw markdown and
 * leaving it renders it again. Fenced code stays verbatim in mono. Nothing is converted: the
 * document is still the exact file text.
 */

const hide = Decoration.replace({});
const line = (cls: string) => Decoration.line({ class: cls });
const mark = (cls: string) => Decoration.mark({ class: cls });

/** Line numbers the selection touches: their markup stays visible for editing. */
function activeLines(state: EditorState): Set<number> {
  const out = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) out.add(n);
  }
  return out;
}

function build(view: EditorView, focused: boolean): DecorationSet {
  const { state } = view;
  // Unfocused, every line renders; focused, the edited lines show their markup.
  const active = focused ? activeLines(state) : new Set<number>();
  const isActive = (pos: number) => active.has(state.doc.lineAt(pos).number);
  const decos: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (n) => {
        const name = n.name;
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          decos.push(line(`cm-live-h cm-live-h${heading[1]}`).range(state.doc.lineAt(n.from).from));
          return;
        }
        if (name === "FencedCode") {
          for (let p = n.from; p <= n.to; ) {
            const l = state.doc.lineAt(p);
            decos.push(line("cm-live-fence").range(l.from));
            p = l.to + 1;
          }
          return false;
        }
        if (name === "Table") {
          for (let p = n.from; p <= n.to; ) {
            const l = state.doc.lineAt(p);
            decos.push(line("cm-live-table").range(l.from));
            p = l.to + 1;
          }
          return false;
        }
        if (name === "Blockquote") {
          for (let p = n.from; p <= n.to; ) {
            const l = state.doc.lineAt(p);
            decos.push(line("cm-live-quote").range(l.from));
            p = l.to + 1;
          }
          return;
        }
        if (name === "InlineCode") decos.push(mark("cm-live-code").range(n.from, n.to));
        if (name === "Link") decos.push(mark("cm-live-link").range(n.from, n.to));
        if (name === "ListMark") {
          // Hanging indent: the indent and marker render in mono, so a wrapped item lines up under
          // its text at (indent + marker + space) × one mono advance (~0.6em).
          const l = state.doc.lineAt(n.from);
          const cols = n.to + 1 - l.from;
          decos.push(Decoration.line({ attributes: { style: `padding-left: calc(20px + ${cols * 0.6}em); text-indent: -${cols * 0.6}em` } }).range(l.from));
          decos.push(mark("cm-live-listmark").range(l.from, Math.min(n.to + 1, l.to)));
        }
        if (isActive(n.from)) return;
        if (name === "HeaderMark") {
          // The `#`s plus the space after them.
          const end = state.doc.sliceString(n.to, n.to + 1) === " " ? n.to + 1 : n.to;
          decos.push(hide.range(n.from, end));
        } else if (name === "EmphasisMark" || name === "StrikethroughMark" || name === "CodeMark" || name === "LinkMark" || name === "QuoteMark") {
          const end = name === "QuoteMark" && state.doc.sliceString(n.to, n.to + 1) === " " ? n.to + 1 : n.to;
          if (n.node.parent?.name !== "FencedCode") decos.push(hide.range(n.from, end));
        } else if (name === "URL" && n.node.parent?.name === "Link") {
          decos.push(hide.range(n.from, n.to));
        }
      },
    });
  }
  return Decoration.set(decos, true);
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view, view.hasFocus);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged) this.decorations = build(u.view, u.view.hasFocus);
    }
  },
  { decorations: (v) => v.decorations },
);

const liveTheme = EditorView.theme({
  ".cm-content": { fontFamily: "var(--font-sans, ui-sans-serif, system-ui, sans-serif)", fontSize: "14px", lineHeight: "1.6", maxWidth: "52em", width: "100%", marginInline: "auto", padding: "16px 0" },
  ".cm-line": { padding: "0 20px" },
  ".cm-live-h": { fontWeight: "600", color: "var(--color-fg)", lineHeight: "1.3" },
  ".cm-live-h1": { fontSize: "1.45em", paddingTop: "0.6em", paddingBottom: "0.2em" },
  ".cm-live-h2": { fontSize: "1.2em", paddingTop: "0.4em", paddingBottom: "0.15em" },
  ".cm-live-h3": { fontSize: "1.08em", paddingTop: "0.3em" },
  ".cm-live-h4": { fontSize: "1em", paddingTop: "0.2em" },
  ".cm-live-h5, .cm-live-h6": { fontSize: "0.95em", color: "var(--color-muted)" },
  ".cm-live-table": { fontFamily: "var(--font-mono)", fontSize: "12.5px" },
  ".cm-live-fence": { fontFamily: "var(--font-mono)", fontSize: "12.5px", backgroundColor: "var(--color-surface)" },
  ".cm-live-quote": { borderLeft: "2px solid var(--color-border)", color: "var(--color-muted)" },
  ".cm-live-code": { fontFamily: "var(--font-mono)", fontSize: "0.9em", backgroundColor: "var(--color-surface-raised)", borderRadius: "3px", padding: "0 3px" },
  ".cm-live-link": { color: "var(--color-accent)" },
  ".cm-live-listmark": { color: "var(--color-muted)", fontFamily: "var(--font-mono)", fontSize: "1em" },
});

// Rendered text keeps the foreground; colour is left for links and code, as on the board.
const liveHighlight = HighlightStyle.define([
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: "var(--color-muted)" },
]);

/** The live-markdown extension for `MarkdownEditor`'s `live` mode (replaces its source highlight). */
export const livePreview = [plugin, liveTheme, syntaxHighlighting(liveHighlight)];
