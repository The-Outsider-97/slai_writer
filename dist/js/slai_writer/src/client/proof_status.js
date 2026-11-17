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
/** How often and how long Writer retries a proofing service that failed to load. The server decides when a retry is worth making (it keeps its own pause and
 *  says how many seconds are left); this only turns that into a bounded schedule: never sooner than the server asked, never more than `RECOVERY_LIMIT`
 *  attempts in a row, so a service that stays down costs a handful of small requests and then waits for the person (the Check button, a changed setting
 *  or language, a reload). Pressing Check, a changed setting and a success all start the count again. */
export const RECOVERY_LIMIT = 12;
const MIN_DELAY_S = 5, MAX_DELAY_S = 300;
export class Recovery {
    attempts = new Map();
    /** Milliseconds to wait before the next automatic attempt, or null once the limit is reached. `seconds` is what the server said was left. */
    plan(kind, seconds) {
        const used = this.attempts.get(kind) ?? 0;
        if (used >= RECOVERY_LIMIT)
            return null;
        this.attempts.set(kind, used + 1);
        const asked = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : MIN_DELAY_S;
        return (Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, asked)) + 1) * 1000; // one second past the server's pause, so the retry is not refused for being early
    }
    /** True when the limit was reached, so the panel can say that Writer has stopped trying by itself. */
    exhausted(kind) { return (this.attempts.get(kind) ?? 0) >= RECOVERY_LIMIT; }
    reset(kind) { if (kind)
        this.attempts.delete(kind);
    else
        this.attempts.clear(); }
}
/** The pause (in seconds) a failed proofing response asks for: in `details.retryAfter` of an error, or `retryAfter` of an answer. */
export function retryAfterOf(source) {
    if (!source || typeof source !== "object")
        return null;
    const value = source.retryAfter;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
