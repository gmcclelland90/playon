import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { SERVER_DISPLAY_NAME_MAX } from "@playon/shared";

type Props = {
  name: string;
  pending?: boolean;
  error?: string | null;
  disabled?: boolean;
  /** Controlled edit mode. Omit to keep it internal. */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  onSave: (name: string) => void | Promise<void>;
  /** When false, idle state is only a Rename control (tile chip). */
  showName?: boolean;
  as?: "h3" | "strong";
};

export function ServerNameControl({
  name,
  pending = false,
  error = null,
  disabled = false,
  editing: editingProp,
  onEditingChange,
  onSave,
  showName = true,
  as = "h3",
}: Props) {
  const inputId = useId();
  const [internalEditing, setInternalEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  const editing = editingProp ?? internalEditing;

  function setEditing(next: boolean) {
    onEditingChange?.(next);
    if (editingProp === undefined) setInternalEditing(next);
  }

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  async function commit() {
    const next = draft.trim();
    if (!next || next === name) {
      setEditing(false);
      setDraft(name);
      return;
    }
    try {
      await onSave(next);
      setEditing(false);
    } catch {
      // Parent surfaces the error; stay in edit mode.
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void commit();
  }

  if (!editing) {
    const Title = as;
    return (
      <div className={showName ? "server-name-control" : "server-name-control chip"}>
        {showName ? <Title className="server-name-label">{name}</Title> : null}
        <button
          type="button"
          className="linkish"
          disabled={disabled}
          onClick={() => setEditing(true)}
        >
          Rename
        </button>
      </div>
    );
  }

  return (
    <form className="server-name-editor" onSubmit={onSubmit}>
      <label className="sr-only" htmlFor={inputId}>
        Server display name
      </label>
      <input
        id={inputId}
        ref={inputRef}
        value={draft}
        maxLength={SERVER_DISPLAY_NAME_MAX}
        disabled={pending || disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setDraft(name);
            setEditing(false);
          }
        }}
        aria-label="Server display name"
        autoComplete="off"
        spellCheck={false}
      />
      <button
        type="submit"
        className="btn btn-primary btn-compact"
        disabled={pending || disabled || !draft.trim()}
      >
        {pending ? "Saving…" : "Save"}
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-compact"
        disabled={pending}
        onClick={() => {
          setDraft(name);
          setEditing(false);
        }}
      >
        Cancel
      </button>
      {error ? <p className="error">{error}</p> : null}
    </form>
  );
}
