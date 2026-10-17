import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../..',import.meta.url));
function source(workflow){return readFileSync(ROOT+'.github/workflows/'+workflow+'.yml','utf8');}
function steps(text){
 const matches=[...text.matchAll(/^      - name: (.+)$/gm)];
 return matches.map((m,i)=>({name:m[1],body:text.slice(m.index,matches[i+1]?.index??text.length)}));
}
function step(rows,name){const found=rows.filter(s=>s.name===name);assert.equal(found.length,1,name);return found[0];}

for(const workflow of ['daily','gameday']){
 test(workflow+' pins the public engine and measures after settlements in every mode, before review and publication',()=>{
  const text=source(workflow),rows=steps(text),checkout=step(rows,'Checkout pinned SelfLearning pilot engine (optional)');
  const feedback=step(rows,'Shared parlay feedback pilot'),disabled=step(rows,'Record disabled shared parlay feedback pilot');
  const index=name=>rows.findIndex(s=>s.name===name);
  assert.match(text,/workflow_dispatch:/);
  const config=step(rows,'Resolve reviewed NFL feedback configuration');
  assert.match(config.body,/scripts\/pilot_config\.py --config config\/selflearning_pilot\.json --github-output/);
  assert.ok(index(config.name)<index(checkout.name));
  assert.match(checkout.body,/if: steps\.selflearn_config\.outputs\.enabled == '1'/);
  assert.match(checkout.body,/uses: actions\/checkout@[0-9a-f]{40}/);
  assert.match(checkout.body,/repository: liddar12\/SelfLearning/);
  assert.match(checkout.body,/ref: \$\{\{ steps\.selflearn_config\.outputs\.engine_commit \}\}/);
  assert.ok(!checkout.body.includes('continue-on-error: true'));
  assert.match(checkout.body,/path: \.selflearn-engine/);assert.match(checkout.body,/persist-credentials: false/);
  assert.ok(index(checkout.name)<index('Begin per-stage record (R88)'));
  assert.match(feedback.body,/id: shared_feedback/);
  assert.match(feedback.body,/if: steps\.selflearn_config\.outputs\.enabled == '1'/);
  assert.ok(!feedback.body.includes('inputs.mode'),'outcome corrections also run in scores-only mode');
  assert.match(feedback.body,/timeout-minutes: 15/);assert.match(feedback.body,/continue-on-error: true/);
  assert.ok(feedback.body.includes('stage.sh --continue-on-error '+workflow+' "Shared parlay feedback pilot"'));
  assert.ok(feedback.body.includes('python3 -I -S -B scripts/run_parlay_feedback.py --execute --fetch-outcomes --engine-checkout .selflearn-engine --engine-commit "$SELFLEARN_NFL_ENGINE_COMMIT"'));
  for(const predecessor of ['MY PARLAYS generation (selected freshness, existing intent only)','Resolve parlay legs against nflverse weekly yards','Resolve MY cards against nflverse weekly yards','Replay lab (candidate parlay rules vs shipped, measure only)']){
   assert.ok(index(predecessor)>=0&&index(predecessor)<index(feedback.name),predecessor);
  }
  assert.ok(index(feedback.name)<index('Build post-game review (data/review.json)'));
  assert.ok(index(feedback.name)<index('Learning loops record (MODEL tab)'));
  assert.match(disabled.body,/if: steps\.selflearn_config\.outputs\.enabled != '1'/);
  assert.ok(disabled.body.includes('skip --workflow '+workflow+' --stage "Shared parlay feedback pilot"'));
  const validate=step(rows,'Validate shared feedback immutable records');
  assert.match(validate.body,/run: python3 -I -S -B scripts\/run_parlay_feedback\.py --check-records/);
  assert.ok(index(validate.name)>index(feedback.name));assert.match(rows.at(-1).body,/scripts\/publish_my_generation\.py/);
  assert.ok(!feedback.body.includes('approve')&&!feedback.body.includes('apply-my')&&!feedback.body.includes('SELFLEARN_OPERATOR_TOKEN'));
 });

 test(workflow+' summarizes the actual attempt outcome, never a continue-on-error green conclusion',()=>{
  const summary=step(steps(source(workflow)),'Summarize shared feedback attempt (measure only)');
  assert.match(summary.body,/if: always\(\)/);
  assert.match(summary.body,/PILOT_OUTCOME: \$\{\{ steps\.shared_feedback\.outcome \}\}/);
  assert.ok(!summary.body.includes('.conclusion'));
  const match=/        run: \|\n([\s\S]*)/.exec(summary.body);assert.ok(match);
  const shell=match[1].split('\n').map(line=>line.startsWith('          ')?line.slice(10):'').join('\n');
  const temporary=mkdtempSync(join(tmpdir(),'nfl-pilot-summary-'));
  try{
   for(const [enabled,outcome,expected]of [['1','success','Measurement completed'],['1','failure','FAILED'],['1','cancelled','NOT COMPLETED'],['1','skipped','NOT COMPLETED'],['1','','NOT COMPLETED'],['0','success','DISABLED'],['','failure','DISABLED']]){
    const destination=join(temporary,(enabled||'empty')+'-'+(outcome||'empty')+'.md');
    const result=spawnSync('bash',['-eu','-c',shell],{env:{...process.env,CONFIG_OUTCOME:'success',PILOT_ENABLED:enabled,PILOT_OUTCOME:outcome,GITHUB_STEP_SUMMARY:destination},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);const text=readFileSync(destination,'utf8');
    assert.ok(text.includes(expected),text);assert.match(text,/No shared-engine model was approved or activated/);
    assert.match(text,/not deployment or accuracy evidence/);
    if(outcome==='failure'&&enabled==='1'){assert.match(result.stdout,/::warning::/);assert.match(text,/not a fresh success/);}
   }
   const destination=join(temporary,'bad-config.md');
   const result=spawnSync('bash',['-eu','-c',shell],{env:{...process.env,CONFIG_OUTCOME:'failure',PILOT_ENABLED:'1',PILOT_OUTCOME:'success',GITHUB_STEP_SUMMARY:destination},encoding:'utf8'});
   assert.equal(result.status,0,result.stderr);assert.match(readFileSync(destination,'utf8'),/CONFIGURATION NOT VERIFIED/);
  }finally{rmSync(temporary,{recursive:true,force:true});}
 });
}

test('manual dispatch remains available before 10am Sunday without inventing a new cron or automatic approval',()=>{
 const cron=text=>[...text.matchAll(/- cron: "([^"]+)"/g)].map(m=>m[1]);
 assert.deepEqual(cron(source('daily')),['7 10 * * *','7 22 * * *','15 23 * * 1,4','3 16 * * 0','15 19 * * 0','20 23 * * 0']);
 assert.deepEqual(cron(source('gameday')),['0 */2 * * 0','0 0,2 * * 1','0 0,2 * * 2','0 0,2 * * 5']);
 assert.match(source('gameday'),/type: choice[\s\S]*options: \[lock, scores, both\]/);
 for(const workflow of ['daily','gameday']){
  const text=source(workflow);
  assert.ok(!text.includes('scripts/period_operator.py'),'measure-only wiring cannot automatically record model intent');
  assert.match(text,/-- python3 -I -S -B scripts\/run_my_generation\.py --execute/);
  assert.match(text,/--freshness-profile "\$MY_FRESHNESS_PROFILE"/);
 }
});

test('reviewed release/config pushes automatically refresh main without a data-only recursion',()=>{
 const text=source('daily'),block=/  push:\n([\s\S]*?)  # R78/.exec(text);assert.ok(block);
 assert.match(block[1],/branches: \[main\]/);
 const paths=[...block[1].matchAll(/^      - (.+)$/gm)].map(m=>m[1]);
 assert.deepEqual(paths,['config/selflearning_pilot.json','.github/workflows/daily.yml','scripts/run_my_generation.py','scripts/publish_my_generation.py','scripts/pilot_config.py']);
 assert.ok(!paths.some(path=>path.startsWith('data/')||path==='**'));
});

test('scores-only publication does not require a generation result or reuse an old MY semantic pass',()=>{
 const rows=steps(source('gameday')),generation=step(rows,'MY PARLAYS generation (selected freshness, existing intent only)');
 assert.match(generation.body,/if:.*!= 'scores'/);
 const publish=rows.at(-1).body,branch=/if \[ "\$PIPELINE_MODE" = "scores" \]; then([\s\S]*?)else/.exec(publish);assert.ok(branch);
 assert.match(branch[1],/bash scripts\/publish_data\.sh "data: gameday refresh \[skip actions\]"/);
 assert.ok(!/generation-result|generation-binding|selected-MY-binding|period-generation-id|no-new-generation/.test(branch[1]));
 assert.match(publish,/else[\s\S]*scripts\/publish_my_generation\.py --execute/);
});

test('original generation evidence is retained on failures without uploading credentials or the whole runner temp',()=>{
 for(const workflow of ['daily','gameday']){
  const rows=steps(source(workflow)),artifact=step(rows,'Retain private MY generation evidence (7 days)');
  assert.match(artifact.body,/if: always\(\)/);assert.match(artifact.body,/uses: actions\/upload-artifact@v4/);
  assert.match(artifact.body,/retention-days: 7/);assert.match(artifact.body,/if-no-files-found: warn/);
  const path=/          path: \|\n([\s\S]*?)          retention-days:/.exec(artifact.body);assert.ok(path);
  assert.deepEqual(path[1].trim().split('\n').map(line=>line.trim()),['${{ runner.temp }}/my-generation/*.json','${{ runner.temp }}/my-generation-result.json']);
  assert.ok(!/credential|\.env|TOKEN|runner\.temp \}\}\/?\*\*/.test(path[1]));
  assert.ok(rows.indexOf(artifact)>rows.findIndex(row=>row.name==='Validate data contracts'));
  assert.equal(rows.indexOf(artifact),rows.length-2,'retain evidence before the final publish, including failed attempts');
 }
});
