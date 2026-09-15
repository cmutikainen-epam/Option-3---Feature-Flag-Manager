import { useEffect, useRef, useState } from "react";
import { streamAgentChat } from "./api";

export interface ChatMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

interface AgentChatModalProps {
  readonly flagName: string;
  readonly onClose: () => void;
}

/**
 * Chat modal for asking pi about a single feature flag. Each send starts a
 * brand-new server-side session (see `server/routes/chatWithAgent.ts`), so
 * this component just accumulates the visible transcript locally — the
 * server has no memory of previous turns.
 */
export default function AgentChatModal({ flagName, onClose }: AgentChatModalProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const abortRef = useRef<(() => void) | undefined>(undefined);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return () => abortRef.current?.();
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [messages]);

  const send = (event: React.SyntheticEvent) => {
    event.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || streaming) return;

    setError(undefined);
    setMessages((prev) => [...prev, { role: "user", text: trimmed }, { role: "assistant", text: "" }]);
    setInput("");
    setStreaming(true);

    abortRef.current = streamAgentChat(flagName, trimmed, {
      onDelta: (delta) => {
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") next[next.length - 1] = { ...last, text: last.text + delta };
          return next;
        });
      },
      onError: (message) => {
        setError(message);
        setStreaming(false);
      },
      onDone: () => {
        setStreaming(false);
      },
    });
  };

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal chat-modal"
        role="dialog"
        aria-label={`Chat about ${flagName}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__header">
          <h2>Chat about “{flagName}”</h2>
          <button type="button" className="modal__close" aria-label="Close chat" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="chat-transcript" ref={transcriptRef}>
          {messages.length === 0 ? (
            <p className="chat-empty">Ask pi anything about this flag.</p>
          ) : (
            messages.map((message, i) => (
              <div key={i} className={`chat-message chat-message--${message.role}`}>
                <span className="chat-message__text">
                  {message.text || (message.role === "assistant" && streaming ? "…" : "")}
                </span>
              </div>
            ))
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>

        <form className="chat-form" onSubmit={send}>
          <input
            aria-label="Chat message"
            placeholder="Type a message…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={streaming}
            autoFocus
          />
          <button type="submit" disabled={streaming || !input.trim()}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
