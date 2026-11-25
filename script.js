'use strict';

const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
const CURRENCY = '₱';
const COMPANY_NAME = 'AAA Company'; // shown at the top of the Statement of Cash Flow

const isConfigured =
  !SUPABASE_URL.startsWith('YOUR_') && !SUPABASE_ANON_KEY.startsWith('YOUR_');
const db = isConfigured
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;


const NORMAL_BALANCE = {
  Asset: 'Debit',
  Expense: 'Debit',
  Liability: 'Credit',
  Equity: 'Credit',
  Revenue: 'Credit',
};

// Everything loaded from the database, plus the page being shown
const state = { accounts: [], entries: [], page: 'home' };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Escapes text before it is placed inside HTML
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Formats an amount as 1,500.00, with negatives in parentheses
function formatAmount(n, symbol = '') {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const s = Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return v < 0 ? `(${symbol}${s})` : `${symbol}${s}`;
}

const money = (n) => formatAmount(n, CURRENCY); // with currency symbol
const plain = (n) => formatAmount(n);           // without currency symbol

// Like money(), but leaves zero amounts blank
const cell = (n) => (Math.abs(n) < 0.005 ? '' : money(n));

// Converts an amount to whole cents so totals compare exactly
const cents = (n) => Math.round((Number(n) || 0) * 100);

// Sum of one field (debit or credit, in cents) across lines
const sumOf = (lines, key) => lines.reduce((s, l) => s + l[key], 0);

// Today's date as YYYY-MM-DD
function today() {
  return new Date().toLocaleDateString('en-CA');
}

// YYYY-MM-DD text from year, month and day numbers
const isoDate = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// Turns 2023-12-31 into "Dec 31, 2023"
function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

// Shows a short message at the top of the page
let statusTimer;
function notify(message, type = 'ok') {
  const el = $('#status');
  el.textContent = message;
  el.className = `status ${type}`;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el.classList.add('hidden'), type === 'error' ? 7000 : 3500);
}

// Stops an action when Supabase is not connected yet
function requireDb() {
  if (!db) {
    notify('Connect your Supabase database first (see top of script.js).', 'error');
    return false;
  }
  return true;
}

// "101 — Cash" style name for an account id
function accountLabel(id) {
  const a = state.accounts.find((x) => x.id === id);
  return a ? `${a.code} — ${a.name}` : 'Unknown account';
}

/* =====================================================
   3. DATA (Supabase)
   ===================================================== */

// Loads all accounts and journal entries (with their lines)
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

// Reloads the data and redraws the current page
async function refresh() {
  await loadData();
  render();
}

/* =====================================================
   4. NAVIGATION
   ===================================================== */

// Switches to a page and highlights its tab
function showPage(page) {
  if (!$(`#page-${page}`)) page = 'home';
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
const CASH_FLOW_OPTIONS = ['Cash', 'Operating', 'Investing', 'Financing'];

// Cash flow group of an account: its own setting, else guessed from name and type
function cashFlowCategory(a) {
  if (a.cash_flow) return a.cash_flow;
  if (/cash/i.test(a.name)) return 'Cash';
  return a.type === 'Equity' ? 'Financing' : 'Operating';
}

// Draws the accounts table
function renderAccounts() {
  const body = $('#accounts-body');
  if (!state.accounts.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">No accounts yet.</td></tr>';
    return;
  }
  body.innerHTML = state.accounts.map((a) => `
    <tr>
      <td>${esc(a.code)}</td>
      <td>${esc(a.name)}</td>
      <td>${esc(a.type)}</td>
      <td>${NORMAL_BALANCE[a.type] || ''}</td>
      <td>
        <select class="cf-select" data-cf-account="${a.id}">
          <option value="">Auto (${cashFlowCategory({ ...a, cash_flow: null })})</option>
          ${CASH_FLOW_OPTIONS.map((o) => `<option value="${o}" ${a.cash_flow === o ? 'selected' : ''}>${o}</option>`).join('')}
        </select>
      </td>
      <td class="act"><button class="btn-del" data-del-account="${a.id}">Delete</button></td>
    </tr>`).join('');
}

// Adds a new account
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

// Saves the Cash Flow choice of an account
document.addEventListener('change', async (e) => {
  const select = e.target.closest('[data-cf-account]');
  if (!select || !requireDb()) return;
  const { error } = await db
    .from('accounts')
    .update({ cash_flow: select.value || null })
    .eq('id', select.dataset.cfAccount);
  if (error) return notify(error.message, 'error');
  notify('Cash flow category saved.');
  refresh();
});

/* =====================================================
   6. JOURNAL ENTRIES (Business Transactions and Adjustments)
   Both pages use the same form: one entry with two or more lines.
   ===================================================== */
const MIN_LINES = 2;

// Dropdown options for every account
function accountOptions() {
  return '<option value="" disabled selected>Select account</option>' +
    state.accounts
      .map((a) => `<option value="${a.id}">${esc(a.code)} — ${esc(a.name)}</option>`)
      .join('');
}

// One empty account line (account, debit, credit, remove button)
function lineRowHtml() {
  return `
    <tr class="line-row">
      <td><select name="account">${accountOptions()}</select></td>
      <td><input type="number" name="debit" min="0" step="0.01" class="amount-input"></td>
      <td><input type="number" name="credit" min="0" step="0.01" class="amount-input"></td>
      <td class="act"><button type="button" class="btn-x" data-remove-line title="Remove line">&#10005;</button></td>
    </tr>`;
}

// Adds one empty line to a form
function addLine(form) {
  $('.lines-body', form).insertAdjacentHTML('beforeend', lineRowHtml());
}

// Clears a form back to its minimum number of empty lines
function resetLines(form) {
  $('.lines-body', form).innerHTML = '';
  for (let i = 0; i < MIN_LINES; i++) addLine(form);
  updateTotals(form);
}

// Reads the lines of a form (amounts in cents)
function readLines(form) {
  return $$('.line-row', form).map((row) => ({
    account_id: $('[name=account]', row).value,
    debit: cents($('[name=debit]', row).value),
    credit: cents($('[name=credit]', row).value),
  }));
}

// Updates the Totals row and the Balanced / Out of balance note
function updateTotals(form) {
  const lines = readLines(form);
  const d = sumOf(lines, 'debit');
  const c = sumOf(lines, 'credit');
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

// Fills every account dropdown and gives the forms their starting lines and date
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

// HTML rows of one saved entry: debit lines, then credit lines, then the note
function entryRowsHtml(entry) {
  const lines = [...(entry.journal_lines || [])].sort((a, b) => a.line_no - b.line_no);
  const ordered = [
    ...lines.filter((l) => Number(l.debit) > 0),
    ...lines.filter((l) => Number(l.credit) > 0),
  ];
  const note = [entry.reference && `Ref. ${entry.reference}`, entry.description]
    .filter(Boolean).join(' — ');

  const rows = ordered.map((l, i) => {
    const credit = Number(l.credit);
    const classes = ['je', i === 0 ? 'je-first' : '', i === ordered.length - 1 && !note ? 'je-end' : '']
      .filter(Boolean).join(' ');
    return `
      <tr class="${classes}">
        <td>${i === 0 ? formatDate(entry.entry_date) : ''}</td>
        <td class="${credit > 0 ? 'credit-name' : ''}">${esc(accountLabel(l.account_id))}</td>
        <td class="num">${cell(Number(l.debit))}</td>
        <td class="num">${cell(credit)}</td>
        <td class="act">${i === 0 ? `<button class="btn-del" data-del-entry="${entry.id}">Delete</button>` : ''}</td>
      </tr>`;
  }).join('');

  const noteRow = note
    ? `<tr class="je je-end"><td></td><td class="desc" colspan="4">${esc(note)}</td></tr>`
    : '';
  return rows + noteRow;
}

// Draws the saved entries (journal list) of both pages
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

    const lines = list.flatMap((e) => e.journal_lines || []);
    const totalD = lines.reduce((s, l) => s + Number(l.debit), 0);
    const totalC = lines.reduce((s, l) => s + Number(l.credit), 0);
    body.innerHTML = list.map(entryRowsHtml).join('');
    foot.innerHTML = `<tr><td colspan="2">Total</td><td class="num">${money(totalD)}</td><td class="num">${money(totalC)}</td><td></td></tr>`;
  });
}

// Add line / remove line buttons
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

// Live totals; a line can hold a debit or a credit, never both
document.addEventListener('input', (e) => {
  const form = e.target.closest('.entry-form');
  if (!form) return;
  const row = e.target.closest('.line-row');
  if (row && e.target.value) {
    if (e.target.name === 'debit') $('[name=credit]', row).value = '';
    if (e.target.name === 'credit') $('[name=debit]', row).value = '';
  }
  updateTotals(form);
});

// Returns a message if the lines cannot be saved, otherwise an empty string
function validateLines(lines) {
  if (lines.length < 2) return 'Add at least two lines.';
  if (lines.some((l) => !l.account_id)) return 'Select an account for every line.';
  if (lines.some((l) => (l.debit > 0) === (l.credit > 0))) {
    return 'Each line needs either a debit or a credit amount.';
  }
  const diff = sumOf(lines, 'debit') - sumOf(lines, 'credit');
  if (diff !== 0) {
    return `Total debit and total credit must be equal. Difference: ${money(Math.abs(diff) / 100)}.`;
  }
  return '';
}

// Saves a new entry and its lines
$$('.entry-form').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!requireDb()) return;

    const lines = readLines(form).filter((l) => l.account_id || l.debit || l.credit);
    const problem = validateLines(lines);
    if (problem) return notify(problem, 'error');

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
      await db.from('journal_entries').delete().eq('id', entry.id); // remove the empty entry
      return notify(lineError.message, 'error');
    }

    form.reset();
    form.elements.entry_date.value = date;
    resetLines(form);
    notify('Entry saved.');
    refresh();
  });
});

// Delete buttons for accounts and entries
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

// Total debit and credit per account for the given kinds of entries
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

const isActive = (r) => r.debit !== 0 || r.credit !== 0; // account has activity
const net = (r) => r.debit - r.credit;                   // positive = debit balance

// All figures used by the income statement, owner's equity and financial position
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

/* Small HTML builders for the statements */
const line = (label, amount, cls = '') =>
  `<div class="line ${cls}"><span>${esc(label)}</span><span>${money(amount)}</span></div>`;
const section = (title) => `<div class="section">${esc(title)}</div>`;
const items = (list) => list.map((x) => line(x.name, x.amount, 'indent')).join('');
const emptyStatement = (msg) => `<div class="card"><p class="empty">${msg}</p></div>`;
const incomeLabel = (s) => (s.netIncome < 0 ? 'Net Loss' : 'Net Income');
const NO_DATA = 'No data yet.';

// Warning shown only when the report is out of balance
function balanceWarning(difference, hint = '') {
  return Math.abs(difference) < 0.005
    ? ''
    : `<p class="note warn">Out of balance by ${money(Math.abs(difference))}.${hint}</p>`;
}

/* =====================================================
   8. REPORT PAGES
   ===================================================== */

// Trial balance: each account's balance in the debit or credit column
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
    ${balanceWarning(td - tc)}`;
}

// Adjusted trial balance: trial balance, adjustments and adjusted balances side by side
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
    ${balanceWarning(sums.atD - sums.atC)}`;
}

// Income statement: revenue less expenses
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

// Statement of owner's equity: capital plus net income
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

// Statement of financial position: assets, liabilities and owner's equity
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
    ${balanceWarning(s.difference, ' Check your entries.')}`;
}

// Cash in and out per account, grouped as Operating, Investing and Financing.
// In an entry that touches cash, each non-cash line (credit - debit) is the
// cash it brought in or took out.
function collectCashFlows() {
  const category = new Map(state.accounts.map((a) => [a.id, cashFlowCategory(a)]));
  const groups = { Operating: new Map(), Investing: new Map(), Financing: new Map() };
  const dates = [];
  let endingCash = 0;

  state.entries.forEach((e) => {
    const lines = e.journal_lines || [];
    if (!lines.some((l) => category.get(l.account_id) === 'Cash')) return;
    dates.push(e.entry_date);
    lines.forEach((l) => {
      const cat = category.get(l.account_id);
      const amount = Number(l.debit) - Number(l.credit);
      if (cat === 'Cash') { endingCash += amount; return; }
      const group = groups[cat];
      if (group) group.set(l.account_id, (group.get(l.account_id) || 0) - amount);
    });
  });

  return { groups, dates, endingCash };
}

// Statement of cash flow, laid out with an item column and a total column
function renderCashFlows() {
  const out = $('#cash-flows-out');
  const { groups, dates, endingCash } = collectCashFlows();
  if (!dates.length) {
    out.innerHTML = emptyStatement('No cash transactions yet.');
    return;
  }

  // Period: first day of the earliest month to last day of the latest month
  dates.sort();
  const [fy, fm] = dates[0].split('-').map(Number);
  const [ly, lm] = dates[dates.length - 1].split('-').map(Number);
  const periodStart = isoDate(fy, fm, 1);
  const periodEnd = isoDate(ly, lm, new Date(ly, lm, 0).getDate());

  // Items of one group, sorted by account code, without zero amounts
  const byId = new Map(state.accounts.map((a) => [a.id, a]));
  const list = (group) => [...group.entries()]
    .filter(([, amount]) => Math.abs(amount) >= 0.005)
    .sort(([a], [b]) => byId.get(a).code.localeCompare(byId.get(b).code))
    .map(([id, amount]) => ({ name: byId.get(id).name, amount }));
  const total = (rows) => rows.reduce((s, x) => s + x.amount, 0);

  const operating = list(groups.Operating);
  const investing = list(groups.Investing);
  const financing = list(groups.Financing);
  const netOp = total(operating);
  const netInv = total(investing);
  const netFin = total(financing);
  const netChange = netOp + netInv + netFin;
  const beginning = endingCash - netChange;

  // Row builders
  const wording = {
    Operating: (x) => `${x.amount < 0 ? 'Cash paid for' : 'Cash received from'} ${x.name}`,
    Investing: (x) => `${x.amount < 0 ? 'Purchase of' : 'Sale of'} ${x.name}`,
    Financing: (x) => x.name,
  };
  const heading = (text) => `<tr class="cf-head"><td colspan="3">${text}</td></tr>`;
  const itemRows = (group, rows) => rows.map((x, i) => `
    <tr>
      <td class="cf-label">${esc(wording[group](x))}</td>
      <td class="cf-amt ${i === rows.length - 1 ? 'cf-rule' : ''}">${plain(x.amount)}</td>
      <td></td>
    </tr>`).join('');
  const totalRow = (text, amount, cls = '') => `
    <tr class="cf-net">
      <td>${text}</td><td></td><td class="cf-amt ${cls}">${plain(amount)}</td>
    </tr>`;
  const word = (n) => (n < 0 ? 'used in' : 'from');

  out.innerHTML = `
    <div class="statement">
      <div class="cf-title">
        ${COMPANY_NAME ? `<div class="cf-company">${esc(COMPANY_NAME)}</div>` : ''}
        <div>Statement of Cash Flow</div>
        <div>For the Month Ended, ${formatDate(periodEnd)}</div>
      </div>
      <table class="cf-table">
        <tbody>
          ${heading('Cash flows from operating activities')}
          ${itemRows('Operating', operating)}
          ${totalRow(`Net cash ${word(netOp)} operating activities`, netOp)}
          ${heading('Cash flows from investing activities')}
          ${itemRows('Investing', investing)}
          ${totalRow(`Net cash ${word(netInv)} investing activities`, netInv)}
          ${heading('Cash flows from financing activities')}
          ${itemRows('Financing', financing)}
          ${totalRow(`Net cash ${word(netFin)} financing activities`, netFin)}
          <tr class="cf-gap"><td colspan="3"></td></tr>
          ${totalRow(netChange < 0 ? 'Net decrease in cash' : 'Net increase in cash', netChange)}
          <tr>
            <td class="cf-label">Cash, beginning (${formatDate(periodStart)})</td><td></td>
            <td class="cf-amt cf-rule">${plain(beginning)}</td>
          </tr>
          <tr class="cf-net">
            <td class="cf-label">Cash, ending (${formatDate(periodEnd)})</td><td></td>
            <td class="cf-amt cf-double">${plain(endingCash)}</td>
          </tr>
        </tbody>
      </table>
    </div>`;
}

/* =====================================================
   9. HOME DASHBOARD
   ===================================================== */

// Short number for chart labels: 1,500 -> 1.5K
function compact(n) {
  const a = Math.abs(n);
  const t = a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : a.toFixed(0);
  const s = t.replace(/\.0(?=[KM])/, '');
  return n < 0 ? `(${s})` : s;
}

// Cuts long names so they fit under a bar
const shorten = (text, max = 11) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// Bar chart drawn as SVG. data = [{ label, value, tone }]; negatives turn red
function barChart(data) {
  if (!data.some((d) => Math.abs(d.value) >= 0.005)) {
    return '<p class="chart-empty">No data yet.</p>';
  }
  const W = 360, H = 190, top = 22, bottom = 34, side = 8;
  const hi = Math.max(0, ...data.map((d) => d.value));
  const lo = Math.min(0, ...data.map((d) => d.value));
  const y = (v) => top + ((hi - v) / (hi - lo)) * (H - top - bottom);
  const slot = (W - side * 2) / data.length;
  const width = Math.min(54, slot * 0.6);

  const bars = data.map((d, i) => {
    const x = side + slot * i + (slot - width) / 2;
    const y0 = y(0);
    const y1 = y(d.value);
    const h = Math.max(Math.abs(y1 - y0), 1);
    const tone = d.value < 0 ? 'neg' : d.tone || 't1';
    const labelY = d.value < 0 ? y0 + h + 12 : y1 - 5;
    return `
      <rect class="${tone}" x="${x.toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${width.toFixed(1)}" height="${h.toFixed(1)}" rx="3">
        <title>${esc(d.label)}: ${money(d.value)}</title>
      </rect>
      <text x="${(x + width / 2).toFixed(1)}" y="${labelY.toFixed(1)}">${compact(d.value)}</text>
      <text class="lbl" x="${(x + width / 2).toFixed(1)}" y="${H - 8}">${esc(shorten(d.label))}</text>`;
  }).join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart">
    <line class="zero" x1="${side}" x2="${W - side}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"></line>
    ${bars}
  </svg>`;
}

// One dashboard card: title, link to the tab, key figures and a chart
function dashCard(page, title, stats, chart) {
  const figures = stats.map(([label, value, cls = '']) =>
    `<div><span>${label}</span><strong class="${cls}">${value}</strong></div>`).join('');
  return `
    <section class="card dash-card">
      <div class="dash-head">
        <h3>${title}</h3>
        <button type="button" class="link-btn" data-go="${page}">View</button>
      </div>
      <div class="dash-stats">${figures}</div>
      ${chart}
    </section>`;
}

// Draws the summary cards and charts for every tab
function renderHome() {
  const out = $('#home-out');
  const s = statements();
  const cf = collectCashFlows();
  const sumMap = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  const operating = sumMap(cf.groups.Operating);
  const investing = sumMap(cf.groups.Investing);
  const financing = sumMap(cf.groups.Financing);

  const transactions = state.entries.filter((e) => e.kind === 'transaction');
  const adjustments = state.entries.filter((e) => e.kind === 'adjustment');
  const entryTotal = (list) => list.reduce((sum, e) =>
    sum + (e.journal_lines || []).reduce((t, l) => t + Number(l.debit), 0), 0);

  // Debit and credit column totals of a trial balance
  const split = (rows) => rows.reduce((t, r) => {
    const n = net(r);
    if (n > 0) t.debit += n; else t.credit -= n;
    return t;
  }, { debit: 0, credit: 0 });
  const tb = split(totals(['transaction']));
  const atb = split(totals(['transaction', 'adjustment']));
  const tbBalanced = Math.abs(tb.debit - tb.credit) < 0.005;
  const atbBalanced = Math.abs(atb.debit - atb.credit) < 0.005;
  const status = (ok) => (ok ? ['Status', 'Balanced'] : ['Status', 'Out of balance', 'warn']);

  // Transaction amount per month (latest six months)
  const monthly = [...transactions.reduce((m, e) => {
    const key = e.entry_date.slice(0, 7);
    return m.set(key, (m.get(key) || 0) + entryTotal([e]));
  }, new Map())].sort().slice(-6).map(([key, value]) => {
    const [yr, mo] = key.split('-').map(Number);
    return { label: new Date(yr, mo - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }), value };
  });

  // Accounts that the adjustments touch most
  const adjusted = totals(['adjustment']).filter(isActive)
    .sort((a, b) => (b.debit + b.credit) - (a.debit + a.credit)).slice(0, 5)
    .map((r) => ({ label: r.account.name, value: r.debit + r.credit, tone: 't3' }));

  const types = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'];
  const typeCounts = types.map((t) => ({ label: t, value: state.accounts.filter((a) => a.type === t).length }));

  const incomeName = incomeLabel(s);
  const kpis = [
    ['Total Assets', money(s.totalAssets), ''],
    [incomeName, money(s.netIncome), s.netIncome < 0 ? 'neg' : ''],
    ['Cash Balance', money(cf.endingCash), cf.endingCash < 0 ? 'neg' : ''],
    ['Journal Entries', String(state.entries.length), ''],
  ].map(([label, value, cls]) => `<div class="kpi"><span>${label}</span><strong class="${cls}">${value}</strong></div>`).join('');

  out.innerHTML = `
    <div class="kpis">${kpis}</div>
    <div class="dash-grid">
      ${dashCard('accounts', 'Chart of Accounts',
        [['Accounts', String(state.accounts.length)]],
        barChart(typeCounts))}
      ${dashCard('transactions', 'Business Transactions',
        [['Entries', String(transactions.length)], ['Total amount', money(entryTotal(transactions))]],
        barChart(monthly.map((m) => ({ ...m, tone: 't2' }))))}
      ${dashCard('trial-balance', 'Trial Balance',
        [['Debits', money(tb.debit)], ['Credits', money(tb.credit)], status(tbBalanced)],
        barChart([{ label: 'Debits', value: tb.debit }, { label: 'Credits', value: tb.credit, tone: 't2' }]))}
      ${dashCard('adjustments', 'Adjustments',
        [['Entries', String(adjustments.length)], ['Total amount', money(entryTotal(adjustments))]],
        barChart(adjusted))}
      ${dashCard('adjusted-trial-balance', 'Adjusted Trial Balance',
        [['Debits', money(atb.debit)], ['Credits', money(atb.credit)], status(atbBalanced)],
        barChart([
          { label: 'Unadjusted', value: tb.debit },
          { label: 'Adjustments', value: entryTotal(adjustments), tone: 't3' },
          { label: 'Adjusted', value: atb.debit, tone: 't2' },
        ]))}
      ${dashCard('income-statement', 'Income Statement',
        [['Revenue', money(s.totalRevenue)], ['Expenses', money(s.totalExpenses)], [incomeName, money(s.netIncome), s.netIncome < 0 ? 'warn' : '']],
        barChart([
          { label: 'Revenue', value: s.totalRevenue },
          { label: 'Expenses', value: s.totalExpenses, tone: 't3' },
          { label: incomeName, value: s.netIncome, tone: 't2' },
        ]))}
      ${dashCard('owners-equity', "Owner's Equity",
        [['Capital', money(s.totalCapital)], ['Ending equity', money(s.endingEquity)]],
        barChart([
          { label: 'Capital', value: s.totalCapital },
          { label: incomeName, value: s.netIncome, tone: 't2' },
          { label: 'Ending', value: s.endingEquity, tone: 't3' },
        ]))}
      ${dashCard('financial-position', 'Financial Position',
        [['Assets', money(s.totalAssets)], ['Liabilities', money(s.totalLiabilities)], status(Math.abs(s.difference) < 0.005)],
        barChart([
          { label: 'Assets', value: s.totalAssets },
          { label: 'Liabilities', value: s.totalLiabilities, tone: 't3' },
          { label: 'Equity', value: s.endingEquity, tone: 't2' },
        ]))}
      ${dashCard('cash-flows', 'Statement of Cash Flows',
        [['Net change', money(operating + investing + financing)], ['Ending cash', money(cf.endingCash)]],
        barChart([
          { label: 'Operating', value: operating },
          { label: 'Investing', value: investing, tone: 't2' },
          { label: 'Financing', value: financing, tone: 't3' },
        ]))}
    </div>`;
}

// "View" buttons on the dashboard open their tab
$('#home-out').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-go]');
  if (btn) showPage(btn.dataset.go);
});

/* =====================================================
   10. RENDER AND START
   ===================================================== */

// Redraws the page that is currently shown
function render() {
  renderAccountSelects();
  switch (state.page) {
    case 'home': renderHome(); break;
    case 'accounts': renderAccounts(); break;
    case 'transactions':
    case 'adjustments': renderEntries(); break;
    case 'trial-balance': renderTrialBalance(); break;
    case 'adjusted-trial-balance': renderAdjustedTrialBalance(); break;
    case 'income-statement': renderIncomeStatement(); break;
    case 'owners-equity': renderOwnersEquity(); break;
    case 'financial-position': renderFinancialPosition(); break;
    case 'cash-flows': renderCashFlows(); break;
  }
}

// Runs when the page opens: loads the data and shows the first page
(async function init() {
  if (!isConfigured) $('#setup-banner').classList.remove('hidden');
  await loadData();
  showPage(location.hash.replace('#', '') || 'home');
})();
