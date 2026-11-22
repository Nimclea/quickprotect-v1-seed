import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifySource, classify, main, renderDecisionCard } from './event-adapter.mjs';
import { inspectHistory, readAcceptance, CLAIM, REPOSITORY, REPOSITORY_ID } from './native-consumer.mjs';

verifySource();
const { decideTransition } = await import('./kernel/decision/transition-decision-engine-v0.1.mjs');
const { executeProofRecipe } = await import('./kernel/proof/proof-runtime-v0.1.mjs');
const root = fileURLToPath(new URL('../../', import.meta.url));
const workspace = path.resolve(root);
const dir = fs.mkdtempSync(path.join(workspace, '.auto-protect-test-'));
const policy = JSON.parse(fs.readFileSync(new URL('../freeze-policy.json', import.meta.url)));
function git(...args) {
  const r = spawnSync('git', ['-c', 'user.name=Native Fixture', '-c', 'user.email=fixture@invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
  { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function commit(message) { git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); }
git('init', '-q');
fs.mkdirSync(path.join(dir, 'src'));
const product = fs.readFileSync(path.join(workspace, 'src/quickprotect-seed.js'));
fs.writeFileSync(path.join(dir, 'src/quickprotect-seed.js'), product);
const base = commit('Synthetic fixture baseline');
fs.writeFileSync(path.join(dir, 'allowed.txt'), 'synthetic allowed delta\n');
const head = commit('Synthetic allowed candidate');
const history = inspectHistory({ cwd: dir, base, head, policy });
const binding = { repository: REPOSITORY, repository_id: REPOSITORY_ID, pr: 7, base, candidate: head };
const snapshots = {};
function accepted() {
  const identity = { identity_id: `${REPOSITORY_ID}:pr:7:${head}`, revision: head,
    scene: 'github-pr-freeze-proposal', current: true };
  const scope = { affected: [CLAIM], unaffected: [] };
  // Deliberately synthetic. Tests exercise the original runtime, not real product acceptance.
  const record = executeProofRecipe({ id: 'synthetic-recipe', type: 'NARROW_DELTA_PROOF',
    adapter_id: 'synthetic-test-only', input: { claims: [CLAIM] } },
  { identity, scope, environment: 'NATIVE_SYNTHETIC_TEST_ONLY' }, {
    'synthetic-test-only': { owner: 'REPO_OWNED', version: 'test-only', execute: () => ({
      result: 'PASS', positive_source: true, non_interference: true, output: { proven_claims: [CLAIM] },
    }) },
  });
  return { binding: { ...binding }, identity, scope, evidence: { ...record, full_proof: true },
    authority: { current: true, conflict: false, allows_transition: true },
    agent_provenance: { authenticated: true, binding: { ...binding }, reference: 'synthetic:test-only' } };
}
const files = [{ filename: 'allowed.txt', sha: 'a'.repeat(40) }];
function consume(acceptance = accepted(), overrides = {}) {
  return classify(decideTransition, { head, current: true, files, policy, evidence: [], binding, history, acceptance, ...overrides });
}
after(() => {
  const output = new URL('./evidence/', import.meta.url);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(new URL('native-observation-synthetic-receipts.json', output), JSON.stringify({
    evidence_kind: 'NATIVE_EXECUTION_WITH_SYNTHETIC_PR_AND_ACCEPTANCE',
    real_product_acceptance: false, live_github_currentness: false,
    original_source: verifySource(), snapshots,
  }, null, 2) + '\n');
  const resolved = path.resolve(dir);
  assert.equal(path.dirname(resolved), workspace);
  assert.ok(path.basename(resolved).startsWith('.auto-protect-test-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});

test('original modules remain pinned; allowed native history is preserved', () => {
  assert.equal(Object.keys(verifySource().modules).length, 3);
  assert.equal(history.status, 'PRESERVED');
  assert.deepEqual(history.commits, [head]);
});
test('qualified synthetic record retains original K4 receipt but cannot supply proposal targets', () => {
  const r = consume();
  snapshots.qualified_synthetic = r;
  assert.equal(r.decision, 'PASS');
  assert.equal(r.agent_provenance, 'AGENT_VERIFIED');
  assert.equal(r.original_k4.reason_code, 'AFFECTED_CLAIM_REPROVEN_CURRENT');
  assert.equal(r.proposal, null);
  assert.equal(r.proposal_status, 'UNAVAILABLE_ACCEPTED_TARGET_BINDING');
});
test('CI success without acceptance remains UNKNOWN', () => {
  const r = consume(null, { evidence: [{ checks: [{ conclusion: 'success', head_sha: head }] }] });
  snapshots.ci_only = r;
  assert.equal(r.decision, 'UNKNOWN'); assert.equal(r.proposal, null);
});
test('full proof boolean and CI-shaped evidence do not qualify', () => {
  const a = accepted(); a.evidence = { result: 'PASS', full_proof: true };
  const r = consume(a);
  assert.equal(r.decision, 'UNKNOWN'); assert.equal(r.agent_provenance, 'AGENT_VERIFIED');
  assert.equal(r.proposal, null);
  snapshots.verified_agent_without_code_proof = r;
});
test('qualified code with unverified or absent Agent provenance preserves K4 independently', () => {
  const original = consume().original_k4;
  for (const mutate of [a => { a.agent_provenance.authenticated = false; },
    a => { delete a.agent_provenance; }, a => { delete a.agent_provenance.reference; },
    a => { a.agent_provenance.reference = ' '; }, a => { delete a.agent_provenance.binding; }]) {
    const a = accepted(); mutate(a); const r = consume(a);
    assert.equal(r.decision, 'PASS'); assert.equal(r.agent_provenance, 'AGENT_UNVERIFIED');
    assert.deepEqual(r.original_k4, original);
    assert.equal(r.proposal, null);
    snapshots.unverified_agent_qualified_code = r;
  }
});
test('missing provenance reference cannot rescue missing code proof', () => {
  const a = accepted(); delete a.agent_provenance.reference; delete a.evidence;
  const r = consume(a);
  assert.equal(r.decision, 'UNKNOWN'); assert.equal(r.agent_provenance, 'AGENT_UNVERIFIED');
  assert.equal(r.proposal, null);
});
test('authenticated attribution conflicts are explicit and independent of K4 authority', () => {
  for (const mutate of [a => { a.agent_provenance.binding.candidate = base; },
    a => { a.agent_provenance.conflict = true; }]) {
    const a = accepted(); mutate(a);
    const independent = consume(a);
    assert.equal(independent.agent_provenance, 'AGENT_CONFLICT');
    assert.equal(independent.decision, 'PASS');
    assert.equal(independent.proposal, null);
    assert.match(independent.agent_provenance_next, /conflict/);
    a.authority.conflict = true;
    const rejected = consume(a);
    assert.equal(rejected.agent_provenance, 'AGENT_CONFLICT');
    assert.equal(rejected.decision, 'STOP');
    assert.equal(rejected.original_k4.reason_code, 'AUTHORITY_CONFLICT');
    assert.equal(rejected.proposal, null);
    snapshots.agent_conflict_with_authority_rejection = rejected;
  }
});
test('unauthenticated conflicting assertions remain unverified', () => {
  const a = accepted(); a.agent_provenance.authenticated = false;
  a.agent_provenance.conflict = true; a.agent_provenance.binding.candidate = base;
  assert.equal(consume(a).agent_provenance, 'AGENT_UNVERIFIED');
});
test('missing, stale, denied and conflicting authority never permits PASS', () => {
  for (const authority of [undefined, {}, { current: false, allows_transition: true },
    { current: true, allows_transition: false }, { current: true, allows_transition: true, conflict: true }]) {
    for (const authenticated of [true, false]) {
      const a = accepted(); a.authority = authority; a.agent_provenance.authenticated = authenticated;
      const r = consume(a); assert.notEqual(r.decision, 'PASS'); assert.equal(r.proposal, null);
    }
  }
});
test('unaffected PRESERVE never projects to PASS', () => {
  const a = accepted(); a.scope = { affected: [], unaffected: [CLAIM] };
  const r = consume(a);
  assert.equal(r.original_k4.outcome, 'PRESERVE'); assert.equal(r.decision, 'UNKNOWN'); assert.equal(r.proposal, null);
});
test('tampered proof digest, negative control, wrong claim and wrong revision cannot pass', () => {
  for (const mutate of [
    a => { a.evidence.evidence_id = 'forged'; },
    a => { a.evidence.provenance.recipe_type = 'NEGATIVE_CONTROL'; },
    a => { a.evidence.output.proven_claims = ['another-claim']; },
    a => { a.identity.revision = 'b'.repeat(40); },
  ]) { const a = accepted(); mutate(a); assert.equal(consume(a).decision, 'UNKNOWN'); }
});
test('wrong PR, base, candidate and identity acceptance bindings cannot pass', () => {
  for (const mutate of [a => { a.binding.pr++; }, a => { a.binding.candidate = base; },
    a => { a.binding.base = head; }, a => { a.identity.identity_id = 'wrong'; }]) {
    for (const authenticated of [true, false]) {
      const a = accepted(); mutate(a); a.agent_provenance.authenticated = authenticated;
      assert.equal(consume(a).decision, 'UNKNOWN');
    }
  }
});
test('missing, stale and foreign history prevent a qualified PASS', () => {
  for (const h of [undefined, { ...history, status: 'UNKNOWN' }, { ...history, candidate: base }]) {
    const r = consume(accepted(), { history: h }); assert.equal(r.decision, 'UNKNOWN'); assert.equal(r.proposal, null);
  }
});
test('stale currentness stays UNKNOWN even for a protected change', () => {
  const r = consume(accepted(), { current: false, files: [{ filename: 'src/quickprotect-seed.js', sha: head }] });
  assert.equal(r.decision, 'UNKNOWN'); assert.equal(r.original_k4.reason_code, 'IDENTITY_NOT_CURRENT');
});
test('protected net change and rename source retain STOP', () => {
  for (const f of [{ filename: 'src/quickprotect-seed.js', sha: head },
    { filename: 'moved.js', previous_filename: '.releasebridge/verify-pr.cjs', sha: head }]) {
    const r = consume(null, { files: [f] }); assert.equal(r.decision, 'STOP'); assert.equal(r.proposal, null);
  }
});
test('incomplete provider scope cannot mask a protected-path STOP', () => {
  const a = accepted(); delete a.scope;
  const r = consume(a, { files: [{ filename: 'src/quickprotect-seed.js', sha: head }] });
  assert.equal(r.decision, 'STOP'); assert.equal(r.original_k4.reason_code, 'AUTHORITY_CONFLICT');
});
for (const [reason, mutate] of [
  ['PARTITION_REQUIRED', a => { a.scope.scope_status = 'PARTITION_REQUIRED'; }],
  ['NEXT_QUERY_DOES_NOT_SHRINK_CONE', a => { a.scope.scope_status = 'STOP_NO_INFO_GAIN'; }],
  ['ROOT_CAUSE_MINING_FORBIDDEN_AFTER_CAUSAL_CLOSE', a => { a.evidence.causal_closed = true; a.evidence.mining_requested = true; }],
  ['PROOF_DOES_NOT_IMPLY_PERMISSION', a => { a.authority.allows_transition = false; }],
  ['FAIL_AUTHORITY', a => { a.evidence.result = 'FAIL'; a.evidence.failure_class = 'FAIL_AUTHORITY'; }],
  ['QUALIFIED_PRODUCT_CONTRADICTION', a => { a.evidence.result = 'FAIL'; a.evidence.failure_class = 'FAIL_PRODUCT'; a.evidence.qualified_contradiction = true; }],
  ['AUTHORITY_CONFLICT', a => { a.authority.conflict = true; }],
]) test(`original historical STOP: ${reason}`, () => {
  for (const provenance of ['verified', 'unverified', 'conflict']) {
    const a = accepted(); mutate(a);
    if (provenance === 'unverified') delete a.agent_provenance;
    if (provenance === 'conflict') a.agent_provenance.conflict = true;
    const r = consume(a);
    snapshots[reason + '_' + provenance] = r;
    assert.equal(r.decision, 'STOP'); assert.equal(r.original_k4.reason_code, reason);
    assert.equal(r.proposal, null); assert.ok(r.next.length > 20);
  }
});
test('NEXT separates missing code, history, stale candidate and Agent attribution', () => {
  const a = accepted(); delete a.agent_provenance;
  const missingCode = consume(null);
  const missingHistory = consume(a, { history: undefined });
  const stale = consume(a, { current: false });
  const qualified = consume(a);
  assert.equal(missingCode.why, 'INDEPENDENT_CODE_ACCEPTANCE_MISSING');
  assert.match(missingCode.next, /code acceptance/);
  assert.equal(missingHistory.why, 'NATIVE_HISTORY_UNVERIFIED');
  assert.match(missingHistory.next, /Git objects/);
  assert.match(stale.next, /fresh PR/);
  assert.match(qualified.next, /qualified acceptance binding the new path and Git blob/);
  for (const r of [missingCode, missingHistory, stale, qualified]) {
    assert.doesNotMatch(r.next, /Agent|provenance/);
    assert.match(r.agent_provenance_next, /Authenticate Agent attribution separately/);
  }
});
test('A/B-only source and low-authority failures do not become PASS', () => {
  for (const failure_class of ['FAIL_OBSERVER', 'FAIL_OPERATOR', 'FAIL_FIXTURE', 'FAIL_ENVIRONMENT', 'FAIL_CURRENTNESS', 'UNKNOWN']) {
    const a = accepted(); a.evidence.result = 'FAIL'; a.evidence.failure_class = failure_class;
    assert.equal(consume(a).decision, 'UNKNOWN');
  }
  const a = accepted(); a.evidence.ab_test = true; a.evidence.positive_source = false;
  assert.equal(consume(a).original_k4.reason_code, 'NON_ADJUDICATIVE_CAUSE_NOT_PROVEN');
});
test('mutated policy cannot relocate the protected boundary', () => {
  const p = structuredClone(policy); p.protected_paths[0].path = 'allowed.txt';
  assert.throws(() => consume(null, { policy: p }), /POLICY_CONTRACT_INVALID/);
});
test('provider has no implicit authority and must return the exact binding', async () => {
  assert.equal(await readAcceptance(undefined, binding), null);
  await assert.rejects(readAcceptance(async () => ({ ...accepted(), binding: { ...binding, pr: 8 } }), binding), /ACCEPTANCE_BINDING_MISMATCH/);
});

async function replay({ provider, stale = false, fail = false, ciFail = false, summary = false,
  candidate = head, observedFiles = files, historyCwd = dir, action = 'synchronize' } = {}) {
  const pr = { number: 7, state: 'open', changed_files: 1,
    base: { ref: 'main', sha: base, repo: { id: REPOSITORY_ID } }, head: { sha: candidate, repo: { id: REPOSITORY_ID } } };
  const eventPath = path.join(dir, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify({ action, number: 7,
    repository: { id: REPOSITORY_ID, full_name: REPOSITORY }, pull_request: pr }));
  let prReads = 0;
  return main({ env: { GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_REPOSITORY: REPOSITORY,
      ...(summary ? { GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md') } : {}) },
    cwd: historyCwd, emit: false, readQualifiedAcceptance: provider,
    read: async route => {
      if (fail) throw Error('SYNTHETIC_TRANSPORT_FAILURE');
      if (route === 'pulls/7') { prReads++; return stale && prReads === 2 ? { ...pr, state: 'closed' } : pr; }
      if (route.includes('/files?')) return observedFiles;
      if (route === 'branches/main') return { commit: { sha: base } };
      if (route.includes('/check-runs?')) {
        if (ciFail) throw Error('SYNTHETIC_CI_UNAVAILABLE');
        return { total_count: 1, check_runs: [{ id: 1, head_sha: candidate, conclusion: 'success' }] };
      }
      throw Error('UNEXPECTED_TEST_ROUTE');
    } });
}
test('existing PR entry point executes original K4 with synthetic provider without a proposal', async () => {
  const r = await replay({ provider: async () => accepted() });
  snapshots.pr_entry_point = r;
  assert.equal(r.decision, 'PASS'); assert.equal(r.proposal, null);
  assert.equal(r.freeze_proposal_eligible, false);
});
test('existing PR entry point with green CI and no provider stays UNKNOWN', async () => {
  const r = await replay(); assert.equal(r.decision, 'UNKNOWN'); assert.equal(r.proposal, null);
});
test('existing PR entry point accepts qualified synthetic code with no Agent provenance', async () => {
  const r = await replay({ provider: async () => { const a = accepted(); delete a.agent_provenance; return a; } });
  assert.equal(r.decision, 'PASS'); assert.equal(r.agent_provenance, 'AGENT_UNVERIFIED');
  assert.equal(r.proposal, null);
  snapshots.pr_entry_point_unverified_agent = r;
});
test('PR changing during provider execution invalidates the proposal', async () => {
  const r = await replay({ provider: async () => accepted(), stale: true });
  assert.equal(r.decision, 'UNKNOWN'); assert.equal(r.proposal, null);
});
test('provider and transport failures fail closed', async () => {
  for (const opts of [{ fail: true }, { provider: async () => { throw Error('PROVIDER_UNAVAILABLE'); } }]) {
    const r = await replay(opts); assert.equal(r.decision, 'UNKNOWN'); assert.equal(r.proposal, null);
  }
});
test('native Git detects protected change even after a revert leaves net diff clean', () => {
  fs.writeFileSync(path.join(dir, 'src/quickprotect-seed.js'), 'forbidden synthetic change\n');
  const changed = commit('Synthetic forbidden product edit');
  fs.writeFileSync(path.join(dir, 'src/quickprotect-seed.js'), product);
  const reverted = commit('Synthetic revert');
  assert.equal(git('diff', base, reverted, '--', 'src/quickprotect-seed.js'), '');
  const h = inspectHistory({ cwd: dir, base, head: reverted, policy });
  assert.equal(h.status, 'STOP'); assert.equal(h.why, 'FROZEN_PATH_CHANGED'); assert.equal(h.commit, changed);
  const r = consume(null, { head: reverted, binding: { ...binding, candidate: reverted }, history: h });
  snapshots.change_then_revert = r;
  assert.equal(r.decision, 'STOP'); assert.equal(r.proposal, null);
});

test('old policy targets, PR diff and invented acceptance target fields cannot create proposals', () => {
  const a = accepted();
  a.targets = [{ path: 'allowed.txt', blob: git('rev-parse', head + ':allowed.txt') }];
  a.accepted_paths = a.targets;
  a.protected_paths = policy.protected_paths;
  for (const acceptance of [null, a]) {
    const r = consume(acceptance);
    assert.equal(r.proposal, null);
    assert.equal(r.proposal_status, 'UNAVAILABLE_ACCEPTED_TARGET_BINDING');
  }
});

test('customer card preserves exact identity, compatible outputs and independent provenance', async () => {
  const r = await replay({ summary: true });
  assert.equal(r.exact_candidate_sha, head);
  assert.equal(r.decision, 'UNKNOWN'); assert.equal(r.proposal, null);
  assert.equal(r.next_action, r.next); assert.equal(r.freeze_proposal_eligible, false);
  assert.equal(r.agent_provenance, 'AGENT_UNVERIFIED');
  assert.ok(r.evidence_used.some(x => x.kind === 'NATIVE_GIT_HISTORY' && x.candidate === head));
  assert.ok(r.evidence_missing.includes('QUALIFIED_INDEPENDENT_CODE_ACCEPTANCE_AND_CURRENT_AUTHORITY'));
  assert.ok(r.evidence_missing.includes('QUALIFIED_NEW_PATH_BLOB_ACCEPTANCE'));
  const card = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8');
  for (const field of [head, base, 'PR #7', 'UNKNOWN', 'WHY', 'NEXT', 'Evidence used',
    'Evidence missing', 'Original K4 outcome', 'K4 reason', 'Agent provenance', 'Proposal status']) {
    assert.ok(card.includes(field), field);
  }
  assert.equal(card, renderDecisionCard(r));
  snapshots.customer_observation_without_acceptance = r;
});

test('customer card renders untrusted markup, commands and controls as literal bounded text', () => {
  const hostile = '<script>alert(1)</script>\n|fake| [click](javascript:alert(1)) `code` &lt;img&gt;\r::error::bad\u202e';
  const card = renderDecisionCard({ binding: { pr: hostile }, decision: 'UNKNOWN', why: hostile,
    next: hostile, agent_provenance: hostile, evidence_used: [{ text: hostile }], evidence_missing: [hostile] });
  for (const raw of ['<script>', '|fake|', '[click]', 'javascript:', '`code`', '&lt;img&gt;', '::error::', '\u202e']) {
    assert.ok(!card.includes(raw), raw);
  }
  assert.ok(card.includes('&#60;script&#62;'));
  assert.ok(!card.includes('/pull/'));
  assert.ok(renderDecisionCard({ why: 'x'.repeat(100000) }).length < 10000);
});

test('missing native objects and invalid events remain UNKNOWN with a complete card', async () => {
  for (const options of [{ candidate: 'b'.repeat(40) }, { action: 'untrusted' }, { fail: true }]) {
    const r = await replay(options);
    assert.equal(r.decision, 'UNKNOWN'); assert.equal(r.proposal, null);
    assert.ok(r.evidence_missing.length > 0);
    assert.ok(renderDecisionCard(r).includes('### NEXT'));
  }
});

test('CI outage cannot mask protected-path STOP or promote an allowed candidate', async () => {
  const denied = await replay({ ciFail: true, observedFiles: [{ filename: 'src/quickprotect-seed.js', sha: head }] });
  assert.equal(denied.decision, 'STOP'); assert.equal(denied.original_k4.reason_code, 'AUTHORITY_CONFLICT');
  assert.ok(denied.evidence_missing.includes('CI_CONTEXT_INCOMPLETE'));
  const allowed = await replay({ ciFail: true });
  assert.equal(allowed.decision, 'UNKNOWN'); assert.equal(allowed.proposal, null);
});

test('native ancestry, merge and 100-commit boundaries are enforced without executing head code', () => {
  const tree = git('rev-parse', head + '^{tree}');
  const unrelated = git('commit-tree', tree, '-m', 'Synthetic unrelated root');
  assert.equal(inspectHistory({ cwd: dir, base, head: unrelated, policy }).why, 'BASE_NOT_ANCESTOR');
  const merged = git('commit-tree', tree, '-p', head, '-p', unrelated, '-m', 'Synthetic merge');
  assert.equal(inspectHistory({ cwd: dir, base, head: merged, policy }).why, 'MERGE_COMMIT_NOT_ADMITTED');
  assert.equal(inspectHistory({ cwd: dir, base, head: base, policy }).why, 'COMMIT_COUNT');
  let tip = base;
  for (let n = 1; n <= 101; n++) {
    tip = git('commit-tree', tree, '-p', tip, '-m', 'Synthetic bounded history ' + n);
    if (n === 100) {
      const result = inspectHistory({ cwd: dir, base, head: tip, policy });
      assert.equal(result.status, 'PRESERVED'); assert.equal(result.commits.length, 100);
    }
  }
  assert.equal(inspectHistory({ cwd: dir, base, head: tip, policy }).why, 'COMMIT_COUNT');
  // A candidate with executable source is inspected as Git data only.
  fs.writeFileSync(path.join(dir, 'candidate.mjs'), "throw Error('CANDIDATE_EXECUTED');\n");
  const executable = commit('Synthetic candidate code, never executed');
  const before = git('rev-parse', 'HEAD');
  const result = inspectHistory({ cwd: dir, base: git('rev-parse', executable + '^'), head: executable, policy });
  assert.equal(result.status, 'PRESERVED'); assert.equal(git('rev-parse', 'HEAD'), before);
  assert.equal(inspectHistory({ cwd: dir, base, head, policy, fetchCandidate: true }).why, 'TRUSTED_BASE_CHECKOUT_REQUIRED');
});

test('shallow repositories cannot claim complete history', () => {
  // Git's native shallow boundary in the disposable fixture; no transport needed.
  const shallowFile = path.join(dir, '.git', 'shallow');
  fs.writeFileSync(shallowFile, git('rev-parse', 'HEAD') + '\n');
  try {
    assert.equal(git('rev-parse', '--is-shallow-repository'), 'true');
    const r = inspectHistory({ cwd: dir, base, head, policy });
    assert.equal(r.status, 'UNKNOWN'); assert.equal(r.why, 'SHALLOW_HISTORY_UNVERIFIED');
  } finally { fs.unlinkSync(shallowFile); }
});
