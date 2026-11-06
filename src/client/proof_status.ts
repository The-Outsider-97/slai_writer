/** Which of the automatic proofing checks cannot run, and why. A check that says it cannot run is not retried after every edit, and its reason
 *  stays visible in the Proofing panel until a later check works, so the person is never left with empty proofing and no explanation
 *  (a missing component, or a document in a language the word list does not cover). */
export type ProofKind = "spell" | "grammar";

const TITLES: Record<ProofKind, string> = { spell: "Spelling is not available here.", grammar: "Grammar is not available here." };
const ORDER: readonly ProofKind[] = ["spell", "grammar"];

export interface ProofNotice { kind: ProofKind; title: string; reason: string }

export class ProofStatus {
  private readonly reasons = new Map<ProofKind, string>();

  /** The outcome of a check: the reason when it could not run, null when it ran. */
  report(kind: ProofKind, reason: string | null): void {
    if (reason) this.reasons.set(kind, reason); else this.reasons.delete(kind);
  }

  /** Whether an automatic pass should try this check. After one reported it cannot run, only a button, a reload, a changed setting or a changed
   *  document language tries again, so an unavailable checker costs one request, not one per keystroke. */
  shouldAutoCheck(kind: ProofKind): boolean { return !this.reasons.has(kind); }

  /** Forget what was reported, for one check or for both. */
  reset(kind?: ProofKind): void { if (kind) this.reasons.delete(kind); else this.reasons.clear(); }

  /** The notices to show, in a fixed order, only for the checks the person has switched on. */
  notices(enabled: Readonly<Record<ProofKind, boolean>>): ProofNotice[] {
    return ORDER.filter((kind) => enabled[kind] && this.reasons.has(kind)).map((kind) => ({ kind, title: TITLES[kind], reason: this.reasons.get(kind) as string }));
  }
}
