import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
const REPO = 'Nimclea/quickprotect-v1-seed', ID = 1440488291;
const SHA = /^[a-f0-9]{40}$/;
const root = new URL('./', import.meta.url);
export function verifySource() {
 const manifest = JSON.parse(fs.readFileSync(new URL('source-manifest.json', root)));
 if (manifest.source_head !== 'ee73a9362965a782540e43da0e5621a327863cc1') throw Error('SOURCE_HEAD_CONFLICT');
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
export function classify(decideTransition, {head, current, files, policy, evidence}) {
 if (policy.schema !== 'RELEASEBRIDGE_PR_FREEZE_POLICY_V1' || policy.repo !== REPO ||
  policy.base_ref !== 'main' || policy.protected_paths?.length !== 1 ||
  !SHA.test(policy.protected_paths[0].blob)) throw Error('POLICY_CONTRACT_INVALID');
 const controls=['.releasebridge/freeze-policy.json','.releasebridge/verify-pr.cjs','.github/workflows/releasebridge-freeze.yml'];
 const forbidden=files.filter(f => [f.filename,f.previous_filename].some(p =>
  controls.includes(p) || p === policy.protected_paths[0].path));
 const claim='candidate-eligible-for-agent-freeze';
 const receipt=decideTransition({
  state:{object_id:head,claim_id:claim},
  identity:{current,revision:head},
  scope:{affected:[claim],unaffected:[]},
  evidence:{result:'UNKNOWN',full_proof:false,references:evidence},
  authority:{current:false,conflict:current && forbidden.length>0,allows_transition:false}
 });
 // This intake has no independent acceptance provider. It cannot promote to PASS.
 return {decision:receipt.outcome==='STOP'?'STOP':'UNKNOWN',original_k4:receipt,
  why:!current?'CURRENT_GIT_BINDING_UNVERIFIED':forbidden.length?'PROTECTED_PATH_CHANGED':'INDEPENDENT_ACCEPTANCE_MISSING',
  next:!current?'Refresh PR event after Base and Candidate currentness match.':forbidden.length?'Restore protected files and submit a permitted Git candidate.':'Obtain independent acceptance for this exact Git candidate from existing CI/scope evidence; otherwise remain UNKNOWN.',
  agent_provenance:'AGENT_UNVERIFIED',proposal:null,changed_paths:files.map(f=>f.filename),evidence};
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
export async function main() {
 const manifest=verifySource();
 const {decideTransition}=await import('./kernel/decision/transition-decision-engine-v0.1.mjs');
 let e,p,result;
 try {
  e=JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
  p=validateEvent(e,process.env);
  const first=await get('pulls/'+e.number);
  const same=x=>x.state==='open' && x.number===e.number && x.base?.repo?.id===ID &&
   x.head?.repo?.id===p.head.repo.id && x.base.sha===p.base.sha && x.head.sha===p.head.sha &&
   x.base.ref==='main';
  if(!same(first) || !Number.isSafeInteger(first.changed_files) || first.changed_files>300) throw Error('STALE_OR_UNBOUNDED_CANDIDATE');
  const files=[];
  for(let page=1;page<=3;page++) {
   const batch=await get('pulls/'+e.number+'/files?per_page=100&page='+page);
   if(!Array.isArray(batch)) throw Error('INVALID_FILES');
   files.push(...batch); if(batch.length<100) break;
  }
  if(files.length!==first.changed_files || files.some(f=>typeof f.filename!=='string'||!SHA.test(f.sha))) throw Error('INCOMPLETE_FILES');
  const branch=await get('branches/main');
  const checks=await get('commits/'+p.head.sha+'/check-runs?per_page=100');
  const last=await get('pulls/'+e.number);
  const current=same(last)&&branch.commit.sha===p.base.sha;
  const evidence=[{pr:'https://github.com/'+REPO+'/pull/'+e.number,
   checks:(checks.check_runs??[]).map(c=>({id:c.id,head_sha:c.head_sha,conclusion:c.conclusion,url:c.html_url})),
   checks_complete:checks.total_count <=100}];
  const policy=JSON.parse(fs.readFileSync('.releasebridge/freeze-policy.json','utf8'));
  result=classify(decideTransition,{head:p.head.sha,current,files,policy,evidence});
 } catch(err) {
  result={decision:'UNKNOWN',why:String(err.message),next:'Resolve the missing or stale native evidence, then process a fresh authorized PR event.',
   original_k4:decideTransition({}),agent_provenance:'AGENT_UNVERIFIED',proposal:null};
 }
 result.binding={repository:REPO,repository_id:ID,pr:e?.number??null,base:p?.base.sha??null,
  candidate:p?.head.sha??null,installation_id:e?.installation?.id??null,
  run_id:process.env.GITHUB_RUN_ID,run_attempt:process.env.GITHUB_RUN_ATTEMPT,
  workflow_sha:process.env.GITHUB_WORKFLOW_SHA,original_source_head:manifest.source_head};
 result.exact_candidate_sha=result.binding.candidate;
 result.evidence_used=Array.isArray(result.evidence)?result.evidence:[];
 result.evidence_missing=result.decision==='UNKNOWN'?[result.why]:[];
 result.next_action=result.next??'Inspect missing evidence before proceeding.';
 result.freeze_proposal_eligible=false;
 // Data is JSON only; never interpreted as shell, executable paths, or workflow commands.
 const text=JSON.stringify(result,null,2);
 const marker=crypto.randomUUID();
 console.log('::stop-commands::'+marker); console.log(text); console.log('::'+marker+'::');
 if(process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  'K4 decision: '+result.decision+'\n\nAgent provenance: AGENT_UNVERIFIED. No proposal or activation.\n');
 return result;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 main().catch(()=>{console.error('TRUSTED_SOURCE_OR_RUNTIME_FAILURE');process.exitCode=1;});
}
