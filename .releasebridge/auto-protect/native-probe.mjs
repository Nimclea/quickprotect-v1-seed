// Read-only local execution evidence. This is not a synthetic PR or a live GitHub attestation.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, verifySource } from './event-adapter.mjs';
import { inspectHistory } from './native-consumer.mjs';

const cwd = fileURLToPath(new URL('../../', import.meta.url));
function git(...args) {
  const r = spawnSync('git', ['--no-optional-locks', ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (r.status !== 0) throw Error('NATIVE_GIT_READ_FAILED');
  return r.stdout.trim();
}
const head = git('rev-parse', 'HEAD');
const base = git('rev-parse', 'refs/remotes/origin/main');
const policy = JSON.parse(fs.readFileSync(new URL('../freeze-policy.json', import.meta.url)));
const report = {
  evidence_kind: 'ACTUAL_LOCAL_NATIVE_EXECUTION', cwd, head, cached_origin_main: base,
  cached_ref_is_not_live_currentness: true, worktree_status: git('status', '--porcelain=v1'),
  source_verification: verifySource(), history: inspectHistory({ cwd, base, head, policy }),
  consumer: await main({ cwd, emit: false,
    env: { ...process.env, RB_FETCH_CANDIDATE: 'false', GITHUB_STEP_SUMMARY: undefined } }),
};
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
