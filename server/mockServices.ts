/**
 * server/mockServices.ts
 *
 * Typed loaders for the two mock external services used in development,
 * production (until real integrations exist), and tests.
 *
 * ┌─────────────────────────────────────────────────┐
 * │  data/jira.jsonl  — one JSON object per line    │
 * │  data/git.json    — keyed object                │
 * └─────────────────────────────────────────────────┘
 *
 * Both files are read once at module load time and cached in memory.
 * No network calls, no credentials required.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Shared normalisation
// ---------------------------------------------------------------------------

/**
 * Split a flag name or ticket name into lowercase tokens, treating hyphens,
 * underscores, and whitespace as equivalent word separators.
 *
 * Examples:
 *   "dark-mode"        → ["dark", "mode"]
 *   "dark_mode_extras" → ["dark", "mode", "extras"]
 *   "billingV3"        → ["billingv3"]   (camelCase not split — intentional)
 */
const tokenise = (s: string): string[] =>
  s.toLowerCase().split(/[-_\s]+/).filter((t) => t.length > 0);

/**
 * Returns true when every token in `key` is present in the token set of
 * `candidate`.  This makes "dark-mode" match "dark_mode_extras" without
 * "dark_mode_extras" accidentally matching the shorter key "dark".
 */
const keyTokensMatch = (key: string, candidate: string): boolean => {
  const keyTokens = tokenise(key);
  const candidateTokens = new Set(tokenise(candidate));
  return keyTokens.length > 0 && keyTokens.every((t) => candidateTokens.has(t));
};

// ---------------------------------------------------------------------------
// Jira mock
// ---------------------------------------------------------------------------

export interface JiraTicket {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** IDs of other tickets that must ship before this one. */
  readonly dependencies: string[];
  /** Email addresses of stakeholders for this ticket. */
  readonly stakeholders: readonly string[];
}

const loadJiraTickets = (): Map<string, JiraTicket> => {
  const path = join(process.cwd(), "data/jira.jsonl");
  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const map = new Map<string, JiraTicket>();
  for (const line of lines) {
    const ticket = JSON.parse(line) as JiraTicket;
    map.set(ticket.id, ticket);
  }
  return map;
};

/** All Jira tickets, keyed by ticket ID. Loaded once at startup. */
export const jiraTickets: Map<string, JiraTicket> = loadJiraTickets();

/**
 * Find tickets whose `name` token-matches `flagName`, or whose `id` equals
 * `flagName` (case-insensitive).  Token matching treats hyphens, underscores,
 * and spaces as equivalent separators, so "dark_mode_extras" matches the
 * "dark-mode" ticket, and "dark-mode" also matches "dark_mode_extras".
 */
export const findJiraTicketsByFlag = (flagName: string): JiraTicket[] => {
  return Array.from(jiraTickets.values()).filter(
    (t) =>
      t.id.toLowerCase() === flagName.toLowerCase() ||
      keyTokensMatch(t.name, flagName) ||
      keyTokensMatch(flagName, t.name),
  );
};

/**
 * Find stakeholders (emails) for a given ticket ID or name.
 * Returns empty array if ticket not found or has no stakeholders.
 */
export const findStakeholders = (ticketIdOrName: string): string[] => {
  const tickets = findJiraTicketsByFlag(ticketIdOrName);
  if (tickets.length === 0) return [];
  return Array.from(new Set(tickets.flatMap((t) => t.stakeholders)));
};
export const resolveJiraDependencies = (ticketId: string): JiraTicket[] => {
  const visited = new Set<string>();
  const result: JiraTicket[] = [];
  const queue = [ticketId];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const ticket = jiraTickets.get(id);
    if (!ticket || ticket.id === ticketId) {
      // Don't add the root ticket itself, only its deps
      if (ticket && ticket.id !== ticketId) result.push(ticket);
      if (ticket) queue.push(...ticket.dependencies);
      continue;
    }
    result.push(ticket);
    queue.push(...ticket.dependencies);
  }

  return result;
};

// ---------------------------------------------------------------------------
// Git mock
// ---------------------------------------------------------------------------

export interface GitScanResult {
  /** 0.0–1.0. Higher = safer to enable. */
  readonly confidence: number;
  /** Human-readable warning about conflicts, dependencies, or other risks. */
  readonly warningMessage: string;
}

const loadGitScanResults = (): Map<string, GitScanResult> => {
  const path = join(process.cwd(), "data/git.json");
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, GitScanResult>;
  return new Map(Object.entries(raw));
};

/** All git scan results, keyed by flag name or keyword. Loaded once at startup. */
export const gitScanResults: Map<string, GitScanResult> = loadGitScanResults();

/**
 * Look up the git scan result for a flag name.
 *
 * Strategy (in order):
 *  1. Exact match (after lowercasing).
 *  2. Token match: the key's tokens are all present in the flag's tokens
 *     (e.g. "dark-mode" key matches "dark_mode_extras" flag).
 *  3. Token match in reverse: the flag's tokens are all present in the key
 *     (e.g. "billing-v3" flag matches "billing" key).
 *  4. `undefined` if nothing matches.
 */
export const findGitScanResult = (flagName: string): GitScanResult | undefined => {
  // 1. exact
  const exact = gitScanResults.get(flagName.toLowerCase()) ?? gitScanResults.get(flagName);
  if (exact) return exact;

  // 2 & 3. token containment in either direction
  for (const [key, result] of gitScanResults) {
    if (keyTokensMatch(key, flagName) || keyTokensMatch(flagName, key)) return result;
  }

  return undefined;
};
