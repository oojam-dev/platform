/** A rule the user broke (or ran into), with a message fit to show them. */
export type RuleErrorCode = "no_votes_left" | "post_limit" | "banned" | "vote_cap" | "idea_closed" | "not_found" | "invalid";

export class RuleError extends Error {
  constructor(
    public code: RuleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RuleError";
  }
}
