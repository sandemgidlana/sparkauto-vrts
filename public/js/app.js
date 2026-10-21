'use strict';
const $ = s => document.querySelector(s);
const el = (t, a = {}, ...c) => {
  const e = document.createElement(t);
  for (const [k, v] of Object.entries(a)) { if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v); }
  e.append(...c.flat().filter(x => x != null)); return e;   // strings become text nodes, never HTML
};
const R = n => 'R' + Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = s => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-ZA') : '-');
const statusBadge = s => el('span', { class: 'badge s' + (['Awaiting Parts', 'In Progress', 'Ready for Collection'].indexOf(s) + 1) }, s);
let me, reload = () => {};

async function api(url, method = 'GET', body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { location.href = '/login.html'; throw new Error('Please log in.'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Something went wrong.');
  return d;
}
const toast = m => alert(m);
const act = async fn => { try { await fn(); reload(); } catch (x) { toast(x.message); } };

function table(heads, rows) {
  return el('div', { class: 'scroll' }, el('table', {}, el('thead', {}, el('tr', {}, heads.map(h => el('th', { scope: 'col' }, h)))),
    el('tbody', {}, rows.length ? rows : el('tr', {}, el('td', { colspan: heads.length }, 'Nothing to show yet.')))));
}
const tr = (...cells) => el('tr', {}, cells.map(c => (c instanceof Node && c.tagName === 'TD') ? c : el('td', {}, c)));
const btn = (label, fn, cls = '') => el('button', { type: 'button', class: 'sm ' + cls, onclick: fn }, label);

function ask(title, fields, onOk) {
  const dlg = $('#dlg'); dlg.replaceChildren();
  const err = el('p', { class: 'err', role: 'alert' });
  const form = el('form', {}, el('h2', {}, title), fields.map(f => {
    let inp;
    if (f.type === 'select') inp = el('select', { name: f.name }, f.options.map(o => el('option', { value: o.v }, o.l)));
    else if (f.type === 'textarea') inp = el('textarea', { name: f.name, rows: 3 });
    else inp = el('input', { name: f.name, type: f.type || 'text', step: f.step, min: f.min });
    if (f.required !== false) inp.required = true;
    inp.value = f.value ?? ''; return el('label', {}, f.label, inp);
  }), err, el('div', { class: 'row' }, el('button', { type: 'submit' }, 'Save'), el('button', { type: 'button', class: 'ghost', onclick: () => dlg.close() }, 'Cancel')));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    try { await onOk(Object.fromEntries(new FormData(form))); dlg.close(); reload(); } catch (x) { err.textContent = x.message; }
  });
  dlg.append(form); dlg.showModal();
}
const isMA = () => me.role !== 'Mechanic';

// ---------- Views ----------
async function dashboard() {
  const jobs = await api('/api/jobs'), v = $('#view');
  const count = s => jobs.filter(j => j.status === s).length;
  v.append(el('h2', {}, 'Dashboard'), el('div', { class: 'cards' },
    ['Awaiting Parts', 'In Progress', 'Ready for Collection'].map(s => el('div', { class: 'stat' }, el('b', {}, String(count(s))), s))));
  if (isMA()) {
    const alerts = await api('/api/alerts');
    v.append(el('h3', {}, 'Low-stock alerts (' + alerts.length + ')'),
      table(['Part', 'In stock', 'Low level', 'Raised by', 'When', ''], alerts.map(a => tr(a.name, String(a.stock), String(a.min_stock), a.raised_by, when(a.raised_at),
        btn('Update stock', () => restock(a.part_id, a.name, a.stock))))));
  }
}
function restock(id, name, cur) {
  ask('Update stock: ' + name, [{ name: 'stock', label: 'New stock quantity', type: 'number', min: 0, step: 1, value: cur }], d => api(`/api/parts/${id}/stock`, 'PUT', d));
}

async function jobs() {
  const rows = await api('/api/jobs'), v = $('#view');
  v.append(el('h2', {}, 'Service jobs'));
  if (isMA()) v.append(el('p', {}, btn('+ New job', newJob)));
  v.append(table(['Job', 'Plate', 'Vehicle', 'Owner', 'Mechanic', 'Status', 'Total', ''], rows.map(j => tr(j.job_ref, j.plate, j.make_model, j.owner_name,
    j.mechanic_name || 'Unassigned', statusBadge(j.status), el('td', { class: 'num' }, R(j.total)), btn('Open', () => openJob(j.id))))));
}
async function jobForm(job) {
  const [vehicles, mechs] = await Promise.all([api('/api/vehicles'), api('/api/mechanics')]);
  if (!vehicles.length) return toast('Add a vehicle first (Vehicles menu).');
  ask(job ? 'Edit ' + job.job_ref : 'New service job', [
    { name: 'vehicle_id', label: 'Vehicle', type: 'select', value: job?.vehicle_id, options: vehicles.map(x => ({ v: x.id, l: `${x.plate} - ${x.make_model} (${x.owner_name})` })) },
    { name: 'description', label: 'Repair description / work required', type: 'textarea', value: job?.description },
    { name: 'mechanic_id', label: 'Assigned mechanic', type: 'select', required: false, value: job?.mechanic_id ?? '', options: [{ v: '', l: 'Unassigned' }, ...mechs.map(m => ({ v: m.id, l: m.full_name }))] },
    { name: 'labour_cost', label: 'Labour cost (R)', type: 'number', step: '0.01', min: 0, value: job?.labour_cost ?? 0 }
  ], async d => {
    if (job) { await api('/api/jobs/' + job.id, 'PUT', d); reload = () => openJob(job.id); }
    else { const r = await api('/api/jobs', 'POST', d); reload = () => openJob(r.id); }
  });
}
const newJob = () => jobForm();

async function openJob(id) {
  reload = () => openJob(id);
  const j = await api('/api/jobs/' + id), parts = await api('/api/parts'), v = $('#view');
  v.replaceChildren(el('p', {}, btn('< Back to jobs', () => go('jobs'), 'ghost')),
    el('h2', {}, `${j.job_ref}: ${j.plate}`), el('div', { class: 'card' },
      el('p', {}, el('b', {}, 'Vehicle: '), j.make_model), el('p', {}, el('b', {}, 'Owner: '), `${j.owner_name} ${j.owner_phone || ''} ${j.owner_email || ''}`),
      el('p', {}, el('b', {}, 'Mechanic: '), j.mechanic_name || 'Unassigned'), el('p', {}, el('b', {}, 'Work required: '), j.description),
      el('p', {}, el('b', {}, 'Status: '), statusBadge(j.status)),
      isMA() ? el('div', { class: 'row' }, btn('Edit job', () => jobForm(j)), btn('Delete job', () => { if (confirm('Delete ' + j.job_ref + '? Its parts go back into stock.')) act(async () => { await api('/api/jobs/' + j.id, 'DELETE'); reload = () => go('jobs'); }); }, 'danger')) : null));
  const partRows = j.parts.map(p => {
    const q = el('input', { type: 'number', min: 0, step: 1, value: p.qty, 'aria-label': 'Quantity of ' + p.name });
    return tr(p.name, el('td', { class: 'num' }, R(p.unit_price)), el('td', {}, q), el('td', { class: 'num' }, R(p.line_total)),
      el('td', {}, btn('Save qty', () => act(() => api(`/api/jobs/${j.id}/parts/${p.part_id}`, 'PUT', { qty: q.value }))), ' ', btn('Remove', () => act(() => api(`/api/jobs/${j.id}/parts/${p.part_id}`, 'PUT', { qty: 0 })), 'danger')));
  });
  const sel = el('select', { 'aria-label': 'Part to add' }, parts.map(p => el('option', { value: p.id }, `${p.name} (${R(p.price)}, ${p.stock} in stock)`)));
  const aq = el('input', { type: 'number', min: 1, step: 1, value: 1, 'aria-label': 'Quantity to add' });
  v.append(el('div', { class: 'card' }, el('h3', {}, 'Spare parts and cost'),
    table(['Part', 'Unit price', 'Qty', 'Line total', ''], partRows),
    parts.length ? el('div', { class: 'inline' }, sel, aq, btn('Add part', () => act(async () => { const cur = j.parts.find(p => p.part_id == sel.value); await api(`/api/jobs/${j.id}/parts/${sel.value}`, 'PUT', { qty: (cur ? cur.qty : 0) + Number(aq.value) }); }))) : el('p', {}, 'No parts exist yet.'),
    el('p', {}, `Labour: ${R(j.labour_cost)} | Parts: ${R(j.parts_cost)}`), el('h3', {}, 'Total repair cost: ' + R(j.total))));
  const wd = el('input', { type: 'checkbox', checked: j.work_done ? '' : null }), pa = el('input', { type: 'checkbox', checked: j.parts_accounted ? '' : null });
  const st = el('select', { 'aria-label': 'New status' }, ['Awaiting Parts', 'In Progress', 'Ready for Collection'].map(s => el('option', { value: s, selected: s === j.status ? '' : null }, s)));
  v.append(el('div', { class: 'card checks' }, el('h3', {}, 'Safety checks and progress'),
    el('label', {}, wd, 'Repair work completed'), el('label', {}, pa, 'Required spare parts accounted for'),
    el('p', {}, btn('Save checks', () => act(() => api(`/api/jobs/${j.id}/checks`, 'POST', { work_done: wd.checked, parts_accounted: pa.checked })))),
    el('p', {}, el('b', {}, 'Mechanic safety sign-off: '), j.safety_signed_at ? `Signed by ${j.safety_signed_by} on ${when(j.safety_signed_at)}` : 'Not signed yet'),
    me.role === 'Mechanic' ? el('p', {}, btn('Confirm vehicle is safe (sign off)', () => act(() => api(`/api/jobs/${j.id}/signoff`, 'POST')))) : null,
    el('div', { class: 'inline' }, st, btn('Update status', () => act(() => api(`/api/jobs/${j.id}/status`, 'POST', { status: st.value })))),
    el('p', { class: 'note' }, 'A job can only be set to Ready for Collection once the work is done, parts are accounted for and a mechanic has signed off. Changing parts cancels the sign-off.'),
    isMA() && j.status === 'Ready for Collection' ? el('p', {}, btn('View / print invoice', () => invoice(j.id))) : null));
}
async function invoice(id) {
  try {
    const j = await api(`/api/jobs/${id}/invoice`), d = $('#inv');
    d.replaceChildren(el('img', { class: 'logo sm', src: '/images/logo.png', alt: 'SparkAuto logo', onerror: "this.onerror=null;this.src='/images/logo.svg'" }),
      el('h2', {}, 'SparkAuto: Invoice'), el('p', {}, `Invoice ${j.invoice_no} | Date: ${when(j.ready_at)}`),
      el('p', {}, `Customer: ${j.owner_name} ${j.owner_phone || ''} ${j.owner_email || ''}`), el('p', {}, `Vehicle: ${j.make_model}, plate ${j.plate}`), el('p', {}, `Work done: ${j.description}`),
      table(['Item', 'Qty', 'Unit price', 'Amount'], [tr('Labour', '', '', el('td', { class: 'num' }, R(j.labour_cost))), ...j.parts.map(p => tr(p.name, String(p.qty), el('td', { class: 'num' }, R(p.unit_price)), el('td', { class: 'num' }, R(p.line_total))))]),
      el('h3', {}, 'Total due: ' + R(j.total)), el('div', { class: 'row noprint' }, btn('Print / save as PDF', () => window.print()), btn('Close', () => d.close(), 'ghost')));
    d.showModal();
  } catch (x) { toast(x.message); }
}

async function vehicles() {
  const rows = await api('/api/vehicles'), v = $('#view');
  v.append(el('h2', {}, 'Vehicles'));
  if (isMA()) v.append(el('p', {}, btn('+ Add vehicle', () => vehForm())));
  v.append(table(['Number plate', 'Make / model', 'Owner', 'Phone', 'Email', ''], rows.map(x => tr(x.plate, x.make_model, x.owner_name, x.owner_phone || '-', x.owner_email || '-',
    isMA() ? el('td', {}, btn('Edit', () => vehForm(x)), ' ', btn('Delete', () => { if (confirm('Delete ' + x.plate + '?')) act(() => api('/api/vehicles/' + x.id, 'DELETE')); }, 'danger')) : ''))));
}
function vehForm(x) {
  ask(x ? 'Edit vehicle' : 'Add vehicle', [
    { name: 'plate', label: 'Number plate', value: x?.plate }, { name: 'make_model', label: 'Make and model', value: x?.make_model },
    { name: 'owner_name', label: 'Owner name', value: x?.owner_name }, { name: 'owner_phone', label: 'Owner phone', type: 'tel', required: false, value: x?.owner_phone },
    { name: 'owner_email', label: 'Owner email', type: 'email', required: false, value: x?.owner_email }
  ], d => (x ? api('/api/vehicles/' + x.id, 'PUT', d) : api('/api/vehicles', 'POST', d)));
}

async function partsView() {
  const rows = await api('/api/parts'), v = $('#view');
  v.append(el('h2', {}, 'Spare parts'));
  if (isMA()) v.append(el('p', {}, btn('+ Add part', () => partForm())));
  v.append(table(['Part', 'Price', 'In stock', 'Low level', 'Status', ''], rows.map(p => tr(p.name, el('td', { class: 'num' }, R(p.price)), String(p.stock), String(p.min_stock),
    p.low ? el('span', { class: 'badge low' }, 'LOW STOCK') : 'OK',
    el('td', {}, isMA() ? [btn('Update stock', () => restock(p.id, p.name, p.stock)), ' ', btn('Edit', () => partForm(p)), ' ', btn('Delete', () => { if (confirm('Delete ' + p.name + '?')) act(() => api('/api/parts/' + p.id, 'DELETE')); }, 'danger')] : null,
      p.low && me.role !== 'Manager' ? [' ', btn('Notify Manager', () => act(async () => { await api(`/api/parts/${p.id}/notify`, 'POST'); toast('Manager notified.'); }), 'ghost')] : null)))));
}
function partForm(p) {
  ask(p ? 'Edit part' : 'Add part', [
    { name: 'name', label: 'Part name', value: p?.name }, { name: 'price', label: 'Price (R)', type: 'number', step: '0.01', min: 0, value: p?.price },
    { name: 'stock', label: 'Stock quantity', type: 'number', step: 1, min: 0, value: p?.stock }, { name: 'min_stock', label: 'Low-stock level', type: 'number', step: 1, min: 0, value: p?.min_stock ?? 5 }
  ], d => (p ? api('/api/parts/' + p.id, 'PUT', d) : api('/api/parts', 'POST', d)));
}

async function reports() {
  const r = await api('/api/reports'), v = $('#view');
  v.append(el('h2', {}, 'Reports'), el('h3', {}, 'Completed repairs: last 7 days (' + r.weekly.length + ')'),
    table(['Job', 'Plate', 'Vehicle', 'Completed', 'Total'], r.weekly.map(x => tr(x.job_ref, x.plate, x.make_model, when(x.ready_at), el('td', { class: 'num' }, R(x.total))))),
    el('h3', {}, 'Low-stock parts'), table(['Part', 'In stock', 'Low level', 'Price'], r.lowStock.map(x => tr(x.name, String(x.stock), String(x.min_stock), R(x.price)))),
    el('h3', {}, 'Outstanding repairs'), table(['Job', 'Plate', 'Vehicle', 'Status', 'Mechanic', 'Opened'], r.outstanding.map(x => tr(x.job_ref, x.plate, x.make_model, statusBadge(x.status), x.mechanic_name || 'Unassigned', when(x.created_at)))));
}

async function users() {
  const rows = await api('/api/users'), v = $('#view');
  v.append(el('h2', {}, 'Staff accounts'), el('p', {}, btn('+ Create user', () => ask('Create user', [
    { name: 'full_name', label: 'Full name' }, { name: 'username', label: 'Username' },
    { name: 'role', label: 'Role', type: 'select', options: ['Manager', 'Admin', 'Mechanic'].map(r => ({ v: r, l: r })) },
    { name: 'password', label: 'Password (8+ characters)', type: 'password' }], d => api('/api/users', 'POST', d)))),
  table(['Name', 'Username', 'Role', 'Last login', ''], rows.map(u => tr(u.full_name, u.username, u.role, when(u.last_login),
    el('td', {}, btn('Reset password', () => ask('New password for ' + u.username, [{ name: 'password', label: 'New password (8+ characters)', type: 'password' }], d => api(`/api/users/${u.id}/password`, 'PUT', d))), ' ',
      btn('Delete', () => { if (confirm('Delete user ' + u.username + '?')) act(() => api('/api/users/' + u.id, 'DELETE')); }, 'danger'))))));
}
async function auditView() {
  const rows = await api('/api/audit');
  $('#view').append(el('h2', {}, 'Audit trail (latest 300)'), table(['When', 'User', 'Action', 'Detail'], rows.map(a => tr(when(a.at), a.username || '-', a.action, a.detail || ''))));
}

// ---------- Navigation ----------
const NAV = { Manager: ['dashboard', 'jobs', 'vehicles', 'parts', 'reports', 'users', 'audit'], Admin: ['dashboard', 'jobs', 'vehicles', 'parts', 'reports'], Mechanic: ['dashboard', 'jobs', 'parts'] };
const LABEL = { dashboard: 'Dashboard', jobs: 'Jobs', vehicles: 'Vehicles', parts: 'Spare parts', reports: 'Reports', users: 'Users', audit: 'Audit trail' };
const VIEWS = { dashboard, jobs, vehicles, parts: partsView, reports, users, audit: auditView };
async function go(name) {
  reload = () => go(name);
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === name));
  $('#view').replaceChildren();
  try { await VIEWS[name](); } catch (x) { $('#view').append(el('p', { class: 'err' }, x.message)); }
}
(async () => {
  me = await api('/api/me');
  $('#who').textContent = `${me.full_name} (${me.role})`;
  $('#nav').append(...NAV[me.role].map(n => el('button', { type: 'button', 'data-v': n, onclick: () => go(n) }, LABEL[n])));
  $('#logout').addEventListener('click', async () => { await api('/api/logout', 'POST'); location.href = '/login.html'; });
  go('dashboard');
})();
