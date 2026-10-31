/**
 * Vibe Cliff K4 Failure Classifier v0.1
 * Pure classification only. No mutation and no trust-state write.
 */

const KNOWN = new Set([
  "FAIL_PRODUCT",
  "FAIL_AUTHORITY",
  "FAIL_CURRENTNESS",
  "FAIL_OBSERVER",
  "FAIL_OPERATOR",
  "FAIL_FIXTURE",
  "FAIL_ENVIRONMENT",
]);

export function classifyFailure(evidence) {
  if (!evidence || evidence.result !== "FAIL") {
    return { failure_class: null, product_counterevidence_qualified: false };
  }

  const failureClass = String(evidence.failure_class || "");
  if (!KNOWN.has(failureClass)) {
    return {
      failure_class: "FAIL_UNKNOWN",
      product_counterevidence_qualified: false,
    };
  }

  return {
    failure_class: failureClass,
    product_counterevidence_qualified:
      failureClass === "FAIL_PRODUCT" &&
      evidence.qualified_contradiction === true &&
      evidence.positive_source === true,
  };
}
