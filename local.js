"use strict";
const $ = id => document.getElementById(id);
const dims = [
  ['audience_relevance', 'Audience relevance', 'Interest in your campaign topics, expressed in sampled comments.'],
  ['engagement', 'Engagement', 'How actively people like and comment on recent videos.'],
  ['brand_fit', 'Brand fit', 'How well the content appears to fit your product and brand requirements.'],
  ['momentum', 'Momentum', 'Whether newer videos are drawing more views than earlier ones.'],
  ['speed_to_activate', 'Publishing activity', 'How frequently the creator posts. This does not confirm availability.'],
  ['trend_fit', 'Trend fit', 'Alignment with verified rising topics in the saved Trends research.']
];
const caps = [
  ['reach', 'Reach', 'Bring a larger observed audience to the team.'],
  ['demonstration', 'Demonstration', 'Help explain or demonstrate how a product works.'],
  ['credibility', 'Credibility', 'Bring signals of expertise and thoughtful discussion.'],
  ['speed', 'Publishing activity', 'Prioritize an active publishing cadence, not guaranteed turnaround.']
];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const clone = x => JSON.parse(JSON.stringify(x));
let token, baseline, current, demoCurrent, liveCurrent;
let mode = 'demo', demoStep = 'brief', liveStep = 'live', busy = false;
let activeJob = null, jobs = [], polling = false;
const drafts = {demo: null, live: null};

const DIMS = [
  ["audience_relevance", "Audience relevance"], ["engagement", "Engagement"],
  ["brand_fit", "Brand fit"], ["momentum", "Momentum"],
  ["speed_to_activate", "Speed to activate"], ["trend_fit", "Trend fit"]
];
const CAPS = ["reach", "demonstration", "credibility", "speed"];
function fit(c, weights) {
  let total = 0, sum = 0;
  for (const [key] of DIMS) {
    const score = c.d[key].s, w = weights[key] ?? 0;
    if (score != null) { total += score * w; sum += w; }
  }
  return sum ? Math.round(total / sum * 10000) / 10000 : null;
}
function components(c, score, priorities, selected) {
  const quality = score / 10;
  if (!selected.length) return {quality, coverage_gain: 0, max_similarity: 0, total: quality, selection_rule: "quality_anchor"};
  const total = CAPS.reduce((sum, k) => sum + priorities[k], 0);
  const gain = total ? CAPS.reduce((sum, k) => sum + priorities[k] * Math.max(
    0, (c.capabilities?.[k] ?? 0) - Math.max(...selected.map(p => p.c.capabilities?.[k] ?? 0))
  ), 0) / total : 0;
  const similarity = Math.max(...selected.map(p => c.similarity?.[p.c.h] ?? 0));
  return {quality, coverage_gain: gain, max_similarity: similarity,
    total: .5 * quality + .35 * gain - .15 * similarity, selection_rule: "marginal_teammate"};
}
function ranked(data, weights, dropped = new Set()) {
  return data.filter(c => !dropped.has(c.h) && c.safety !== "FAIL")
    .map(c => ({c, score: fit(c, weights)})).filter(x => x.score != null)
    .sort((a, b) => b.score - a.score || (a.c.h < b.c.h ? -1 : a.c.h > b.c.h ? 1 : 0));
}
function selectRoster(rows, priorities) {
  const left = [...rows], selected = [];
  while (left.length && selected.length < 4) {
    let index = 0, value = -Infinity;
    left.forEach((r, i) => { const score = components(r.c, r.score, priorities, selected).total;
      if (score > value) { index = i; value = score; } });
    const item = left.splice(index, 1)[0];
    item.components = components(item.c, item.score, priorities, selected);
    selected.push(item);
  }
  return selected;
}

async function api(path, body) {
  if(path === '/api/state') {
    const response = await fetch('./campaign.json');
    if (!response.ok) throw Error('Could not load the campaign.');
    return {demo:await response.json()};
  }
  if(path === '/api/jobs') return {jobs:[]};
  if(path === '/api/live') throw Error('Fresh research runs in the local app. Choose Milanote demo to explore the saved campaign here.');
  const result = clone(current);
  if(body.swap) {
    const [outgoing,incoming] = body.swap;
    result.roster = result.roster.map(c=>c.handle===outgoing ? result.ranking.find(r=>r.handle===incoming) : c);
    result.manual_roster=true;
  } else {
    result.weights=body.weights; result.capability_priorities=body.priorities;
    if(JSON.stringify(body.weights)===JSON.stringify(baseline.weights) && JSON.stringify(body.priorities)===JSON.stringify(baseline.capability_priorities)) return baseline;
    const candidates=baseline.ranking.map(c=>({...c,h:c.handle,d:Object.fromEntries(Object.entries(c.dimensions).map(([k,v])=>[k,{s:v.score}])),safety:c.brand_safety}));
    const rows=ranked(candidates,body.weights);
    result.ranking=rows.map(r=>({...r.c,combined_score:r.score}));
    result.roster=selectRoster(rows,body.priorities).map(r=>({...r.c,combined_score:r.score,marginal_components:r.components}));
    result.manual_roster=false;
  }
  result.revised=true;
  result.warnings=[];
  result.roster.forEach((c,index)=>{
    if(c.brand_safety==='REVIEW') result.warnings.push(c.handle+' is flagged for metadata review.');
    for(const [key,v] of Object.entries(c.dimensions)) if(v.score==null) result.warnings.push(c.handle+': missing evidence for '+key+'.');
    for(const other of result.roster.slice(0,index)) if(c.similarity[other.handle]>.85) result.warnings.push(c.handle+' and '+other.handle+' have similar content/comment language; this does not establish shared viewers.');
  });
  for(const [key,p] of Object.entries(result.capability_priorities)) if(p>0 && Math.max(...result.roster.map(c=>c.capabilities[key]))<.5) result.warnings.push('Limited team coverage for '+key+'.');
  return result;
}

function message(text = '') {
  $('message').textContent = text;
  $('message').hidden = !text;
  if (text) $('message').scrollIntoView({block:'center'});
}
function setBusy(value) {
  busy = value;
  document.querySelectorAll('#demo-mode,#live-mode,#preferences button,#preferences input,#results button,#results select,#brief-next')
    .forEach(node => node.disabled = value);
}
function show(step, focus = true) {
  if (mode === 'demo') demoStep = step; else liveStep = step;
  const sections = {'brief':'demo-brief', 'preferences':'preferences', 'preparing':'preparing', 'live':'live-panel', 'results':'results'};
  Object.entries(sections).forEach(([key, id]) => $(id).hidden = step !== key);
  if (step === 'brief') requestAnimationFrame(fitBrief);
  $('demo-journey').hidden = mode !== 'demo';
  document.querySelectorAll('[data-step]').forEach(node => {
    if (node.dataset.step === (step === 'preparing' ? 'results' : step)) node.setAttribute('aria-current', 'step');
    else node.removeAttribute('aria-current');
  });
  if (focus) {
    window.scrollTo({top:0, behavior:'instant'});
    const heading = $(sections[step]).querySelector('h1');
    if (heading?.hasAttribute('tabindex')) heading.focus({preventScroll:true});
  }
}
function fitBrief() {
  if ($('demo-brief').hidden) return;
  document.querySelectorAll('#demo-brief textarea').forEach(field => {
    field.style.height = 'auto';
    field.style.height = (field.scrollHeight + 2) + 'px';
  });
}
window.addEventListener('resize', fitBrief);
function draftFrom(snapshot) {
  return {weights: clone(snapshot.weights), priorities: clone(snapshot.capability_priorities)};
}
function importance(value) {
  if (value === 0) return 'Not prioritized';
  if (value < .34) return 'Some emphasis';
  if (value < .67) return 'More emphasis';
  return 'Strong emphasis';
}
function slider(group, key, label, description, value) {
  return `<div class="slider"><label for="${group}-${key}">${label}<output id="v-${group}-${key}">${importance(value)}</output></label><p id="hint-${group}-${key}">${description}</p><input type="range" id="${group}-${key}" min="0" max="1" step="0.01" value="${value}" aria-describedby="hint-${group}-${key}" aria-valuetext="${importance(value)} (${value.toFixed(2)})"><div class="range-labels"><span>Less emphasis</span><span>More emphasis</span></div></div>`;
}
function controls() {
  const draft = drafts[mode];
  $('weights').innerHTML = dims.map(([k, label, hint]) => slider('w', k, label, hint, draft.weights[k])).join('');
  $('priorities').innerHTML = caps.map(([k, label, hint]) => slider('p', k, label, hint, draft.priorities[k])).join('');
  $('preference-source').textContent = mode === 'demo'
    ? 'Uses saved Milanote evidence. No fresh research or external API calls.'
    : 'Adjusts the selected live result using its saved evidence. No new external API calls.';
}
function evidence(c) {
  return `<div class="dimensions">${dims.map(([k, label]) => {
    const d = c.raw_dimensions[k], score = c.dimensions[k].score;
    return `<div class="dimension"><b>${label}: ${score == null ? 'not measured' : score.toFixed(2) + '/10'}</b><p>${esc(d.reason)}</p>${d.evidence?.length ? '<ul>' + d.evidence.map(q => {
      let link = '';
      if (q.url && /^https:\/\/www\.youtube\.com\//.test(q.url)) link = `<a href="${esc(q.url)}" target="_blank" rel="noopener noreferrer">Source</a>`;
      else if (q.video_id && q.video_id !== 'channel-description') link = `<a href="https://www.youtube.com/watch?v=${encodeURIComponent(q.video_id)}" target="_blank" rel="noopener noreferrer">Source video</a>`;
      else if (q.video_id) link = 'Channel description';
      return `<li>${esc(q.quote || q.topic || 'Supporting source')} ${link}</li>`;
    }).join('') + '</ul>' : ''}</div>`;
  }).join('')}</div>`;
}
function contribution(c, index) {
  if (current.manual_roster) return 'Chosen by you as part of this team.';
  if (!index) return 'The strongest individual fit under your selected priorities.';
  if (c.marginal_components.coverage_gain <= 0) return 'Adds individual campaign fit alongside the selected teammates.';
  const earlier = current.roster.slice(0, index);
  const strongest = caps.map(([k, label]) => ({label, gain: current.capability_priorities[k] * Math.max(0, c.capabilities[k] - Math.max(...earlier.map(p => p.capabilities[k])))})).sort((a,b) => b.gain - a.gain)[0];
  return `Adds ${strongest.label.toLowerCase()} coverage beyond the teammates already selected.`;
}
function renderResults() {
  if (!current) return;
  $('mode-label').textContent = mode === 'demo' ? 'Milanote · recommendations from saved research' : 'Your live campaign · recommendations';
  $('team-context').textContent = current.campaign.specific_goal;
  $('team-intro').textContent = current.roster.length === 4
    ? 'Different strengths. One campaign. A team shaped around your priorities.'
    : `We found ${current.roster.length} eligible creators with these settings. Adjust your priorities to explore other options.`;
  $('restore').textContent = mode === 'demo' ? 'Restore original demo result' : 'Restore selected live result';
  $('run-meta').textContent = `Run ${current.run_id} | Evidence snapshot started ${current.data_snapshot_at} | ${current.campaign.objective}`;
  $('ranking-count').textContent = `${current.ranking.length} shortlisted creators. Ranking weights and team priorities are independent.`;
  const selected = new Set(current.roster.map(c => c.handle));
  $('roster').innerHTML = current.roster.map((c,i) => {
    const initials = c.title.split(/\s+/).filter(Boolean).slice(0,2).map(x => x[0]).join('');
    const excerpt = c.raw_dimensions.brand_fit.reason.split(/(?<=\.)\s+/)[0];
    return `<article class="role"><div class="role-top"><div class="avatar" aria-hidden="true">${esc(initials)}</div><span class="tag">${current.manual_roster ? 'Your selection' : 'Recommended'}</span></div><h3>${esc(c.title)}</h3><p class="handle">${esc(c.handle)}</p><p class="fit-reason"><span class="ai-label">AI fit assessment · excerpt</span>${esc(excerpt)}</p><p class="contribution">${esc(contribution(c,i))}</p>${c.brand_safety === 'REVIEW' ? '<p class="note">Flagged for metadata review before outreach.</p>' : ''}<details><summary>Why this creator · scores and evidence</summary><p class="note">Individual rank #${current.ranking.findIndex(x=>x.handle===c.handle)+1} · combined score ${c.combined_score.toFixed(2)}/10 · metadata safety: ${esc(c.brand_safety)}</p><p class="note">Original model explanations below. Not independently verified.</p>${evidence(c)}</details></article>`;
  }).join('');
  $('ranking').innerHTML = current.ranking.map(c => `<article class="candidate ${selected.has(c.handle) ? 'selected' : ''}"><div class="candidate-top"><div class="who"><b>${esc(c.title)}</b><span class="note">${esc(c.handle)} · ${esc(c.brand_safety)}${selected.has(c.handle) ? ' · In your team' : ''}</span></div></div><details><summary>View assessment and scores</summary><p class="note">Combined score: ${c.combined_score == null ? 'unmeasured' : c.combined_score.toFixed(2) + '/10'}</p>${evidence(c)}</details>${!selected.has(c.handle) && c.brand_safety !== 'FAIL' && c.combined_score != null && current.roster.length ? `<div class="swap"><select aria-label="Creator to replace with ${esc(c.handle)}">${current.roster.map(r=>`<option value="${esc(r.handle)}">Replace ${esc(r.title)}</option>`).join('')}</select><button data-swap="${esc(c.handle)}">Add to my team</button></div>` : ''}</article>`).join('');
  $('warning-summary').textContent = current.warnings.length ? `Things to review before outreach (${current.warnings.length})` : 'Research limitations to keep in mind';
  $('warnings').innerHTML = current.warnings.map(w=>`<li>${esc(w)}</li>`).join('') || '<li>No roster warnings recorded.</li>';
}
function acceptResult(result) {
  current = result;
  if (mode === 'demo') demoCurrent = result; else liveCurrent = result;
  drafts[mode] = draftFrom(result);
}
async function findTeam() {
  if (busy || !current) return;
  message();
  const draft = clone(drafts[mode]);
  if (!Object.values(draft.weights).some(v=>v>0)) {
    message('Give at least one individual-fit priority some emphasis before finding your team.');
    return;
  }
  setBusy(true); show('preparing');
  try {
    // A short visual transition accompanies a real local backend calculation.
    // It never suggests that discovery or new AI research is happening.
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1100;
    const [result] = await Promise.all([
      api('/api/rescore', {run_id:current.run_id, ...draft}),
      new Promise(resolve=>setTimeout(resolve, delay))
    ]);
    acceptResult(result); renderResults(); show('results');
    $('shortlist-panel').open = false; $('technical-panel').open = false;
  } catch (e) {
    show('preferences'); message(e.message);
  } finally { setBusy(false); }
}
async function swap(outgoing, incoming) {
  if (busy) return;
  setBusy(true); message();
  try {
    acceptResult(await api('/api/rescore', {run_id:current.run_id, swap:[outgoing,incoming]}));
    renderResults();
  } catch (e) { message(e.message); }
  finally { setBusy(false); }
}
function openPreferences(fromResult = false) {
  if (busy || !current) return;
  if (fromResult || !drafts[mode]) drafts[mode] = draftFrom(current);
  controls(); message(); show('preferences');
}
function setMode(next) {
  if (busy || !baseline) return;
  mode = next;
  $('demo-mode').setAttribute('aria-pressed', next === 'demo');
  $('live-mode').setAttribute('aria-pressed', next === 'live');
  current = next === 'demo' ? demoCurrent : liveCurrent;
  message();
  const step = next === 'demo' ? demoStep : liveStep;
  if (step === 'results') renderResults();
  if (step === 'preferences') controls();
  show(step);
}
function populateCampaign(c) {
  for (const k of ['product_description','audience','objective','specific_goal']) $(k).value = c[k];
  for (const k of ['banned_phrases','raw_tone','category_exclusions','competitors']) $(k).value = Array.isArray(c.brand_requirements[k]) ? c.brand_requirements[k].join('\n') : c.brand_requirements[k];
  $('demo-product').value = c.product_description;
  $('demo-objective').value = c.objective;
  $('demo-goal').value = c.specific_goal;
  $('demo-audience').value = c.audience;
  $('demo-requirements').innerHTML = [['raw_tone','Brand voice'],['banned_phrases','Phrases to avoid'],['category_exclusions','Excluded categories'],['competitors','Competitors']].map(([k,label])=>`<h3>${label}</h3>${Array.isArray(c.brand_requirements[k]) ? '<ul>'+c.brand_requirements[k].map(x=>`<li>${esc(x)}</li>`).join('')+'</ul>' : '<p>'+esc(c.brand_requirements[k])+'</p>'}`).join('');
}
function campaign() {
  const c = {};
  for (const k of ['product_description','audience','objective','specific_goal']) c[k] = $(k).value;
  c.brand_requirements = {raw_tone:$('raw_tone').value};
  for (const k of ['banned_phrases','category_exclusions','competitors']) c.brand_requirements[k] = $(k).value.split('\n').map(x=>x.trim()).filter(Boolean);
  return c;
}
async function start(resume) {
  message();
  if (!$('consent').checked) { message('Please confirm API quota use before starting or resuming.'); return; }
  try {
    const j = await api('/api/live', resume ? {resume,confirm:true} : {campaign:campaign(),use_trends:$('use-trends').checked,confirm:true});
    activeJob = j.id; await poll();
  } catch (e) { message(e.message); }
}
async function poll() {
  if (polling) return;
  polling = true;
  try {
    jobs = (await api('/api/jobs')).jobs;
    const selection = $('live-runs').value;
    $('live-runs').innerHTML = '<option value="">Select a completed run</option>'+jobs.filter(j=>j.status==='complete').map(j=>`<option value="${esc(j.run_id)}">${esc(j.run_id)}</option>`).join('');
    $('live-runs').value = selection;
    const j = jobs.find(x=>x.id===activeJob) || jobs.at(-1);
    $('start').disabled = jobs.some(x=>x.status==='running');
    $('live-error').hidden = !j || j.status !== 'failed';
    if (j) {
      $('job-status').textContent = j.status === 'running' ? j.stage : j.status === 'complete' ? 'Live run complete. Results saved separately.' : 'Live run stopped.';
      if (j.status === 'failed') {
        $('failure-reason').textContent = j.reason;
        $('checkpoint-note').textContent = j.checkpoint_saved ? 'Checkpoint saved. Completed work can be reused; unfinished calls still use quota.' : 'No checkpoint was created.';
        $('resume').disabled = !j.checkpoint_saved; activeJob = j.id;
      }
      if (j.status === 'complete' && activeJob === j.id && !busy) {
        liveCurrent = await api('/api/run/'+j.run_id);
        drafts.live = draftFrom(liveCurrent);
        $('live-runs').value = j.run_id; activeJob = null;
        liveStep = 'results';
        if (mode === 'live') { current = liveCurrent; renderResults(); show('results'); }
      }
    }
  } catch (e) {
    message('Local server unavailable. Restart it if needed; your saved research is unchanged.');
  } finally { polling = false; }
}

$('demo-mode').onclick = ()=>setMode('demo');
$('live-mode').onclick = ()=>setMode('live');
$('brief-next').onclick = ()=>openPreferences();
$('refine').onclick = ()=>openPreferences(true);
$('preferences-back').onclick = ()=>show(mode === 'demo' ? 'brief' : 'results');
$('restart').onclick = ()=>{ message(); show(mode === 'demo' ? 'brief' : 'live'); };
$('apply').onclick = findTeam;
$('reset').onclick = async()=>{
  if (busy) return;
  message();
  if (mode === 'demo') { drafts.demo = draftFrom(baseline); controls(); return; }
  setBusy(true);
  try { const result = await api('/api/rescore', {run_id:current.run_id, reset:true}); acceptResult(result); controls(); }
  catch(e) { message(e.message); }
  finally { setBusy(false); }
};
$('restore').onclick = async()=>{
  if (busy) return;
  setBusy(true);
  try {
    if (mode === 'demo') acceptResult(baseline);
    else if ($('live-runs').value) acceptResult(await api('/api/run/'+$('live-runs').value));
    renderResults();
  } catch(e) { message(e.message); }
  finally { setBusy(false); }
};
$('pdf').onclick = ()=>{ if(current===baseline || !current.revised) window.open('./report.pdf','_blank','noopener'); else window.print(); };
$('ranking').onclick = e=>{
  const b = e.target.closest('[data-swap]');
  if (b) swap(b.parentElement.querySelector('select').value, b.dataset.swap);
};
document.addEventListener('input', e=>{
  if (e.target.type !== 'range') return;
  const group = e.target.id.slice(0,1), key = e.target.id.slice(2), value = Number(e.target.value);
  drafts[mode][group === 'w' ? 'weights' : 'priorities'][key] = value;
  $('v-'+e.target.id).textContent = importance(value);
  e.target.setAttribute('aria-valuetext', `${importance(value)} (${value.toFixed(2)})`);
});
$('campaign-form').onsubmit = e=>{ e.preventDefault(); start(); };
$('resume').onclick = ()=>start(activeJob);
$('live-runs').onchange = async()=>{
  try {
    if (!$('live-runs').value || busy) return;
    const result = await api('/api/run/'+$('live-runs').value);
    liveCurrent = result; drafts.live = draftFrom(result); liveStep = 'results';
    if (mode === 'live') { current = result; renderResults(); show('results'); }
  } catch(e) { message(e.message); }
};
(async()=>{
  try {
    const state = await api('/api/state');
    token = state.token; baseline = state.demo; demoCurrent = baseline; current = baseline;
    drafts.demo = draftFrom(baseline); populateCampaign(baseline.campaign);
    $('brief-next').disabled = false; show('brief', false);
    await poll();
  } catch(e) { message('Could not load the saved demo. '+e.message); }
})();
