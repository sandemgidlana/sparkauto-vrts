'use strict';
const $ = s => document.querySelector(s);
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Something went wrong.');
  return d;
}
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  try { await post('/api/login', Object.fromEntries(new FormData(e.target))); location.href = '/'; }
  catch (x) { $('#loginErr').textContent = x.message; }
});
$('#showForgot').addEventListener('click', () => { $('#forgotForm').hidden = !$('#forgotForm').hidden; });
$('#getCode').addEventListener('click', async () => {
  try { $('#forgotMsg').textContent = (await post('/api/forgot', { username: $('#forgotForm').username.value })).message; }
  catch (x) { $('#forgotMsg').textContent = x.message; }
});
$('#forgotForm').addEventListener('submit', async e => {
  e.preventDefault();
  try { await post('/api/reset', Object.fromEntries(new FormData(e.target))); $('#forgotMsg').textContent = 'Password changed. You can now log in.'; }
  catch (x) { $('#forgotMsg').textContent = x.message; }
});
