(() => {
  const KEY = 'baht-budget-v1';
  const fmt = d => new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB', maximumFractionDigits: d });
  const THB0 = fmt(0), THB2 = fmt(2);
  const $ = id => document.getElementById(id);
  const q = sel => app.querySelector(sel);
  const qa = sel => app.querySelectorAll(sel);

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
  const save = s => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };
  const clampDay = (y, m, d) => new Date(y, m, Math.min(d, new Date(y, m + 1, 0).getDate()));
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const genId = p => `${p || 'id'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fmtDate = (d, opts = { day: 'numeric', month: 'short' }) => new Date(d).toLocaleDateString('en-GB', opts);

  const cycleFor = (rd, today) => {
    const y = today.getFullYear(), m = today.getMonth(), cur = clampDay(y, m, rd);
    return today >= cur ? { start: cur, end: clampDay(y, m + 1, rd) } : { start: clampDay(y, m - 1, rd), end: cur };
  };

  const migrateState = s => {
    if (!s) return s;
    if (!s.accounts) {
      s = {
        accounts: [{ id: 'acct-main', name: 'Main Budget', type: 'budget', balance: 0, monthlyBudget: s.monthlyBudget, refreshDay: s.refreshDay, endDate: null, expenses: s.expenses || [], color: 0 }],
        transfers: [], activeAccountId: 'acct-main'
      };
    }
    s.transfers = s.transfers || [];
    s.accounts.forEach(a => (a.expenses || []).forEach(e => {
      if ((e.tags || []).includes('transfer')) {
        e.amount = 0;
        if (!e.transferId && s.transfers.length) {
          const m = s.transfers.find(t => Math.abs(t.ts - e.ts) < 5000);
          if (m) e.transferId = m.id;
        }
      }
    }));
    return s;
  };

  let state = migrateState(load()), panelOpen = state ? null : 'setup', activeTag = null, tagBreakdownOpen = false;
  let mode = 'view', editingId = null, selectedId = null, deleteSelection = [], pendingDelete = null;
  let dailyMode = 'dynamic', heroJustSwitched = false, calc = {}, currentTab = 'budget', editingAccountId = null, newAccountType = 'budget';
  const app = $('app');

  const getAccountById = id => state?.accounts?.find(a => a.id === id) || null;
  const getActiveAccount = () => (!state?.accounts || state.activeAccountId === 'combined') ? null : (getAccountById(state.activeAccountId) || state.accounts[0] || null);
  const getBudgets = () => state?.accounts ? state.accounts.filter(a => a.type === 'budget') : [];
  const syncBudgets = (rd, ed) => getBudgets().forEach(a => { a.refreshDay = rd; a.endDate = ed; });
  const parseTags = raw => {
    const tags = [];
    const note = raw.replace(/#([\w-]+)/g, (_, t) => (tags.push(t.toLowerCase()), '')).replace(/\s+/g, ' ').trim();
    return { note, tags };
  };

  const trackingBalance = a => (state.transfers || []).reduce((b, t) => b + (t.toId === a.id ? t.amount : t.fromId === a.id ? -t.amount : 0), a.balance || 0);

  const budgetRemaining = (a, cyc) => {
    const inCyc = x => x.ts >= cyc.start.getTime() && x.ts < cyc.end.getTime();
    const spent = a.expenses.filter(inCyc).reduce((s, e) => s + e.amount, 0);
    const delta = (state.transfers || []).filter(inCyc).reduce((d, t) => d + (t.toId === a.id ? t.amount : t.fromId === a.id ? -t.amount : 0), 0);
    return a.monthlyBudget - spent + delta;
  };

  function render() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    app.innerHTML = `<h1 class="brand">DAILY BUDGET</h1>`
      + (currentTab === 'accounts' ? renderAccountsTab(today) : renderBudgetTab(today))
      + renderPanels()
      + `<div class="bottom-nav"><div class="bottom-nav-inner">`
      + `<button type="button" data-act="switchTab" data-tab="budget" class="${currentTab === 'budget' ? 'active' : ''}"><span class="nav-icon">\u{1F4B0}</span>Budget</button>`
      + `<button type="button" data-act="switchTab" data-tab="accounts" class="${currentTab === 'accounts' ? 'active' : ''}"><span class="nav-icon">\u{1F3E6}</span>Accounts</button>`
      + `</div></div>`;
    wire();
    animateBars();
    if (heroJustSwitched) {
      heroJustSwitched = false;
      const hn = $('heroNum');
      if (hn) { void hn.offsetWidth; requestAnimationFrame(() => hn.classList.remove('num-in')); }
    }
  }

  function renderBudgetTab(today) {
    const budgetAccts = getBudgets();
    if (!budgetAccts.length) return `<div class="empty" style="padding:40px 0;">No budget accounts yet.<br>Go to Accounts tab to create one.</div>`;

    let isCombined = state.activeAccountId === 'combined';
    if (isCombined && budgetAccts.length < 2) { state.activeAccountId = budgetAccts[0].id; isCombined = false; save(state); }

    let acct = getActiveAccount();
    if (!isCombined && (!acct || acct.type !== 'budget')) { state.activeAccountId = (acct = budgetAccts[0]).id; save(state); }

    let html = budgetAccts.length > 1 ? `<div style="margin-bottom:16px; text-align:left;"><select id="acctSelector" style="width:100%; font-weight:600;"><option value="combined"${isCombined ? ' selected' : ''}>Total Combined Budget</option>${budgetAccts.map(a => `<option value="${a.id}"${!isCombined && a.id === acct.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>` : '';

    const displayAcct = isCombined ? {
      id: 'combined', name: 'Total Combined Budget', type: 'budget', refreshDay: budgetAccts[0].refreshDay, endDate: budgetAccts[0].endDate,
      monthlyBudget: budgetAccts.reduce((s, a) => s + a.monthlyBudget, 0),
      expenses: budgetAccts.flatMap(a => a.expenses.map(e => ({ ...e, _acctId: a.id, _acctName: a.name })))
    } : acct;

    const cyc = cycleFor(displayAcct.refreshDay, today);
    let remaining = 0, spentToday = 0;
    (isCombined ? budgetAccts : [displayAcct]).forEach(ba => {
      spentToday += ba.expenses.filter(e => e.ts >= today.getTime()).reduce((s, e) => s + e.amount, 0);
      remaining += budgetRemaining(ba, cyc);
    });

    const daysLeft = Math.max(1, Math.round((cyc.end - today) / 86400000));
    const daily = (dailyMode === 'static' ? remaining + spentToday : remaining) / daysLeft;
    calc = { remaining, daysLeft };

    html += `<div class="hero"><div class="row topbar"><div style="display:flex; gap:8px;"><button class="ghost install-btn" id="installBtn" type="button">Download app</button><button class="ghost" data-act="export" type="button">Export</button></div>${isCombined ? '' : '<button class="gear" data-act="settings">⚙</button>'}</div>`
      + `<div class="install-help" id="installHelp"></div>`
      + `<div class="num display${daily < 0 ? ' neg-flag' : ''}${heroJustSwitched ? ' num-in' : ''}" id="heroNum">${THB2.format(daily)} <small>/ day</small></div>`
      + `<div class="sub">${daysLeft} day${daysLeft === 1 ? '' : 's'} until refresh &middot; ${THB2.format(remaining)} left of ${THB2.format(displayAcct.monthlyBudget)}</div>`
      + `<div class="sub" style="font-size:12px; margin-top:2px;">${dailyMode === 'static' ? 'Static \u2014 excludes today\u2019s spending' : 'Dynamic \u2014 includes today\u2019s spending'} (tap to switch)</div>`;

    if (displayAcct.endDate) {
      const [y, m, d] = displayAcct.endDate.split('-');
      const endD = new Date(y, m - 1, d);
      const left = Math.max(0, Math.round((endD - today) / 86400000));
      html += `<div class="sub" style="font-size:12px; margin-top:4px; color:${left <= 7 ? 'var(--neg)' : 'var(--muted)'};">\u{1F4C5} ${isCombined ? 'Budgets end ' : 'Account ends '}${fmtDate(endD, { day: 'numeric', month: 'short', year: 'numeric' })} (${left} day${left === 1 ? '' : 's'} left)</div>`;
    }
    html += `</div><div class="section-title">Add expense</div><form class="add" id="addForm" data-combined="${isCombined}">`
      + (isCombined ? `<select id="addFormAcct" style="flex:1; max-width:95px; padding:10px 6px; font-size:13px;">${budgetAccts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>` : '')
      + `<input type="number" step="0.01" min="0.01" placeholder="0.00" id="amtInput" required style="flex:1; max-width:${isCombined ? '85px' : '110px'}; padding:10px 8px;">`
      + `<input type="text" placeholder="What for? #tag to tag it" id="noteInput" style="flex:2; min-width:0;"><button type="submit" style="padding:10px 14px;">Add</button></form>`
      + `<div class="hint" id="impactHint" style="margin:-8px 0 14px; min-height:1em;"></div>`;

    const inCycleAll = displayAcct.expenses.filter(e => e.ts >= cyc.start.getTime() && e.ts < cyc.end.getTime()).sort((a, b) => b.ts - a.ts);
    const allTags = [...new Set(inCycleAll.flatMap(e => e.tags || []))];
    const UNTAGGED = '__untagged__', hasUntagged = inCycleAll.some(e => !e.tags?.length);

    if ((activeTag === UNTAGGED && !hasUntagged) || (activeTag && activeTag !== UNTAGGED && !allTags.includes(activeTag))) activeTag = null;
    const inCycle = !activeTag ? inCycleAll : activeTag === UNTAGGED ? inCycleAll.filter(e => !e.tags?.length) : inCycleAll.filter(e => (e.tags || []).includes(activeTag));

    html += `<div class="section-title"><span>This cycle</span><div class="mode-switch">${['view', 'edit', 'delete'].map(m => `<button type="button" data-act="setMode" data-mode="${m}" class="${mode === m ? 'active' : ''}" title="${m}" aria-label="${m} mode">${m === 'view' ? '\u{1F441}' : m === 'edit' ? '\u270E' : '\u{1F5D1}'}</button>`).join('')}</div></div>`;

    if (allTags.length) {
      const chipKeys = hasUntagged ? [...allTags, UNTAGGED] : allTags;
      html += `<div class="tag-filter">${chipKeys.map(t => `<button type="button" data-act="tagfilter" data-tag="${t}" class="${activeTag === t ? 'active' : ''}">${t === UNTAGGED ? 'Untagged' : '#' + t}</button>`).join('')}</div>`;
      const tagTotals = {};
      inCycleAll.forEach(e => e.tags?.length ? e.tags.forEach(t => tagTotals[t] = (tagTotals[t] || 0) + e.amount) : (tagTotals[UNTAGGED] = (tagTotals[UNTAGGED] || 0) + e.amount));
      const tagRows = Object.keys(tagTotals).sort((a, b) => tagTotals[b] - tagTotals[a]);
      const maxTotal = Math.max(...tagRows.map(t => tagTotals[t])) || 1;
      html += `<details class="tag-breakdown"${tagBreakdownOpen ? ' open' : ''}><summary>Spent by tag <span class="chev">›</span></summary>${tagRows.map(t => `<div class="tag-bar-row"><span class="tag-bar-label">${t === UNTAGGED ? 'Untagged' : '#' + t}</span><div class="tag-bar-track"><div class="tag-bar-fill" data-pct="${Math.max(4, Math.round(tagTotals[t] / maxTotal * 100))}" style="width:0%"></div></div><span class="tag-bar-amt">${THB2.format(tagTotals[t])}</span></div>`).join('')}</details>`;
    }
    if (mode === 'delete') deleteSelection = deleteSelection.filter(id => inCycle.some(e => e.id === id));

    if (!inCycle.length) {
      return html + `<div class="empty">${activeTag ? `No expenses tagged ${esc(activeTag === UNTAGGED ? 'Untagged' : '#' + activeTag)} this cycle.` : 'No expenses logged yet this cycle.'}</div>`;
    }
    if (mode === 'edit') html += `<div class="hint" style="margin:0 0 8px;">Double-tap an entry to edit it</div>`;
    if (mode === 'delete' && deleteSelection.length) html += `<div class="row" style="margin:0 0 10px; font-size:13px;"><span>${deleteSelection.length} selected</span><button type="button" class="danger" data-act="bulkDelete" style="padding:6px 14px; font-size:13px;">Delete</button></div>`;

    return html + `<ul class="expenses">${inCycle.map(e => {
      const dateStr = fmtDate(e.ts);
      const acctBadge = isCombined && e._acctName ? `<span class="tag-chip" style="color:var(--text); border-color:var(--line); opacity:0.75;">${esc(e._acctName)}</span> ` : '';
      const fullTagsStr = acctBadge + (e.tags || []).map(t => `<span class="tag-chip${t === 'transfer' ? ' transfer-chip' : ''}">#${t}</span>`).join('');
      const isTx = (e.tags || []).includes('transfer');
      const amtDisplay = isTx && e.amount === 0 ? '⇄' : THB2.format(e.amount);

      if (mode === 'edit' && editingId === e.id) {
        if (isTx) return `<li class="editing"><div class="edit-form" style="padding:10px 0;"><div style="font-size:13px; color:var(--text); margin-bottom:8px;">Transfer record: <strong>${esc(e.note || '')}</strong></div><div class="edit-actions"><button type="button" class="ghost danger-text" data-act="deleteEdit" data-id="${e.id}">Delete transfer</button><button type="button" class="ghost" data-act="cancelEdit">Cancel</button></div></div></li>`;
        const fullText = e.note + (e.tags?.length ? ' ' + e.tags.map(t => '#' + t).join(' ') : '');
        return `<li class="editing"><form class="edit-form" data-act="editForm" data-id="${e.id}"><input type="number" step="0.01" min="0.01" class="edit-amt" value="${e.amount}" required><input type="text" class="edit-note" value="${esc(fullText)}" placeholder="What for? #tag to tag it"><div class="edit-actions"><button type="button" class="ghost danger-text" data-act="deleteEdit" data-id="${e.id}">Delete</button><button type="button" class="ghost" data-act="cancelEdit">Cancel</button><button type="submit">Save</button></div></form></li>`;
      }
      if (mode === 'delete') {
        return `<li><label class="del-row"><input type="checkbox" data-act="delCheck" data-id="${e.id}"${deleteSelection.includes(e.id) ? ' checked' : ''}><span class="del-row-text"><div>${esc(e.note || 'Expense')}${fullTagsStr}</div><div class="note">${dateStr}</div></span><span>${amtDisplay}</span></label></li>`;
      }
      return `<li class="${mode === 'view' && selectedId === e.id ? 'selected' : ''}" data-act="${mode === 'edit' ? 'editRow' : 'viewRow'}" data-id="${e.id}"><div><div>${esc(e.note || 'Expense')}</div><div class="note">${dateStr}${fullTagsStr}</div></div><div>${amtDisplay}</div></li>`;
    }).join('')}</ul>`;
  }

  function renderAccountsTab(today) {
    const accounts = state?.accounts || [];
    const totalBal = accounts.reduce((s, a) => s + (a.type === 'tracking' ? trackingBalance(a) : budgetRemaining(a, cycleFor(a.refreshDay, today))), 0);

    let html = `<div class="total-bar"><div class="total-bar-label">Total across all accounts</div><div class="total-bar-amount display">${THB2.format(totalBal)}</div></div>`
      + `<div class="fab-row"><button type="button" data-act="openAddAccount">+ Account</button><button type="button" class="ghost" data-act="openTransfer" style="border-color:var(--teal); color:var(--teal);">\u21C4 Transfer</button></div>`;

    if (!accounts.length) return html + `<div class="empty">No accounts yet. Create one to get started.</div>`;

    html += `<div class="acct-grid">${accounts.map(a => {
      const isB = a.type === 'budget';
      let bal, meta = 'Tracking account', dailyInfo = '';
      if (isB) {
        const cyc = cycleFor(a.refreshDay, today);
        bal = budgetRemaining(a, cyc);
        const daysLeft = Math.max(1, Math.round((cyc.end - today) / 86400000));
        meta = `Budget ${THB0.format(a.monthlyBudget)} · Refreshes day ${a.refreshDay}`;
        if (a.endDate) {
          const [y, m, d] = a.endDate.split('-');
          meta += ` · Ends ${fmtDate(new Date(y, m - 1, d))}`;
        }
        dailyInfo = `<div class="acct-card-daily">${THB2.format(bal / daysLeft)}/day · ${daysLeft}d left</div>`;
      } else bal = trackingBalance(a);

      return `<div class="acct-card ${isB ? 'active-type' : 'tracking-type'}" data-act="selectAccount" data-id="${a.id}"><div class="acct-card-head"><span class="acct-card-name">${esc(a.name)}</span><span class="acct-type-badge ${isB ? 'budget' : 'tracking'}">${isB ? 'Budget' : 'Tracking'}</span></div><div class="acct-card-bal${bal < 0 ? ' neg-flag' : ''}">${THB2.format(bal)}</div><div class="acct-card-meta">${meta}</div>${dailyInfo}</div>`;
    }).join('')}</div>`;

    if (state.transfers?.length) {
      html += `<div class="section-title">Recent transfers</div>` + state.transfers.slice().sort((a, b) => b.ts - a.ts).slice(0, 10).map(t => {
        const d = new Date(t.ts);
        const dateStr = `${fmtDate(d)} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
        return `<div class="transfer-entry"><div class="transfer-icon">\u21C4</div><div class="transfer-detail"><div class="transfer-accts">${esc(getAccountById(t.fromId)?.name || '?')} → ${esc(getAccountById(t.toId)?.name || '?')}</div><div class="transfer-date">${dateStr}${t.note ? ' · ' + esc(t.note) : ''}</div></div><div class="transfer-amt">${THB2.format(t.amount)}</div><button type="button" class="del-tx-btn" data-act="deleteTx" data-id="${t.id}" title="Delete transfer" aria-label="Delete transfer">×</button></div>`;
      }).join('');
    }
    return html;
  }

  function renderPanels() {
    let html = '';
    const acct = getActiveAccount();

    if (panelOpen === 'setup' || panelOpen === 'settings') {
      const isB = acct?.type === 'budget';
      html += `<div class="panel"><div class="card"><h2>${panelOpen === 'setup' ? 'Set up your budget' : 'Edit budget \u2014 ' + esc(acct?.name || '')}</h2>`
        + `<label for="mbInput">Monthly budget (THB)</label><input type="number" min="0.01" step="0.01" id="mbInput" value="${isB ? acct.monthlyBudget : ''}" placeholder="15000">`
        + `<label for="rdInput">Resets on day of month</label><input type="number" min="1" max="31" id="rdInput" value="${isB ? acct.refreshDay : ''}" placeholder="1">`
        + `<div class="hint">E.g. if you get paid on the 25th, set this to 25. Note: Editing this links the cycle of all your budget accounts.</div>`
        + `<label for="edInput">End date (optional)</label><input type="date" id="edInput" value="${acct?.endDate || ''}">`
        + `<div class="hint">Leave empty for no end date.</div><div class="actions">${panelOpen === 'settings' ? '<button class="ghost" data-act="cancelPanel">Cancel</button>' : ''}<button data-act="savePanel">Save</button></div></div></div>`;
    }

    if (panelOpen === 'addAccount') {
      const exB = getBudgets()[0];
      html += `<div class="panel"><div class="card"><h2>New Account</h2><label>Account type</label><div class="type-toggle">`
        + `<button type="button" data-act="setNewType" data-type="budget" class="${newAccountType === 'budget' ? 'active' : ''}">Budget</button>`
        + `<button type="button" data-act="setNewType" data-type="tracking" class="${newAccountType === 'tracking' ? 'active' : ''}">Tracking</button></div>`
        + `<div class="hint" style="margin-top:8px;">${newAccountType === 'budget' ? 'Has its own expense list and daily budget. Cycles are automatically synced together.' : 'Tracks a balance. Good for bank accounts, savings, or cash on hand.'}</div>`
        + `<label for="newAcctName">Account name</label><input type="text" id="newAcctName" placeholder="e.g. Savings, Cash, Food Budget">`
        + (newAccountType === 'budget'
          ? `<label for="newAcctBudget">Monthly budget (THB)</label><input type="number" id="newAcctBudget" min="0.01" step="0.01" placeholder="15000"><label for="newAcctRefresh">Resets on day of month (Synced to all)</label><input type="number" id="newAcctRefresh" min="1" max="31" placeholder="1" value="${exB ? exB.refreshDay : ''}"><label for="newAcctEnd">End date (optional)</label><input type="date" id="newAcctEnd" value="${exB?.endDate || ''}">`
          : `<label for="newAcctBal">Current balance (THB)</label><input type="number" id="newAcctBal" min="0" step="0.01" placeholder="0.00">`)
        + `<div class="actions"><button class="ghost" data-act="cancelPanel">Cancel</button><button data-act="saveNewAccount">Create</button></div></div></div>`;
    }

    if (panelOpen === 'editAccount' && editingAccountId) {
      const ea = getAccountById(editingAccountId);
      if (ea) {
        html += `<div class="panel"><div class="card"><h2>Edit Account</h2><label for="editAcctName">Account name</label><input type="text" id="editAcctName" value="${esc(ea.name)}">`
          + (ea.type === 'budget'
            ? `<label for="editAcctBudget">Monthly budget (THB)</label><input type="number" id="editAcctBudget" min="0.01" step="0.01" value="${ea.monthlyBudget}"><label for="editAcctRefresh">Resets on day of month (Synced to all)</label><input type="number" id="editAcctRefresh" min="1" max="31" value="${ea.refreshDay}"><label for="editAcctEnd">End date (optional)</label><input type="date" id="editAcctEnd" value="${ea.endDate || ''}">`
            : `<label for="editAcctBal">Base balance (THB)</label><input type="number" id="editAcctBal" step="0.01" value="${ea.balance || 0}"><div class="hint">This is the starting balance before transfers.</div>`)
          + `<div class="actions"><button class="ghost danger-text" data-act="deleteAccount" data-id="${ea.id}">Delete</button><button class="ghost" data-act="cancelPanel">Cancel</button><button data-act="saveEditAccount">Save</button></div></div></div>`;
      }
    }

    if (panelOpen === 'transfer') {
      const accounts = state?.accounts || [];
      const opts = selIdx => accounts.map((a, i) => `<option value="${a.id}"${i === selIdx ? ' selected' : ''}>${esc(a.name)} (${a.type === 'budget' ? 'Budget' : 'Tracking'})</option>`).join('');
      html += accounts.length < 2
        ? `<div class="panel"><div class="card"><h2>Transfer</h2><div class="empty">You need at least 2 accounts to transfer money.</div><div class="actions"><button class="ghost" data-act="cancelPanel">Close</button></div></div></div>`
        : `<div class="panel"><div class="card"><h2>Transfer Money</h2><label for="txFrom">From</label><select id="txFrom">${opts(0)}</select><label for="txTo">To</label><select id="txTo">${opts(1)}</select><label for="txAmt">Amount (THB)</label><input type="number" id="txAmt" min="0.01" step="0.01" placeholder="0.00"><label for="txNote">Note (optional)</label><input type="text" id="txNote" placeholder="e.g. Top up cash"><div class="actions"><button class="ghost" data-act="cancelPanel">Cancel</button><button data-act="doTransfer" style="background:var(--teal);">Transfer</button></div></div></div>`;
    }

    if (pendingDelete && state) {
      const delItems = getBudgets().flatMap(a => a.expenses.filter(x => pendingDelete.includes(x.id)).map(x => ({ ...x, _acctName: a.name })));
      if (delItems.length) {
        html += `<div class="panel"><div class="card"><h2>Delete ${delItems.length > 1 ? delItems.length + ' expenses?' : 'this expense?'}</h2><ul class="confirm-list">${delItems.map(e => `<li><span class="confirm-note">${fmtDate(e.ts)} \u00b7 ${esc(e.note || 'Expense')}</span><span>${(e.tags || []).includes('transfer') && e.amount === 0 ? '<span class="tag-chip transfer-chip">#transfer</span>' : THB2.format(e.amount)}</span></li>`).join('')}</ul><div class="actions"><button type="button" class="ghost" data-act="cancelDelete">Cancel</button><button type="button" class="danger" data-act="confirmDelete">Delete</button></div></div></div>`;
      }
    }
    return html;
  }

  function animateBars() {
    const bars = qa('.tag-bar-fill');
    if (!bars.length) return;
    bars.forEach(el => { el.style.transition = 'none'; el.style.width = '0%'; });
    void app.offsetHeight;
    requestAnimationFrame(() => {
      bars.forEach(el => el.style.transition = '');
      requestAnimationFrame(() => bars.forEach(el => el.style.width = el.getAttribute('data-pct') + '%'));
    });
  }

  function updateImpactHint() {
    const hintEl = $('impactHint');
    if (!hintEl) return;
    const amt = parseFloat($('amtInput').value);
    if (!amt || amt <= 0) { hintEl.textContent = ''; return; }
    if (calc.daysLeft <= 1) { hintEl.textContent = 'No effect on tomorrow \u2014 a new cycle starts.'; return; }
    const tmr = calc.daysLeft - 1, before = calc.remaining / tmr, after = (calc.remaining - amt) / tmr;
    hintEl.textContent = `Tomorrow\u2019s budget: ${THB2.format(before)} \u2192 ${THB2.format(after)} (${THB2.format(after - before)}/day)`;
  }

  function wire() {
    qa('[data-act="switchTab"]').forEach(btn => btn.addEventListener('click', () => { currentTab = btn.dataset.tab; render(); }));
    $('acctSelector')?.addEventListener('change', e => { state.activeAccountId = e.target.value; save(state); render(); });

    $('addForm')?.addEventListener('submit', ev => {
      ev.preventDefault();
      const amt = parseFloat($('amtInput').value);
      if (!amt || amt <= 0) return;
      const { note, tags } = parseTags($('noteInput').value.trim());
      const targetId = ev.currentTarget.dataset.combined === 'true' ? $('addFormAcct').value : state.activeAccountId;
      const targetAcct = getAccountById(targetId);
      if (!targetAcct || targetAcct.type !== 'budget') return;
      targetAcct.expenses.push({ id: genId('exp'), amount: amt, note, tags, ts: Date.now() });
      save(state); render();
    });

    $('amtInput')?.addEventListener('input', updateImpactHint);
    $('heroNum')?.addEventListener('click', e => {
      e.currentTarget.classList.add('num-out');
      setTimeout(() => { dailyMode = dailyMode === 'static' ? 'dynamic' : 'static'; heroJustSwitched = true; render(); }, 170);
    });

    qa('[data-act="tagfilter"]').forEach(b => b.addEventListener('click', () => { activeTag = activeTag === b.dataset.tag ? null : b.dataset.tag; render(); }));
    qa('[data-act="setMode"]').forEach(b => b.addEventListener('click', () => { mode = b.dataset.mode; editingId = selectedId = null; deleteSelection = []; render(); }));
    qa('li[data-act="viewRow"]').forEach(li => li.addEventListener('click', () => { selectedId = selectedId === li.dataset.id ? null : li.dataset.id; render(); }));
    qa('li[data-act="editRow"]').forEach(li => li.addEventListener('dblclick', () => { editingId = li.dataset.id; render(); }));
    qa('[data-act="delCheck"]').forEach(cb => cb.addEventListener('change', () => {
      const id = cb.dataset.id, i = deleteSelection.indexOf(id);
      if (cb.checked && i === -1) deleteSelection.push(id);
      if (!cb.checked && i > -1) deleteSelection.splice(i, 1);
      render();
    }));

    q('[data-act="bulkDelete"]')?.addEventListener('click', () => { pendingDelete = deleteSelection.slice(); render(); });
    q('[data-act="cancelDelete"]')?.addEventListener('click', () => { pendingDelete = null; render(); });
    q('[data-act="confirmDelete"]')?.addEventListener('click', () => {
      const ids = pendingDelete || [], txIds = [];
      ids.forEach(id => {
        const exp = getBudgets().flatMap(a => a.expenses).find(x => x.id === id);
        if (exp) {
          if (exp.transferId) txIds.push(exp.transferId);
          else if ((exp.tags || []).includes('transfer') && state.transfers) {
            const m = state.transfers.find(t => Math.abs(t.ts - exp.ts) < 5000);
            if (m) txIds.push(m.id);
          }
        }
      });
      getBudgets().forEach(a => a.expenses = a.expenses.filter(x => !ids.includes(x.id) && (!x.transferId || !txIds.includes(x.transferId))));
      if (txIds.length && state.transfers) state.transfers = state.transfers.filter(t => !txIds.includes(t.id));
      save(state); pendingDelete = editingId = null; deleteSelection = []; render();
    });

    q('[data-act="editForm"]')?.addEventListener('submit', ev => {
      ev.preventDefault();
      const f = ev.currentTarget, amt = parseFloat(f.querySelector('.edit-amt').value);
      if (!amt || amt <= 0) return;
      const { note, tags } = parseTags(f.querySelector('.edit-note').value.trim());
      const exp = getBudgets().flatMap(a => a.expenses).find(x => x.id === f.dataset.id);
      if (exp) { Object.assign(exp, { amount: amt, note, tags }); save(state); }
      editingId = null; render();
    });

    q('[data-act="cancelEdit"]')?.addEventListener('click', () => { editingId = null; render(); });
    q('[data-act="deleteEdit"]')?.addEventListener('click', e => { pendingDelete = [e.currentTarget.dataset.id]; render(); });
    q('.tag-breakdown')?.addEventListener('toggle', e => { tagBreakdownOpen = e.currentTarget.open; if (tagBreakdownOpen) animateBars(); });
    q('[data-act="settings"]')?.addEventListener('click', () => { panelOpen = 'settings'; render(); });
    q('[data-act="cancelPanel"]')?.addEventListener('click', () => { panelOpen = editingAccountId = null; render(); });

    q('[data-act="savePanel"]')?.addEventListener('click', () => {
      const mb = parseFloat($('mbInput').value), rd = parseInt($('rdInput').value, 10), ed = $('edInput').value || null;
      if (!mb || mb <= 0 || !rd || rd < 1 || rd > 31) return;
      if (panelOpen === 'setup' && !state?.accounts) {
        state = { accounts: [{ id: 'acct-main', name: 'Main Budget', type: 'budget', balance: 0, monthlyBudget: mb, refreshDay: rd, endDate: ed, expenses: [], color: 0 }], transfers: [], activeAccountId: 'acct-main' };
      } else {
        const acct = getActiveAccount();
        if (acct?.type === 'budget') { acct.monthlyBudget = mb; syncBudgets(rd, ed); }
      }
      save(state); panelOpen = null; render();
    });

    q('[data-act="openAddAccount"]')?.addEventListener('click', () => { newAccountType = 'budget'; panelOpen = 'addAccount'; render(); });
    qa('[data-act="setNewType"]').forEach(b => b.addEventListener('click', () => { newAccountType = b.dataset.type; render(); }));

    q('[data-act="saveNewAccount"]')?.addEventListener('click', () => {
      const name = ($('newAcctName').value || '').trim();
      if (!name) return;
      const newAcct = { id: genId('acct'), name, type: newAccountType, balance: 0, expenses: [], color: state.accounts.length };
      if (newAccountType === 'budget') {
        const mb = parseFloat($('newAcctBudget').value), rd = parseInt($('newAcctRefresh').value, 10), ed = $('newAcctEnd').value || null;
        if (!mb || mb <= 0 || !rd || rd < 1 || rd > 31) return;
        Object.assign(newAcct, { monthlyBudget: mb, refreshDay: rd, endDate: ed });
        syncBudgets(rd, ed);
      } else newAcct.balance = parseFloat($('newAcctBal').value) || 0;
      state.accounts.push(newAcct);
      save(state); panelOpen = null; render();
    });

    qa('[data-act="selectAccount"]').forEach(c => c.addEventListener('click', () => { editingAccountId = c.dataset.id; panelOpen = 'editAccount'; render(); }));

    q('[data-act="saveEditAccount"]')?.addEventListener('click', () => {
      const ea = getAccountById(editingAccountId), name = ($('editAcctName').value || '').trim();
      if (!ea || !name) return;
      ea.name = name;
      if (ea.type === 'budget') {
        const mb = parseFloat($('editAcctBudget').value), rd = parseInt($('editAcctRefresh').value, 10);
        if (!mb || mb <= 0 || !rd || rd < 1 || rd > 31) return;
        ea.monthlyBudget = mb;
        syncBudgets(rd, $('editAcctEnd').value || null);
      } else ea.balance = parseFloat($('editAcctBal').value) || 0;
      save(state); panelOpen = editingAccountId = null; render();
    });

    q('[data-act="deleteAccount"]')?.addEventListener('click', e => {
      const id = e.currentTarget.dataset.id;
      if (state.accounts.length <= 1) return alert('You must have at least one account.');
      if (!confirm('Delete this account and all its data?')) return;
      const linkedTxIds = (state.transfers || []).filter(t => t.fromId === id || t.toId === id).map(t => t.id);
      state.accounts = state.accounts.filter(a => a.id !== id);
      if (linkedTxIds.length) state.accounts.forEach(a => { if (a.expenses) a.expenses = a.expenses.filter(x => !x.transferId || !linkedTxIds.includes(x.transferId)); });
      state.transfers = (state.transfers || []).filter(t => t.fromId !== id && t.toId !== id);
      if (state.activeAccountId === id || state.activeAccountId === 'combined') state.activeAccountId = (getBudgets()[0] || state.accounts[0]).id;
      save(state); panelOpen = editingAccountId = null; render();
    });

    q('[data-act="openTransfer"]')?.addEventListener('click', () => { panelOpen = 'transfer'; render(); });
    q('[data-act="doTransfer"]')?.addEventListener('click', () => {
      const fromId = $('txFrom').value, toId = $('txTo').value, amt = parseFloat($('txAmt').value), note = ($('txNote').value || '').trim();
      if (!amt || amt <= 0) return;
      if (fromId === toId) return alert('Cannot transfer to the same account.');
      const now = Date.now(), txId = genId('tx');
      (state.transfers = state.transfers || []).push({ id: txId, fromId, toId, amount: amt, note, ts: now });
      const fromAcct = getAccountById(fromId), toAcct = getAccountById(toId);
      if (fromAcct?.type === 'budget') fromAcct.expenses.push({ id: genId('exp'), amount: 0, note: `Transfer to ${toAcct ? toAcct.name : '?'} (${THB2.format(amt)})`, tags: ['transfer'], transferId: txId, ts: now });
      if (toAcct?.type === 'budget') toAcct.expenses.push({ id: genId('exp'), amount: 0, note: `Received from ${fromAcct ? fromAcct.name : '?'} (${THB2.format(amt)})`, tags: ['transfer'], transferId: txId, ts: now });
      save(state); panelOpen = null; render();
    });

    wireInstallButton();
    q('[data-act="export"]')?.addEventListener('click', doExport);
    qa('[data-act="deleteTx"]').forEach(btn => btn.addEventListener('click', ev => {
      ev.stopPropagation();
      const txId = btn.dataset.id;
      if (!confirm('Delete this transfer record?')) return;
      if (state.transfers) state.transfers = state.transfers.filter(t => t.id !== txId);
      state.accounts?.forEach(a => { if (a.expenses) a.expenses = a.expenses.filter(x => x.transferId !== txId); });
      save(state); render();
    }));
  }

  function buildCsv(expenses) {
    const rows = [['Date', 'Note', 'Tags', 'Amount (THB)']];
    expenses.slice().sort((a, b) => a.ts - b.ts).forEach(e => {
      const d = new Date(e.ts);
      rows.push([
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        `"${(e.note || '').replace(/"/g, '""')}"`,
        `"${(e.tags || []).join(' ')}"`,
        e.amount ? e.amount.toFixed(2) : '0.00'
      ]);
    });
    return rows.map(r => r.join(',')).join('\n');
  }

  function fallbackDownload(csv, filename) {
    try {
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: filename });
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch {}
  }

  async function doExport() {
    const isCombined = state.activeAccountId === 'combined', acct = getActiveAccount();
    if (!isCombined && !acct) return;
    const expenses = isCombined ? getBudgets().flatMap(a => a.expenses) : acct.expenses;
    if (!expenses?.length) return;
    const csv = buildCsv(expenses);
    const filename = `${isCombined ? 'combined-budget' : 'budget-export-' + acct.name.replace(/\s+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
    try {
      const dl = typeof claude !== 'undefined' && claude.use ? await claude.use('downloads') : null;
      if (dl) await dl.save({ filename, data: csv }); else fallbackDownload(csv, filename);
    } catch { fallbackDownload(csv, filename); }
  }

  let deferredPrompt = null;
  const ua = navigator.userAgent || '';
  const isIos = () => /iphone|ipad|ipod/i.test(ua);
  const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; $('installBtn')?.classList.add('show'); });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; $('installBtn')?.classList.remove('show'); $('installHelp')?.classList.remove('show'); });

  function wireInstallButton() {
    const btn = $('installBtn'), help = $('installHelp');
    if (!btn || isStandalone()) return;
    if (deferredPrompt) btn.classList.add('show');
    if (isIos() && /^((?!chrome|crios|fxios|edgios).)*safari/i.test(ua) && help) {
      btn.classList.add('show'); btn.textContent = 'Download app';
      help.textContent = 'Tap Share, then "Add to Home Screen" to install.'; help.classList.add('show');
    }
    btn.addEventListener('click', () => {
      if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt.userChoice.then(() => deferredPrompt = null); }
      else if (help) {
        help.textContent = isIos() ? 'Tap Share, then "Add to Home Screen" to install.' : 'In your browser menu choose "Install app" or "Add to Home screen". Serving over http(s) is required for the automatic prompt.';
        help.classList.add('show');
      }
    });
  }

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => { try { navigator.serviceWorker.register('./sw.js'); } catch {} });
  }

  render();
  setInterval(() => {
    const a = document.activeElement;
    if (!(a && app.contains(a) && a.tagName === 'INPUT')) render();
  }, 60000);
})();