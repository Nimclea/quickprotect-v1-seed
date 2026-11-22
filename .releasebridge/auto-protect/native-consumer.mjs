import { spawnSync } from 'node:child_process';

export const REPOSITORY = 'Nimclea/quickprotect-v1-seed';
export const REPOSITORY_ID = 1440488291;
export const CLAIM = 'candidate-eligible-for-agent-freeze';
const SHA = /^[a-f0-9]{40}$/;
const PRODUCT = 'src/quickprotect-seed.js';
const PRODUCT_BLOB = 'e638835ea64f09a8ea8f9f92a5b94b9d079cc760';
const CONTROLS = ['.releasebridge/freeze-policy.json', '.releasebridge/verify-pr.cjs',
  '.github/workflows/releasebridge-freeze.yml'];

export function protectedPaths(policy) {
  if (policy?.schema !== 'RELEASEBRIDGE_PR_FREEZE_POLICY_V1' || policy.repo !== REPOSITORY ||
      policy.base_ref !== 'main' || policy.protected_paths?.length !== 1 ||
      policy.protected_paths[0].path !== PRODUCT || policy.protected_paths[0].blob !== PRODUCT_BLOB) {
    throw Error('POLICY_CONTRACT_INVALID');
  }
  return [PRODUCT, ...CONTROLS];
}

// Reuse QuickProtect's trusted-base, exact-object inspection. Fetching is opt-in
// for the trusted Actions checkout. Candidate files are never checked out or run.
export function inspectHistory({ cwd = process.cwd(), base, head, policy, fetchCandidate = false }) {
  const protectedSet = new Set(protectedPaths(policy));
  const binding = { base, candidate: head };
  if (!SHA.test(base) || !SHA.test(head)) return { ...binding, status: 'UNKNOWN', why: 'HISTORY_BINDING_INVALID' };
  const git = (...args) => {
    const r = spawnSync('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 4_000_000, windowsHide: true,
    });
    if (r.status !== 0) {
      const error = Error('NATIVE_HISTORY_UNAVAILABLE'); error.status = r.status; throw error;
    }
    return r.stdout.trim();
  };
  try {
    if (git('rev-parse', '--is-shallow-repository') !== 'false') {
      return { ...binding, status: 'UNKNOWN', why: 'SHALLOW_HISTORY_UNVERIFIED' };
    }
    if (fetchCandidate) {
      if (git('rev-parse', 'HEAD') !== base) throw Error('TRUSTED_BASE_CHECKOUT_REQUIRED');
      // Fixed repository and validated SHA: no candidate-controlled URL or shell.
      git('fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head',
        '--no-auto-maintenance', 'https://github.com/' + REPOSITORY + '.git', head);
    }
    if (git('rev-parse', base + '^{commit}') !== base ||
        git('rev-parse', head + '^{commit}') !== head) throw Error('HISTORY_COMMIT_REQUIRED');
    if (git('rev-parse', base + ':' + PRODUCT) !== PRODUCT_BLOB) {
      return { ...binding, status: 'STOP', why: 'BASELINE_BLOB_CURRENTNESS' };
    }
    try { git('merge-base', '--is-ancestor', base, head); }
    catch (err) {
      if (err.status === 1) return { ...binding, status: 'STOP', why: 'BASE_NOT_ANCESTOR' };
      throw err;
    }
    const commits = git('rev-list', '--reverse', '--max-count=101', base + '..' + head).split(/\s+/).filter(Boolean);
    if (!commits.length || commits.length > 100) return { ...binding, status: 'STOP', why: 'COMMIT_COUNT' };
    for (const commit of commits) {
      const parents = git('rev-list', '--parents', '-n', '1', commit).split(/\s+/);
      if (parents.length !== 2) return { ...binding, status: 'STOP', why: 'MERGE_COMMIT_NOT_ADMITTED', commit };
      const changed = git('diff-tree', '-r', '--no-renames', '--no-commit-id', '--name-only', '-z', parents[1], commit)
        .split('\0').filter(Boolean);
      const forbidden = changed.filter(p => protectedSet.has(p));
      if (forbidden.length) return { ...binding, status: 'STOP', why: 'FROZEN_PATH_CHANGED', commit, forbidden };
    }
    return { ...binding, status: 'PRESERVED', commits };
  } catch (err) {
    return { ...binding, status: 'UNKNOWN', why: err.message };
  }
}

export function exactBinding(binding) {
  return binding?.repository === REPOSITORY && binding.repository_id === REPOSITORY_ID &&
    Number.isSafeInteger(binding.pr) && binding.pr > 0 && SHA.test(binding.base) && SHA.test(binding.candidate);
}
function sameBinding(a, b) {
  return exactBinding(a) && exactBinding(b) &&
    ['repository', 'repository_id', 'pr', 'base', 'candidate'].every(k => a[k] === b[k]);
}

// A programmatic integration seam for an EXISTING authenticated acceptance provider.
// No provider is installed by this change. Never load providers or authority from PR
// JSON, CI conclusions, environment paths, or candidate code. Hashes are not authentication.
export async function readAcceptance(readQualifiedAcceptance, binding) {
  if (!readQualifiedAcceptance) return null;
  if (!exactBinding(binding)) throw Error('ACCEPTANCE_BINDING_INVALID');
  const accepted = await readQualifiedAcceptance(Object.freeze({ ...binding }));
  if (!accepted) return null;
  if (!sameBinding(accepted.binding, binding)) throw Error('ACCEPTANCE_BINDING_MISMATCH');
  return JSON.parse(JSON.stringify(accepted));
}

const NEXT = {
  PARTITION_REQUIRED: 'Partition the affected scope before requesting more proof.',
  NEXT_QUERY_DOES_NOT_SHRINK_CONE: 'Stop this query sequence; identify a query that reduces uncertainty.',
  ROOT_CAUSE_MINING_FORBIDDEN_AFTER_CAUSAL_CLOSE: 'Keep causal closure; do not resume root-cause mining.',
  PROOF_DOES_NOT_IMPLY_PERMISSION: 'Obtain applicable transition permission from the existing authority.',
  QUALIFIED_PRODUCT_CONTRADICTION: 'Resolve the qualified product contradiction before advancing this candidate.',
  FAIL_AUTHORITY: 'Resolve the authority failure through the existing authority.',
  AUTHORITY_CONFLICT: 'Resolve the existing authority conflict before advancing this candidate.',
  AUTHORITY_NOT_CURRENT: 'Obtain current authority for this exact candidate.',
  IDENTITY_NOT_CURRENT: 'Revalidate the acceptance identity against the fresh PR, base, and exact candidate.',
  ACCEPTANCE_BINDING_MISMATCH: 'Obtain authenticated independent code acceptance bound to this exact repository, PR, base, and candidate.',
  ACCEPTANCE_IDENTITY_MISMATCH: 'Obtain independent code acceptance with the exact candidate identity and claim scene.',
  INDEPENDENT_CODE_ACCEPTANCE_MISSING: 'Obtain authenticated independent claim-specific code acceptance and applicable current authority for this exact PR candidate.',
  NON_ADJUDICATIVE_CAUSE_NOT_PROVEN: 'Obtain positive-source evidence; an A/B result alone does not prove cause.',
};

// Projects the original K4 receipt; does not define another transition engine.
export function consumeCandidate(decideTransition, { head, current, files, policy, evidence = [], binding,
  history, acceptance }) {
  const protectedSet = new Set(protectedPaths(policy));
  if (!Array.isArray(files) || files.some(f => typeof f.filename !== 'string' || !SHA.test(f.sha))) {
    throw Error('INCOMPLETE_FILES');
  }
  const forbidden = files.filter(f => [f.filename, f.previous_filename].some(p => protectedSet.has(p)));
  const historyBound = history?.base === binding?.base && history?.candidate === head;
  const denied = forbidden.length > 0 || (historyBound && history.status === 'STOP');
  const accepted = acceptance && sameBinding(acceptance.binding, binding) && binding.candidate === head;
  // Incomplete provider data must not mask the observer's existing protected-path STOP.
  const useAcceptance = accepted && !denied;
  const identity = useAcceptance ? { ...acceptance.identity, current: current === true && acceptance.identity?.current === true } :
    { current: current === true, revision: head };
  const input = {
    state: { object_id: head, claim_id: CLAIM }, identity,
    scope: useAcceptance ? acceptance.scope : { affected: [CLAIM], unaffected: [] },
    evidence: useAcceptance ? acceptance.evidence : { result: 'UNKNOWN', full_proof: false, references: evidence },
    authority: useAcceptance ? { ...acceptance.authority, conflict: acceptance.authority?.conflict === true } :
      { current: false, conflict: current === true && denied, allows_transition: false },
  };
  const receipt = decideTransition(input);
  // Separate attribution from code trust. These claims still come only through the
  // existing trusted provider seam; an authenticated flag in arbitrary JSON is not authentication.
  const agent = acceptance?.agent_provenance;
  const agentConflict = agent?.authenticated === true && (agent.conflict === true ||
    (exactBinding(binding) && exactBinding(agent.binding) && !sameBinding(agent.binding, binding)));
  const agentVerified = agent?.authenticated === true && sameBinding(agent.binding, binding) &&
    typeof agent.reference === 'string' && agent.reference.trim().length > 0;
  const provenance = agentConflict ? 'AGENT_CONFLICT' : agentVerified ? 'AGENT_VERIFIED' : 'AGENT_UNVERIFIED';
  const provenanceNext = agentConflict ?
    'Resolve the authenticated Agent attribution conflict with its source; retain any applicable K4 authority rejection.' :
    agentVerified ? 'Retain the authenticated Agent attribution reference separately from code acceptance.' :
      'Authenticate Agent attribution separately if needed; unverified attribution neither proves nor disproves code acceptance.';
  const identityBound = accepted && identity.revision === head && identity.identity_id ===
    `${REPOSITORY_ID}:pr:${binding.pr}:${head}` && identity.scene === 'github-pr-freeze-proposal';
  const pass = receipt.outcome === 'PRESERVE' && receipt.reason_code === 'AFFECTED_CLAIM_REPROVEN_CURRENT' &&
    identityBound && historyBound && history.status === 'PRESERVED' && !denied;
  const decision = receipt.outcome === 'STOP' ? 'STOP' : pass ? 'PASS' : 'UNKNOWN';
  let why = receipt.reason_code;
  if (!current) why = 'CURRENT_GIT_BINDING_UNVERIFIED';
  else if (denied) why = forbidden.length ? 'PROTECTED_PATH_CHANGED' : history.why;
  else if (!accepted) why = acceptance ? 'ACCEPTANCE_BINDING_MISMATCH' : 'INDEPENDENT_CODE_ACCEPTANCE_MISSING';
  else if (receipt.outcome === 'PRESERVE' && receipt.reason_code === 'AFFECTED_CLAIM_REPROVEN_CURRENT') {
    why = !identityBound ? 'ACCEPTANCE_IDENTITY_MISMATCH' :
      !historyBound || history.status !== 'PRESERVED' ? 'NATIVE_HISTORY_UNVERIFIED' : receipt.reason_code;
  }
  const next = !current ? 'Read a fresh PR and base branch; revalidate the exact candidate after evidence collection.' :
    denied ? 'Do not advance this forbidden candidate; retain the protected baseline and every-commit restrictions.' :
    pass ? 'Obtain qualified acceptance binding the new path and Git blob before any Freeze proposal can be generated.' :
    NEXT[why] || (why === 'NATIVE_HISTORY_UNVERIFIED' ? 'Supply complete native base and candidate Git objects; rerun the bounded history inspection.' :
      'Obtain authenticated independent claim-specific code proof and applicable current authority for this exact PR candidate.');
  // No qualified target-acceptance contract exists in this seed. Neither old
  // policy targets, PR files nor caller-invented target fields establish it.
  const proposal = null;
  return { decision, why, next, original_k4: receipt, agent_provenance: provenance,
    agent_provenance_next: provenanceNext,
    proposal_status: 'UNAVAILABLE_ACCEPTED_TARGET_BINDING',
    proposal, changed_paths: files.map(f => f.filename), evidence, history: history ?? null,
    qualified_evidence: useAcceptance ? acceptance.evidence : null };
}
