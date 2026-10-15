import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = process.argv[2];
if (!root) throw new Error('Usage: node audit_live.mjs AUDITED_CHECKOUT [ORIGIN]');
const origin = process.argv[3] || 'https://nfl2026.netlify.app';
const paths = ['app/views/parlays.js','app/views/myparlays.js','app/views/model.js',
  'data/parlays.json','data/review.json','data/learning_loops.json',
  'data/leg_pool_backtest.json','data/pipeline_status.json','data/injuries.json'];
const digest = x => createHash('sha256').update(x).digest('hex');
const rows = await Promise.all(paths.map(async path => {
  const expected = digest(await readFile(`${root}/${path}`));
  try {
    const response = await fetch(`${origin}/${path}`, {signal:AbortSignal.timeout(25000)});
    const body = Buffer.from(await response.arrayBuffer());
    return {path,status:response.status,expected,observed:digest(body),matches:digest(body)===expected,bytes:body.length};
  } catch (error) {return {path,error:error.message,cause:error.cause?.code};}
}));
console.log(JSON.stringify({checked_utc:new Date().toISOString(),sha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),origin,rows},null,2));
