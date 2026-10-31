'use strict';
// Source of this script is the PR base branch. Never execute PR head code.
const cp=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const fail=m=>{throw Error('RB_PR_DENY:'+m)};
function git(...args){let r=cp.spawnSync('git',args,{encoding:'utf8',timeout:30000,maxBuffer:2e6});if(r.status!==0)fail('GIT_'+args[0]+':'+(r.stderr||'').slice(0,250));return r.stdout.trim()}
function exactOid(x){return typeof x==='string'&&/^[a-f\d]{40,64}$/i.test(x)}
try{
 const repo=process.env.GITHUB_REPOSITORY;
 const base=process.env.RB_BASE_SHA,head=process.env.RB_HEAD_SHA;
 const baseRef=process.env.RB_BASE_REF;
 if(!exactOid(base)||!exactOid(head)||!repo||!baseRef)fail('PR_EVENT_BINDING');
 const p=JSON.parse(git('show',base+':.releasebridge/freeze-policy.json'));
 if(p.schema!=='RELEASEBRIDGE_PR_FREEZE_POLICY_V1'||p.repo!==repo||p.base_ref!==baseRef||!Array.isArray(p.protected_paths)||p.protected_paths.length!==1)fail('POLICY_BINDING');
 for(const row of p.protected_paths){
  if(!row||typeof row.path!=='string'||!/^[-\w./]+$/.test(row.path)||row.path.startsWith('/')||row.path.split('/').includes('..')||!exactOid(row.blob))fail('PROTECTED_PATH');
  const original=git('rev-parse',base+':'+row.path);
  if(original!==row.blob)fail('BASELINE_BLOB_CURRENTNESS');
 }
 // Trusted base checkout; only retrieve untrusted Git objects as data.
 git('fetch','--quiet','--no-tags','origin',head);
 git('merge-base','--is-ancestor',base,head);
 const commits=git('rev-list','--reverse',base+'..'+head).split(/\s+/).filter(Boolean);
 if(!commits.length||commits.length>100)fail('COMMIT_COUNT');
 const protectedSet=new Set([...p.protected_paths.map(v=>v.path), ...['.github/workflows/releasebridge-freeze.yml','.releasebridge/verify-pr.cjs','.releasebridge/freeze-policy.json']]);
 for(const commit of commits){
  const parents=git('rev-list','--parents','-n','1',commit).split(/\s+/);
  if(parents.length!==2)fail('MERGE_COMMIT_NOT_ADMITTED');
  const changed=cp.spawnSync('git',['diff-tree','-r','--no-commit-id','--name-only','-z',parents[1],commit],{encoding:'utf8',timeout:30000});
  if(changed.status!==0)fail('DIFF_READ');
  for(const file of changed.stdout.split('\0').filter(Boolean))if(protectedSet.has(file))fail('FROZEN_PATH_CHANGED:'+file);
 }
 console.log('RELEASEBRIDGE_PR_CHECK=PASS_PROTECTED_UNIT_PRESERVED');
}catch(e){console.error('RELEASEBRIDGE_PR_CHECK=DENY '+String(e.message||e));process.exitCode=1}
