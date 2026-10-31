/**
 * Vibe Cliff K5 Deterministic Proof Runtime v0.1
 *
 * Executes repo-owned adapters supplied by the caller. The runtime itself
 * does not mutate governed state or infer authority.
 */
import crypto from "node:crypto";

const RECIPE_TYPES = new Set([
  "COUNTERFACTUAL_PROOF",
  "NARROW_DELTA_PROOF",
  "NATURAL_PATH_PROOF",
  "REPLAY_PROOF",
  "NEGATIVE_CONTROL",
]);

export class ProofRuntimeError extends Error {
  constructor(reasonCode, details = "") {
    super(details ? `${reasonCode}:${details}` : reasonCode);
    this.reason_code = reasonCode;
    this.details = details;
  }
}

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

function classifyAdapterResult(result) {
  const failureClass = String(result?.failure_class || "");
  const valid = new Set([
    "",
    "FAIL_PRODUCT",
    "FAIL_AUTHORITY",
    "FAIL_CURRENTNESS",
    "FAIL_OBSERVER",
    "FAIL_OPERATOR",
    "FAIL_FIXTURE",
    "FAIL_ENVIRONMENT",
  ]);
  if (!valid.has(failureClass)) return "FAIL_UNKNOWN";
  return failureClass;
}

export function executeProofRecipe(recipe, context, adapterRegistry) {
  if (!recipe || !RECIPE_TYPES.has(String(recipe.type || ""))) {
    throw new ProofRuntimeError("PROOF_RECIPE_TYPE_UNSUPPORTED");
  }
  if (!recipe.id || !recipe.adapter_id) {
    throw new ProofRuntimeError("PROOF_RECIPE_IDENTITY_INVALID");
  }
  if (!context?.identity?.identity_id || context.identity.current !== true) {
    throw new ProofRuntimeError("PROOF_INPUT_IDENTITY_NOT_CURRENT");
  }
  if (!context?.scope || !context?.environment) {
    throw new ProofRuntimeError("PROOF_CONTEXT_INCOMPLETE");
  }

  const adapter = adapterRegistry?.[recipe.adapter_id];
  if (!adapter || adapter.owner !== "REPO_OWNED" || typeof adapter.execute !== "function") {
    throw new ProofRuntimeError("PROOF_ADAPTER_NOT_REPO_OWNED");
  }

  const inputBinding = {
    recipe_id: String(recipe.id),
    recipe_type: String(recipe.type),
    adapter_id: String(recipe.adapter_id),
    identity_id: String(context.identity.identity_id),
    revision: String(context.identity.revision || ""),
    scene: String(context.identity.scene || ""),
    scope: context.scope,
    environment: String(context.environment),
    recipe_input: recipe.input || null,
  };

  const adapterInput = JSON.parse(JSON.stringify(inputBinding));
  let raw;
  try {
    raw = adapter.execute(adapterInput);
  } catch (e) {
    return evidenceRecord(
      inputBinding,
      recipe,
      adapter,
      {
        result: "FAIL",
        failure_class: "FAIL_OPERATOR",
        output: { adapter_exception: String(e?.message || e) },
        non_interference: true,
        cost_units: Number(recipe.cost_units || 0),
      }
    );
  }

  if (!raw || !["PASS", "FAIL"].includes(String(raw.result || ""))) {
    throw new ProofRuntimeError("PROOF_ADAPTER_RESULT_INVALID");
  }

  return evidenceRecord(inputBinding, recipe, adapter, {
    result: String(raw.result),
    failure_class: classifyAdapterResult(raw),
    output: raw.output ?? null,
    positive_source: raw.positive_source === true,
    non_interference: raw.non_interference === true,
    cost_units:
      Number.isFinite(Number(raw.cost_units))
        ? Number(raw.cost_units)
        : Number(recipe.cost_units || 0),
  });
}

function evidenceRecord(inputBinding, recipe, adapter, result) {
  const provenance = {
    recipe_id: String(recipe.id),
    recipe_type: String(recipe.type),
    adapter_id: String(recipe.adapter_id),
    adapter_owner: String(adapter.owner),
    adapter_version: String(adapter.version || ""),
    input_digest: sha(stable(inputBinding)),
  };

  const core = {
    schema: "NIMCLEA_O_VIBE_CLIFF_EVIDENCE_RECORD_V0_1",
    producer: `PROOF_RUNTIME:${recipe.adapter_id}`,
    input_identity: {
      identity_id: inputBinding.identity_id,
      revision: inputBinding.revision,
      scene: inputBinding.scene,
    },
    environment: inputBinding.environment,
    result: result.result,
    failure_class: result.failure_class,
    output: result.output,
    positive_source: result.positive_source === true,
    proof_binding: inputBinding,
    provenance,
    currentness: "CURRENT_AT_EXECUTION",
    non_interference: result.non_interference,
    cost: {
      unit: "K5_DETERMINISTIC_COST_UNIT",
      value: result.cost_units,
    },
  };

  return {
    ...core,
    evidence_id: sha(stable(core)),
  };
}

// A completion flag is not proof. Consume the bound K5 record and its
// claim-specific positive result, retaining negative controls as separate evidence.
export function qualifiesPositiveProof(evidence, { identity, scope, claim_id }) {
  if (!evidence || evidence.schema !== "NIMCLEA_O_VIBE_CLIFF_EVIDENCE_RECORD_V0_1") return false;
  const positiveRecipes = new Set(["COUNTERFACTUAL_PROOF", "NARROW_DELTA_PROOF", "NATURAL_PATH_PROOF", "REPLAY_PROOF"]);
  const p = evidence.provenance, b = evidence.proof_binding;
  if (!p || !b || !positiveRecipes.has(p.recipe_type) || evidence.positive_source !== true ||
      evidence.result !== "PASS" || evidence.failure_class !== "" || evidence.non_interference !== true ||
      evidence.currentness !== "CURRENT_AT_EXECUTION" || p.adapter_owner !== "REPO_OWNED" ||
      !p.adapter_version || evidence.producer !== `PROOF_RUNTIME:${p.adapter_id}` ||
      p.recipe_id !== b.recipe_id || p.recipe_type !== b.recipe_type || p.adapter_id !== b.adapter_id ||
      p.input_digest !== sha(stable(b)) || evidence.environment !== b.environment ||
      identity?.current !== true || !identity.identity_id || !identity.revision || !identity.scene ||
      b.identity_id !== identity.identity_id || b.revision !== identity.revision || b.scene !== identity.scene ||
      stable(evidence.input_identity) !== stable({identity_id:b.identity_id,revision:b.revision,scene:b.scene}) ||
      stable(b.scope) !== stable(scope) || !Array.isArray(b.recipe_input?.claims) ||
      !b.recipe_input.claims.includes(claim_id) || !Array.isArray(evidence.output?.proven_claims) ||
      !evidence.output.proven_claims.includes(claim_id)) return false;
  const core = {
    schema:evidence.schema, producer:evidence.producer, input_identity:evidence.input_identity,
    environment:evidence.environment, result:evidence.result, failure_class:evidence.failure_class,
    output:evidence.output, positive_source:evidence.positive_source, proof_binding:b,
    provenance:p, currentness:evidence.currentness, non_interference:evidence.non_interference, cost:evidence.cost,
  };
  return evidence.evidence_id === sha(stable(core));
}
