// Types shared between the API server and the web client. This is a `.d.ts`
// so it is never emitted to JS — both sides import it type-only, and the
// declarations are erased at build time.

/** A feature flag, as stored by the server and returned by the API. */
export interface FeatureFlag {
  readonly id: number;
  readonly name: string;
  readonly enabled: boolean;
  readonly version: number;
  readonly createdAt: string;
}

export type ServerMessage = { type: "flags"; flags: FeatureFlag[] };
