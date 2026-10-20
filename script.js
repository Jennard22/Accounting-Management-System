/* ---------- Supabase setup ---------- */
const SUPABASE_URL = 'https://dwlhinnknrnoaqmoqfkh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR3bGhpbm5rbnJub2FxbW9xZmtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1MTE5ODksImV4cCI6MjEwODA4Nzk4OX0.kDLu4amtQxw0MewzQ_cB16W5ojMAy4ojLJ1BvfGOepg';

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ---------- Constants and state ---------- */
const TYPES = {
  Asset: 'Dr',
  Liability: 'Cr',
  Equity: 'Cr',
  Revenue: 'Cr',
  Expense: 'Dr'
};

const ADJ_TYPES = [
  'Accrued expense',
  'Accrued revenue',
  'Prepaid expense',
  'Unearned revenue',
  'Depreciation',
  'Supplies used',
  'Bad debts',
  'Other'
];

const TABS = [
  ['coa', 'Chart of accounts'],
  ['txn', 'Business transactions'],
  ['tb', 'Trial balance'],
  ['adj', 'Adjustments']
];

let S = { accounts: [], txns: [], adjs: [] };

const draft = {
  txn: [{}, {}],
  adj: [{}, {}]
};

/* ---------- Helpers ---------- */
const $ = id => document.getElementById(id);

const esc = s => String(s).replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[c]));

const fmt = n => n
  ? n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : '';

const acct = id => S.accounts.find(a => a.id === id);

const label = a => a ? a.code + ' – ' + a.name : '(deleted account)';

const sorted = () => [...S.accounts].sort((a, b) =>
  a.code.localeCompare(b.code, undefined, { numeric: true })
);

/* ---------- Loading data from Supabase ---------- */
async function loadAll() {
  const [a, e] = await Promise.all([
    db.from('accounts').select('*'),
    db.from('journal_entries').select('*, journal_lines(*)')
  ]);

  if (a.error || e.error) {
    alert((a.error || e.error).message);
    return;
  }

  const toEntry = x => ({
    id: x.id,
    date: x.entry_date,
    ref: x.ref || '',
    desc: x.description || '',
    type: x.adj_type,
    lines: x.journal_lines.map(l => ({
      acct: l.account_id,
      dr: Number(l.debit),
      cr: Number(l.credit)
    }))
  });

  S.accounts = a.data.map(x => ({
    id: x.id,
    code: x.code,
    name: x.name,
    type: x.type
  }));

  S.txns = e.data.filter(x => x.kind === 'transaction').map(toEntry);
  S.adjs = e.data.filter(x => x.kind === 'adjustment').map(toEntry);
}

/* ---------- Tabs ---------- */
function show(id) {
  TABS.forEach(([t]) => $(t).classList.toggle('on', t === id));

  [...$('tabs').children].forEach(b =>
    b.setAttribute('aria-selected', b.dataset.t === id)
  );

  ({
    coa: rCoa,
    txn: () => rJournal('txn'),
    tb: rTB,
    adj: () => rJournal('adj')
  })[id]();
}

$('tabs').innerHTML = TABS.map(([t, l]) =>
  `<button role="tab" data-t="${t}" onclick="show('${t}')">${l}</button>`
).join('');

/* ---------- Chart of accounts ---------- */
function rCoa() {
  const rows = sorted().map(a => `
    <tr>
      <td>${esc(a.code)}</td>
      <td>${esc(a.name)}</td>
      <td>${a.type}</td>
      <td>${TYPES[a.type] === 'Dr' ? 'Debit' : 'Credit'}</td>
      <td><button class="btn del sm" onclick="delAcct('${a.id}')">Delete</button></td>
    </tr>`).join('');

  $('coa').innerHTML = `
    <div class="card">
      <h2>Add account</h2>
      <div class="row">
        <div class="f" style="flex:0 1 120px">
          <label for="ac">Code</label>
          <input id="ac" placeholder="e.g. 1010">
        </div>
        <div class="f" style="flex:2 1 220px">
          <label for="an">Account name</label>
          <input id="an" placeholder="e.g. Cash on hand">
        </div>
        <div class="f">
          <label for="at">Type</label>
          <select id="at">
            ${Object.keys(TYPES).map(t => `<option>${t}</option>`).join('')}
          </select>
        </div>
        <button class="btn" onclick="addAcct()">Add account</button>
      </div>
      <div id="cm" class="status"></div>
    </div>

    <div class="card">
      <h2>Accounts (${S.accounts.length})</h2>
      <div class="tw">
        ${S.accounts.length
          ? `<table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Normal balance</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>`
          : '<div class="empty">No accounts yet. Add your first account above.</div>'}
      </div>
    </div>`;
}

async function addAcct() {
  const code = $('ac').value.trim();
  const name = $('an').value.trim();
  const type = $('at').value;
  const m = $('cm');

  if (!code || !name) {
    m.className = 'status err';
    m.textContent = 'Enter both a code and a name.';
    return;
  }

  const { error } = await db.from('accounts').insert({ code, name, type });

  if (error) {
    m.className = 'status err';
    m.textContent = error.code === '23505'
      ? 'That account code already exists.'
      : error.message;
    return;
  }

  await loadAll();
  rCoa();
}

async function delAcct(id) {
  const { error } = await db.from('accounts').delete().eq('id', id);

  if (error) {
    alert(error.code === '23503'
      ? 'This account is used in journal entries. Delete those entries first.'
      : error.message);
    return;
  }

  await loadAll();
  rCoa();
}

/* ---------- Journals: transactions and adjustments share one engine ---------- */
function rJournal(k) {
  const isA = k === 'adj';
  const list = isA ? S.adjs : S.txns;
  const el = $(k);

  if (!S.accounts.length) {
    el.innerHTML = `
      <div class="card">
        <div class="empty">
          Add accounts in the chart of accounts before recording
          ${isA ? 'adjusting entries' : 'transactions'}.
        </div>
      </div>`;
    return;
  }

  el._opts = '<option value="">Select account</option>' +
    sorted().map(a => `<option value="${a.id}">${esc(label(a))}</option>`).join('');

  el.innerHTML = `
    <div class="card">
      <h2>${isA ? 'New adjusting entry' : 'New journal entry'}</h2>

      <div class="row" style="margin-bottom:12px">
        <div class="f" style="flex:0 1 160px">
          <label for="${k}d">Date</label>
          <input type="date" id="${k}d" value="${new Date().toISOString().slice(0, 10)}">
        </div>
        <div class="f" style="flex:0 1 130px">
          <label for="${k}r">Reference no.</label>
          <input id="${k}r">
        </div>
        ${isA ? `
        <div class="f">
          <label for="${k}t">Adjustment type</label>
          <select id="${k}t">
            ${ADJ_TYPES.map(t => `<option>${t}</option>`).join('')}
          </select>
        </div>` : ''}
        <div class="f" style="flex:3 1 240px">
          <label for="${k}n">Description</label>
          <input id="${k}n">
        </div>
      </div>

      <div class="tw">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th class="n">Debit</th>
              <th class="n">Credit</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="${k}l"></tbody>
          <tfoot>
            <tr>
              <td>Totals</td>
              <td class="n" id="${k}td"></td>
              <td class="n" id="${k}tc"></td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div class="row" style="margin-top:12px">
        <button class="btn alt" onclick="addLine('${k}')">Add line</button>
        <button class="btn" onclick="saveEntry('${k}')">Save entry</button>
      </div>
      <div id="${k}m" class="status"></div>
    </div>

    <div class="card">
      <h2>${isA ? 'Adjusting entries' : 'Journal'} (${list.length})</h2>
      ${list.length
        ? [...list]
            .sort((a, b) => a.date.localeCompare(b.date))
            .map(e => entryHTML(e, k))
            .join('')
        : `<div class="empty">No ${isA ? 'adjusting entries' : 'transactions'} recorded yet.</div>`}
    </div>`;

  paintLines(k);
}

function paintLines(k) {
  const opts = $(k)._opts;

  $(k + 'l').innerHTML = draft[k].map((l, i) => `
    <tr>
      <td>
        <select aria-label="Account" onchange="draft['${k}'][${i}].acct=this.value">${opts}</select>
      </td>
      <td>
        <input type="number" min="0" step="0.01" aria-label="Debit"
               value="${l.dr || ''}" oninput="setAmt('${k}',${i},'dr',this)">
      </td>
      <td>
        <input type="number" min="0" step="0.01" aria-label="Credit"
               value="${l.cr || ''}" oninput="setAmt('${k}',${i},'cr',this)">
      </td>
      <td>
        <button class="btn del sm" onclick="rmLine('${k}',${i})" aria-label="Remove line">✕</button>
      </td>
    </tr>`).join('');

  [...$(k + 'l').rows].forEach((r, i) => {
    r.querySelector('select').value = draft[k][i].acct || '';
  });

  totals(k);
}

function setAmt(k, i, f, inp) {
  draft[k][i][f] = parseFloat(inp.value) || 0;
  totals(k);
}

function totals(k) {
  const d = draft[k].reduce((s, l) => s + (l.dr || 0), 0);
  const c = draft[k].reduce((s, l) => s + (l.cr || 0), 0);
  $(k + 'td').textContent = fmt(d);
  $(k + 'tc').textContent = fmt(c);
}

function addLine(k) {
  draft[k].push({});
  paintLines(k);
}

function rmLine(k, i) {
  if (draft[k].length <= 2) return;
  draft[k].splice(i, 1);
  paintLines(k);
}

async function saveEntry(k) {
  const m = $(k + 'm');
  const lines = draft[k].filter(l => l.acct || l.dr || l.cr);

  const bad = text => {
    m.className = 'status err';
    m.textContent = text;
  };

  if (!$(k + 'd').value) return bad('Choose a date.');
  if (lines.length < 2) return bad('An entry needs at least two lines.');
  if (lines.some(l => !l.acct)) return bad('Select an account on every line.');
  if (lines.some(l => (l.dr && l.cr) || (!l.dr && !l.cr))) {
    return bad('Each line needs either a debit or a credit amount.');
  }

  const d = lines.reduce((s, l) => s + (l.dr || 0), 0);
  const c = lines.reduce((s, l) => s + (l.cr || 0), 0);

  if (Math.abs(d - c) > 0.005) {
    return bad('Debits and credits must be equal. Difference: ' + fmt(Math.abs(d - c)));
  }

  const { error } = await db.rpc('save_entry', {
    p_kind: k === 'adj' ? 'adjustment' : 'transaction',
    p_date: $(k + 'd').value,
    p_ref: $(k + 'r').value.trim(),
    p_desc: $(k + 'n').value.trim(),
    p_adj_type: k === 'adj' ? $(k + 't').value : null,
    p_lines: lines.map(l => ({
      account_id: l.acct,
      debit: l.dr || 0,
      credit: l.cr || 0
    }))
  });

  if (error) return bad(error.message);

  draft[k] = [{}, {}];
  await loadAll();
  rJournal(k);
}

function entryHTML(e, k) {
  return `
    <div class="entry">
      <div class="hd">
        <span>
          ${esc(e.date)}${e.ref ? ' · Ref ' + esc(e.ref) : ''}
          ${e.type ? `<span class="tag">${esc(e.type)}</span>` : ''}
          <br>${esc(e.desc || 'No description')}
        </span>
        <button class="btn del sm" onclick="delEntry('${k}','${e.id}')">Delete</button>
      </div>
      <div class="tw">
        <table>
          <tbody>
            ${e.lines.map(l => `
            <tr>
              <td style="padding-left:${l.cr ? '32px' : '10px'}">${esc(label(acct(l.acct)))}</td>
              <td class="n" style="width:130px">${fmt(l.dr)}</td>
              <td class="n" style="width:130px">${fmt(l.cr)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

async function delEntry(k, id) {
  if (!confirm('Delete this entry?')) return;

  const { error } = await db.from('journal_entries').delete().eq('id', id);
  if (error) return alert(error.message);

  await loadAll();
  rJournal(k);
}

/* ---------- Trial balance: unadjusted, adjustments, adjusted ---------- */
function sums(list) {
  const m = {};

  list.forEach(e => e.lines.forEach(l => {
    const x = m[l.acct] || (m[l.acct] = { dr: 0, cr: 0 });
    x.dr += l.dr;
    x.cr += l.cr;
  }));

  return m;
}

function split(net) {
  return net >= 0 ? [net, 0] : [0, -net];
}

function rTB() {
  const u = sums(S.txns);
  const j = sums(S.adjs);
  const T = [0, 0, 0, 0, 0, 0];

  const rows = sorted().map(a => {
    const ud = u[a.id] || { dr: 0, cr: 0 };
    const ad = j[a.id] || { dr: 0, cr: 0 };
    const un = split(ud.dr - ud.cr);
    const af = split(ud.dr - ud.cr + ad.dr - ad.cr);
    const v = [un[0], un[1], ad.dr, ad.cr, af[0], af[1]];

    if (!v.some(x => x)) return '';

    v.forEach((x, i) => T[i] += x);

    return `
      <tr>
        <td>${esc(a.code)}</td>
        <td>${esc(a.name)}</td>
        ${v.map(x => `<td class="n">${fmt(x)}</td>`).join('')}
      </tr>`;
  }).join('');

  const ok = i => Math.abs(T[i] - T[i + 1]) < 0.005;

  const chk = (i, name) => `
    <span class="${ok(i) ? 'ok' : 'err'}">
      ${name}: ${ok(i) ? 'balanced' : 'out of balance by ' + fmt(Math.abs(T[i] - T[i + 1]))}
    </span>`;

  $('tb').innerHTML = `
    <div class="card">
      <div class="tools">
        <h2 style="margin:0">Trial balance</h2>
        <button class="btn alt noprint" onclick="window.print()">Print</button>
      </div>
      ${rows
        ? `<div class="tw">
            <table>
              <thead>
                <tr>
                  <th rowspan="2">Code</th>
                  <th rowspan="2">Account</th>
                  <th colspan="2" class="n">Unadjusted</th>
                  <th colspan="2" class="n">Adjustments</th>
                  <th colspan="2" class="n">Adjusted</th>
                </tr>
                <tr>
                  <th class="n">Debit</th><th class="n">Credit</th>
                  <th class="n">Debit</th><th class="n">Credit</th>
                  <th class="n">Debit</th><th class="n">Credit</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
              <tfoot>
                <tr>
                  <td colspan="2">Totals</td>
                  ${T.map(x => `<td class="n">${fmt(x) || '0.00'}</td>`).join('')}
                </tr>
              </tfoot>
            </table>
          </div>
          <div class="status">
            ${chk(0, 'Unadjusted')} &nbsp; ${chk(2, 'Adjustments')} &nbsp; ${chk(4, 'Adjusted')}
          </div>`
        : '<div class="empty">Nothing to show yet. The trial balance fills in as you record transactions and adjustments.</div>'}
    </div>`;
}

/* ---------- Sign in / sign out ---------- */
const mainEl = document.querySelector('main');
const headerEl = document.querySelector('header');
let appShown = false;

const authBox = document.createElement('div');
authBox.id = 'auth';
authBox.style.cssText = 'max-width:380px;margin:40px auto;padding:0 24px';
mainEl.before(authBox);

headerEl.style.position = 'relative';

const signOutBtn = document.createElement('button');
signOutBtn.type = 'button';
signOutBtn.className = 'btn alt sm';
signOutBtn.textContent = 'Sign out';
signOutBtn.style.cssText = 'position:absolute;top:20px;right:24px;z-index:5';
signOutBtn.addEventListener('click', signOut);
headerEl.append(signOutBtn);

async function signOut() {
  try {
    // 'local' clears this browser's session even if the network request fails
    const { error } = await db.auth.signOut({ scope: 'local' });
    if (error) console.error('Sign out error:', error.message);
  } catch (e) {
    console.error('Sign out failed:', e);
  }
  resetToSignedOut();
}

function resetToSignedOut() {
  S = { accounts: [], txns: [], adjs: [] };
  draft.txn = [{}, {}];
  draft.adj = [{}, {}];
  showAuth();
}

function showAuth() {
  appShown = false;
  mainEl.style.display = 'none';
  $('tabs').style.display = 'none';
  signOutBtn.style.display = 'none';
  authBox.style.display = 'block';

  authBox.innerHTML = `
    <div class="card">
      <h2>Sign in</h2>
      <div class="f" style="margin-bottom:10px">
        <label for="em">Email</label>
        <input id="em" type="email" autocomplete="email">
      </div>
      <div class="f" style="margin-bottom:12px">
        <label for="pw">Password</label>
        <input id="pw" type="password" autocomplete="current-password">
      </div>
      <div class="row">
        <button class="btn" onclick="signIn()">Sign in</button>
        <button class="btn alt" onclick="signUp()">Create account</button>
      </div>
      <div id="am" class="status"></div>
    </div>`;
}

function authMsg(text, isError) {
  const m = $('am');
  m.className = 'status ' + (isError ? 'err' : 'ok');
  m.textContent = text;
}

async function signIn() {
  const { error } = await db.auth.signInWithPassword({
    email: $('em').value.trim(),
    password: $('pw').value
  });
  if (error) authMsg(error.message, true);
}

async function signUp() {
  const { data, error } = await db.auth.signUp({
    email: $('em').value.trim(),
    password: $('pw').value
  });

  if (error) return authMsg(error.message, true);

  if (!data.session) {
    authMsg('Account created. Check your email to confirm it, then sign in.', false);
  }
}

async function showApp() {
  appShown = true;
  authBox.style.display = 'none';
  mainEl.style.display = '';
  $('tabs').style.display = '';
  signOutBtn.style.display = '';

  await loadAll();
  show('coa');
}

/* ---------- Start ---------- */
db.auth.onAuthStateChange((event, session) => {
  // Deferred so Supabase calls don't run inside the auth callback
  setTimeout(() => {
    if (session && !appShown) {
      showApp();
    } else if (!session && (appShown || event === 'INITIAL_SESSION')) {
      resetToSignedOut();
    }
  }, 0);
});