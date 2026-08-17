/**
 * shared/graph/stakeholder-alert.ts
 *
 * A flow that checks stakeholders for a feature flag and alerts them
 * if there are any. If no stakeholders are found, an alternative alerting
 * channel is used.
 *
 * Topology:
 *
 *   start ──→ checkingStakeholders ──(has_stakeholders)──→ alertingStakeholders ──→ terminal
 *                    ↓
 *            (no_stakeholders)
 *                    ↓
 *             alertingChannel ────────────────────────→ terminal
 */

import { Effect } from "effect";
import { GraphBuilder, type AgentGraph, type NodeHandler } from "./index.js";
import { findStakeholders } from "../../server/mockServices.js";

// ---------------------------------------------------------------------------
// State shape for this flow
// ---------------------------------------------------------------------------

export interface AlertResult {
  readonly channel: "direct" | "fallback";
  readonly recipients: readonly string[];
  readonly message: string;
  readonly timestamp: number;
}

export interface StakeholderAlertState {
  readonly flagName: string;
  readonly stakeholders: readonly string[];
  readonly alertResult?: AlertResult;
  readonly hasError: boolean;
  readonly errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

export interface StakeholderAlertCallbacks {
  readonly onCheckComplete?: (state: StakeholderAlertState) => Effect.Effect<void>;
  readonly onDirectAlert?: (state: StakeholderAlertState, result: AlertResult) => Effect.Effect<void>;
  readonly onFallbackAlert?: (state: StakeholderAlertState, result: AlertResult) => Effect.Effect<void>;
  readonly onComplete?: (state: StakeholderAlertState) => Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// Node handlers
// ---------------------------------------------------------------------------

const startNode: NodeHandler<StakeholderAlertState> = (state) =>
  Effect.gen(function* () {
    yield* Effect.log(`[start] initializing stakeholder alert for flag: ${state.flagName}`);
    return { state, transitions: ["checking"] };
  });

/**
 * Check if stakeholders exist for the given flag.
 * Emits "has_stakeholders" if any found, "no_stakeholders" if none.
 */
const checkingStakeholdersNode: NodeHandler<StakeholderAlertState> = (state) =>
  Effect.gen(function* () {
    yield* Effect.log(`[checkingStakeholders] looking up stakeholders for ${state.flagName}`);

    const stakeholders = findStakeholders(state.flagName);

    yield* Effect.log(
      `[checkingStakeholders] found ${stakeholders.length} stakeholder(s)`,
    );

    const newState: StakeholderAlertState = {
      ...state,
      stakeholders,
    };

    // Route based on whether stakeholders exist
    if (stakeholders.length > 0) {
      return {
        state: newState,
        transitions: ["has_stakeholders"],
      };
    } else {
      return {
        state: newState,
        transitions: ["no_stakeholders"],
      };
    }
  });

/**
 * Direct alerting: notify all found stakeholders.
 * Logs the alert and stores the result in state.
 */
const alertingStakeholdersNode: NodeHandler<StakeholderAlertState> = (state) =>
  Effect.gen(function* () {
    const message = `[alertingStakeholders] sending direct alerts to ${state.stakeholders.length} stakeholder(s)`;
    yield* Effect.log(message);

    for (const email of state.stakeholders) {
      yield* Effect.log(`  → ${email}`);
    }

    const result: AlertResult = {
      channel: "direct",
      recipients: state.stakeholders,
      message: `Stakeholder notification for ${state.flagName}`,
      timestamp: Date.now(),
    };

    yield* Effect.log(
      `[alertingStakeholders] alerts sent to ${state.stakeholders.length} recipients`,
    );

    return {
      state: { ...state, alertResult: result },
      transitions: ["done"],
    };
  });

/**
 * Fallback alerting: use an alternative channel when no stakeholders found.
 * (e.g., alert a default team, post to Slack, etc.)
 * For now, just logs the fallback action.
 */
const alertingChannelNode: NodeHandler<StakeholderAlertState> = (state) =>
  Effect.gen(function* () {
    yield* Effect.log(
      `[alertingChannel] no stakeholders found, using fallback alert channel`,
    );

    const fallbackChannel = "default-alert-channel";
    yield* Effect.log(`  → notifying ${fallbackChannel}`);
    yield* Effect.log(`  → reason: no direct stakeholders for ${state.flagName}`);

    const result: AlertResult = {
      channel: "fallback",
      recipients: [fallbackChannel],
      message: `Fallback notification for ${state.flagName} (no stakeholders found)`,
      timestamp: Date.now(),
    };

    yield* Effect.log(`[alertingChannel] fallback alert posted`);

    return {
      state: { ...state, alertResult: result },
      transitions: ["done"],
    };
  });

const terminalNode: NodeHandler<StakeholderAlertState> = (state) =>
  Effect.gen(function* () {
    const channelName = state.alertResult?.channel || "unknown";
    yield* Effect.log(
      `[terminal] COMPLETE - alert via ${channelName} (${state.alertResult?.recipients.length || 0} recipients)`,
    );
    return { state, transitions: [] };
  });

// ---------------------------------------------------------------------------
// Graph factory
// ---------------------------------------------------------------------------

/**
 * Build the stakeholder-alert flow.
 *
 * This flow:
 * 1. Starts and transitions to checkingStakeholders
 * 2. checkingStakeholders looks up stakeholders for the flag
 * 3. If found → transitions to alertingStakeholders (direct notify)
 * 4. If not found → transitions to alertingChannel (fallback notify)
 * 5. Both paths → terminal node
 */
export const makeStakeholderAlertGraph = (
  flagName: string,
  callbacks?: StakeholderAlertCallbacks,
): AgentGraph<StakeholderAlertState> =>
  new GraphBuilder<StakeholderAlertState>()
    .node("start", startNode)
    .node("checkingStakeholders", checkingStakeholdersNode)
    .node("alertingStakeholders", alertingStakeholdersNode)
    .node("alertingChannel", alertingChannelNode)
    .terminal("terminal", terminalNode)
    .edge("start", "checkingStakeholders", "checking")
    .edge("checkingStakeholders", "alertingStakeholders", "has_stakeholders")
    .edge("checkingStakeholders", "alertingChannel", "no_stakeholders")
    .edge("alertingStakeholders", "terminal", "done")
    .edge("alertingChannel", "terminal", "done")
    .build(
      { flagName, stakeholders: [], hasError: false },
      (kind, state) =>
        Effect.gen(function* () {
          if (kind === "terminal" && callbacks?.onComplete) {
            yield* callbacks.onComplete(state);
          }
        }),
    );
