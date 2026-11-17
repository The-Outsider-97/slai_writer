import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProofStatus, RECOVERY_LIMIT, Recovery, retryAfterOf } from "../src/client/proof_status.js";

const both = { spell: true, grammar: true };

describe("proofing availability", () => {
  it("says nothing while every check works", () => {
    const status = new ProofStatus();
    assert.deepEqual(status.notices(both), []);
    assert.equal(status.shouldAutoCheck("spell"), true);
    assert.equal(status.shouldAutoCheck("grammar"), true);
  });

  it("keeps the reason of a check that cannot run, and stops retrying it automatically", () => {
    const status = new ProofStatus();
    status.report("spell", "SLAI's spell checker has a EN word list; this document is in NL, so it was not checked.");
    assert.equal(status.shouldAutoCheck("spell"), false);
    assert.equal(status.shouldAutoCheck("grammar"), true);           // one unavailable check never disables the other
    assert.deepEqual(status.notices(both), [{ kind: "spell", title: "Spelling is not available here.", reason: "SLAI's spell checker has a EN word list; this document is in NL, so it was not checked." }]);
  });

  it("lists spelling before grammar, whichever was reported first", () => {
    const status = new ProofStatus();
    status.report("grammar", "g");
    status.report("spell", "s");
    assert.deepEqual(status.notices(both).map((n) => n.kind), ["spell", "grammar"]);
  });

  it("clears a reason when the check later runs", () => {
    const status = new ProofStatus();
    status.report("grammar", "needs the language agent");
    status.report("grammar", null);
    assert.deepEqual(status.notices(both), []);
    assert.equal(status.shouldAutoCheck("grammar"), true);
  });

  it("does not show a notice for a check the person has switched off", () => {
    const status = new ProofStatus();
    status.report("spell", "s");
    status.report("grammar", "g");
    assert.deepEqual(status.notices({ spell: false, grammar: true }).map((n) => n.kind), ["grammar"]);
  });

  it("forgets one check or both on reset", () => {
    const status = new ProofStatus();
    status.report("spell", "s");
    status.report("grammar", "g");
    status.reset("spell");
    assert.deepEqual(status.notices(both).map((n) => n.kind), ["grammar"]);
    status.reset();
    assert.deepEqual(status.notices(both), []);
  });
});

describe("retrying a proofing service that failed to load", () => {
  it("waits at least what the server asked, plus a second, and never less than five seconds", () => {
    const r = new Recovery();
    assert.equal(r.plan("spell", 15), 16000);
    assert.equal(r.plan("spell", 0), 6000);
    assert.equal(r.plan("spell", undefined), 6000);
    assert.equal(r.plan("spell", 9999), 301000);                     // bounded above as well
  });

  it("stops after the limit and says so, and counts each check on its own", () => {
    const r = new Recovery();
    for (let i = 0; i < RECOVERY_LIMIT; i++) assert.notEqual(r.plan("grammar", 5), null);
    assert.equal(r.plan("grammar", 5), null);
    assert.equal(r.exhausted("grammar"), true);
    assert.equal(r.exhausted("spell"), false);
    assert.notEqual(r.plan("spell", 5), null);
  });

  it("starts the count again after a reset (button, setting, language, success)", () => {
    const r = new Recovery();
    for (let i = 0; i < RECOVERY_LIMIT; i++) r.plan("spell", 5);
    r.reset("spell");
    assert.equal(r.exhausted("spell"), false);
    assert.notEqual(r.plan("spell", 5), null);
    r.reset();
    assert.equal(r.exhausted("spell"), false);
  });

  it("reads the pause from an error's details or an answer, and ignores anything else", () => {
    assert.equal(retryAfterOf({ retryAfter: 12 }), 12);
    assert.equal(retryAfterOf({ retryAfter: null }), null);
    assert.equal(retryAfterOf({ retryAfter: "soon" }), null);
    assert.equal(retryAfterOf({ retryAfter: -3 }), null);
    assert.equal(retryAfterOf(undefined), null);
    assert.equal(retryAfterOf("x"), null);
  });
});
