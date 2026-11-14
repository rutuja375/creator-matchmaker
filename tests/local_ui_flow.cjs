/* Run against a local server. Real live-run POSTs are intercepted, never sent. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

(async () => {
  const base = process.env.UI_URL || 'http://127.0.0.1:8766';
  const screenshots = process.env.UI_SCREENSHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'matchmaker-ui-'));
  fs.mkdirSync(screenshots, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.UI_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [], posts = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.method() === 'POST') posts.push({ url: r.url(), body: r.postDataJSON() }); });
    await page.route('**/api/live', route => route.fulfill({ status: 403, json: { error: 'Live calls disabled in this test.' } }));
    const baseline = (await (await page.request.get(base + '/api/state')).json()).demo;
    await page.goto(base);
    await page.waitForFunction(() => !document.getElementById('brief-next').disabled);
    assert.equal(await page.locator('#results').isVisible(), false);
    assert.equal(await page.locator('#preferences').isVisible(), false);
    assert.equal(await page.locator('#demo-product').inputValue(), baseline.campaign.product_description);
    assert.equal(await page.locator('#demo-product').getAttribute('readonly'), '');
    await page.screenshot({ path: path.join(screenshots, 'brief-desktop.png'), fullPage: true });
    await page.locator('#brief-next').click();
    assert.equal(await page.locator('#weights input').count(), 6);
    assert.equal(await page.locator('#priorities input').count(), 4);
    await page.locator('#w-brand_fit').fill('0.7');
    await page.locator('#p-reach').fill('0.9');
    await page.locator('#preferences-back').click();
    await page.locator('#brief-next').click();
    assert.equal(await page.locator('#w-brand_fit').inputValue(), '0.7');
    assert.equal(await page.locator('#p-reach').inputValue(), '0.9');
    await page.screenshot({ path: path.join(screenshots, 'preferences-desktop.png'), fullPage: true });

    async function calculate() {
      const response = page.waitForResponse(r => r.url().endsWith('/api/rescore') && r.request().method() === 'POST');
      await page.locator('#apply').click();
      assert.equal(await page.locator('#preparing').isVisible(), true);
      assert.match(await page.locator('#preparing').innerText(), /saved evidence/);
      const result = await (await response).json();
      await page.locator('#results').waitFor({ state: 'visible' });
      return result;
    }
    const changed = await calculate();
    assert.equal(changed.weights.brand_fit, .7);
    assert.equal(changed.capability_priorities.reach, .9);
    assert.notEqual(changed.run_id, baseline.run_id);
    assert.ok(changed.ranking.some(c => c.combined_score !== baseline.ranking.find(b => b.handle === c.handle).combined_score));
    assert.equal(await page.locator('#roster .role').count(), 4);
    for (const c of changed.roster) assert.ok((await page.locator('#roster').innerText()).includes(c.title));
    assert.equal(await page.locator('#technical-panel').getAttribute('open'), null);
    assert.equal(await page.locator('#shortlist-panel').getAttribute('open'), null);
    assert.ok(!(await page.locator('#roster').innerText()).includes('Combined score'));
    await page.screenshot({ path: path.join(screenshots, 'team-desktop.png'), fullPage: true });

    await page.locator('#refine').click();
    await page.locator('#p-reach').fill('0');
    const prioritiesOnly = await calculate();
    assert.deepEqual(prioritiesOnly.weights, changed.weights);
    assert.equal(prioritiesOnly.capability_priorities.reach, 0);
    assert.deepEqual(prioritiesOnly.ranking.map(c=>c.combined_score), changed.ranking.map(c=>c.combined_score));
    await page.locator('#refine').click();
    for (const input of await page.locator('#weights input').all()) await input.fill('0');
    const before = posts.length;
    await page.locator('#apply').click();
    assert.match(await page.locator('#message').innerText(), /at least one/);
    assert.equal(posts.length, before);
    await page.locator('#reset').click();
    for (const [k,v] of Object.entries(baseline.weights)) assert.equal(Number(await page.locator('#w-'+k).inputValue()), v);
    const restored = await calculate();
    assert.deepEqual(restored.roster.map(c=>c.handle), baseline.roster.map(c=>c.handle));

    await page.locator('#refine').click();
    await page.route('**/api/rescore', route=>route.fulfill({status:400,json:{error:'Simulated local calculation failure'}}), {times:1});
    await page.locator('#apply').click();
    await page.locator('#message').filter({hasText:'Simulated local calculation failure'}).waitFor();
    assert.equal(await page.locator('#preferences').isVisible(), true);
    assert.equal(await page.locator('#preparing').isVisible(), false);
    assert.equal(await page.locator('#results').isVisible(), false);
    await calculate();
    await page.locator('#shortlist-panel > summary').click();
    const swapResponse = page.waitForResponse(r=>r.url().endsWith('/api/rescore') && r.request().method()==='POST');
    await page.locator('[data-swap]').first().click();
    const swapped = await (await swapResponse).json();
    await page.waitForFunction(() => document.querySelector('#roster').innerText.includes('Chosen by you'));
    assert.equal(swapped.manual_roster, true);

    await page.locator('#live-mode').click();
    assert.equal(await page.locator('#live-panel').isVisible(), true);
    assert.equal(await page.locator('#results').isVisible(), false);
    await page.locator('#start').click();
    assert.match(await page.locator('#message').innerText(), /confirm API quota/);
    assert.equal(posts.some(p=>p.url.endsWith('/api/live')), false);
    await page.locator('#demo-mode').click();
    assert.equal(await page.locator('#results').isVisible(), true);
    await page.locator('#restart').click();
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(screenshots,'brief-mobile.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth + 1),false);
    await page.locator('#brief-next').click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth + 1),false);
    await page.screenshot({path:path.join(screenshots,'preferences-mobile.png'),fullPage:true});
    await calculate();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth + 1),false);
    const after = (await (await page.request.get(base+'/api/state')).json()).demo;
    assert.deepEqual(after, baseline);
    assert.deepEqual(errors, []);
    console.log('PASS: guided flow; hidden initial results; real rescore; independent priorities; reset; local errors; swaps; live consent; mobile; original baseline unchanged.');
    console.log('Screenshots: '+screenshots);
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
