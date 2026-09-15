/**
 * shared/graph/flag-analysis.ts
 *
 * The feature-flag analysis flow.
 *
 * An example of a concrete `AgentGraph<S>` built with the generic
 * `GraphBuilder`. This flow:
 *   1. Checks Jira for dependencies/blockers
 *   2. Checks the repo for merge-conflict risk (in parallel)
 *   3. Summarizes findings and routes on risk level
 *   4. Optionally attempts remediation (fallback)
 *   5. Terminates with success or failure
 *
 * Topology:
 *
 *        ┌─> check_jira ─┐
 *   start┤                ├─> summarize_findings ─┬─(success)─> success
 *        └─> check_repo ─┘                        └─(fallback)─> fallback ─┬─(success)─> success
 *                                                                          └─(failure)─> failure
 */

import { Effect } from "effect";
import { GraphBuilder, type AgentGraph, type NodeHandler } from "./index.js";
import {
  findGitScanResult,
  findJiraTicketsByFlag,
  resolveJiraDependencies,
} from "../../server/mockServices.js";

// ---------------------------------------------------------------------------
// State shape for this flow
// ---------------------------------------------------------------------------

export interface CheckJiraResult {
  readonly source: "jira";
  readonly summary: string;
}

export interface CheckRepoResult {
  readonly source: "repo";
  readonly summary: string;
}

export interface SummaryResult {
  readonly content: string;
  readonly outcome: "success" | "fallback";
}

export interface FallbackResult {
  readonly content: string;
  readonly outcome: "success" | "failure";
}

export interface FlowState {
  readonly flagName: string;
  readonly checkJira?: CheckJiraResult;
  readonly checkRepo?: CheckRepoResult;
  readonly summary?: SummaryResult;
  readonly fallback?: FallbackResult;
  /** Populated when a terminal is reached, for the caller to inspect. */
  readonly verdict?: "success" | "failure";
}

// ---------------------------------------------------------------------------
// Callbacks the caller wants when a terminal is hit
// ---------------------------------------------------------------------------

export interface FlowCallbacks {
  readonly onSuccess: (state: FlowState, summary: SummaryResult) => Effect.Effect<void>;
  readonly onFailure: (state: FlowState, fallback: FallbackResult) => Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// Node handlers for this flow
// ---------------------------------------------------------------------------

const startNode: NodeHandler<FlowState> = (state) =>
  Effect.gen(function* () {
    yield* Effect.log("[start]");
    return { state, transitions: [] };
  });

const checkJiraNode: NodeHandler<FlowState> = (state) =>
  Effect.gen(function* () {
    yield* Effect.log(`[check_jira] ${state.flagName}`);

    const tickets = findJiraTicketsByFlag(state.flagName);
    if (tickets.length === 0) {
      return {
        state: {
          ...state,
          checkJira: {
            source: "jira",
            summary: `No Jira tickets found for "${state.flagName}".`,
          },
        },
        transitions: [],
      };
    }

    const parts = tickets.map((ticket) => {
      const deps = resolveJiraDependencies(ticket.id);
      const depNote =
        deps.length === 0 ? "no deps" : `deps: ${deps.map((d) => d.id).join(", ")}`;
      return `[${ticket.id}] ${ticket.name} (${depNote})`;
    });

    return {
      state: {
        ...state,
        checkJira: { source: "jira", summary: parts.join("\n") },
      },
      transitions: [],
    };
  });

const checkRepoNode: NodeHandler<FlowState> = (state) =>
  Effect.gen(function* () {
    yield* Effect.log(`[check_repo] ${state.flagName}`);

    const scan = findGitScanResult(state.flagName);
    if (!scan) {
      return {
        state: {
          ...state,
          checkRepo: {
            source: "repo",
            summary: `No scan data found for "${state.flagName}".`,
          },
        },
        transitions: [],
      };
    }

    const level =
      scan.confidence >= 0.8 ? "LOW" : scan.confidence >= 0.5 ? "MEDIUM" : "HIGH";

    return {
      state: {
        ...state,
        checkRepo: {
          source: "repo",
          summary:
            `Risk: ${level} (${(scan.confidence * 100).toFixed(0)}%)\n` +
            scan.warningMessage,
        },
      },
      transitions: [],
    };
  });

const summarizeNode: NodeHandler<FlowState> = (state) =>
  Effect.gen(function* () {
    yield* Effect.log("[summarize_findings]");

    const jira = state.checkJira?.summary ?? "";
    const repo = state.checkRepo?.summary ?? "";
    const content = `Jira:\n${jira}\n\nRepo:\n${repo}`;

    const outcome: "success" | "fallback" =
      repo.includes("HIGH") || jira.includes("BLOCKER") ? "fallback" : "success";

    return {
      state: { ...state, summary: { content, outcome } },
      // Branch: only follow the edge whose label matches the outcome.
      transitions: [outcome],
    };
  });

const fallbackNode: NodeHandler<FlowState> = (state) =>
  Effect.gen(function* () {
    yield* Effect.log("[fallback]");

    const content =
      "Remediation attempted but could not resolve issues:\n" +
      (state.summary?.content ?? "");

    // Stubbed remediation always escalates for now.
    const outcome: "success" | "failure" = "failure";

    return {
      state: { ...state, fallback: { content, outcome } },
      transitions: [outcome],
    };
  });

const terminal =
  (verdict: "success" | "failure"): NodeHandler<FlowState> =>
  (state) =>
    Effect.gen(function* () {
      yield* Effect.log(`[${verdict}] TERMINAL`);
      return { state: { ...state, verdict }, transitions: [] };
    });

// ---------------------------------------------------------------------------
// Graph factory
// ---------------------------------------------------------------------------

/**
 * Build the feature-flag analysis graph for a given flag name and callbacks.
 *
 * This is a *concrete* graph — a fully-specified example of what an
 * `AgentGraph<FlowState>` looks like. Any caller can construct their own
 * `AgentGraph` using the same `GraphBuilder` API.
 */
export const makeFeatureFlagGraph = (
  flagName: string,
  callbacks: FlowCallbacks,
): AgentGraph<FlowState> =>
  new GraphBuilder<FlowState>()
    .node("start", startNode)
    .node("check_jira", checkJiraNode)
    .node("check_repo", checkRepoNode)
    .node("summarize_findings", summarizeNode)
    .node("fallback", fallbackNode)
    .terminal("success", terminal("success"))
    .terminal("failure", terminal("failure"))
    .edge("start", "check_jira")
    .edge("start", "check_repo")
    .edge("check_jira", "summarize_findings")
    .edge("check_repo", "summarize_findings")
    // Branching edges use labels that match the node's emitted transition.
    .edge("summarize_findings", "success", "success")
    .edge("summarize_findings", "fallback", "fallback")
    .edge("fallback", "success", "success")
    .edge("fallback", "failure", "failure")
    .build({ flagName }, (kind, state) =>
      Effect.gen(function* () {
        if (kind === "success" && state.summary) {
          yield* callbacks.onSuccess(state, state.summary);
        } else if (kind === "failure" && state.fallback) {
          yield* callbacks.onFailure(state, state.fallback);
        }
      }),
    );
