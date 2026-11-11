'use strict';

/* =====================================================
   1. SETTINGS  -  paste your Supabase details here
   ===================================================== */
const SUPABASE_URL = 'https://nzlwvesdrwtwunxtplko.supabase.co';   // your Project URL
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56bHd2ZXNkcnd0d3VueHRwbGtvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQzNDg4NDgsImV4cCI6MjEwOTkyNDg0OH0.H-0703bfrbEQAVJ0u85BI_LAiuvZHtwly9LUHBrOK6s'; // publishable key
const CURRENCY = '₱';  

const isConfigured =
  !SUPABASE_URL.startsWith('YOUR_') && !SUPABASE_ANON_KEY.startsWith('YOUR_');
const db = isConfigured
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

/* =====================================================
   2. HELPERS
   ===================================================== */
const NORMAL_BALANCE = {
  Asset: 'Debit',
  Expense: 'Debit',
  Liability: 'Credit',
  Equity: 'Credit',
  Revenue: 'Credit',
};

const state = { accounts: [], entries: [], page: 'accounts' };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function money(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const s = Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return v < 0 ? `(${CURRENCY}${s})` : `${CURRENCY}${s}`;
}

// Blank cell for zero values
const cell = (n) => (Math.abs(n) < 0.005 ? '' : money(n));

function today() {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

let statusTimer;
function notify(message, type = 'ok') {
  const el = $('#status');
  el.textContent = message;
  el.className = `status ${type}`;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el.classList.add('hidden'), type === 'error' ? 7000 : 3500);
}

function requireDb() {
  if (!db) {
    notify('Connect your Supabase database first (see top of script.js).', 'error');
    return false;
  }
  return true;
}

function accountLabel(id) {
  const a = state.accounts.find((x) => x.id === id);
  return a ? `${a.code} — ${a.name}` : 'Unknown account';
}

/* =====================================================
   3. DATA (Supabase)
   ===================================================== */
async function loadData() {
  if (!db) return;
  const [acc, ent] = await Promise.all([
    db.from('accounts').select('*').order('code'),
    db.from('journal_entries').select('*, journal_lines(*)').order('entry_date').order('created_at'),
  ]);
  const error = acc.error || ent.error;
  if (error) {
    notify(`Could not load data: ${error.message}`, 'error');
    return;
  }
  state.accounts = acc.data;
  state.entries = ent.data;
}

async function refresh() {
  await loadData();
  render();
}

/* =====================================================
   4. NAVIGATION
   ===================================================== */
function showPage(page) {
  if (!$(`#page-${page}`)) page = 'accounts';
  state.page = page;
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  history.replaceState(null, '', `#${page}`);
  render();
  window.scrollTo(0, 0);
}

$('#nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-item');
  if (btn) showPage(btn.dataset.page);
});

/* =====================================================
   5. CHART OF ACCOUNTS
   ===================================================== */
function renderAccounts() {
  const body = $('#accounts-body');
  if (!state.accounts.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">No accounts yet.</td></tr>';
    return;
  }
  body.innerHTML = state.accounts.map((a) => `
    <tr>
      <td>${esc(a.code)}</td>
      <td>${esc(a.name)}</td>
      <td>${esc(a.type)}</td>
      <td>${NORMAL_BALANCE[a.type] || ''}</td>
      <td class="act"><button class="btn-del" data-del-account="${a.id}">Delete</button></td>
    </tr>`).join('');
}

$('#account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!requireDb()) return;
  const data = new FormData(e.target);
  const { error } = await db.from('accounts').insert({
    code: data.get('code').trim(),
    name: data.get('account_name').trim(),
    type: data.get('type'),
  });
  if (error) {
    notify(error.code === '23505' ? 'That account code already exists.' : error.message, 'error');
    return;
  }
  e.target.reset();
  notify('Account added.');
  refresh();
});

/* =====================================================
   6. JOURNAL ENTRIES (Business Transactions & Adjustments)
   ===================================================== */
const MIN_LINES = 2;
const cents = (n) => Math.round((Number(n) || 0) * 100);

function accountOptions() {
  return '<option value="" disabled selected>Select account</option>' +
    state.accounts
      .map((a) => `<option value="${a.id}">${esc(a.code)} — ${esc(a.name)}</option>`)
      .join('');
}

function lineRowHtml() {
  return `
    <tr class="line-row">
      <td><select name="account">${accountOptions()}</select></td>
      <td><input type="number" name="debit" min="0" step="0.01" class="amount-input"></td>
      <td><input type="number" name="credit" min="0" step="0.01" class="amount-input"></td>
      <td class="act"><button type="button" class="btn-x" data-remove-line title="Remove line">&#10005;</button></td>
    </tr>`;
}

function addLine(form) {
  $('.lines-body', form).insertAdjacentHTML('beforeend', lineRowHtml());
}

function resetLines(form) {
  $('.lines-body', form).innerHTML = '';
  for (let i = 0; i < MIN_LINES; i++) addLine(form);
  updateTotals(form);
}

function readLines(form) {
  return $$('.line-row', form).map((row) => ({
    account_id: $('[name=account]', row).value,
    debit: cents($('[name=debit]', row).value),
    credit: cents($('[name=credit]', row).value),
  }));
}

function updateTotals(form) {
  const lines = readLines(form);
  const d = lines.reduce((s, l) => s + l.debit, 0);
  const c = lines.reduce((s, l) => s + l.credit, 0);
  $('.tot-debit', form).textContent = money(d / 100);
  $('.tot-credit', form).textContent = money(c / 100);

  const hint = $('.balance-hint', form);
  if (d === 0 && c === 0) {
    hint.textContent = '';
    hint.className = 'balance-hint';
  } else if (d === c) {
    hint.textContent = 'Balanced';
    hint.className = 'balance-hint ok';
  } else {
    hint.textContent = `Out of balance by ${money(Math.abs(d - c) / 100)}`;
    hint.className = 'balance-hint warn';
  }
}

function renderAccountSelects() {
  $$('.entry-form').forEach((form) => {
    if (!$$('.line-row', form).length) resetLines(form);
    $$('select[name=account]', form).forEach((select) => {
      const previous = select.value;
      select.innerHTML = accountOptions();
      if (previous && state.accounts.some((a) => a.id === previous)) select.value = previous;
    });
    if (!form.elements.entry_date.value) form.elements.entry_date.value = today();
  });
}

function renderEntries() {
  [
    ['transaction', 'Journal', 'transactions'],
    ['adjustment', 'Adjusting Entries', 'adjustments'],
  ].forEach(([kind, title, label]) => {
    const list = state.entries.filter((e) => e.kind === kind);
    const body = $(`[data-entries="${kind}"]`);
    const foot = $(`[data-entries-total="${kind}"]`);
    $(`[data-entries-title="${kind}"]`).textContent = `${title} (${list.length})`;

    if (!list.length) {
      body.innerHTML = `<tr><td colspan="5" class="empty">No ${label} recorded yet.</td></tr>`;
      foot.innerHTML = '';
      return;
    }

    let totalD = 0, totalC = 0;
    body.innerHTML = list.map((e) => {
      const lines = [...(e.journal_lines || [])].sort((a, b) => a.line_no - b.line_no);
      const ordered = [
        ...lines.filter((l) => Number(l.debit) > 0),
        ...lines.filter((l) => Number(l.credit) > 0),
      ];
      const note = [e.reference && `Ref. ${e.reference}`, e.description].filter(Boolean).join(' — ');

      const rows = ordered.map((l, i) => {
        const d = Number(l.debit), c = Number(l.credit);
        totalD += d; totalC += c;
        const classes = ['je', i === 0 ? 'je-first' : '', i === ordered.length - 1 && !note ? 'je-end' : '']
          .filter(Boolean).join(' ');
        return `
      <tr class="${classes}">
        <td>${i === 0 ? formatDate(e.entry_date) : ''}</td>
        <td class="${c > 0 ? 'credit-name' : ''}">${esc(accountLabel(l.account_id))}</td>
        <td class="num">${cell(d)}</td>
        <td class="num">${cell(c)}</td>
        <td class="act">${i === 0 ? `<button class="btn-del" data-del-entry="${e.id}">Delete</button>` : ''}</td>
      </tr>`;
      }).join('');

      const noteRow = note
        ? `<tr class="je je-end"><td></td><td class="desc" colspan="4">${esc(note)}</td></tr>`
        : '';
      return rows + noteRow;
    }).join('');

    foot.innerHTML = `<tr><td colspan="2">Total</td><td class="num">${money(totalD)}</td><td class="num">${money(totalC)}</td><td></td></tr>`;
  });
}

/* Add / remove lines and live totals */
document.addEventListener('click', (e) => {
  const form = e.target.closest('.entry-form');
  if (!form) return;

  if (e.target.closest('[data-add-line]')) {
    addLine(form);
    return;
  }
  const remove = e.target.closest('[data-remove-line]');
  if (remove) {
    const row = remove.closest('.line-row');
    if ($$('.line-row', form).length > MIN_LINES) {
      row.remove();
    } else {
      $$('input', row).forEach((i) => { i.value = ''; });
      $('select', row).value = '';
    }
    updateTotals(form);
  }
});

document.addEventListener('input', (e) => {
  const form = e.target.closest('.entry-form');
  if (!form) return;
  const row = e.target.closest('.line-row');
  // a line is either a debit or a credit, never both
  if (row && e.target.value) {
    if (e.target.name === 'debit') $('[name=credit]', row).value = '';
    if (e.target.name === 'credit') $('[name=debit]', row).value = '';
  }
  updateTotals(form);
});

$$('.entry-form').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!requireDb()) return;

    const lines = readLines(form).filter((l) => l.account_id || l.debit || l.credit);
    if (lines.length < 2) return notify('Add at least two lines.', 'error');
    if (lines.some((l) => !l.account_id)) return notify('Select an account for every line.', 'error');
    if (lines.some((l) => (l.debit > 0) === (l.credit > 0))) {
      return notify('Each line needs either a debit or a credit amount.', 'error');
    }
    const d = lines.reduce((s, l) => s + l.debit, 0);
    const c = lines.reduce((s, l) => s + l.credit, 0);
    if (d !== c) {
      return notify(`Total debit and total credit must be equal. Difference: ${money(Math.abs(d - c) / 100)}.`, 'error');
    }

    const date = form.elements.entry_date.value;
    const { data: entry, error } = await db
      .from('journal_entries')
      .insert({
        entry_date: date,
        reference: form.elements.reference.value.trim() || null,
        description: form.elements.description.value.trim() || null,
        kind: form.dataset.kind,
      })
      .select()
      .single();
    if (error) return notify(error.message, 'error');

    const { error: lineError } = await db.from('journal_lines').insert(
      lines.map((l, i) => ({
        entry_id: entry.id,
        line_no: i,
        account_id: l.account_id,
        debit: l.debit / 100,
        credit: l.credit / 100,
      })),
    );
    if (lineError) {
      await db.from('journal_entries').delete().eq('id', entry.id); // undo the empty entry
      return notify(lineError.message, 'error');
    }

    form.reset();
    form.elements.entry_date.value = date;
    resetLines(form);
    notify('Entry saved.');
    refresh();
  });
});

/* Delete buttons (accounts + entries) */
document.addEventListener('click', async (e) => {
  const accBtn = e.target.closest('[data-del-account]');
  const entBtn = e.target.closest('[data-del-entry]');
  if (!accBtn && !entBtn) return;
  if (!requireDb()) return;

  if (accBtn) {
    if (!confirm('Delete this account?')) return;
    const { error } = await db.from('accounts').delete().eq('id', accBtn.dataset.delAccount);
    if (error) {
      notify(error.code === '23503'
        ? 'This account is used in an entry. Delete those entries first.'
        : error.message, 'error');
      return;
    }
    notify('Account deleted.');
  } else {
    if (!confirm('Delete this entry?')) return;
    const { error } = await db.from('journal_entries').delete().eq('id', entBtn.dataset.delEntry);
    if (error) return notify(error.message, 'error');
    notify('Entry deleted.');
  }
  refresh();
});

/* =====================================================
   7. REPORT CALCULATIONS
   ===================================================== */
// Debit / credit totals per account for the given entry kinds
function totals(kinds) {
  const map = new Map(state.accounts.map((a) => [a.id, { account: a, debit: 0, credit: 0 }]));
  state.entries
    .filter((e) => kinds.includes(e.kind))
    .forEach((e) => {
      (e.journal_lines || []).forEach((l) => {
        const row = map.get(l.account_id);
        if (!row) return;
        row.debit += Number(l.debit);
        row.credit += Number(l.credit);
      });
    });
  return [...map.values()];
}

const isActive = (r) => r.debit !== 0 || r.credit !== 0;
const net = (r) => r.debit - r.credit;

function statements() {
  const rows = totals(['transaction', 'adjustment']).filter(isActive);
  const pick = (type, creditNormal) =>
    rows
      .filter((r) => r.account.type === type)
      .map((r) => ({
        name: r.account.name,
        amount: creditNormal ? r.credit - r.debit : r.debit - r.credit,
      }));
  const sum = (list) => list.reduce((s, x) => s + x.amount, 0);

  const revenue = pick('Revenue', true);
  const expenses = pick('Expense', false);
  const assets = pick('Asset', false);
  const liabilities = pick('Liability', true);
  const capital = pick('Equity', true);

  const totalRevenue = sum(revenue);
  const totalExpenses = sum(expenses);
  const netIncome = totalRevenue - totalExpenses;
  const totalCapital = sum(capital);
  const endingEquity = totalCapital + netIncome;
  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);

  return {
    hasData: rows.length > 0,
    revenue, expenses, assets, liabilities, capital,
    totalRevenue, totalExpenses, netIncome,
    totalCapital, endingEquity,
    totalAssets, totalLiabilities,
    difference: totalAssets - (totalLiabilities + endingEquity),
  };
}

/* Small HTML builders for statements */
const line = (label, amount, cls = '') =>
  `<div class="line ${cls}"><span>${esc(label)}</span><span>${money(amount)}</span></div>`;
const section = (title) => `<div class="section">${esc(title)}</div>`;
const items = (list) => list.map((x) => line(x.name, x.amount, 'indent')).join('');
const emptyStatement = (msg) => `<div class="card"><p class="empty">${msg}</p></div>`;
const NO_DATA = 'No data yet.';
const incomeLabel = (s) => (s.netIncome < 0 ? 'Net Loss' : 'Net Income');

/* =====================================================
   8. REPORT RENDERERS
   ===================================================== */
function balanceCheck(d, c) {
  return Math.abs(d - c) < 0.005
    ? '<p class="note ok">Debits equal credits.</p>'
    : `<p class="note warn">Out of balance by ${money(Math.abs(d - c))}.</p>`;
}

function renderTrialBalance() {
  const out = $('#trial-balance-out');
  const rows = totals(['transaction']).filter(isActive);
  if (!rows.length) {
    out.innerHTML = '<p class="empty">No transactions recorded yet.</p>';
    return;
  }

  let td = 0, tc = 0;
  const body = rows.map((r) => {
    const n = net(r);
    const dr = n >= 0 ? n : 0;
    const cr = n < 0 ? -n : 0;
    td += dr; tc += cr;
    return `<tr>
      <td>${esc(r.account.code)}</td><td>${esc(r.account.name)}</td>
      <td class="num">${cell(dr)}</td><td class="num">${cell(cr)}</td></tr>`;
  }).join('');

  out.innerHTML = `
    <table>
      <thead><tr><th>Code</th><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td colspan="2">Total</td><td class="num">${money(td)}</td><td class="num">${money(tc)}</td></tr></tfoot>
    </table>
    ${balanceCheck(td, tc)}`;
}

function renderAdjustedTrialBalance() {
  const out = $('#adjusted-trial-balance-out');
  const tb = totals(['transaction']);
  const adj = totals(['adjustment']);
  const all = totals(['transaction', 'adjustment']);

  const idx = all.map((_, i) => i).filter((i) => isActive(all[i]));
  if (!idx.length) {
    out.innerHTML = '<p class="empty">No entries recorded yet.</p>';
    return;
  }

  const sums = { tbD: 0, tbC: 0, adD: 0, adC: 0, atD: 0, atC: 0 };
  const body = idx.map((i) => {
    const a = all[i].account;
    const tbN = net(tb[i]);
    const atN = net(all[i]);
    const tbD = tbN >= 0 ? tbN : 0, tbC = tbN < 0 ? -tbN : 0;
    const atD = atN >= 0 ? atN : 0, atC = atN < 0 ? -atN : 0;
    const adD = adj[i].debit, adC = adj[i].credit;
    sums.tbD += tbD; sums.tbC += tbC;
    sums.adD += adD; sums.adC += adC;
    sums.atD += atD; sums.atC += atC;
    return `<tr>
      <td>${esc(a.code)}</td><td>${esc(a.name)}</td>
      <td class="num">${cell(tbD)}</td><td class="num">${cell(tbC)}</td>
      <td class="num">${cell(adD)}</td><td class="num">${cell(adC)}</td>
      <td class="num">${cell(atD)}</td><td class="num">${cell(atC)}</td></tr>`;
  }).join('');

  out.innerHTML = `
    <table>
      <thead>
        <tr>
          <th rowspan="2">Code</th><th rowspan="2">Account</th>
          <th colspan="2" class="group">Trial Balance</th>
          <th colspan="2" class="group">Adjustments</th>
          <th colspan="2" class="group">Adjusted Trial Balance</th>
        </tr>
        <tr>
          <th class="num">Debit</th><th class="num">Credit</th>
          <th class="num">Debit</th><th class="num">Credit</th>
          <th class="num">Debit</th><th class="num">Credit</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td colspan="2">Total</td>
        <td class="num">${money(sums.tbD)}</td><td class="num">${money(sums.tbC)}</td>
        <td class="num">${money(sums.adD)}</td><td class="num">${money(sums.adC)}</td>
        <td class="num">${money(sums.atD)}</td><td class="num">${money(sums.atC)}</td>
      </tr></tfoot>
    </table>
    ${balanceCheck(sums.atD, sums.atC)}`;
}

function renderIncomeStatement() {
  const out = $('#income-statement-out');
  const s = statements();
  if (!s.revenue.length && !s.expenses.length) {
    out.innerHTML = emptyStatement('No revenue or expense entries yet.');
    return;
  }
  out.innerHTML = `
    <div class="statement">
      <h3>Income Statement</h3>
      ${section('Revenue')}
      ${items(s.revenue)}
      ${line('Total Revenue', s.totalRevenue, 'sub-total')}
      ${section('Expenses')}
      ${items(s.expenses)}
      ${line('Total Expenses', s.totalExpenses, 'sub-total')}
      ${line(incomeLabel(s), Math.abs(s.netIncome), 'grand')}
    </div>`;
}

function balanceNote(s) {
  return Math.abs(s.difference) < 0.005
    ? '<p class="note ok">Assets equal liabilities plus owner\'s equity.</p>'
    : `<p class="note warn">Out of balance by ${money(Math.abs(s.difference))}. Check your entries.</p>`;
}

function renderOwnersEquity() {
  const out = $('#owners-equity-out');
  const s = statements();
  if (!s.hasData) { out.innerHTML = emptyStatement(NO_DATA); return; }

  out.innerHTML = `
    <div class="statement">
      <h3>Statement of Owner's Equity</h3>
      ${items(s.capital)}
      ${line("Total Owner's Capital", s.totalCapital, 'sub-total')}
      ${line(s.netIncome < 0 ? 'Less: Net Loss' : 'Add: Net Income', Math.abs(s.netIncome))}
      ${line("Owner's Equity, ending", s.endingEquity, 'grand')}
    </div>`;
}

function renderFinancialPosition() {
  const out = $('#financial-position-out');
  const s = statements();
  if (!s.hasData) { out.innerHTML = emptyStatement(NO_DATA); return; }

  out.innerHTML = `
    <div class="statement">
      <h3>Statement of Financial Position</h3>
      ${section('Assets')}
      ${items(s.assets)}
      ${line('Total Assets', s.totalAssets, 'sub-total')}
      ${section('Liabilities')}
      ${items(s.liabilities)}
      ${line('Total Liabilities', s.totalLiabilities, 'sub-total')}
      ${section("Owner's Equity")}
      ${items(s.capital)}
      ${line(s.netIncome < 0 ? 'Less: Net Loss' : 'Add: Net Income', Math.abs(s.netIncome), 'indent')}
      ${line("Total Owner's Equity", s.endingEquity, 'sub-total')}
      ${line("Total Liabilities and Owner's Equity", s.totalLiabilities + s.endingEquity, 'grand')}
    </div>
    ${balanceNote(s)}`;
}

/* =====================================================
   9. MAIN RENDER
   ===================================================== */
function render() {
  renderAccountSelects();
  switch (state.page) {
    case 'accounts': renderAccounts(); break;
    case 'transactions':
    case 'adjustments': renderEntries(); break;
    case 'trial-balance': renderTrialBalance(); break;
    case 'adjusted-trial-balance': renderAdjustedTrialBalance(); break;
    case 'income-statement': renderIncomeStatement(); break;
    case 'owners-equity': renderOwnersEquity(); break;
    case 'financial-position': renderFinancialPosition(); break;
  }
}

/* =====================================================
   10. START
   ===================================================== */
(async function init() {
  if (!isConfigured) $('#setup-banner').classList.remove('hidden');
  await loadData();
  showPage(location.hash.replace('#', '') || 'accounts');
})();
