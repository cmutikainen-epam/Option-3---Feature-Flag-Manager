/**
 * server/mockServices.test.ts
 *
 * Tests for the Jira and Git mock service loaders.
 * Verifies data loading, lookup, and dependency resolution without
 * spinning up any agents or network connections.
 */

import { describe, it, expect } from "vitest";
import {
  jiraTickets,
  findJiraTicketsByFlag,
  resolveJiraDependencies,
  findStakeholders,
  gitScanResults,
  findGitScanResult,
} from "./mockServices.js";

// ---------------------------------------------------------------------------
// Jira — data loading
// ---------------------------------------------------------------------------

describe("jiraTickets (loaded from data/jira.jsonl)", () => {
  it("loads at least one ticket", () => {
    expect(jiraTickets.size).toBeGreaterThan(0);
  });

  it("every ticket has required fields", () => {
    for (const ticket of jiraTickets.values()) {
      expect(typeof ticket.id).toBe("string");
      expect(typeof ticket.name).toBe("string");
      expect(typeof ticket.description).toBe("string");
      expect(Array.isArray(ticket.dependencies)).toBe(true);
    }
  });

  it("contains a known ticket id (PLAT-101)", () => {
    expect(jiraTickets.has("PLAT-101")).toBe(true);
  });

  it("known ticket has correct name", () => {
    expect(jiraTickets.get("PLAT-101")?.name).toBe("dark-mode");
  });
});

// ---------------------------------------------------------------------------
// Jira — findJiraTicketsByFlag
// ---------------------------------------------------------------------------

describe("findJiraTicketsByFlag", () => {
  it("finds a ticket by exact flag name match", () => {
    const results = findJiraTicketsByFlag("dark-mode");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((t) => t.name === "dark-mode")).toBe(true);
  });

  it("finds a ticket by partial name match (case-insensitive)", () => {
    const results = findJiraTicketsByFlag("BILLING");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((t) => t.name.toLowerCase().includes("billing"))).toBe(true);
  });

  it("returns empty array for unknown flag name", () => {
    expect(findJiraTicketsByFlag("nonexistent-flag-xyz")).toHaveLength(0);
  });

  it("finds a ticket by exact ticket id", () => {
    const results = findJiraTicketsByFlag("PLAT-103");
    expect(results.some((t) => t.id === "PLAT-103")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Jira — resolveJiraDependencies
// ---------------------------------------------------------------------------

describe("resolveJiraDependencies", () => {
  it("returns empty array for a ticket with no dependencies", () => {
    // PLAT-103 (ai-suggestions) has dependencies: []
    const deps = resolveJiraDependencies("PLAT-103");
    expect(deps).toHaveLength(0);
  });

  it("returns direct dependencies", () => {
    // PLAT-101 (dark-mode) depends on PLAT-98 (design-token-system)
    const deps = resolveJiraDependencies("PLAT-101");
    expect(deps.some((d) => d.id === "PLAT-98")).toBe(true);
  });

  it("returns transitive dependencies (BFS)", () => {
    // PLAT-102 (new-onboarding-flow) depends on PLAT-104 and PLAT-107
    // PLAT-104 has no further deps, PLAT-107 has no further deps
    const deps = resolveJiraDependencies("PLAT-102");
    const ids = deps.map((d) => d.id);
    expect(ids).toContain("PLAT-104");
    expect(ids).toContain("PLAT-107");
  });

  it("does not include the root ticket itself in the result", () => {
    const deps = resolveJiraDependencies("PLAT-101");
    expect(deps.some((d) => d.id === "PLAT-101")).toBe(false);
  });

  it("handles a deep chain (billing-v3 → payment-provider-stripe)", () => {
    // PLAT-105 depends on PLAT-106
    const deps = resolveJiraDependencies("PLAT-105");
    expect(deps.some((d) => d.id === "PLAT-106")).toBe(true);
  });

  it("does not infinite-loop on unknown ticket id", () => {
    const deps = resolveJiraDependencies("PLAT-9999");
    expect(deps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Git — data loading
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Jira — findStakeholders
// ---------------------------------------------------------------------------

describe("findStakeholders", () => {
  it("returns stakeholders for a flag with them", () => {
    const stakeholders = findStakeholders("ai-suggestions");
    expect(Array.isArray(stakeholders)).toBe(true);
    expect(stakeholders.length).toBeGreaterThan(0);
    expect(stakeholders[0]).toMatch(/@example\.com$/);
  });

  it("returns empty array for a flag with no stakeholders", () => {
    const stakeholders = findStakeholders("billing-v3");
    expect(Array.isArray(stakeholders)).toBe(true);
    expect(stakeholders).toHaveLength(0);
  });

  it("returns empty array for an unknown flag", () => {
    const stakeholders = findStakeholders("totally-unknown-flag-zzz");
    expect(Array.isArray(stakeholders)).toBe(true);
    expect(stakeholders).toHaveLength(0);
  });

  it("deduplicates stakeholders if multiple tickets match", () => {
    const stakeholders = findStakeholders("dark-mode");
    expect(Array.isArray(stakeholders)).toBe(true);
    const unique = new Set(stakeholders);
    expect(unique.size).toBe(stakeholders.length);
  });

  it("finds stakeholders by ticket id (PLAT-103)", () => {
    const stakeholders = findStakeholders("PLAT-103");
    expect(stakeholders.length).toBeGreaterThan(0);
  });

  it("finds stakeholders by normalized name (ai_suggestions)", () => {
    const stakeholders = findStakeholders("ai_suggestions");
    expect(stakeholders.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Jira — every ticket has stakeholders field
// ---------------------------------------------------------------------------

describe("JiraTicket stakeholders field", () => {
  it("every loaded ticket has a stakeholders field (array)", () => {
    for (const ticket of jiraTickets.values()) {
      expect(Array.isArray(ticket.stakeholders)).toBe(true);
    }
  });

  it("stakeholders are valid email addresses or empty array", () => {
    for (const ticket of jiraTickets.values()) {
      for (const email of ticket.stakeholders) {
        expect(typeof email).toBe("string");
        expect(email).toMatch(/@/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Git — data loading
// ---------------------------------------------------------------------------

describe("gitScanResults (loaded from data/git.json)", () => {
  it("loads at least one entry", () => {
    expect(gitScanResults.size).toBeGreaterThan(0);
  });

  it("every entry has confidence (number 0–1) and warningMessage (string)", () => {
    for (const result of gitScanResults.values()) {
      expect(typeof result.confidence).toBe("number");
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(typeof result.warningMessage).toBe("string");
      expect(result.warningMessage.length).toBeGreaterThan(0);
    }
  });

  it("contains a known key (dark-mode)", () => {
    expect(gitScanResults.has("dark-mode")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Git — findGitScanResult
// ---------------------------------------------------------------------------

describe("findGitScanResult", () => {
  it("finds by exact key", () => {
    const result = findGitScanResult("dark-mode");
    expect(result).toBeDefined();
    expect(result?.confidence).toBeGreaterThan(0);
  });

  it("returns undefined for a completely unknown flag", () => {
    const result = findGitScanResult("totally-unknown-flag-zzz");
    expect(result).toBeUndefined();
  });

  it("finds by keyword substring — flag name contains a known key", () => {
    // 'billing-v3' should match the 'billing' key via substring
    const result = findGitScanResult("billing-v3");
    expect(result).toBeDefined();
  });

  it("finds by keyword substring — known key contains part of flag name", () => {
    // 'monitoring' key matches 'monitoring-dashboard' flag
    const result = findGitScanResult("monitoring-dashboard");
    expect(result).toBeDefined();
  });

  it("high confidence entry returns confidence >= 0.8", () => {
    const result = findGitScanResult("export-to-csv");
    expect(result?.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("low confidence entry returns confidence < 0.5", () => {
    const result = findGitScanResult("multi-region-failover");
    expect(result?.confidence).toBeLessThan(0.5);
  });
});
