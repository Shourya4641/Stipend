/**
 * The paid resource: six on-chain facts about a token mint (D14).
 *
 * No score. A number like "87/100" hides the rule that produced it and
 * cannot be argued with; a judge, or an agent, can disagree with a stated
 * rule. Every finding names what was read and which published rule applies.
 *
 * A fact the chain will not give us is reported as `unavailable`, never
 * omitted and never guessed. One unavailable field among five answered is
 * an honest result; a confident number that might be wrong is not.
 */
export const Severity = {
  /** Nothing here can harm a holder. */
  Ok: "ok",
  /** Legitimate uses exist, but a holder should know. */
  Caution: "caution",
  /** Someone else can take or devalue your tokens. */
  Risk: "risk",
  /** The chain did not answer. Absence of evidence, not evidence of safety. */
  Unavailable: "unavailable",
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

export type Finding = {
  /** Stable id, so a caller can branch on it without parsing prose. */
  id: string;
  severity: Severity;
  title: string;
  /** What was actually read from the chain. */
  observed: string;
  /** Why it matters, in one sentence. */
  rule: string;
};

export type SafetyReport = {
  mint: string;
  network: string;
  checkedAt: string;
  /** Highest severity among the findings. Not an average, not a score. */
  verdict: Severity;
  findings: Finding[];
};
