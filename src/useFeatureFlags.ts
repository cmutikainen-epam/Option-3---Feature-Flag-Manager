import { useEffect, useState, useRef } from "react";
import { Cause, Effect, Exit, Option } from "effect";
import type { FeatureFlag, ServerMessage } from "../shared/types";
import { createFlag, deleteFlag as deleteFlagRequest, setFlagEnabled } from "./api";

export type FeatureFlags = readonly FeatureFlag[];

/** The failure's message if there is one, else a generic fallback. */
const errorMessage = (cause: Cause.Cause<string>): string =>
  Option.match(Cause.failureOption(cause), {
    onNone: () => "Unexpected error",
    onSome: (message) => message,
  });

function socketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

export interface LiveFeatureFlags {
  readonly flags: FeatureFlags;
  readonly loading: boolean;
  readonly connected: boolean;
  readonly error: string | undefined;
  readonly addFlag: (name: string) => void;
  readonly toggleFlag: (id: number, enabled: boolean, version: number) => void;
  readonly deleteFlag: (id: number) => void;
  readonly clearError: () => void;
}

/**
 * Loads flags once over REST for the initial paint, then keeps them live via a
 * WebSocket: the server broadcasts the updated list whenever the database
 * changes, so edits from any client appear here without polling. The socket
 * auto-reconnects with a short backoff.
 */
export function useFeatureFlags(): LiveFeatureFlags {
  const [flags, setFlags] = useState<FeatureFlags>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const socketRef = useRef<WebSocket | null>(null);

  // Live updates over WebSocket, with reconnect.
  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const connect = () => {
      const socket = new WebSocket(socketUrl());
      socketRef.current = socket;

      socket.onopen = () => {
        // A CONNECTING socket can't be cancelled without the browser logging a warning,
        // so instead let it finish connecting and close it immediately here.
        if (disposed) {
          socket.close();
          return;
        }
        setConnected(true);
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        try {
          const message: ServerMessage = JSON.parse(event.data);
          if (message.type === "flags") {
            setFlags(message.flags);
            setLoading(false);
          }
        } catch {
          console.log("Received bad data from websocket");
        }
      };

      socket.onclose = () => {
        setConnected(false);
        if (!disposed) reconnectTimer = setTimeout(connect, 1000);
      };

      socket.onerror = () => {
        socket.close();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      // Only close now if already open; a socket still CONNECTING is closed
      // by its own onopen handler once the handshake completes (see above).
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.close();
      }
    };
  }, []);

  // We dont need a readFlag function here and we dont need to read the success resonse as we get the successful response via websocket.
  // We check for error responses so we can display a meaningfull message.
  const addFlag = (name: string) => {
    Effect.runPromiseExit(createFlag(name)).then((exit) => {
      if (Exit.isFailure(exit)) setError(errorMessage(exit.cause));
    });
  };

  const toggleFlag = (id: number, enabled: boolean, version: number) => {
    Effect.runPromiseExit(setFlagEnabled(id, enabled, version)).then((exit) => {
      if (Exit.isFailure(exit)) setError(errorMessage(exit.cause));
    });
  };

  const deleteFlag = (id: number) => {
    Effect.runPromiseExit(deleteFlagRequest(id)).then((exit) => {
      if (Exit.isFailure(exit)) setError(errorMessage(exit.cause));
    });
  };

  const clearError = () => setError(undefined);

  return { flags, connected, loading, error, addFlag, toggleFlag, deleteFlag, clearError };
}
