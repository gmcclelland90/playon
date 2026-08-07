import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Renders assistant chat content as GitHub-flavored markdown. */
export function ChatMarkdown({ content }: { content: string }) {
  if (!content) return null;
  return (
    <div className="msg-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
