import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { Effect } from "effect";
import { FlagsEventBus } from "./events.js";
import { listFlags } from "./db.js";
import type { FeatureFlag } from "../shared/types.js";

/** Messages the server pushes to clients. */
export type ServerMessage = { type: "flags"; flags: FeatureFlag[] };

const encode = (flags: FeatureFlag[]): string => JSON.stringify({ type: "flags", flags });

// Read the flags, then hand them to `onFlags`. A DB failure is logged and
// swallowed so it can't take down a connection or a broadcast.
const withFlags = (onFlags: (flags: FeatureFlag[]) => void): void =>
  Effect.runSync(
    listFlags().pipe(
      Effect.match({
        onFailure: (error) => console.error("[ws] failed to read flags:", error),
        onSuccess: onFlags,
      }),
    ),
  );

/**
 * Attach a WebSocket server at `/ws` to the given HTTP server. Every connected
 * client receives the current flags on connect, and an updated list whenever
 * the database changes.
 */
export function attachWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket) => {
    // Send the current state immediately so a new client is in sync.
    withFlags((flags) => socket.send(encode(flags)));
  });

  // Broadcast the fresh list to all open clients on any DB change.
  const unsubscribe = FlagsEventBus.onTableChange((timestamp) => {
    console.log(`Feature Flag Table Changed at ${timestamp}`);
    withFlags((flags) => {
      const message = encode(flags);
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      }
    });
  });

  wss.on("close", unsubscribe);
  return wss;
}
