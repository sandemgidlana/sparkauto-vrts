'use strict';
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, 'sparkauto.db'));
db.exec('PRAGMA foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('Manager','Admin','Mechanic')), password_hash TEXT NOT NULL, last_login TEXT,
  reset_hash TEXT, reset_expires INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS vehicles(id INTEGER PRIMARY KEY AUTOINCREMENT, plate TEXT UNIQUE NOT NULL, make_model TEXT NOT NULL,
  owner_name TEXT NOT NULL, owner_phone TEXT, owner_email TEXT);
CREATE TABLE IF NOT EXISTS parts(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, price REAL NOT NULL CHECK(price>=0),
  stock INTEGER NOT NULL CHECK(stock>=0), min_stock INTEGER NOT NULL DEFAULT 5);
CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, job_ref TEXT UNIQUE,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT, description TEXT NOT NULL,
  mechanic_id INTEGER REFERENCES users(id) ON DELETE SET NULL, labour_cost REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Awaiting Parts' CHECK(status IN('Awaiting Parts','In Progress','Ready for Collection')),
  parts_accounted INTEGER NOT NULL DEFAULT 0, work_done INTEGER NOT NULL DEFAULT 0,
  safety_signed_by TEXT, safety_signed_at TEXT, ready_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS job_parts(job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  part_id INTEGER NOT NULL REFERENCES parts(id) ON DELETE RESTRICT, qty INTEGER NOT NULL CHECK(qty>0),
  unit_price REAL NOT NULL, PRIMARY KEY(job_id, part_id));
CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  raised_by TEXT, raised_at TEXT DEFAULT CURRENT_TIMESTAMP, resolved INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT DEFAULT CURRENT_TIMESTAMP, username TEXT, action TEXT, detail TEXT);
`);

const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const bad = (m, s = 400) => { const e = new Error(m); e.status = s; return e; };
const S = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const N = v => (v === '' || v === null || v === undefined ? NaN : Number(v));
const STATUSES = ['Awaiting Parts', 'In Progress', 'Ready for Collection'];
const audit = (who, action, detail = '') => run('INSERT INTO audit(username,action,detail) VALUES(?,?,?)', who, action, detail);
const A = (req, action, detail) => audit(req.session.user.username, action, detail);

// ---- Seed original accounts on first run (all can be deleted later by a Manager) ----
if (!one('SELECT id FROM users LIMIT 1')) {
  const mk = (u, n, r) => run('INSERT INTO users(username,full_name,role,password_hash) VALUES(?,?,?,?)', u, n, r, bcrypt.hashSync('Spark@2026', 10));
  mk('manager', 'Workshop Manager', 'Manager'); mk('admin', 'Front Office', 'Admin'); mk('mechanic', 'Workshop Mechanic', 'Mechanic');
  console.log('First run: created users manager / admin / mechanic with password Spark@2026. Change these straight away.');
}

// ---- Domain helpers ----
function getJob(req, id) {
  const j = one(`SELECT j.*, v.plate, v.make_model, v.owner_name, v.owner_phone, v.owner_email, u.full_name AS mechanic_name,
    COALESCE((SELECT SUM(qty*unit_price) FROM job_parts WHERE job_id=j.id),0) AS parts_cost
    FROM jobs j JOIN vehicles v ON v.id=j.vehicle_id LEFT JOIN users u ON u.id=j.mechanic_id WHERE j.id=?`, id);
  if (!j) throw bad('Job not found', 404);
  if (req.session.user.role === 'Mechanic' && j.mechanic_id !== req.session.user.id) throw bad('This job is not assigned to you', 403);
  j.parts_cost = Math.round(j.parts_cost * 100) / 100;
  j.total = Math.round((j.labour_cost + j.parts_cost) * 100) / 100;
  return j;
}
const jobParts = id => all('SELECT jp.part_id, p.name, jp.qty, jp.unit_price, ROUND(jp.qty*jp.unit_price,2) AS line_total FROM job_parts jp JOIN parts p ON p.id=jp.part_id WHERE jp.job_id=? ORDER BY p.name', id);
function flagLowStock(partId, by) {
  const p = one('SELECT * FROM parts WHERE id=?', partId);
  if (p.stock <= p.min_stock && !one('SELECT id FROM alerts WHERE part_id=? AND resolved=0', partId)) {
    run('INSERT INTO alerts(part_id,raised_by) VALUES(?,?)', partId, by);
  }
  if (p.stock > p.min_stock) run('UPDATE alerts SET resolved=1 WHERE part_id=?', partId);
}
// Any change to a job's parts voids earlier sign-off, so a changed repair must be re-checked.
const voidSignoff = id => run(`UPDATE jobs SET safety_signed_by=NULL, safety_signed_at=NULL, parts_accounted=0, ready_at=NULL,
  status=CASE WHEN status='Ready for Collection' THEN 'In Progress' ELSE status END WHERE id=?`, id);
function setJobPart(jobId, partId, qty, by) {
  tx(() => {
    const part = one('SELECT * FROM parts WHERE id=?', partId);
    if (!part) throw bad('Part not found', 404);
    const ex = one('SELECT qty, unit_price FROM job_parts WHERE job_id=? AND part_id=?', jobId, partId);
    const delta = qty - (ex ? ex.qty : 0);
    if (delta > part.stock) throw bad(`Only ${part.stock} of "${part.name}" in stock.`, 409);
    run('UPDATE parts SET stock=stock-? WHERE id=?', delta, partId);
    if (qty === 0) run('DELETE FROM job_parts WHERE job_id=? AND part_id=?', jobId, partId);
    else run('INSERT INTO job_parts(job_id,part_id,qty,unit_price) VALUES(?,?,?,?) ON CONFLICT(job_id,part_id) DO UPDATE SET qty=excluded.qty', jobId, partId, qty, ex ? ex.unit_price : part.price);
    voidSignoff(jobId); flagLowStock(partId, by);
  });
}
function setStatus(job, status) {
  if (!STATUSES.includes(status)) throw bad('Invalid status');
  if (status === 'Ready for Collection') {
    const missing = [];
    if (!job.work_done) missing.push('repair work completed');
    if (!job.parts_accounted) missing.push('spare parts accounted for');
    if (!job.safety_signed_at) missing.push('mechanic safety sign-off');
    if (missing.length) throw bad('Vehicle cannot be released. Missing: ' + missing.join(', ') + '.', 409);
    run("UPDATE jobs SET status=?, ready_at=datetime('now') WHERE id=?", status, job.id);
  } else run('UPDATE jobs SET status=?, ready_at=NULL WHERE id=?', status, job.id);
}
function jobInput(b) {
  const vehicle_id = N(b.vehicle_id), labour = N(b.labour_cost === '' ? 0 : b.labour_cost), description = S(b.description, 1000);
  const mechanic_id = b.mechanic_id === '' || b.mechanic_id == null ? null : N(b.mechanic_id);
  if (!one('SELECT id FROM vehicles WHERE id=?', vehicle_id)) throw bad('Choose a valid vehicle.');
  if (!description) throw bad('Enter a repair description.');
  if (!(labour >= 0)) throw bad('Labour cost must be 0 or more.');
  if (mechanic_id !== null && !one("SELECT id FROM users WHERE id=? AND role='Mechanic'", mechanic_id)) throw bad('Choose a valid mechanic.');
  return { vehicle_id, labour, description, mechanic_id };
}

// ---- App & security ----
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' }); next(); });
app.use(express.json({ limit: '20kb' }));
app.use(session({ name: 'sid', secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 3600 * 1000 } }));

const tries = new Map();
const limiter = (req, res, next) => {
  const now = Date.now(), k = req.ip, l = (tries.get(k) || []).filter(t => now - t < 15 * 60000);
  if (l.length >= 15) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  l.push(now); tries.set(k, l); next();
};
const wrap = fn => (req, res) => {
  try { fn(req, res); } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    if (/UNIQUE/.test(e.message)) return res.status(409).json({ error: 'That value already exists.' });
    if (/FOREIGN KEY|constraint/i.test(e.message)) return res.status(409).json({ error: 'It is still in use, so it cannot be removed.' });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
};
const login = (req, res, next) => (req.session.user ? next() : res.status(401).json({ error: 'Please log in.' }));
const need = (...roles) => (req, res, next) => (roles.includes(req.session.user.role) ? next() : res.status(403).json({ error: 'You do not have permission to do that.' }));
const MA = need('Manager', 'Admin');

// ---- Auth ----
app.post('/api/login', limiter, wrap((req, res) => {
  const u = one('SELECT * FROM users WHERE username=?', S(req.body.username, 40).toLowerCase());
  const pw = typeof req.body.password === 'string' ? req.body.password : '';
  if (!u || !bcrypt.compareSync(pw, u.password_hash)) { audit(S(req.body.username, 40), 'LOGIN_FAILED'); throw bad('Wrong username or password.', 401); }
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Server error' });
    req.session.user = { id: u.id, username: u.username, role: u.role, full_name: u.full_name };
    run("UPDATE users SET last_login=datetime('now') WHERE id=?", u.id);
    audit(u.username, 'LOGIN'); res.json(req.session.user);
  });
}));
app.post('/api/logout', login, wrap((req, res) => { audit(req.session.user.username, 'LOGOUT'); req.session.destroy(() => res.json({ ok: true })); }));
app.get('/api/me', login, (req, res) => res.json(req.session.user));
// Forgotten password: a one-time code is printed in the server console for the Manager to pass on.
app.post('/api/forgot', limiter, wrap((req, res) => {
  const u = one('SELECT * FROM users WHERE username=?', S(req.body.username, 40).toLowerCase());
  if (u) {
    const code = crypto.randomBytes(5).toString('hex');
    run('UPDATE users SET reset_hash=?, reset_expires=? WHERE id=?', crypto.createHash('sha256').update(code).digest('hex'), Date.now() + 30 * 60000, u.id);
    console.log(`PASSWORD RESET CODE for ${u.username}: ${code} (valid 30 minutes)`); audit(u.username, 'PASSWORD_RESET_REQUESTED');
  }
  res.json({ message: 'If that account exists, a reset code has been issued. Ask the Manager for it.' });
}));
app.post('/api/reset', limiter, wrap((req, res) => {
  const u = one('SELECT * FROM users WHERE username=?', S(req.body.username, 40).toLowerCase());
  const code = S(req.body.code, 20), pw = typeof req.body.password === 'string' ? req.body.password : '';
  if (pw.length < 8) throw bad('New password must be at least 8 characters.');
  const h = crypto.createHash('sha256').update(code).digest('hex');
  if (!u || !u.reset_hash || u.reset_expires < Date.now() || u.reset_hash !== h) throw bad('Invalid or expired reset code.');
  run('UPDATE users SET password_hash=?, reset_hash=NULL, reset_expires=NULL WHERE id=?', bcrypt.hashSync(pw, 10), u.id);
  audit(u.username, 'PASSWORD_RESET_DONE'); res.json({ ok: true });
}));
app.use('/api', login);

// ---- Users (Manager) ----
app.get('/api/users', need('Manager'), (req, res) => res.json(all('SELECT id,username,full_name,role,last_login,created_at FROM users ORDER BY role,username')));
app.post('/api/users', need('Manager'), wrap((req, res) => {
  const username = S(req.body.username, 30).toLowerCase(), full = S(req.body.full_name, 80), role = req.body.role, pw = req.body.password;
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw bad('Username: 3-30 letters, numbers, . _ -');
  if (!full) throw bad('Enter the full name.');
  if (!['Manager', 'Admin', 'Mechanic'].includes(role)) throw bad('Choose a role.');
  if (typeof pw !== 'string' || pw.length < 8) throw bad('Password must be at least 8 characters.');
  run('INSERT INTO users(username,full_name,role,password_hash) VALUES(?,?,?,?)', username, full, role, bcrypt.hashSync(pw, 10));
  A(req, 'USER_CREATED', `${username} (${role})`); res.status(201).json({ ok: true });
}));
app.put('/api/users/:id/password', need('Manager'), wrap((req, res) => {
  const u = one('SELECT * FROM users WHERE id=?', req.params.id); if (!u) throw bad('User not found', 404);
  if (typeof req.body.password !== 'string' || req.body.password.length < 8) throw bad('Password must be at least 8 characters.');
  run('UPDATE users SET password_hash=? WHERE id=?', bcrypt.hashSync(req.body.password, 10), u.id);
  A(req, 'PASSWORD_CHANGED_BY_MANAGER', u.username); res.json({ ok: true });
}));
app.delete('/api/users/:id', need('Manager'), wrap((req, res) => {
  const u = one('SELECT * FROM users WHERE id=?', req.params.id); if (!u) throw bad('User not found', 404);
  if (u.id === req.session.user.id) throw bad('You cannot delete the account you are logged in with. Ask another Manager to do it.', 409);
  if (u.role === 'Manager' && one("SELECT COUNT(*) c FROM users WHERE role='Manager'").c <= 1) throw bad('This is the last Manager. Create another Manager first.', 409);
  run('DELETE FROM users WHERE id=?', u.id); A(req, 'USER_DELETED', `${u.username} (${u.role})`); res.json({ ok: true });
}));
app.get('/api/mechanics', MA, (req, res) => res.json(all("SELECT id, full_name FROM users WHERE role='Mechanic' ORDER BY full_name")));

// ---- Vehicles ----
function vehInput(b) {
  const plate = S(b.plate, 12).toUpperCase(), make_model = S(b.make_model, 80), owner_name = S(b.owner_name, 80);
  if (!/^[A-Z0-9][A-Z0-9 -]{1,11}$/.test(plate)) throw bad('Enter a valid number plate, e.g. EC 123-456.');
  if (!make_model) throw bad('Enter the make and model.');
  if (!owner_name) throw bad("Enter the owner's name.");
  const owner_email = S(b.owner_email, 120);
  if (owner_email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(owner_email)) throw bad('Enter a valid email address.');
  return { plate, make_model, owner_name, owner_phone: S(b.owner_phone, 20), owner_email };
}
app.get('/api/vehicles', (req, res) => res.json(all('SELECT * FROM vehicles ORDER BY plate')));
app.post('/api/vehicles', MA, wrap((req, res) => {
  const v = vehInput(req.body);
  run('INSERT INTO vehicles(plate,make_model,owner_name,owner_phone,owner_email) VALUES(?,?,?,?,?)', v.plate, v.make_model, v.owner_name, v.owner_phone, v.owner_email);
  A(req, 'VEHICLE_ADDED', v.plate); res.status(201).json({ ok: true });
}));
app.put('/api/vehicles/:id', MA, wrap((req, res) => {
  const v = vehInput(req.body);
  if (!run('UPDATE vehicles SET plate=?,make_model=?,owner_name=?,owner_phone=?,owner_email=? WHERE id=?', v.plate, v.make_model, v.owner_name, v.owner_phone, v.owner_email, req.params.id).changes) throw bad('Vehicle not found', 404);
  A(req, 'VEHICLE_UPDATED', v.plate); res.json({ ok: true });
}));
app.delete('/api/vehicles/:id', MA, wrap((req, res) => {
  const v = one('SELECT plate FROM vehicles WHERE id=?', req.params.id); if (!v) throw bad('Vehicle not found', 404);
  if (one('SELECT id FROM jobs WHERE vehicle_id=?', req.params.id)) throw bad('This vehicle has repair jobs. Delete those jobs first.', 409);
  run('DELETE FROM vehicles WHERE id=?', req.params.id); A(req, 'VEHICLE_DELETED', v.plate); res.json({ ok: true });
}));

// ---- Spare parts ----
function partInput(b) {
  const name = S(b.name, 80), price = N(b.price), stock = N(b.stock), min = N(b.min_stock === '' || b.min_stock == null ? 5 : b.min_stock);
  if (!name) throw bad('Enter the part name.');
  if (!(price >= 0)) throw bad('Enter a valid price.');
  if (!Number.isInteger(stock) || stock < 0) throw bad('Stock must be a whole number, 0 or more.');
  if (!Number.isInteger(min) || min < 0) throw bad('Low-stock level must be a whole number, 0 or more.');
  return { name, price, stock, min };
}
app.get('/api/parts', (req, res) => res.json(all('SELECT *, (stock<=min_stock) AS low FROM parts ORDER BY name')));
app.post('/api/parts', MA, wrap((req, res) => {
  const p = partInput(req.body);
  const id = run('INSERT INTO parts(name,price,stock,min_stock) VALUES(?,?,?,?)', p.name, p.price, p.stock, p.min).lastInsertRowid;
  flagLowStock(id, req.session.user.username); A(req, 'PART_ADDED', p.name); res.status(201).json({ ok: true });
}));
app.put('/api/parts/:id', MA, wrap((req, res) => {
  const p = partInput(req.body);
  if (!run('UPDATE parts SET name=?,price=?,stock=?,min_stock=? WHERE id=?', p.name, p.price, p.stock, p.min, req.params.id).changes) throw bad('Part not found', 404);
  flagLowStock(req.params.id, req.session.user.username); A(req, 'PART_UPDATED', `${p.name}: price R${p.price}, stock ${p.stock}`); res.json({ ok: true });
}));
app.put('/api/parts/:id/stock', MA, wrap((req, res) => {
  const stock = N(req.body.stock), p = one('SELECT * FROM parts WHERE id=?', req.params.id);
  if (!p) throw bad('Part not found', 404);
  if (!Number.isInteger(stock) || stock < 0) throw bad('Stock must be a whole number, 0 or more.');
  run('UPDATE parts SET stock=? WHERE id=?', stock, p.id); flagLowStock(p.id, req.session.user.username);
  A(req, 'STOCK_UPDATED', `${p.name}: ${p.stock} -> ${stock}`); res.json({ ok: true });
}));
app.delete('/api/parts/:id', MA, wrap((req, res) => {
  const p = one('SELECT name FROM parts WHERE id=?', req.params.id); if (!p) throw bad('Part not found', 404);
  run('DELETE FROM parts WHERE id=?', req.params.id); A(req, 'PART_DELETED', p.name); res.json({ ok: true });
}));
app.post('/api/parts/:id/notify', wrap((req, res) => {
  const p = one('SELECT * FROM parts WHERE id=?', req.params.id); if (!p) throw bad('Part not found', 404);
  if (!one('SELECT id FROM alerts WHERE part_id=? AND resolved=0', p.id)) run('INSERT INTO alerts(part_id,raised_by) VALUES(?,?)', p.id, req.session.user.username);
  A(req, 'LOW_STOCK_NOTIFIED', p.name); res.json({ ok: true });
}));
app.get('/api/alerts', MA, (req, res) => res.json(all(`SELECT a.id, a.raised_by, a.raised_at, p.id AS part_id, p.name, p.stock, p.min_stock
  FROM alerts a JOIN parts p ON p.id=a.part_id WHERE a.resolved=0 ORDER BY a.raised_at DESC`)));

// ---- Jobs ----
app.get('/api/jobs', (req, res) => {
  const mech = req.session.user.role === 'Mechanic';
  const rows = all(`SELECT j.id, j.job_ref, j.status, j.labour_cost, j.created_at, v.plate, v.make_model, v.owner_name, u.full_name AS mechanic_name,
    ROUND(j.labour_cost + COALESCE((SELECT SUM(qty*unit_price) FROM job_parts WHERE job_id=j.id),0),2) AS total
    FROM jobs j JOIN vehicles v ON v.id=j.vehicle_id LEFT JOIN users u ON u.id=j.mechanic_id
    ${mech ? 'WHERE j.mechanic_id=?' : ''} ORDER BY j.id DESC`, ...(mech ? [req.session.user.id] : []));
  res.json(rows);
});
app.get('/api/jobs/:id', wrap((req, res) => { const j = getJob(req, req.params.id); j.parts = jobParts(j.id); res.json(j); }));
app.post('/api/jobs', MA, wrap((req, res) => {
  const j = jobInput(req.body);
  const id = tx(() => {
    const n = (one('SELECT COALESCE(MAX(id),0)+1 AS n FROM jobs').n);
    return run('INSERT INTO jobs(job_ref,vehicle_id,description,mechanic_id,labour_cost) VALUES(?,?,?,?,?)', 'JOB' + String(n).padStart(3, '0'), j.vehicle_id, j.description, j.mechanic_id, j.labour).lastInsertRowid;
  });
  A(req, 'JOB_CREATED', one('SELECT job_ref FROM jobs WHERE id=?', id).job_ref); res.status(201).json({ id });
}));
app.put('/api/jobs/:id', MA, wrap((req, res) => {
  const job = getJob(req, req.params.id), j = jobInput(req.body);
  run('UPDATE jobs SET vehicle_id=?, description=?, mechanic_id=?, labour_cost=? WHERE id=?', j.vehicle_id, j.description, j.mechanic_id, j.labour, job.id);
  if (j.description !== job.description || j.vehicle_id !== job.vehicle_id) voidSignoff(job.id);
  A(req, 'JOB_UPDATED', job.job_ref); res.json({ ok: true });
}));
app.delete('/api/jobs/:id', MA, wrap((req, res) => {
  const job = getJob(req, req.params.id);
  tx(() => { for (const p of jobParts(job.id)) run('UPDATE parts SET stock=stock+? WHERE id=?', p.qty, p.part_id); run('DELETE FROM jobs WHERE id=?', job.id); });
  A(req, 'JOB_DELETED', job.job_ref + ' (parts returned to stock)'); res.json({ ok: true });
}));
app.put('/api/jobs/:id/parts/:partId', wrap((req, res) => {
  const job = getJob(req, req.params.id), qty = N(req.body.qty);
  if (!Number.isInteger(qty) || qty < 0 || qty > 1000) throw bad('Quantity must be a whole number (0 removes the part).');
  setJobPart(job.id, Number(req.params.partId), qty, req.session.user.username);
  A(req, 'PART_ASSIGNED', `${job.job_ref}: part #${req.params.partId} qty ${qty}`); res.json({ ok: true });
}));
app.post('/api/jobs/:id/checks', wrap((req, res) => {
  const job = getJob(req, req.params.id), wd = req.body.work_done ? 1 : 0, pa = req.body.parts_accounted ? 1 : 0;
  if (!wd || !pa) voidSignoff(job.id);
  run('UPDATE jobs SET work_done=?, parts_accounted=? WHERE id=?', wd, pa, job.id);
  if (!wd) run('UPDATE jobs SET parts_accounted=? WHERE id=?', pa, job.id);
  A(req, 'PROGRESS_UPDATED', `${job.job_ref}: work done=${!!wd}, parts accounted=${!!pa}`); res.json({ ok: true });
}));
app.post('/api/jobs/:id/signoff', need('Mechanic'), wrap((req, res) => {
  const job = getJob(req, req.params.id);
  if (!job.work_done || !job.parts_accounted) throw bad('Tick "repair work completed" and "spare parts accounted for" before signing off.', 409);
  run("UPDATE jobs SET safety_signed_by=?, safety_signed_at=datetime('now') WHERE id=?", req.session.user.full_name, job.id);
  A(req, 'SAFETY_SIGNOFF', job.job_ref); res.json({ ok: true });
}));
app.post('/api/jobs/:id/status', wrap((req, res) => {
  const job = getJob(req, req.params.id); setStatus(job, req.body.status);
  A(req, 'STATUS_CHANGED', `${job.job_ref}: ${job.status} -> ${req.body.status}`); res.json({ ok: true });
}));
app.get('/api/jobs/:id/invoice', MA, wrap((req, res) => {
  const j = getJob(req, req.params.id);
  if (j.status !== 'Ready for Collection') throw bad('An invoice is available once the repair is Ready for Collection.', 409);
  j.parts = jobParts(j.id); j.invoice_no = 'INV-' + j.job_ref; A(req, 'INVOICE_VIEWED', j.job_ref); res.json(j);
}));

// ---- Reports & audit ----
app.get('/api/reports', MA, (req, res) => res.json({
  weekly: all(`SELECT j.job_ref, v.plate, v.make_model, j.ready_at, ROUND(j.labour_cost + COALESCE((SELECT SUM(qty*unit_price) FROM job_parts WHERE job_id=j.id),0),2) AS total
    FROM jobs j JOIN vehicles v ON v.id=j.vehicle_id WHERE j.status='Ready for Collection' AND j.ready_at >= datetime('now','-7 days') ORDER BY j.ready_at DESC`),
  lowStock: all('SELECT name, stock, min_stock, price FROM parts WHERE stock<=min_stock ORDER BY stock'),
  outstanding: all(`SELECT j.job_ref, v.plate, v.make_model, j.status, u.full_name AS mechanic_name, j.created_at FROM jobs j JOIN vehicles v ON v.id=j.vehicle_id
    LEFT JOIN users u ON u.id=j.mechanic_id WHERE j.status<>'Ready for Collection' ORDER BY j.created_at`)
}));
app.get('/api/audit', need('Manager'), (req, res) => res.json(all('SELECT at, username, action, detail FROM audit ORDER BY id DESC LIMIT 300')));

// ---- Pages ----
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('/', (req, res) => (req.session.user ? res.sendFile(path.join(__dirname, 'views', 'app.html')) : res.redirect('/login.html')));
app.listen(3000, () => console.log('SparkAuto VRTS running at http://localhost:3000'));
