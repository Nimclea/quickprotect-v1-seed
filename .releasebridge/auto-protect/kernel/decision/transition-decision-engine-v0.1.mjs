/**
 * Vibe Cliff K4 Deterministic Transition Decision Engine v0.1
 *
 * Input axes: State + Identity + Scope + Evidence + Authority.
 * Output: PRESERVE / REPROVE / STOP / UNKNOWN.
 */

import crypto from "node:crypto";
import { classifyFailure } from "./failure-classifier-v0.1.mjs";
import { qualifiesPositiveProof } from "../proof/proof-runtime-v0.1.mjs";

const OUTCOME = Object.freeze({
  PRESERVE: "PRESERVE",
  REPROVE: "REPROVE",
  STOP: "STOP",
  UNKNOWN: "UNKNOWN",
});

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha(text) {
  return crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex").toUpperCase();
}

function claimDisposition(scope, claimId) {
  const id = String(claimId || "");
  if ((scope?.affected || []).map(String).includes(id)) return "AFFECTED";
  if ((scope?.unaffected || []).map(String).includes(id)) return "UNAFFECTED";
  if ((scope?.unknown || []).map(String).includes(id)) return "UNKNOWN";
  return "NOT_BOUND";
}

function receipt(input, outcome, reasonCode) {
  const core = {
    schema: "NIMCLEA_O_VIBE_CLIFF_TRANSITION_DECISION_V0_1",
    state_object_id: String(input?.state?.object_id || ""),
    claim_id: String(input?.state?.claim_id || input?.state?.object_id || ""),
    outcome,
    reason_code: reasonCode,
    input_digest: sha(stable({
      state: input?.state || null,
      identity: input?.identity || null,
      scope: input?.scope || null,
      evidence: input?.evidence || null,
      authority: input?.authority || null,
    })),
  };

  return {
    ...core,
    decision_id: sha(stable(core)),
  };
}

export function decideTransition(input) {
  if (!input?.state || !input?.identity || !input?.scope || !input?.evidence || !input?.authority) {
    return receipt(input || {}, OUTCOME.UNKNOWN, "DECISION_INPUT_INCOMPLETE");
  }

  if (input.identity.current !== true) {
    return receipt(input, OUTCOME.UNKNOWN, "IDENTITY_NOT_CURRENT");
  }

  if (input.scope.scope_status === "PARTITION_REQUIRED") {
    return receipt(input, OUTCOME.STOP, "PARTITION_REQUIRED");
  }
  if (input.scope.scope_status === "STOP_NO_INFO_GAIN") {
    return receipt(input, OUTCOME.STOP, "NEXT_QUERY_DOES_NOT_SHRINK_CONE");
  }

  const claimId = String(input.state.claim_id || input.state.object_id || "");
  const disposition = claimDisposition(input.scope, claimId);

  if (disposition === "UNKNOWN" || disposition === "NOT_BOUND") {
    return receipt(input, OUTCOME.UNKNOWN, "SCOPE_UNKNOWN");
  }

  if (input.authority.conflict === true) {
    return receipt(input, OUTCOME.STOP, "AUTHORITY_CONFLICT");
  }
  if (input.authority.current !== true) {
    return receipt(input, OUTCOME.UNKNOWN, "AUTHORITY_NOT_CURRENT");
  }

  const failure = classifyFailure(input.evidence);

  if (
    input.evidence.ab_test === true &&
    input.evidence.positive_source !== true
  ) {
    return receipt(input, OUTCOME.UNKNOWN, "NON_ADJUDICATIVE_CAUSE_NOT_PROVEN");
  }

  if (
    input.evidence.causal_closed === true &&
    input.evidence.mining_requested === true
  ) {
    return receipt(input, OUTCOME.STOP, "ROOT_CAUSE_MINING_FORBIDDEN_AFTER_CAUSAL_CLOSE");
  }

  if (
    input.evidence.full_proof === true &&
    input.authority.allows_transition !== true
  ) {
    return receipt(input, OUTCOME.STOP, "PROOF_DOES_NOT_IMPLY_PERMISSION");
  }

  if (failure.failure_class === "FAIL_AUTHORITY") {
    return receipt(input, OUTCOME.STOP, "FAIL_AUTHORITY");
  }
  if (failure.failure_class === "FAIL_CURRENTNESS") {
    return receipt(input, OUTCOME.UNKNOWN, "FAIL_CURRENTNESS");
  }

  if (
    ["FAIL_OBSERVER", "FAIL_OPERATOR", "FAIL_FIXTURE", "FAIL_ENVIRONMENT"].includes(
      failure.failure_class
    )
  ) {
    // Preserve earned history without declaring an affected candidate proven.
    return disposition === "UNAFFECTED"
      ? receipt(input, OUTCOME.PRESERVE, "LOW_AUTHORITY_FAILURE_CANNOT_DOWNGRADE_PRODUCT_TRUTH")
      : receipt(input, OUTCOME.REPROVE, "AFFECTED_UNCERTAINTY_REQUIRES_PROOF");
  }

  if (failure.failure_class === "FAIL_UNKNOWN") {
    return receipt(input, OUTCOME.UNKNOWN, "UNCLASSIFIED_FAILURE");
  }

  if (failure.failure_class === "FAIL_PRODUCT") {
    if (failure.product_counterevidence_qualified) {
      return receipt(input, OUTCOME.STOP, "QUALIFIED_PRODUCT_CONTRADICTION");
    }

    if (disposition === "UNAFFECTED") {
      return receipt(input, OUTCOME.PRESERVE, "RAW_FAIL_CANNOT_REVOKE_UNAFFECTED_TRUTH");
    }
    return receipt(input, OUTCOME.REPROVE, "PRODUCT_FAIL_NOT_QUALIFIED_FOR_REVOCATION");
  }

  if (disposition === "UNAFFECTED") {
    return receipt(input, OUTCOME.PRESERVE, "UNAFFECTED_PREFIX_INHERITS");
  }

  if (
    input.evidence.result === "PASS" &&
    input.evidence.full_proof === true &&
    input.authority.allows_transition === true &&
    qualifiesPositiveProof(input.evidence, { identity: input.identity, scope: input.scope, claim_id: claimId })
  ) {
    return receipt(input, OUTCOME.PRESERVE, "AFFECTED_CLAIM_REPROVEN_CURRENT");
  }

  return receipt(input, OUTCOME.REPROVE, "AFFECTED_UNCERTAINTY_REQUIRES_PROOF");
}
