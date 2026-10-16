import Markdown from "react-markdown";

/**
 * The digest text as styled markdown (the `.md-preview` look the Instructions preview uses).
 * react-markdown escapes raw HTML and sanitises link URLs by default; never add rehype-raw here —
 * the text is model output built from third-party ticket content.
 */
export default function DigestMarkdown({ text }: { text: string }) {
  return (
    <div className="md-preview text-body text-fg [&>*:first-child]:mt-0 [&>*:last-child]:mb-0" data-digest-text>
      <Markdown>{text}</Markdown>
    </div>
  );
}
