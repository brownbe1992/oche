'use strict';
/* Dart Builder / loadouts, and the component editor.
 *
 * Split out of frontend/index.html (docs/frontend-module-split-roadmap.md). A CLASSIC
 * script, deliberately not an ES module: classic scripts share one global scope, so
 * every name here stays visible to the rest of the app exactly as it was inside the one
 * big <script> block, and the ~335 inline on*= handlers keep resolving. The roadmap doc
 * records why ES modules were measured and rejected.
 *
 * Not self-contained, and not meant to be read as if it were: it calls freely into the
 * rest of the app and the rest of the app calls freely into it. The split buys
 * navigability, not isolation. Nothing here runs at load time beyond declaring names.
 */

/* =========================================================================
   DART BUILDER / LOADOUTS  (docs/archive/dart-builder-roadmap.md)
   Reachable from a player's profile ("Manage Loadouts", inside the same
   PIN-gated player-controls block as the finish-rule toggle) and from the New
   Game screen's "Build a loadout" shortcut. Two views inside one screen: a
   loadout list, and a per-loadout editor (component slots + tip texture +
   that loadout's own stats). Simplified from the roadmap doc's CoD-gunsmith
   sketch to a stacked grouped-section layout rather than a literal fanning-
   callout dart illustration — functionally equivalent, and inherently mobile-
   responsive since there's no wide side-callout layout to collapse.
   ========================================================================= */
const DART_ENUM_LABELS = {
  tungsten_80:'Tungsten 80%', tungsten_90:'Tungsten 90%', tungsten_95:'Tungsten 95%', tungsten_97:'Tungsten 97%',
  nickel_silver:'Nickel-Silver', standard_poly:'Standard Polyester', fabric_reinforced:'Fabric-Reinforced',
  extra_long:'Extra Long', carbon_fiber:'Carbon Fiber',
};
function enumLabel(v){
  if(v==null || v==='') return '';
  if(DART_ENUM_LABELS[v]) return DART_ENUM_LABELS[v];
  return String(v).split('_').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
}

let _dartBuilderOptions = null;
let _dartBuilderComponents = { barrel:[], shaft:[], flight:[] };

async function renderDartBuilderScreen(){
  const el = document.getElementById('dart-builder-body');
  if(!el || !dartBuilderPlayer) return;
  if(!_dartBuilderOptions){
    try{ _dartBuilderOptions = await Backend.get('/api/dart-components/options'); }
    catch(e){ el.innerHTML = '<p style="color:var(--muted)">Could not load the Dart Builder right now.</p>'; return; }
  }
  if(dartBuilderView === 'edit') await renderDartBuilderEdit();
  else if(dartBuilderView === 'compare') await renderDartBuilderCompare();
  else if(dartBuilderView === 'quickadd') renderDartBuilderQuickAdd();
  else await renderDartBuilderList();
}

async function renderDartBuilderList(){
  const el = document.getElementById('dart-builder-body');
  const player = dartBuilderPlayer;
  let loadouts = [], defaultLoadout = null;
  try{ [loadouts, defaultLoadout] = await Promise.all([DB.listLoadouts(player), DB.getDefaultLoadout(player)]); }
  catch(e){ el.innerHTML = '<p style="color:var(--muted)">Could not load loadouts.</p>'; return; }
  const defaultId = defaultLoadout ? defaultLoadout.id : null;
  const cards = loadouts.map(lo=>{
    const parts = [lo.barrel, lo.shaft, lo.flight].filter(Boolean).map(c=>c.name).join(' · ') || 'No components yet';
    const lj = jsArg(lo.name);
    return `<div class="card" style="margin-bottom:10px;padding:14px">
      <div style="font-weight:600">${escapeHtml(lo.name)} ${lo.id===defaultId?'<span style="color:var(--gold);font-size:12px">★ Default</span>':''}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:2px">${escapeHtml(parts)}</div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn btn-ghost" onclick="openDartBuilderEdit(${lo.id})">Edit</button>
        <button class="btn btn-ghost" onclick="duplicateDartBuilderLoadout(${lo.id})">Duplicate</button>
        <button class="btn btn-ghost danger" onclick="deleteDartBuilderLoadout(${lo.id},'${lj}')">Delete</button>
      </div>
    </div>`;
  }).join('');
  el.innerHTML = `
    <h2 style="font-size:18px;margin-bottom:4px">${escapeHtml(player)}'s Loadouts</h2>
    <p style="font-size:13px;color:var(--muted);margin:0 0 14px;line-height:1.6">
      Build a saved combination of barrel, shaft, and flight, pick one before a game (New Game's "Change Loadout" button),
      or set one as the default from ${escapeHtml(player)}'s profile so it's chosen automatically.
    </p>
    <div class="btn-row" style="margin-bottom:14px">
      <button class="btn btn-primary" onclick="openDartBuilderEdit(null)">+ New Loadout</button>
      <button class="btn btn-ghost" onclick="openDartBuilderQuickAdd()">⚡ Quick Add Full Set</button>
      ${loadouts.length >= 2 ? `<button class="btn btn-ghost" onclick="openDartBuilderCompare()">⚖️ Compare Loadouts</button>` : ''}
    </div>
    ${cards || '<p style="color:var(--muted);font-size:13px">No loadouts yet.</p>'}
  `;
}

// Loadout comparison view (docs/archive/dart-builder-roadmap.md "loadout comparison
// view", the v1 stretch goal). Side-by-side stats for two or more of a
// player's loadouts, entered from the list screen — same "own screen, not a
// Player Profile filter" placement getLoadoutStats() itself already uses.
function openDartBuilderCompare(){
  dartBuilderView = 'compare';
  _dartBuilderCompareStats = null;
  renderDartBuilderScreen();
}
let _dartBuilderCompareLoadouts = [];
async function renderDartBuilderCompare(){
  const el = document.getElementById('dart-builder-body');
  const player = dartBuilderPlayer;
  // Loadouts + every one's stats are fetched once per screen-entry (guarded by
  // _dartBuilderCompareStats being null, reset only by openDartBuilderCompare()) —
  // toggling a checkbox afterward only touches dartBuilderCompareSelected and
  // re-renders from the cached data, no re-fetch.
  if(!_dartBuilderCompareStats){
    let loadouts = [];
    try{ loadouts = await DB.listLoadouts(player); }
    catch(e){ el.innerHTML = '<p style="color:var(--muted)">Could not load loadouts.</p>'; return; }
    if(loadouts.length < 2){
      el.innerHTML = `<p style="color:var(--muted);font-size:13px">Need at least 2 loadouts to compare.</p>
        <button class="btn btn-ghost" style="margin-top:10px" onclick="dartBuilderView='list';renderDartBuilderScreen();">Back to Loadouts</button>`;
      return;
    }
    try{
      const statsList = await Promise.all(loadouts.map(lo=>DB.loadoutStats(player, lo.id)));
      _dartBuilderCompareStats = {};
      loadouts.forEach((lo,i)=>{ _dartBuilderCompareStats[lo.id] = statsList[i]; });
    }catch(e){ el.innerHTML = '<p style="color:var(--muted)">Could not load loadout stats.</p>'; return; }
    _dartBuilderCompareLoadouts = loadouts;
    dartBuilderCompareSelected = new Set(loadouts.map(lo=>lo.id));   // select all by default
  }
  el.innerHTML = `
    <div style="margin-bottom:14px">
      <h2 style="font-size:18px;margin-bottom:4px">Compare Loadouts</h2>
      <p style="font-size:13px;color:var(--muted);margin:0 0 10px;line-height:1.6">Tap a loadout to add or remove it from the table below.</p>
      <div class="btn-row" role="group" aria-label="Loadouts to compare" style="flex-wrap:wrap" id="db-compare-toggles"></div>
      <button class="btn btn-ghost" style="margin-top:10px" onclick="dartBuilderView='list';renderDartBuilderScreen();">Back to Loadouts</button>
    </div>
    <div id="db-compare-table"></div>
  `;
  renderDartBuilderCompareToggles();
  renderDartBuilderCompareTable();
}
function renderDartBuilderCompareToggles(){
  const el = document.getElementById('db-compare-toggles');
  if(!el) return;
  el.innerHTML = _dartBuilderCompareLoadouts.map(lo=>{
    const on = dartBuilderCompareSelected.has(lo.id);
    return `<button type="button" class="btn btn-ghost" aria-pressed="${on}" style="${on?'background:var(--surface-2);color:var(--ink);border-color:var(--muted)':''}" onclick="toggleDartBuilderCompareLoadout(${lo.id})">${escapeHtml(lo.name)}</button>`;
  }).join('');
}
function toggleDartBuilderCompareLoadout(id){
  if(dartBuilderCompareSelected.has(id)) dartBuilderCompareSelected.delete(id);
  else dartBuilderCompareSelected.add(id);
  renderDartBuilderCompareToggles();
  renderDartBuilderCompareTable();
}
function renderDartBuilderCompareTable(){
  const el = document.getElementById('db-compare-table');
  if(!el) return;
  const selected = _dartBuilderCompareLoadouts.filter(lo=>dartBuilderCompareSelected.has(lo.id));
  if(selected.length < 2){
    el.innerHTML = `<p style="color:var(--muted);font-size:13px">Select at least 2 loadouts to compare.</p>`;
    return;
  }
  const rows = [
    { label:'Components', fmt:lo=>[lo.barrel,lo.shaft,lo.flight].filter(Boolean).map(c=>c.name).join(' · ') || 'No components yet' },
    { label:'Games played', fmt:lo=>String(_dartBuilderCompareStats[lo.id].gamesPlayed) },
    { label:'Wins', fmt:lo=>String(_dartBuilderCompareStats[lo.id].wins) },
    { label:'Win %', fmt:lo=>{ const s=_dartBuilderCompareStats[lo.id]; return s.gamesPlayed>0 ? Math.round(s.wins/s.gamesPlayed*100)+'%' : '—'; } },
    { label:'Darts thrown', fmt:lo=>String(_dartBuilderCompareStats[lo.id].dartsThrown) },
    { label:'3-dart average', fmt:lo=>{ const v=_dartBuilderCompareStats[lo.id].avg; return v!=null ? v.toFixed(1) : '—'; } },
    { label:'180s', fmt:lo=>String(_dartBuilderCompareStats[lo.id].one80s) },
    { label:'Checkouts', fmt:lo=>String(_dartBuilderCompareStats[lo.id].checkouts) },
  ];
  el.innerHTML = `<div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr>
        <th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--wire);color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em"></th>
        ${selected.map(lo=>`<th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--wire);font-weight:600">${escapeHtml(lo.name)}</th>`).join('')}
      </tr></thead>
      <tbody>
        ${rows.map(r=>`<tr>
          <td style="padding:8px 10px;border-bottom:1px solid var(--wire);color:var(--muted)">${r.label}</td>
          ${selected.map(lo=>`<td style="padding:8px 10px;border-bottom:1px solid var(--wire)">${escapeHtml(r.fmt(lo))}</td>`).join('')}
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

// Quick Add Full Set (docs/archive/dart-builder-roadmap.md "quick-add full set" one-shot
// entry form). No new backend endpoint — orchestrates the same createComponent()
// x3 + createLoadout() calls the normal 3-modal flow already makes, just from one
// screen with one Save button, for logging an off-the-shelf set that came as a
// matched barrel/shaft/flight in one go.
function openDartBuilderQuickAdd(){
  dartBuilderView = 'quickadd';
  renderDartBuilderScreen();
}
// Renders one component type's field set inline (not in a modal — every id gets
// a `qa-{type}-` prefix so all three can coexist on the same page). Mirrors
// openComponentEditor()'s exact field set per type; shape/grip use the same
// icon pickers, keyed off the same `qa-{type}-shape`/`qa-{type}-grip` ids
// submitDartBuilderQuickAdd() reads back.
function quickAddComponentFieldsHtml(type){
  const typeOpts = _dartBuilderOptions[type];
  const isShaft = type === 'shaft';
  const shapeList = isShaft ? typeOpts.types : typeOpts.shapes;
  const lengthList = type !== 'flight' ? typeOpts.lengthRanges : null;
  const label = type.charAt(0).toUpperCase()+type.slice(1);
  return `<div class="pp-section">
    <div class="pp-section-title">${label}</div>
    <label class="field">Name</label>
    <input type="text" id="qa-${type}-name" maxlength="64" placeholder="e.g. Red Dragon Razer Edge" style="margin-bottom:10px">
    ${lengthList ? `<label class="field">Length</label>
    <select id="qa-${type}-length" style="width:auto;margin-bottom:10px">
      <option value="">Not set</option>
      ${lengthList.map(v=>`<option value="${v}">${enumLabel(v)}</option>`).join('')}
    </select>` : ''}
    ${type==='barrel' ? `<label class="field">Weight</label>
    <select id="qa-${type}-weight" style="width:auto;margin-bottom:10px">
      <option value="">Not set</option>
      ${typeOpts.weights.map(g=>`<option value="${g}">${g}g</option>`).join('')}
    </select>` : ''}
    <label class="field">Material</label>
    <select id="qa-${type}-material" style="width:auto;margin-bottom:10px">
      <option value="">Not set</option>
      ${typeOpts.materials.map(v=>`<option value="${v}">${enumLabel(v)}</option>`).join('')}
    </select>
    <label class="field">${isShaft?'Type':'Shape'}</label>
    ${isShaft
      ? `<select id="qa-${type}-shape" style="width:auto;margin-bottom:10px">
          <option value="">Not set</option>
          ${shapeList.map(v=>`<option value="${v}">${enumLabel(v)}</option>`).join('')}
        </select>`
      : iconPickerHtml(`qa-${type}-shape`, type==='barrel' ? 'barrelShape' : 'flightShape', shapeList, `${label} shape`, null)}
    ${type==='barrel' ? `<label class="field">Grip</label>
    ${iconPickerHtml(`qa-${type}-grip`, 'barrelGrip', typeOpts.grips, 'Barrel grip', null)}` : ''}
  </div>`;
}
function renderDartBuilderQuickAdd(){
  const el = document.getElementById('dart-builder-body');
  const player = dartBuilderPlayer;
  el.innerHTML = `
    <div style="margin-bottom:14px">
      <h2 style="font-size:18px;margin-bottom:4px">Quick Add Full Set</h2>
      <p style="font-size:13px;color:var(--muted);margin:0 0 10px;line-height:1.6">
        Log an off-the-shelf dart set — name the loadout, fill in the barrel, shaft, and flight that came with it, and save once.
      </p>
      <label class="field">Loadout name</label>
      <input type="text" id="qa-name" maxlength="64" placeholder="e.g. Match Set" style="margin-bottom:10px">
      <button class="btn btn-ghost" onclick="dartBuilderView='list';renderDartBuilderScreen();">Back to Loadouts</button>
    </div>
    ${quickAddComponentFieldsHtml('barrel')}
    ${quickAddComponentFieldsHtml('shaft')}
    ${quickAddComponentFieldsHtml('flight')}
    <div class="pp-section">
      <div class="pp-section-title">Tip Texture</div>
      <select id="qa-tip-texture" style="width:auto">
        <option value="">Not set</option>
        ${(_dartBuilderOptions.tipTextures||[]).map(v=>`<option value="${v}">${enumLabel(v)}</option>`).join('')}
      </select>
    </div>
    <div id="qa-error" style="color:var(--danger,#e5484d);font-size:12px;margin:10px 0" hidden></div>
    <div class="btn-row" style="margin-top:14px">
      <button class="btn btn-primary" onclick="submitDartBuilderQuickAdd()">Save Full Set</button>
    </div>
  `;
}
function quickAddFields(type){
  const get = id => { const el = document.getElementById(id); return el && el.value ? el.value : null; };
  const fields = { name: get(`qa-${type}-name`) };
  if(type !== 'flight') fields.lengthMm = get(`qa-${type}-length`);
  if(type === 'barrel') fields.weightG = get(`qa-${type}-weight`) ? Number(get(`qa-${type}-weight`)) : null;
  fields.material = get(`qa-${type}-material`);
  fields.shape = get(`qa-${type}-shape`);
  if(type === 'barrel') fields.grip = get(`qa-${type}-grip`);
  return fields;
}
function submitDartBuilderQuickAdd(){
  const player = dartBuilderPlayer;
  const errEl = document.getElementById('qa-error');
  const loadoutName = document.getElementById('qa-name').value.trim();
  const barrel = quickAddFields('barrel'), shaft = quickAddFields('shaft'), flight = quickAddFields('flight');
  if(!loadoutName){ errEl.textContent = 'Loadout name is required.'; errEl.hidden = false; return; }
  if(!barrel.name || !shaft.name || !flight.name){
    errEl.textContent = 'Name is required for the barrel, shaft, and flight.';
    errEl.hidden = false;
    return;
  }
  errEl.hidden = true;
  // Sequential, not Promise.all: if the shaft or flight name turns out invalid,
  // stopping partway is preferable to firing all three requests in parallel and
  // having to reconcile which succeeded — the components created so far are
  // never lost either way (they're real, independently usable catalog entries),
  // just not yet attached to a saved loadout.
  DB.createComponent(player, 'barrel', barrel)
    .then(b => DB.createComponent(player, 'shaft', shaft).then(s => [b, s]))
    .then(([b, s]) => DB.createComponent(player, 'flight', flight).then(f => [b, s, f]))
    .then(([b, s, f]) => DB.createLoadout(player, {
      name: loadoutName, barrelId: b.id, shaftId: s.id, flightId: f.id,
      tipTexture: document.getElementById('qa-tip-texture').value || null,
    }))
    .then(lo => {
      dartBuilderView = 'edit';
      dartBuilderLoadoutId = lo.id;
      renderDartBuilderScreen();
    })
    .catch(e => {
      errEl.textContent = (e.message || 'Could not save that set.') + ' Any components already created are still in the catalog — you can assign them to a loadout from the normal editor.';
      errEl.hidden = false;
    });
}

function openDartBuilderEdit(loadoutId){
  dartBuilderView = 'edit';
  dartBuilderLoadoutId = loadoutId;
  renderDartBuilderScreen();
}
function duplicateDartBuilderLoadout(id){
  DB.duplicateLoadout(dartBuilderPlayer, id).then(()=>renderDartBuilderScreen()).catch(e=>uiAlert(e.message||'Could not duplicate that loadout.'));
}
function deleteDartBuilderLoadout(id, name){
  uiConfirm(`Delete loadout "${name}"? This can't be undone.`, ()=>{
    DB.deleteLoadout(dartBuilderPlayer, id).then(()=>renderDartBuilderScreen()).catch(e=>uiAlert(e.message||'Could not delete that loadout.'));
  });
}

async function loadDartBuilderComponents(){
  const player = dartBuilderPlayer;
  const [barrel, shaft, flight] = await Promise.all([
    DB.listComponents(player, 'barrel'), DB.listComponents(player, 'shaft'), DB.listComponents(player, 'flight'),
  ]);
  _dartBuilderComponents = { barrel, shaft, flight };
}
function refreshDartBuilderSlot(type, selectId){
  const sel = document.getElementById('db-slot-'+type);
  if(!sel) return;
  const list = _dartBuilderComponents[type] || [];
  sel.innerHTML = '<option value="">— none —</option>' + list.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  if(selectId) sel.value = selectId;
}

async function renderDartBuilderEdit(){
  const el = document.getElementById('dart-builder-body');
  const player = dartBuilderPlayer;
  const id = dartBuilderLoadoutId;
  let loadout = null;
  if(id){
    try{ loadout = await DB.getLoadout(player, id); }catch(e){ loadout = null; }
  }
  await loadDartBuilderComponents();
  const name = loadout ? loadout.name : '';
  const tipTexture = loadout ? (loadout.tipTexture || '') : '';
  const currentBarrelId = loadout && loadout.barrel ? loadout.barrel.id : null;
  const currentShaftId  = loadout && loadout.shaft  ? loadout.shaft.id  : null;
  const currentFlightId = loadout && loadout.flight ? loadout.flight.id : null;

  function slotHtml(type, currentId, label){
    const list = _dartBuilderComponents[type] || [];
    return `<div class="pp-section">
      <div class="pp-section-title">${label}</div>
      <select id="db-slot-${type}" style="width:auto;margin-bottom:6px">
        <option value="">— none —</option>
        ${list.map(c=>`<option value="${c.id}" ${currentId===c.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('')}
      </select>
      <button type="button" class="btn btn-ghost" style="margin-left:6px;padding:6px 10px;font-size:12px" onclick="openComponentEditor('${type}')">+ New ${label}</button>
    </div>`;
  }

  el.innerHTML = `
    <div style="margin-bottom:14px">
      <label class="field">Loadout name</label>
      <input type="text" id="db-name" maxlength="64" value="${escapeHtml(name)}" placeholder="e.g. Match Set" style="margin-bottom:10px">
      <button class="btn btn-ghost" onclick="dartBuilderView='list';renderDartBuilderScreen();">Change Loadout</button>
    </div>
    ${slotHtml('barrel', currentBarrelId, 'Barrel')}
    ${slotHtml('shaft', currentShaftId, 'Shaft')}
    ${slotHtml('flight', currentFlightId, 'Flight')}
    <div class="pp-section">
      <div class="pp-section-title">Tip Texture</div>
      <select id="db-tip-texture" style="width:auto">
        <option value="">Not set</option>
        ${(_dartBuilderOptions.tipTextures||[]).map(v=>`<option value="${v}" ${tipTexture===v?'selected':''}>${enumLabel(v)}</option>`).join('')}
      </select>
    </div>
    <div id="db-error" style="color:var(--danger,#e5484d);font-size:12px;margin:10px 0" hidden></div>
    <div class="btn-row" style="margin-top:14px">
      <button class="btn btn-primary" onclick="submitDartBuilderLoadout()">Save Loadout</button>
    </div>
    <div id="db-stats-section" style="margin-top:20px"></div>
  `;
  if(id) loadDartBuilderStats(id);
}

function submitDartBuilderLoadout(){
  const player = dartBuilderPlayer;
  const name = document.getElementById('db-name').value.trim();
  const errEl = document.getElementById('db-error');
  if(!name){ errEl.textContent = 'Loadout name is required.'; errEl.hidden = false; return; }
  const fields = {
    name,
    barrelId: document.getElementById('db-slot-barrel').value || null,
    shaftId:  document.getElementById('db-slot-shaft').value  || null,
    flightId: document.getElementById('db-slot-flight').value || null,
    tipTexture: document.getElementById('db-tip-texture').value || null,
  };
  const req = dartBuilderLoadoutId ? DB.updateLoadout(player, dartBuilderLoadoutId, fields) : DB.createLoadout(player, fields);
  req.then(lo=>{
    dartBuilderLoadoutId = lo.id;
    renderDartBuilderScreen();   // stays on the edit view; now has an id, so stats load below
  }).catch(e=>{ errEl.textContent = e.message || 'Could not save that loadout.'; errEl.hidden = false; });
}

function loadDartBuilderStats(id){
  const el = document.getElementById('db-stats-section');
  if(!el) return;
  DB.loadoutStats(dartBuilderPlayer, id).then(s=>{
    el.innerHTML = `
      <div class="pp-section-title">Stats with this loadout</div>
      <div class="pp-cat-lines">
        <div>Games played: ${s.gamesPlayed}</div>
        <div>Wins: ${s.wins}</div>
        <div>Darts thrown: ${s.dartsThrown}</div>
        <div>3-dart average: ${s.avg!=null ? s.avg.toFixed(1) : '—'}</div>
        <div>180s: ${s.one80s}</div>
        <div>Checkouts: ${s.checkouts}</div>
      </div>`;
  }).catch(()=>{ el.innerHTML = ''; });
}

// Simple schematic diagrams for the three enum fields whose plain-text option
// names aren't self-explanatory (docs/archive/dart-builder-roadmap.md's deferred
// accessibility item, built 2026-07) — barrel shape/grip (side profile) and
// flight shape (front-on outline). Deliberately plain/geometric rather than
// photorealistic, same "hand-coded inline SVG" style buildDartboard() already
// uses elsewhere — `currentColor` throughout so each icon inherits its button's
// text color (and so the selected/gold state above just works, in both themes).
const COMPONENT_ICONS = {
  barrelShape: {
    straight: `<svg viewBox="0 0 64 20" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="5" width="48" height="10" rx="5"/></svg>`,
    torpedo:  `<svg viewBox="0 0 64 20" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="32" cy="10" rx="26" ry="7"/></svg>`,
    ton:      `<svg viewBox="0 0 64 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M10,10 C10,6 16,4 24,4 L46,4 C54,4 58,7 58,10 C58,13 54,16 46,16 L24,16 C16,16 10,14 10,10 Z"/></svg>`,
  },
  barrelGrip: {
    smooth:  `<svg viewBox="0 0 64 20" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="5" width="48" height="10" rx="5"/></svg>`,
    knurled: `<svg viewBox="0 0 64 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="8" y="5" width="48" height="10" rx="5"/>
      <path d="M16,5 L20,15 M22,5 L26,15 M28,5 L32,15 M34,5 L38,15 M40,5 L44,15 M46,5 L50,15"/></svg>`,
    ringed:  `<svg viewBox="0 0 64 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="8" y="5" width="48" height="10" rx="5"/>
      <path d="M18,5 L18,15 M26,5 L26,15 M34,5 L34,15 M42,5 L42,15 M50,5 L50,15"/></svg>`,
  },
  flightShape: {
    standard: `<svg viewBox="0 0 32 40" fill="none" stroke="currentColor" stroke-width="2"><path d="M16,3 L28,14 L28,30 C28,34 22,37 16,37 C10,37 4,34 4,30 L4,14 Z"/></svg>`,
    slim:     `<svg viewBox="0 0 32 40" fill="none" stroke="currentColor" stroke-width="2"><path d="M16,3 L23,14 L23,30 C23,34 20,37 16,37 C12,37 9,34 9,30 L9,14 Z"/></svg>`,
    kite:     `<svg viewBox="0 0 32 40" fill="none" stroke="currentColor" stroke-width="2"><path d="M16,3 L28,20 L16,37 L4,20 Z"/></svg>`,
    pear:     `<svg viewBox="0 0 32 40" fill="none" stroke="currentColor" stroke-width="2"><path d="M16,3 C19,3 20,8 19,13 C25,17 29,24 29,29 C29,34 23,37 16,37 C9,37 3,34 3,29 C3,24 7,17 13,13 C12,8 13,3 16,3 Z"/></svg>`,
  },
};
// Renders one field's icon-picker group. `fieldId` is the hidden input whose
// `.value` submitComponentEditor() actually reads (kept identical to the
// plain-<select> field ids it replaces, e.g. "ce-shape"/"ce-grip" — so the
// submit path needed zero changes for this). `iconSetKey` indexes
// COMPONENT_ICONS; `values` is the enum list from getDartComponentOptions().
function iconPickerHtml(fieldId, iconSetKey, values, groupLabel, selected){
  const icons = COMPONENT_ICONS[iconSetKey] || {};
  const opts = values.map(v => `<button type="button" class="icon-opt" data-val="${v}"
      aria-pressed="${v===selected}" aria-label="${escapeHtml(enumLabel(v))}"
      onclick="selectIconOpt('${fieldId}','${v}')">
      ${icons[v] || ''}<span class="icon-opt-label" aria-hidden="true">${escapeHtml(enumLabel(v))}</span>
    </button>`).join('');
  return `<div class="icon-picker" role="group" aria-label="${escapeHtml(groupLabel)}">${opts}</div>
    <input type="hidden" id="${fieldId}" value="${escapeHtml(selected || '')}">`;
}
function selectIconOpt(fieldId, value){
  const input = document.getElementById(fieldId);
  if(!input) return;
  input.value = value;
  const group = input.previousElementSibling;
  if(group) [...group.children].forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.val === value)));
}

// New-component modal, reused for both the "+ New {type}" slot buttons above.
// Field set is derived from /api/dart-components/options per type — no
// duplicated enum list on the frontend (single source of truth stays db.js's
// getDartComponentOptions()).
function openComponentEditor(type){
  const opts = _dartBuilderOptions;
  if(!opts) return;
  const typeOpts = opts[type];
  const isShaft = type === 'shaft';
  const shapeList = isShaft ? typeOpts.types : typeOpts.shapes;
  const lengthList = type !== 'flight' ? typeOpts.lengthRanges : null;
  window.__ceType = type;
  openModal(`
    <p class="modal-msg">New ${type.charAt(0).toUpperCase()+type.slice(1)}</p>
    <label class="field">Name</label>
    <input type="text" id="ce-name" maxlength="64" placeholder="e.g. Red Dragon Razer Edge" style="margin-bottom:10px">
    ${lengthList ? `<label class="field">Length</label>
    <select id="ce-length" style="width:auto;margin-bottom:10px">
      <option value="">Not set</option>
      ${lengthList.map(v=>`<option value="${v}">${enumLabel(v)}</option>`).join('')}
    </select>` : ''}
    ${type==='barrel' ? `<label class="field">Weight</label>
    <select id="ce-weight" style="width:auto;margin-bottom:10px">
      <option value="">Not set</option>
      ${typeOpts.weights.map(g=>`<option value="${g}">${g}g</option>`).join('')}
    </select>` : ''}
    <label class="field">Material</label>
    <select id="ce-material" style="width:auto;margin-bottom:10px">
      <option value="">Not set</option>
      ${typeOpts.materials.map(v=>`<option value="${v}">${enumLabel(v)}</option>`).join('')}
    </select>
    <label class="field">${isShaft?'Type':'Shape'}</label>
    ${isShaft
      ? `<select id="ce-shape" style="width:auto;margin-bottom:10px">
          <option value="">Not set</option>
          ${shapeList.map(v=>`<option value="${v}">${enumLabel(v)}</option>`).join('')}
        </select>`
      : iconPickerHtml('ce-shape', type==='barrel' ? 'barrelShape' : 'flightShape', shapeList, `${type==='barrel'?'Barrel':'Flight'} shape`, null)}
    ${type==='barrel' ? `<label class="field">Grip</label>
    ${iconPickerHtml('ce-grip', 'barrelGrip', typeOpts.grips, 'Barrel grip', null)}` : ''}
    <div id="ce-error" style="color:var(--danger,#e5484d);font-size:12px;margin-bottom:8px" hidden></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitComponentEditor()">Save</button>
    </div>`, 'ce-name');
}
function submitComponentEditor(){
  const type = window.__ceType;
  const name = document.getElementById('ce-name').value.trim();
  const errEl = document.getElementById('ce-error');
  if(!name){ errEl.textContent = 'Name is required.'; errEl.hidden = false; return; }
  const fields = { name };
  const lengthEl = document.getElementById('ce-length'); if(lengthEl) fields.lengthMm = lengthEl.value || null;
  const weightEl = document.getElementById('ce-weight'); if(weightEl) fields.weightG = weightEl.value ? Number(weightEl.value) : null;
  const materialEl = document.getElementById('ce-material'); if(materialEl) fields.material = materialEl.value || null;
  const shapeEl = document.getElementById('ce-shape'); if(shapeEl) fields.shape = shapeEl.value || null;
  const gripEl = document.getElementById('ce-grip'); if(gripEl) fields.grip = gripEl.value || null;
  DB.createComponent(dartBuilderPlayer, type, fields).then(async (comp)=>{
    closeModal();
    await loadDartBuilderComponents();
    refreshDartBuilderSlot(type, comp.id);
  }).catch(e=>{ errEl.textContent = e.message || 'Could not save that component.'; errEl.hidden = false; });
}
