import Editor, { type OnChange, type OnMount } from "@monaco-editor/react";

export function languageFromPath(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  switch (ext) {
    case "yml":
    case "yaml":
      return "yaml";
    case "json":
      return "json";
    case "md":
    case "markdown":
      return "markdown";
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "sh":
    case "bash":
      return "shell";
    case "toml":
      return "ini";
    case "properties":
    case "cfg":
    case "conf":
    case "ini":
      return "ini";
    case "xml":
      return "xml";
    case "html":
    case "htm":
      return "html";
    case "css":
      return "css";
    case "sql":
      return "sql";
    case "dockerfile":
      return "dockerfile";
    default:
      if (base === "dockerfile") return "dockerfile";
      return "plaintext";
  }
}

type CodeEditorProps = {
  path: string;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
};

export function CodeEditor({ path, value, onChange, readOnly }: CodeEditorProps) {
  const language = languageFromPath(path);

  const handleChange: OnChange = (next) => {
    onChange(next ?? "");
  };

  const handleMount: OnMount = (editor) => {
    editor.updateOptions({
      fontFamily: 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: "on",
      automaticLayout: true,
      renderLineHighlight: "line",
      tabSize: 2,
      readOnly: Boolean(readOnly),
    });
  };

  return (
    <Editor
      className="code-editor"
      height="100%"
      theme="vs-dark"
      path={path}
      language={language}
      value={value}
      onChange={handleChange}
      onMount={handleMount}
      options={{
        readOnly: Boolean(readOnly),
        minimap: { enabled: false },
        wordWrap: "on",
        scrollBeyondLastLine: false,
        fontSize: 13,
        automaticLayout: true,
      }}
      loading={<p className="muted status-inline">Loading editor…</p>}
    />
  );
}
