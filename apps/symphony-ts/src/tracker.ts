import { LinearTracker } from "./linear-tracker.ts";
import type { EffectiveConfig, Issue, Tracker } from "./types.ts";
import { normalizeState } from "./util.ts";

export class MockTracker implements Tracker {
  private readonly issues = new Map<string, Issue>();

  constructor(issues: Issue[]) {
    for (const issue of issues) {
      this.issues.set(issue.id, issue);
    }
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return Array.from(this.issues.values());
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    const wanted = new Set(stateNames.map((state) => normalizeState(state)));
    return Array.from(this.issues.values()).filter((issue) => wanted.has(normalizeState(issue.state)));
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    return issueIds.flatMap((id) => {
      const issue = this.issues.get(id);
      return issue ? [issue] : [];
    });
  }

  updateIssueState(issueId: string, state: string): void {
    const issue = this.issues.get(issueId);
    if (issue) {
      this.issues.set(issueId, { ...issue, state });
    }
  }
}

export function createTracker(config: EffectiveConfig): Tracker {
  if (config.tracker.kind === "mock") {
    return new MockTracker(config.tracker.mockIssues);
  }
  return new LinearTracker(config);
}
