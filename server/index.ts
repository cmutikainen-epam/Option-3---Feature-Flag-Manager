import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express, { type Request, type Response } from "express";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { ApiErrorSchema, type ApiError } from "../shared/errors.js";
import { attachWebSocket } from "./ws.js";
import { announceChange } from "./db.js";
import { listFlags } from "./routes/listFlags.js";
import { checkFlag } from "./routes/checkFlag.js";
import { throttledReadSequence } from "./routes/throttledReadSequence.js";
import { createFlag } from "./routes/createFlag.js";
import { updateFlag } from "./routes/updateFlag.js";
import { deleteFlag } from "./routes/deleteFlag.js";

const encodeApiError = Schema.encodeSync(ApiErrorSchema);

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 3001);
const app = express();
app.use(express.json());

// Generic handler wrapper that converts the Effect to a regular promise and returns the result if it is successful.
// Pass `announce: true` for endpoints that mutate flags, to notify WebSocket
// subscribers once the response has actually finished sending — never before.
const handler =
  <A>(
    build: (req: Request) => Effect.Effect<A, ApiError>,
    options?: { readonly announce?: boolean },
  ) =>
  (req: Request, res: Response): void => {
    Effect.runPromiseExit(build(req)).then((exit) => {
      if (Exit.isSuccess(exit)) {
        if (options?.announce) {
          res.once("finish", () => {
            Effect.runFork(announceChange);
          });
        }
        res.json(exit.value);
        return;
      }

      // If not successful, we try to match the error type
      const { status, body } = Option.match(Cause.failureOption(exit.cause), {
        // We don't recognize the error, so we send 500 and create a generic message
        onNone: () => ({
          status: 500,
          body: { error: "Something unexpected happened, Please try again." },
        }),
        // We recognize the error and serialize the custom message
        onSome: (error: ApiError): { readonly status: number; readonly body: unknown } => {
          return { status: error.httpStatus, body: encodeApiError(error) };
        },
      });

      res.status(status).json(body);
    });
  };

app.get("/api/flags", handler(listFlags));
app.post("/api/flags", handler(createFlag, { announce: true }));
app.get("/api/flags/check", handler(checkFlag));
app.get("/api/flags/throttled-read-sequence", handler(throttledReadSequence));
app.patch("/api/flags/:id", handler(updateFlag, { announce: true }));
app.delete("/api/flags/:id", handler(deleteFlag, { announce: true }));

// In production, serve the built frontend from the same origin.
// Skip in development so only the Vite dev server on 5173 serves the frontend.
const isProduction = process.env.NODE_ENV === "production";

// Compiled to dist-server/server/index.js (rootDir covers server + shared),
// so the project root is two levels up, and the client build lives at <root>/dist.
const clientDist = join(__dirname, "..", "..", "dist");
if (isProduction && existsSync(clientDist)) {
  // Serve static assets first
  app.use(express.static(clientDist));
  // Then serve HTML for specific routes
  app.get("/", (_req, res) => {
    res.sendFile(join(clientDist, "index.html"));
  });
  // TODO Eventually this route should only be available in development
  app.get("/test", (_req, res) => {
    res.sendFile(join(clientDist, "test.html"));
  });
}

const server = createServer(app);
attachWebSocket(server); // live updates at ws://<host>/ws

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
