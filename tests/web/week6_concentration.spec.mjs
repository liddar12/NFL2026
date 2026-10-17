import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';

// Synthetic, future-dated browser fixtures; not provider or accuracy evidence.
const pairs=[['SEA','SF'],['NE','NYJ'],['CHI','GB'],['DAL','PHI'],['LAC','KC'],['BUF','MIA'],['ATL','CAR']];
const games=pairs.map(([home,away],i)=>({game_id:'g'+i,home,away,week:6,
 kickoff_utc:'2026-10-18T18:00:00Z',status:'STATUS_SCHEDULED'}));
const longLabel='Alpha 0 '+ 'W'.repeat(250)+' 40+ rec yds';
const pool={version:1,season:2026,week:6,players:games.map((g,i)=>({gsis_id:'p'+i,
 player:'Alpha '+i,team:g.home,side:'home',game_id:g.game_id,position:'WR',market:'wr_rec_yds',
 mu:60,p_team:.6,kickoff_utc:g.kickoff_utc,status:g.status,
 rungs:[{line:39.5,z:.1,selection:i===0?longLabel:'Alpha '+i+' 40+ rec yds',model_prob:.55-i*.005}]})),
 game_legs:[],atd_legs:[]};

for(const width of [402,1280])test(`MY exposure follows shown cards and clears on an empty dial at ${width}px`,async({page})=>{
 const errors=[];page.on('pageerror',error=>errors.push(String(error)));
 await page.setViewportSize({width,height:900});
 await page.clock.install({time:new Date('2026-10-16T20:00:00Z')});
 await page.route('**/data/leg_pool.json*',route=>route.fulfill({json:pool}));
 await page.route('**/data/schedule_full.json*',route=>route.fulfill({json:{version:1,season:2026,games}}));
 await page.goto('/#/parlays');
 await page.locator('.scopeseg [data-seg="my"]').click();
 await expect(page.locator('#mp-input')).toBeVisible();
 await expect(page.locator('#mp-concentration')).toBeHidden();
 await page.locator('#mp-input').fill('Alpha 0');await page.locator('#mp-input').press('Enter');
 await expect(page.locator('#mp-list .mp-card')).toHaveCount(10);
 const panel=page.locator('#mp-concentration .portfolio-concentration');
 await expect(panel.locator('summary')).toContainText('10/10 share one selection');
 await panel.locator('summary').click();
 await expect(panel).toContainText('One loss of the most repeated selection defeats 10 of these 10 shown cards');
 await expect(panel).toContainText('No joint win probability');
 await expect(panel).toContainText('ranking and prices are unchanged');
 const counts=await page.locator('#mp-list .mp-card').evaluateAll(nodes=>{
  const rows=new Map();
  for(const node of nodes)for(const text of new Set([...node.querySelectorAll('.leg-nm')].map(l=>l.textContent))){
   rows.set(text,(rows.get(text)||0)+1);
  }
  return Math.max(...rows.values());
 });
 expect(counts).toBe(10);
 expect(await panel.evaluate(node=>[node,...node.querySelectorAll('li')].every(n=>n.scrollWidth<=n.clientWidth+1))).toBe(true);
 const box=await panel.boundingBox();expect(box.x+box.width).toBeLessThanOrEqual(width+1);
 await page.locator('.mp-dial [data-dial="longshot"]').click();
 await expect(page.locator('#mp-list .mp-card')).toHaveCount(0);
 await expect(page.locator('#mp-concentration')).toBeHidden();
 await expect(page.locator('#mp-concentration')).toBeEmpty();
 await page.locator('.mp-dial [data-dial="even"]').click();
 await expect(page.locator('#mp-list .mp-card')).toHaveCount(10);
 await expect(panel.locator('summary')).toContainText('10/10');
 await page.locator('#mp-seeds [data-drop="p0"]').click();
 await expect(page.locator('#mp-list .mp-card')).toHaveCount(0);
 await expect(page.locator('#mp-concentration')).toBeHidden();
 await page.locator('.scopeseg [data-seg="week"]').click();
 await expect(page.locator('#mp-concentration')).toBeHidden();
 expect(errors).toEqual([]);
});

test('Game exposure is scoped to the shown Game cards and never leaks into Week or MY',async({page})=>{
 const doc=JSON.parse(readFileSync(new URL('../../data/parlays.json',import.meta.url),'utf8'));
 const cards=doc.parlays.filter(c=>c.scope==='game');
 const exposure=new Map();
 for(const card of cards)exposure.set(String(card.game_id),(exposure.get(String(card.game_id))||0)+1);
 expect(Math.max(...exposure.values())).toBeGreaterThan(1);
 await page.goto('/#/parlays');
 await expect(page.locator('#parlays-list .card.parlay')).toHaveCount(cards.length);
 const panel=page.locator('#parlays-list .portfolio-concentration');
 await expect(panel).toBeVisible();await panel.locator('summary').click();
 await expect(panel).toContainText(`/${cards.length}:`);
 await expect(panel).toContainText('A shared game is not necessarily a shared selection');
 await page.locator('.scopeseg [data-seg="week"]').click();
 await expect(page.locator('#parlays-list .portfolio-concentration')).toHaveCount(0);
 await page.locator('.scopeseg [data-seg="game"]').click();await expect(panel).toBeVisible();
 await page.locator('.scopeseg [data-seg="my"]').click();await expect(panel).toBeHidden();
});
