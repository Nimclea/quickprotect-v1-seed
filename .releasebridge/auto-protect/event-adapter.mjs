import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { consumeCandidate, inspectHistory, readAcceptance, protectedPaths } from './native-consumer.mjs';
const REPO = 'Nimclea/quickprotect-v1-seed', ID = 1440488291;
const SHA = /^[a-f0-9]{40}$/;
const root = new URL('./', import.meta.url);
const ORIGINAL_MODULES = Object.freeze({
 'kernel/decision/transition-decision-engine-v0.1.mjs':'d1b681863620065bd4c8db77de2cf3f86f49d89d',
 'kernel/decision/failure-classifier-v0.1.mjs':'62013ec5cc36501e8d3d6fffc332233ab330d588',
 'kernel/proof/proof-runtime-v0.1.mjs':'a1209cf248e535ef828a54b05c52ff3e81a60026',
});
export function verifySource() {
 const manifest = JSON.parse(fs.readFileSync(new URL('source-manifest.json', root)));
 if (manifest.source_head !== 'ee73a9362965a782540e43da0e5621a327863cc1') throw Error('SOURCE_HEAD_CONFLICT');
 if (!manifest.modules || Object.keys(manifest.modules).length !== 3 ||
  Object.entries(ORIGINAL_MODULES).some(([p, hash]) => manifest.modules[p] !== hash)) throw Error('SOURCE_MANIFEST_CONFLICT');
 for (const [p, expected] of Object.entries(manifest.modules)) {
  if (!/^kernel\/(decision|proof)\/[a-z0-9.-]+\.mjs$/.test(p)) throw Error('SOURCE_PATH_INVALID');
  const bytes = fs.readFileSync(new URL(p, root));
  const blob = crypto.createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex');
  if (blob !== expected) throw Error('ORIGINAL_MODULE_BYTES_CHANGED');
 }
 return manifest;
}
export function validateEvent(e, env) {
 const p=e?.pull_request;
 if (env.GITHUB_EVENT_NAME !== 'pull_request_target' || env.GITHUB_REPOSITORY !== REPO ||
  !['opened','synchronize','reopened'].includes(e.action) || e.repository?.id !== ID ||
  e.repository?.full_name !== REPO || !Number.isSafeInteger(e.number) || e.number < 1 ||
  p?.number !== e.number || p.base?.repo?.id !== ID || p.base?.ref !== 'main' ||
  !SHA.test(p.base?.sha) || !SHA.test(p.head?.sha)) throw Error('EVENT_BINDING_INVALID');
 return p;
}
export function classify(decideTransition, context) {
 return consumeCandidate(decideTransition, context);
}
// Encode markup as literal text; only the PR link below is constructed as Markdown.
function safeText(value) {
 return String(value ?? 'UNAVAILABLE').replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, ' ')
  .slice(0, 2400).replace(/[&<>"'`|\\\[\]()*_!#{}:]/g, c => '&#' + c.codePointAt(0) + ';');
}
export function renderDecisionCard(result) {
 const b=result.binding??{};
 const pr=Number.isSafeInteger(b.pr)&&b.pr>0 ?
  '[PR #'+b.pr+'](https://github.com/'+REPO+'/pull/'+b.pr+')' : 'UNAVAILABLE';
 const row=(name,value)=>'| '+name+' | '+safeText(value)+' |';
 return [
  '## ReleaseBridge · Auto-Protect V1+', '',
  '**Decision: '+safeText(result.decision)+'**', '',
  '> Workflow success does not mean K4 PASS.', '',
  '| Field | Result |', '| --- | --- |',
  '| PR | '+pr+' |',
  row('Candidate SHA',result.exact_candidate_sha), row('Base SHA',b.base),
  row('Original K4 outcome',result.original_k4?.outcome),
  row('K4 reason',result.original_k4?.reason_code),
  row('Agent provenance (independent)',result.agent_provenance),
  row('Agent attribution next',result.agent_provenance_next),
  row('Proposal status',result.proposal_status),
  row('Freeze proposal eligible',result.freeze_proposal_eligible===true?'Yes':'No'),
  row('Native history',result.history?.status??'UNKNOWN'),
  row('History reason',result.history?.why??(result.history?.status==='PRESERVED'?'Complete introduced history inspected':'UNAVAILABLE')),
  row('Run ID',b.run_id), row('Run attempt',b.run_attempt), row('Workflow SHA',b.workflow_sha),
  '', '### WHY', '', safeText(result.why),
  '', '### NEXT', '', safeText(result.next_action??result.next),
  '', '### Evidence used', '',
  ...(result.evidence_used?.length ? result.evidence_used.map(x=>'- '+safeText(JSON.stringify(x))) : ['- None available.']),
  '', '### Evidence missing', '',
  ...(result.evidence_missing?.length ? result.evidence_missing.map(x=>'- '+safeText(x)) : ['- None identified for this observation.']),
  '', '> CI is context only. Agent attribution does not establish code acceptance.',
  '> No Freeze proposal, signing, or activation. Synthetic results are not Q3.', '',
 ].join('\n');
}
async function get(route) {
 const response=await fetch('https://api.github.com/repos/'+REPO+'/'+route,{
  method:'GET',headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},
  redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!response.ok) throw Error('GITHUB_READ_'+response.status);
 const text=await response.text();
 if(text.length>4000000) throw Error('EVIDENCE_TOO_LARGE');
 return JSON.parse(text);
}
export async function main({env=process.env, read=get, readQualifiedAcceptance, cwd=process.cwd(), emit=true}={}) {
 const manifest=verifySource();
 const {decideTransition}=await import('./kernel/decision/transition-decision-engine-v0.1.mjs');
 let e,p,result,history=null,evidence=[],ciMissing=false;
 try {
  if(!env.GITHUB_EVENT_PATH) throw Error('PR_EVENT_UNAVAILABLE');
  e=JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH,'utf8'));
  p=validateEvent(e,env);
  const first=await read('pulls/'+e.number);
  const same=x=>x.state==='open' && x.number===e.number && x.base?.repo?.id===ID &&
   x.head?.repo?.id===p.head.repo.id && x.base.sha===p.base.sha && x.head.sha===p.head.sha &&
   x.base.ref==='main';
  if(!same(first) || !Number.isSafeInteger(first.changed_files) || first.changed_files<0 || first.changed_files>300) throw Error('STALE_OR_UNBOUNDED_CANDIDATE');
  const files=[];
  for(let page=1;page<=3;page++) {
   const batch=await read('pulls/'+e.number+'/files?per_page=100&page='+page);
   if(!Array.isArray(batch)) throw Error('INVALID_FILES');
   files.push(...batch); if(batch.length<100) break;
  }
  if(files.length!==first.changed_files || files.some(f=>typeof f.filename!=='string'||!SHA.test(f.sha))) throw Error('INCOMPLETE_FILES');
  const binding={repository:REPO,repository_id:ID,pr:e.number,base:p.base.sha,candidate:p.head.sha};
  const policy=JSON.parse(fs.readFileSync(new URL('../freeze-policy.json',root),'utf8'));
  history=inspectHistory({cwd,base:p.base.sha,head:p.head.sha,policy,
   fetchCandidate:env.RB_FETCH_CANDIDATE==='true'});
  evidence.push({kind:'NATIVE_GIT_HISTORY',...history});
  // CI availability is observational only; a failed CI read cannot hide a STOP.
  try {
   const checks=await read('commits/'+p.head.sha+'/check-runs?per_page=100');
   if(!Array.isArray(checks.check_runs)||!Number.isSafeInteger(checks.total_count)||checks.total_count<0) throw Error('INVALID_CHECKS');
   const complete=checks.total_count===checks.check_runs.length && checks.total_count<=100 &&
    checks.check_runs.every(c=>c.head_sha===p.head.sha);
   ciMissing=!complete;
   evidence.push({kind:'CI_CONTEXT_ONLY',pr:'https://github.com/'+REPO+'/pull/'+e.number,
    checks:checks.check_runs.slice(0,100).map(c=>({id:c.id,head_sha:c.head_sha,conclusion:c.conclusion,url:c.html_url})),
    checks_complete:complete});
  } catch { ciMissing=true; }
  const protectedSet=new Set(protectedPaths(policy));
  const denied=history.status==='STOP'||files.some(f=>[f.filename,f.previous_filename].some(p=>protectedSet.has(p)));
  const acceptance=denied?null:await readAcceptance(readQualifiedAcceptance,binding);
  // Re-read after the potentially asynchronous provider; never reuse pre-proof currentness.
  const branch=await read('branches/main');
  const last=await read('pulls/'+e.number);
  const current=same(last)&&branch.commit.sha===p.base.sha;
  evidence.push({kind:'GITHUB_BINDING_RECHECK',...binding,current});
  result=classify(decideTransition,{head:p.head.sha,current,files,policy,evidence,binding,history,acceptance});
 } catch(err) {
  result={decision:'UNKNOWN',why:String(err.message),next:'Resolve the missing or stale native evidence, then process a fresh authorized PR event.',
   original_k4:decideTransition({}),agent_provenance:'AGENT_UNVERIFIED',proposal:null,history,evidence};
 }
 result.binding={repository:REPO,repository_id:ID,pr:e?.number??null,base:p?.base.sha??null,
  candidate:p?.head.sha??null,installation_id:e?.installation?.id??null,
  run_id:env.GITHUB_RUN_ID,run_attempt:env.GITHUB_RUN_ATTEMPT,
  workflow_sha:env.GITHUB_WORKFLOW_SHA,original_source_head:manifest.source_head};
 result.exact_candidate_sha=result.binding.candidate;
 result.evidence_used=[...(Array.isArray(result.evidence)?result.evidence:[]),
  {kind:'ORIGINAL_K4_RECEIPT',decision_id:result.original_k4?.decision_id,
   outcome:result.original_k4?.outcome,reason_code:result.original_k4?.reason_code}];
 result.evidence_missing=[...new Set([
  ...(result.decision==='UNKNOWN'?[result.why]:[]),
  ...(!result.qualified_evidence?['QUALIFIED_INDEPENDENT_CODE_ACCEPTANCE_AND_CURRENT_AUTHORITY']:[]),
  ...(result.history?.status!=='PRESERVED'?[result.history?.why??'NATIVE_HISTORY_UNVERIFIED']:[]),
  ...(ciMissing?['CI_CONTEXT_INCOMPLETE']:[]),
  'QUALIFIED_NEW_PATH_BLOB_ACCEPTANCE',
 ])];
 result.next_action=result.next??'Inspect missing evidence before proceeding.';
 result.freeze_proposal_eligible=false;
 result.proposal_status='UNAVAILABLE_ACCEPTED_TARGET_BINDING';
 result.agent_provenance_next??='Authenticate Agent attribution separately if needed; it does not establish code acceptance.';
 // Data is JSON only; never interpreted as shell, executable paths, or workflow commands.
 const text=JSON.stringify(result,null,2);
 const marker=crypto.randomUUID();
 if(emit) { console.log('::stop-commands::'+marker); console.log(text); console.log('::'+marker+'::'); }
 if(env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY,renderDecisionCard(result));
 return result;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 main().catch(()=>{console.error('TRUSTED_SOURCE_OR_RUNTIME_FAILURE');process.exitCode=1;});
}
