import type { IssueComment } from "./types.ts";

export type PlanReviewFeedbackIntent = "approve" | "changes" | "idle";

const BLOCKING_PATTERN = /\b(?:not approved|do not implement|hold|blocked)\b/i;
const APPROVAL_PATTERN = /\b(?:lgtm|approved|approve|proceed|implement this plan)\b/i;
const CHANGE_PATTERN = /\b(?:change|changes|update|revise|adjust|modify|rework|add|remove|include|exclude|instead)\b/i;

export function classifyPlanReviewFeedback(comments: IssueComment[]): PlanReviewFeedbackIntent {
  const text = comments.map((comment) => comment.body).join("\n").trim();
  if (!text) {
    return "idle";
  }
  if (!BLOCKING_PATTERN.test(text) && APPROVAL_PATTERN.test(text)) {
    return "approve";
  }
  if (CHANGE_PATTERN.test(text)) {
    return "changes";
  }
  return "idle";
}
