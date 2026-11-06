const TITLES = { spell: "Spelling is not available here.", grammar: "Grammar is not available here." };
const ORDER = ["spell", "grammar"];
export class ProofStatus {
    reasons = new Map();
    /** The outcome of a check: the reason when it could not run, null when it ran. */
    report(kind, reason) {
        if (reason)
            this.reasons.set(kind, reason);
        else
            this.reasons.delete(kind);
    }
    /** Whether an automatic pass should try this check. After one reported it cannot run, only a button, a reload, a changed setting or a changed
     *  document language tries again, so an unavailable checker costs one request, not one per keystroke. */
    shouldAutoCheck(kind) { return !this.reasons.has(kind); }
    /** Forget what was reported, for one check or for both. */
    reset(kind) { if (kind)
        this.reasons.delete(kind);
    else
        this.reasons.clear(); }
    /** The notices to show, in a fixed order, only for the checks the person has switched on. */
    notices(enabled) {
        return ORDER.filter((kind) => enabled[kind] && this.reasons.has(kind)).map((kind) => ({ kind, title: TITLES[kind], reason: this.reasons.get(kind) }));
    }
}
