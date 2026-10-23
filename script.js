(function(){
  var KEY = 'baht-budget-v1';
  var THB0 = new Intl.NumberFormat('th-TH',{style:'currency',currency:'THB',maximumFractionDigits:0});
  var THB2 = new Intl.NumberFormat('th-TH',{style:'currency',currency:'THB',maximumFractionDigits:2});

  function load(){ try{ var r = localStorage.getItem(KEY); return r ? JSON.parse(r) : null; }catch(e){ return null; } }
  function save(s){ try{ localStorage.setItem(KEY, JSON.stringify(s)); }catch(e){} }

  function clampDay(y,m,day){ // m is 0-indexed, may over/underflow on purpose
    var last = new Date(y, m+1, 0).getDate();
    return new Date(y, m, Math.min(day, last));
  }
  function escapeAttr(s){
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
  }
  function cycleFor(refreshDay, today){
    var y = today.getFullYear(), m = today.getMonth();
    var thisRefresh = clampDay(y,m,refreshDay); thisRefresh.setHours(0,0,0,0);
    var start, end;
    if (today >= thisRefresh){
      start = thisRefresh;
      end = clampDay(y, m+1, refreshDay); end.setHours(0,0,0,0);
    } else {
      start = clampDay(y, m-1, refreshDay); start.setHours(0,0,0,0);
      end = thisRefresh;
    }
    return {start:start, end:end};
  }

  // ---- Data migration: old flat state → accounts-based & transfer reconciliation ----
  function migrateState(s){
    if (!s) return s;
    if (!s.accounts){
      // Old state: {monthlyBudget, refreshDay, expenses}
      var mainAcct = {
        id: 'acct-main',
        name: 'Main Budget',
        type: 'budget', // 'budget' | 'tracking'
        balance: 0, // tracking accounts use this
        monthlyBudget: s.monthlyBudget,
        refreshDay: s.refreshDay,
        endDate: null,
        expenses: s.expenses || [],
        color: 0
      };
      s = {
        accounts: [mainAcct],
        transfers: [],
        activeAccountId: 'acct-main'
      };
    }
    if (!s.transfers) s.transfers = [];

    // Reconcile and clean up legacy transfer entries
    s.accounts.forEach(function(acct){
      if (!acct.expenses) return;
      acct.expenses.forEach(function(exp){
        if ((exp.tags || []).indexOf('transfer') > -1){
          // Zero out amount so it never double-counts with transferDelta
          exp.amount = 0;
          // Attempt to link legacy transfer without transferId
          if (!exp.transferId && s.transfers.length){
            var match = s.transfers.find(function(t){ return Math.abs(t.ts - exp.ts) < 5000; });
            if (match) exp.transferId = match.id;
          }
        }
      });
    });

    return s;
  }

  var state = migrateState(load());
  var panelOpen = null; // 'setup' | 'settings' | 'addAccount' | 'editAccount' | 'transfer' | null
  var activeTag = null;
  var tagBreakdownOpen = false;
  var mode = 'view'; // 'view' | 'edit' | 'delete'
  var editingId = null;
  var selectedId = null;
  var deleteSelection = [];
  var pendingDelete = null;
  var dailyMode = 'dynamic';
  var heroJustSwitched = false;
  var calc = {};
  var currentTab = 'budget'; // 'budget' | 'accounts'
  var editingAccountId = null; // which account is being edited in the panel
  var newAccountType = 'budget'; // used in add-account panel
  if (!state) panelOpen = 'setup';

  var app = document.getElementById('app');

  // --- Helper: get current active account ---
  function getActiveAccount(){
    if (!state || !state.accounts) return null;
    return state.accounts.find(function(a){ return a.id === state.activeAccountId; }) || state.accounts[0] || null;
  }
  function getAccountById(id){
    if (!state || !state.accounts) return null;
    return state.accounts.find(function(a){ return a.id === id; }) || null;
  }
  function genId(prefix){
    return (prefix || 'id') + '-' + Date.now() + '-' + Math.random().toString(36).substr(2,6);
  }
  function acctColor(idx){
    var colors = ['var(--gold)','var(--teal)','var(--peach)','var(--sky)','var(--rose)','var(--pos)','var(--neg)'];
    return colors[idx % colors.length];
  }

  // --- Compute effective balance for a tracking account (initial + transfers in - transfers out) ---
  function trackingBalance(acct){
    var bal = acct.balance || 0;
    if (!state.transfers) return bal;
    state.transfers.forEach(function(t){
      if (t.toId === acct.id) bal += t.amount;
      if (t.fromId === acct.id) bal -= t.amount;
    });
    return bal;
  }

  // --- Compute effective remaining for budget account (monthlyBudget - spent + transfers in - transfers out within cycle) ---
  function budgetRemaining(acct, cyc){
    var spent = acct.expenses
      .filter(function(e){ return e.ts >= cyc.start.getTime() && e.ts < cyc.end.getTime(); })
      .reduce(function(a,e){ return a + e.amount; }, 0);
    var transferDelta = 0;
    if (state.transfers){
      state.transfers.forEach(function(t){
        if (t.ts >= cyc.start.getTime() && t.ts < cyc.end.getTime()){
          if (t.toId === acct.id) transferDelta += t.amount;
          if (t.fromId === acct.id) transferDelta -= t.amount;
        }
      });
    }
    return acct.monthlyBudget - spent + transferDelta;
  }

  // ===== RENDER =====
  function render(){
    var today = new Date(); today.setHours(0,0,0,0);
    var html = '<h1 class="brand">DAILY BUDGET</h1>';

    if (currentTab === 'accounts'){
      html += renderAccountsTab(today);
    } else {
      html += renderBudgetTab(today);
    }

    // Panels
    html += renderPanels(today);

    // Bottom nav
    html += '<div class="bottom-nav"><div class="bottom-nav-inner">'
      + '<button type="button" data-act="switchTab" data-tab="budget" class="' + (currentTab==='budget'?'active':'') + '"><span class="nav-icon">\u{1F4B0}</span>Budget</button>'
      + '<button type="button" data-act="switchTab" data-tab="accounts" class="' + (currentTab==='accounts'?'active':'') + '"><span class="nav-icon">\u{1F3E6}</span>Accounts</button>'
      + '</div></div>';

    app.innerHTML = html;
    wire();
    animateBars();
    if (heroJustSwitched){
      heroJustSwitched = false;
      var hn = document.getElementById('heroNum');
      if (hn){
        void hn.offsetWidth;
        requestAnimationFrame(function(){ hn.classList.remove('num-in'); });
      }
    }
  }

  // ===== BUDGET TAB (the original main view) =====
  function renderBudgetTab(today){
    var html = '';
    var acct = getActiveAccount();
    if (!acct || acct.type !== 'budget'){
      // No budget account selected — prompt to pick one or create
      var budgetAccts = state && state.accounts ? state.accounts.filter(function(a){ return a.type === 'budget'; }) : [];
      if (budgetAccts.length === 0){
        html += '<div class="empty" style="padding:40px 0;">No budget accounts yet.<br>Go to Accounts tab to create one.</div>';
        return html;
      }
      // Auto-select first budget account
      state.activeAccountId = budgetAccts[0].id;
      acct = budgetAccts[0];
      save(state);
    }

    // Account selector (if multiple budget accounts)
    var budgetAccts = state.accounts.filter(function(a){ return a.type === 'budget'; });
    if (budgetAccts.length > 1){
      html += '<div style="margin-bottom:16px; text-align:left;">'
        + '<select id="acctSelector" style="width:100%;">'
        + budgetAccts.map(function(a){
            return '<option value="' + a.id + '"' + (a.id===acct.id?' selected':'') + '>' + escapeAttr(a.name) + '</option>';
          }).join('')
        + '</select></div>';
    }

    var cyc = cycleFor(acct.refreshDay, today);
    var spent = acct.expenses
      .filter(function(e){ return e.ts >= cyc.start.getTime() && e.ts < cyc.end.getTime(); })
      .reduce(function(a,e){ return a + e.amount; }, 0);
    var spentToday = acct.expenses
      .filter(function(e){ return e.ts >= today.getTime(); })
      .reduce(function(a,e){ return a + e.amount; }, 0);

    // Factor in transfers for this cycle
    var transferDelta = 0;
    if (state.transfers){
      state.transfers.forEach(function(t){
        if (t.ts >= cyc.start.getTime() && t.ts < cyc.end.getTime()){
          if (t.toId === acct.id) transferDelta += t.amount;
          if (t.fromId === acct.id) transferDelta -= t.amount;
        }
      });
    }

    var remaining = acct.monthlyBudget - spent + transferDelta;
    var daysLeft = Math.max(1, Math.round((cyc.end - today) / 86400000));
    var dynamicDaily = remaining / daysLeft;
    var staticDaily = (acct.monthlyBudget - (spent - spentToday) + transferDelta) / daysLeft;
    var daily = dailyMode === 'static' ? staticDaily : dynamicDaily;
    var over = daily < 0;
    calc.remaining = remaining;
    calc.daysLeft = daysLeft;

    html += '<div class="hero">'
      + '<div class="row topbar"><div style="display:flex; gap:8px;"><button class="ghost install-btn" id="installBtn" type="button">Download app</button><button class="ghost" data-act="export" type="button">Export</button></div><button class="gear" data-act="settings">⚙</button></div>'
      + '<div class="install-help" id="installHelp"></div>'
      + '<div class="num display' + (over?' neg-flag':'') + (heroJustSwitched?' num-in':'') + '" id="heroNum">' + THB2.format(daily) + ' <small>/ day</small></div>'
      + '<div class="sub">' + daysLeft + ' day' + (daysLeft===1?'':'s') + ' until refresh &middot; ' + THB2.format(remaining) + ' left of ' + THB2.format(acct.monthlyBudget) + '</div>'
      + '<div class="sub" style="font-size:12px; margin-top:2px;">' + (dailyMode==='static' ? 'Static \u2014 excludes today\u2019s spending' : 'Dynamic \u2014 includes today\u2019s spending') + ' (tap to switch)</div>';

    // Show end date info if account has one
    if (acct.endDate){
      var parts = acct.endDate.split('-');
      var endD = new Date(parts[0], parts[1]-1, parts[2]);
      endD.setHours(0,0,0,0);
      var totalDaysToEnd = Math.max(0, Math.round((endD - today) / 86400000));
      html += '<div class="sub" style="font-size:12px; margin-top:4px; color:' + (totalDaysToEnd <= 7 ? 'var(--neg)' : 'var(--muted)') + ';">'
        + '\u{1F4C5} Account ends ' + endD.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})
        + ' (' + totalDaysToEnd + ' day' + (totalDaysToEnd===1?'':'s') + ' left)</div>';
    }

    html += '</div>';

    html += '<div class="section-title">Add expense</div>'
      + '<form class="add" id="addForm">'
      + '<input class="amt-input" type="number" step="0.01" min="0.01" placeholder="0.00" id="amtInput" required>'
      + '<input type="text" placeholder="What for? #tag to tag it" id="noteInput">'
      + '<button type="submit">Add</button>'
      + '</form>'
      + '<div class="hint" id="impactHint" style="margin:-8px 0 14px; min-height:1em;"></div>';

    var inCycleAll = acct.expenses
      .filter(function(e){ return e.ts >= cyc.start.getTime() && e.ts < cyc.end.getTime(); })
      .sort(function(a,b){ return b.ts - a.ts; });

    var allTags = [];
    inCycleAll.forEach(function(e){ (e.tags||[]).forEach(function(t){ if (allTags.indexOf(t) === -1) allTags.push(t); }); });
    var UNTAGGED = '__untagged__';
    var hasUntagged = inCycleAll.some(function(e){ return !(e.tags && e.tags.length); });

    // Automatically drop the tag filter if the untagged state becomes empty
    if (activeTag === UNTAGGED && !hasUntagged) activeTag = null;
    else if (activeTag && activeTag !== UNTAGGED && allTags.indexOf(activeTag) === -1) activeTag = null;

    var inCycle = !activeTag ? inCycleAll
      : activeTag === UNTAGGED ? inCycleAll.filter(function(e){ return !(e.tags && e.tags.length); })
      : inCycleAll.filter(function(e){ return (e.tags||[]).indexOf(activeTag) > -1; });

    html += '<div class="section-title"><span>This cycle</span><div class="mode-switch">'
      + ['view','edit','delete'].map(function(m){
          var icon = m==='view' ? '\u{1F441}' : (m==='edit' ? '\u270E' : '\u{1F5D1}');
          return '<button type="button" data-act="setMode" data-mode="' + m + '" class="' + (mode===m?'active':'') + '" title="' + m + '" aria-label="' + m + ' mode">' + icon + '</button>';
        }).join('')
      + '</div></div>';
    if (allTags.length){
      var chipKeys = hasUntagged ? allTags.concat([UNTAGGED]) : allTags;

      html += '<div class="tag-filter">' + chipKeys.map(function(t){
        var label = t === UNTAGGED ? 'Untagged' : '#' + t;
        return '<button type="button" data-act="tagfilter" data-tag="' + t + '" class="' + (activeTag===t?'active':'') + '">' + label + '</button>';
      }).join('') + '</div>';

      var tagTotals = {};
      inCycleAll.forEach(function(e){
        if (e.tags && e.tags.length) e.tags.forEach(function(t){ tagTotals[t] = (tagTotals[t]||0) + e.amount; });
        else tagTotals[UNTAGGED] = (tagTotals[UNTAGGED]||0) + e.amount;
      });
      var tagRows = Object.keys(tagTotals).sort(function(a,b){ return tagTotals[b]-tagTotals[a]; });
      var maxTotal = Math.max.apply(null, tagRows.map(function(t){ return tagTotals[t]; })) || 1;
      html += '<details class="tag-breakdown"' + (tagBreakdownOpen?' open':'') + '><summary>Spent by tag <span class="chev">›</span></summary>'
        + tagRows.map(function(t){
            var pct = Math.max(4, Math.round(tagTotals[t]/maxTotal*100));
            var label = t === UNTAGGED ? 'Untagged' : '#' + t;
            return '<div class="tag-bar-row"><span class="tag-bar-label">' + label + '</span>'
              + '<div class="tag-bar-track"><div class="tag-bar-fill" data-pct="' + pct + '" style="width:0%"></div></div>'
              + '<span class="tag-bar-amt">' + THB2.format(tagTotals[t]) + '</span></div>';
          }).join('')
        + '</details>';
    }
    if (mode === 'delete') deleteSelection = deleteSelection.filter(function(id){ return inCycle.some(function(e){ return e.id===id; }); });

    if (inCycle.length === 0){
      var tagDisp = activeTag === UNTAGGED ? 'Untagged' : '#' + activeTag;
      html += '<div class="empty">' + (activeTag ? 'No expenses tagged ' + escapeAttr(tagDisp) + ' this cycle.' : 'No expenses logged yet this cycle.') + '</div>';
    } else {
      if (mode === 'edit'){
        html += '<div class="hint" style="margin:0 0 8px;">Double-tap an entry to edit it</div>';
      }
      if (mode === 'delete' && deleteSelection.length){
        html += '<div class="row" style="margin:0 0 10px; font-size:13px;"><span>' + deleteSelection.length + ' selected</span>'
          + '<button type="button" class="danger" data-act="bulkDelete" style="padding:6px 14px; font-size:13px;">Delete</button></div>';
      }
      html += '<ul class="expenses">' + inCycle.map(function(e){
        var d = new Date(e.ts);
        var dateStr = d.toLocaleDateString('en-GB',{day:'numeric',month:'short'});
        var tags = (e.tags||[]).map(function(t){
          var isTransfer = t === 'transfer';
          return '<span class="tag-chip' + (isTransfer ? ' transfer-chip' : '') + '">#' + t + '</span>';
        }).join('');

        var isTransferEntry = (e.tags||[]).indexOf('transfer') > -1;
        var amtDisplay = (isTransferEntry && e.amount === 0) ? '⇄' : THB2.format(e.amount);

        if (mode === 'edit' && editingId === e.id){
          if (isTransferEntry){
            return '<li class="editing"><div class="edit-form" style="padding:10px 0;">'
              + '<div style="font-size:13px; color:var(--text); margin-bottom:8px;">Transfer record: <strong>' + escapeAttr(e.note || '') + '</strong></div>'
              + '<div class="edit-actions">'
              + '<button type="button" class="ghost danger-text" data-act="deleteEdit" data-id="' + e.id + '">Delete transfer</button>'
              + '<button type="button" class="ghost" data-act="cancelEdit">Cancel</button>'
              + '</div></div></li>';
          }
          var fullText = e.note + ((e.tags && e.tags.length) ? ' ' + e.tags.map(function(t){ return '#'+t; }).join(' ') : '');
          return '<li class="editing"><form class="edit-form" data-act="editForm" data-id="' + e.id + '">'
            + '<input type="number" step="0.01" min="0.01" class="edit-amt" value="' + e.amount + '" required>'
            + '<input type="text" class="edit-note" value="' + escapeAttr(fullText) + '" placeholder="What for? #tag to tag it">'
            + '<div class="edit-actions">'
            + '<button type="button" class="ghost danger-text" data-act="deleteEdit" data-id="' + e.id + '">Delete</button>'
            + '<button type="button" class="ghost" data-act="cancelEdit">Cancel</button>'
            + '<button type="submit">Save</button>'
            + '</div></form></li>';
        }

        if (mode === 'delete'){
          return '<li><label class="del-row"><input type="checkbox" data-act="delCheck" data-id="' + e.id + '"' + (deleteSelection.indexOf(e.id)>-1?' checked':'') + '>'
            + '<span class="del-row-text"><div>' + escapeAttr(e.note || 'Expense') + tags + '</div><div class="note">' + dateStr + '</div></span>'
            + '<span>' + amtDisplay + '</span></label></li>';
        }

        var clickAct = mode === 'edit' ? 'editRow' : 'viewRow';
        return '<li class="' + (mode==='view' && selectedId===e.id?'selected':'') + '" data-act="' + clickAct + '" data-id="' + e.id + '"><div><div>' + escapeAttr(e.note || 'Expense') + '</div>'
          + '<div class="note">' + dateStr + tags + '</div></div>'
          + '<div>' + amtDisplay + '</div></li>';
      }).join('') + '</ul>';
    }

    return html;
  }

  // ===== ACCOUNTS TAB =====
  function renderAccountsTab(today){
    var html = '';
    var accounts = state && state.accounts ? state.accounts : [];

    // Total balance across all accounts
    var totalBal = 0;
    accounts.forEach(function(a){
      if (a.type === 'tracking'){
        totalBal += trackingBalance(a);
      } else {
        var cyc = cycleFor(a.refreshDay, today);
        totalBal += budgetRemaining(a, cyc);
      }
    });

    html += '<div class="total-bar">'
      + '<div class="total-bar-label">Total across all accounts</div>'
      + '<div class="total-bar-amount display">' + THB2.format(totalBal) + '</div>'
      + '</div>';

    // Action buttons
    html += '<div class="fab-row">'
      + '<button type="button" data-act="openAddAccount">+ Account</button>'
      + '<button type="button" class="ghost" data-act="openTransfer" style="border-color:var(--teal); color:var(--teal);">\u21C4 Transfer</button>'
      + '</div>';

    if (accounts.length === 0){
      html += '<div class="empty">No accounts yet. Create one to get started.</div>';
      return html;
    }

    html += '<div class="acct-grid">';
    accounts.forEach(function(a, idx){
      var isBudget = a.type === 'budget';
      var bal;
      var meta = '';
      var dailyInfo = '';

      if (isBudget){
        var cyc = cycleFor(a.refreshDay, today);
        bal = budgetRemaining(a, cyc);
        var daysLeft = Math.max(1, Math.round((cyc.end - today) / 86400000));
        var dailyVal = bal / daysLeft;
        meta = 'Budget ' + THB0.format(a.monthlyBudget) + ' · Refreshes day ' + a.refreshDay;
        if (a.endDate){
          var parts = a.endDate.split('-');
          var endD = new Date(parts[0], parts[1]-1, parts[2]);
          endD.setHours(0,0,0,0);
          var dToEnd = Math.max(0, Math.round((endD - today) / 86400000));
          meta += ' · Ends ' + endD.toLocaleDateString('en-GB',{day:'numeric',month:'short'});
        }
        dailyInfo = THB2.format(dailyVal) + '/day · ' + daysLeft + 'd left';
      } else {
        bal = trackingBalance(a);
        meta = 'Tracking account';
      }

      html += '<div class="acct-card ' + (isBudget?'active-type':'tracking-type') + '" data-act="selectAccount" data-id="' + a.id + '">'
        + '<div class="acct-card-head">'
        + '<span class="acct-card-name">' + escapeAttr(a.name) + '</span>'
        + '<span class="acct-type-badge ' + (isBudget?'budget':'tracking') + '">' + (isBudget?'Budget':'Tracking') + '</span>'
        + '</div>'
        + '<div class="acct-card-bal' + (bal<0?' neg-flag':'') + '">' + THB2.format(bal) + '</div>'
        + '<div class="acct-card-meta">' + meta + '</div>'
        + (dailyInfo ? '<div class="acct-card-daily">' + dailyInfo + '</div>' : '')
        + '</div>';
    });
    html += '</div>';

    // Recent transfers
    if (state.transfers && state.transfers.length > 0){
      var recent = state.transfers.slice().sort(function(a,b){ return b.ts - a.ts; }).slice(0, 10);
      html += '<div class="section-title">Recent transfers</div>';
      recent.forEach(function(t){
        var fromAcct = getAccountById(t.fromId);
        var toAcct = getAccountById(t.toId);
        var d = new Date(t.ts);
        var dateStr = d.toLocaleDateString('en-GB',{day:'numeric',month:'short'}) + ' ' + d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
        html += '<div class="transfer-entry">'
          + '<div class="transfer-icon">\u21C4</div>'
          + '<div class="transfer-detail">'
          + '<div class="transfer-accts">' + escapeAttr(fromAcct ? fromAcct.name : '?') + ' → ' + escapeAttr(toAcct ? toAcct.name : '?') + '</div>'
          + '<div class="transfer-date">' + dateStr + (t.note ? ' · ' + escapeAttr(t.note) : '') + '</div>'
          + '</div>'
          + '<div class="transfer-amt">' + THB2.format(t.amount) + '</div>'
          + '<button type="button" class="del-tx-btn" data-act="deleteTx" data-id="' + t.id + '" title="Delete transfer" aria-label="Delete transfer">×</button>'
          + '</div>';
      });
    }

    return html;
  }

  // ===== PANELS =====
  function renderPanels(today){
    var html = '';
    var acct = getActiveAccount();

    // Setup / Settings panel (for current budget account)
    if (panelOpen === 'setup' || panelOpen === 'settings'){
      var mb = acct && acct.type === 'budget' ? acct.monthlyBudget : '';
      var rd = acct && acct.type === 'budget' ? acct.refreshDay : '';
      var ed = acct && acct.endDate ? acct.endDate : '';
      html += '<div class="panel"><div class="card">'
        + '<h2>' + (panelOpen==='setup' ? 'Set up your budget' : 'Edit budget \u2014 ' + escapeAttr(acct ? acct.name : '')) + '</h2>'
        + '<label for="mbInput">Monthly budget (THB)</label>'
        + '<input type="number" min="0.01" step="0.01" id="mbInput" value="' + mb + '" placeholder="15000">'
        + '<label for="rdInput">Resets on day of month</label>'
        + '<input type="number" min="1" max="31" id="rdInput" value="' + rd + '" placeholder="1">'
        + '<div class="hint">E.g. if you get paid on the 25th, set this to 25.</div>'
        + '<label for="edInput">End date (optional)</label>'
        + '<input type="date" id="edInput" value="' + ed + '">'
        + '<div class="hint">Leave empty for no end date.</div>'
        + '<div class="actions">'
        + (panelOpen==='settings' ? '<button class="ghost" data-act="cancelPanel">Cancel</button>' : '')
        + '<button data-act="savePanel">Save</button>'
        + '</div></div></div>';
    }

    // Add Account panel
    if (panelOpen === 'addAccount'){
      html += '<div class="panel"><div class="card">'
        + '<h2>New Account</h2>'
        + '<label>Account type</label>'
        + '<div class="type-toggle">'
        + '<button type="button" data-act="setNewType" data-type="budget" class="' + (newAccountType==='budget'?'active':'') + '">Budget</button>'
        + '<button type="button" data-act="setNewType" data-type="tracking" class="' + (newAccountType==='tracking'?'active':'') + '">Tracking</button>'
        + '</div>'
        + '<div class="hint" style="margin-top:8px;">' + (newAccountType==='budget' ? 'Has its own expense list, daily budget, and auto-refresh cycle.' : 'Tracks a balance. Good for bank accounts, savings, or cash on hand.') + '</div>'
        + '<label for="newAcctName">Account name</label>'
        + '<input type="text" id="newAcctName" placeholder="e.g. Savings, Cash, Food Budget">';
      if (newAccountType === 'budget'){
        html += '<label for="newAcctBudget">Monthly budget (THB)</label>'
          + '<input type="number" id="newAcctBudget" min="0.01" step="0.01" placeholder="15000">'
          + '<label for="newAcctRefresh">Resets on day of month</label>'
          + '<input type="number" id="newAcctRefresh" min="1" max="31" placeholder="1">'
          + '<label for="newAcctEnd">End date (optional)</label>'
          + '<input type="date" id="newAcctEnd">';
      } else {
        html += '<label for="newAcctBal">Current balance (THB)</label>'
          + '<input type="number" id="newAcctBal" min="0" step="0.01" placeholder="0.00">';
      }
      html += '<div class="actions">'
        + '<button class="ghost" data-act="cancelPanel">Cancel</button>'
        + '<button data-act="saveNewAccount">Create</button>'
        + '</div></div></div>';
    }

    // Edit Account panel
    if (panelOpen === 'editAccount' && editingAccountId){
      var ea = getAccountById(editingAccountId);
      if (ea){
        html += '<div class="panel"><div class="card">'
          + '<h2>Edit Account</h2>'
          + '<label for="editAcctName">Account name</label>'
          + '<input type="text" id="editAcctName" value="' + escapeAttr(ea.name) + '">';
        if (ea.type === 'budget'){
          html += '<label for="editAcctBudget">Monthly budget (THB)</label>'
            + '<input type="number" id="editAcctBudget" min="0.01" step="0.01" value="' + ea.monthlyBudget + '">'
            + '<label for="editAcctRefresh">Resets on day of month</label>'
            + '<input type="number" id="editAcctRefresh" min="1" max="31" value="' + ea.refreshDay + '">'
            + '<label for="editAcctEnd">End date (optional)</label>'
            + '<input type="date" id="editAcctEnd" value="' + (ea.endDate || '') + '">';
        } else {
          html += '<label for="editAcctBal">Base balance (THB)</label>'
            + '<input type="number" id="editAcctBal" step="0.01" value="' + (ea.balance || 0) + '">'
            + '<div class="hint">This is the starting balance before transfers.</div>';
        }
        html += '<div class="actions">'
          + '<button class="ghost danger-text" data-act="deleteAccount" data-id="' + ea.id + '">Delete</button>'
          + '<button class="ghost" data-act="cancelPanel">Cancel</button>'
          + '<button data-act="saveEditAccount">Save</button>'
          + '</div></div></div>';
      }
    }

    // Transfer panel
    if (panelOpen === 'transfer'){
      var accounts = state && state.accounts ? state.accounts : [];
      if (accounts.length < 2){
        html += '<div class="panel"><div class="card">'
          + '<h2>Transfer</h2>'
          + '<div class="empty">You need at least 2 accounts to transfer money.</div>'
          + '<div class="actions"><button class="ghost" data-act="cancelPanel">Close</button></div>'
          + '</div></div>';
      } else {
        html += '<div class="panel"><div class="card">'
          + '<h2>Transfer Money</h2>'
          + '<label for="txFrom">From</label>'
          + '<select id="txFrom">' + accounts.map(function(a){ return '<option value="' + a.id + '">' + escapeAttr(a.name) + ' (' + (a.type==='budget'?'Budget':'Tracking') + ')' + '</option>'; }).join('') + '</select>'
          + '<label for="txTo">To</label>'
          + '<select id="txTo">' + accounts.map(function(a,i){ return '<option value="' + a.id + '"' + (i===1?' selected':'') + '>' + escapeAttr(a.name) + ' (' + (a.type==='budget'?'Budget':'Tracking') + ')' + '</option>'; }).join('') + '</select>'
          + '<label for="txAmt">Amount (THB)</label>'
          + '<input type="number" id="txAmt" min="0.01" step="0.01" placeholder="0.00">'
          + '<label for="txNote">Note (optional)</label>'
          + '<input type="text" id="txNote" placeholder="e.g. Top up cash">'
          + '<div class="actions">'
          + '<button class="ghost" data-act="cancelPanel">Cancel</button>'
          + '<button data-act="doTransfer" style="background:var(--teal);">Transfer</button>'
          + '</div></div></div>';
      }
    }

    // Delete confirmation panel
    if (pendingDelete && state){
      var acct = getActiveAccount();
      if (acct && acct.type === 'budget'){
        var delItems = pendingDelete
          .map(function(id){ return acct.expenses.find(function(x){ return x.id === id; }); })
          .filter(Boolean);
        html += '<div class="panel"><div class="card">'
          + '<h2>Delete ' + (delItems.length > 1 ? delItems.length + ' expenses?' : 'this expense?') + '</h2>'
          + '<ul class="confirm-list">' + delItems.map(function(e){
              var dd = new Date(e.ts);
              var isTx = (e.tags||[]).indexOf('transfer') > -1;
              var amtDisp = (isTx && e.amount === 0) ? '<span class="tag-chip transfer-chip">#transfer</span>' : THB2.format(e.amount);
              return '<li><span class="confirm-note">' + dd.toLocaleDateString('en-GB',{day:'numeric',month:'short'}) + ' \u00b7 ' + escapeAttr(e.note || 'Expense') + '</span>'
                + '<span>' + amtDisp + '</span></li>';
            }).join('') + '</ul>'
          + '<div class="actions">'
          + '<button type="button" class="ghost" data-act="cancelDelete">Cancel</button>'
          + '<button type="button" class="danger" data-act="confirmDelete">Delete</button>'
          + '</div></div></div>';
      }
    }

    return html;
  }

  function animateBars(){
    var bars = app.querySelectorAll('.tag-bar-fill');
    if (!bars.length) return;
    bars.forEach(function(el){ el.style.transition = 'none'; el.style.width = '0%'; });
    void app.offsetHeight;
    requestAnimationFrame(function(){
      bars.forEach(function(el){ el.style.transition = ''; });
      requestAnimationFrame(function(){
        bars.forEach(function(el){ el.style.width = el.getAttribute('data-pct') + '%'; });
      });
    });
  }

  function updateImpactHint(){
    var hintEl = document.getElementById('impactHint');
    if (!hintEl) return;
    var amt = parseFloat(document.getElementById('amtInput').value);
    if (!amt || amt <= 0){ hintEl.textContent = ''; return; }
    if (calc.daysLeft <= 1){
      hintEl.textContent = 'No effect on tomorrow \u2014 a new cycle starts.';
      return;
    }
    var tmrDays = calc.daysLeft - 1;
    var before = calc.remaining / tmrDays;
    var after = (calc.remaining - amt) / tmrDays;
    hintEl.textContent = 'Tomorrow\u2019s budget: ' + THB2.format(before) + ' \u2192 ' + THB2.format(after)
      + ' (' + THB2.format(after - before) + '/day)';
  }

  // ===== WIRE EVENTS =====
  function wire(){
    // Tab switching
    app.querySelectorAll('[data-act="switchTab"]').forEach(function(btn){
      btn.addEventListener('click', function(){ currentTab = btn.dataset.tab; render(); });
    });
    // Bottom nav buttons (outside #app)
    document.querySelectorAll('.bottom-nav [data-act="switchTab"]').forEach(function(btn){
      btn.addEventListener('click', function(){ currentTab = btn.dataset.tab; render(); });
    });

    // Account selector
    var acctSel = document.getElementById('acctSelector');
    if (acctSel) acctSel.addEventListener('change', function(){
      state.activeAccountId = acctSel.value;
      save(state);
      render();
    });

    // Add form
    var addForm = document.getElementById('addForm');
    if (addForm){
      addForm.addEventListener('submit', function(ev){
        ev.preventDefault();
        var amt = parseFloat(document.getElementById('amtInput').value);
        if (!amt || amt <= 0) return;
        var noteRaw = document.getElementById('noteInput').value.trim();
        var tags = [];
        var note = noteRaw.replace(/#([\w-]+)/g, function(m, t){ tags.push(t.toLowerCase()); return ''; }).replace(/\s+/g,' ').trim();
        var acct = getActiveAccount();
        if (!acct || acct.type !== 'budget') return;
        acct.expenses.push({ id: genId('exp'), amount: amt, note: note, tags: tags, ts: Date.now() });
        save(state);
        render();
      });
    }
    var amtInput = document.getElementById('amtInput');
    if (amtInput) amtInput.addEventListener('input', updateImpactHint);
    var heroNum = document.getElementById('heroNum');
    if (heroNum) heroNum.addEventListener('click', function(){
      heroNum.classList.add('num-out');
      setTimeout(function(){
        dailyMode = dailyMode === 'static' ? 'dynamic' : 'static';
        heroJustSwitched = true;
        render();
      }, 170);
    });
    app.querySelectorAll('[data-act="tagfilter"]').forEach(function(btn){
      btn.addEventListener('click', function(){
        activeTag = (activeTag === btn.dataset.tag) ? null : btn.dataset.tag;
        render();
      });
    });
    app.querySelectorAll('[data-act="setMode"]').forEach(function(btn){
      btn.addEventListener('click', function(){
        mode = btn.dataset.mode;
        editingId = null;
        selectedId = null;
        deleteSelection = [];
        render();
      });
    });
    app.querySelectorAll('li[data-act="viewRow"]').forEach(function(li){
      li.addEventListener('click', function(){
        selectedId = (selectedId === li.dataset.id) ? null : li.dataset.id;
        render();
      });
    });
    app.querySelectorAll('li[data-act="editRow"]').forEach(function(li){
      li.addEventListener('dblclick', function(){
        editingId = li.dataset.id;
        render();
      });
    });
    app.querySelectorAll('[data-act="delCheck"]').forEach(function(cb){
      cb.addEventListener('change', function(){
        var id = cb.dataset.id;
        var i = deleteSelection.indexOf(id);
        if (cb.checked && i === -1) deleteSelection.push(id);
        if (!cb.checked && i > -1) deleteSelection.splice(i, 1);
        render();
      });
    });
    var bulkDeleteBtn = app.querySelector('[data-act="bulkDelete"]');
    if (bulkDeleteBtn) bulkDeleteBtn.addEventListener('click', function(){
      pendingDelete = deleteSelection.slice();
      render();
    });
    var cancelDeleteBtn = app.querySelector('[data-act="cancelDelete"]');
    if (cancelDeleteBtn) cancelDeleteBtn.addEventListener('click', function(){ pendingDelete = null; render(); });
    var confirmDeleteBtn = app.querySelector('[data-act="confirmDelete"]');
    if (confirmDeleteBtn) confirmDeleteBtn.addEventListener('click', function(){
      var ids = pendingDelete || [];
      var acct = getActiveAccount();
      if (acct && acct.type === 'budget'){
        // Find transfer IDs linked to expenses being deleted
        var transferIds = [];
        ids.forEach(function(expId){
          var exp = acct.expenses.find(function(x){ return x.id === expId; });
          if (exp){
            if (exp.transferId){
              transferIds.push(exp.transferId);
            } else if ((exp.tags || []).indexOf('transfer') > -1 && state.transfers){
              var match = state.transfers.find(function(t){ return Math.abs(t.ts - exp.ts) < 5000; });
              if (match) transferIds.push(match.id);
            }
          }
        });
        // Remove the expenses
        acct.expenses = acct.expenses.filter(function(x){ return ids.indexOf(x.id) === -1; });
        // Clean up linked transfers and their sibling expenses on other accounts
        if (transferIds.length && state.transfers){
          state.transfers = state.transfers.filter(function(t){ return transferIds.indexOf(t.id) === -1; });
          // Remove sibling transfer expenses from other accounts
          state.accounts.forEach(function(otherAcct){
            if (otherAcct.id === acct.id) return;
            if (!otherAcct.expenses) return;
            otherAcct.expenses = otherAcct.expenses.filter(function(x){
              return !x.transferId || transferIds.indexOf(x.transferId) === -1;
            });
          });
        }
      }
      save(state);
      pendingDelete = null;
      editingId = null;
      deleteSelection = [];
      render();
    });
    var editForm = app.querySelector('[data-act="editForm"]');
    if (editForm){
      editForm.addEventListener('submit', function(ev){
        ev.preventDefault();
        var amt = parseFloat(editForm.querySelector('.edit-amt').value);
        if (!amt || amt <= 0) return;
        var raw = editForm.querySelector('.edit-note').value.trim();
        var tags = [];
        var note = raw.replace(/#([\w-]+)/g, function(m,t){ tags.push(t.toLowerCase()); return ''; }).replace(/\s+/g,' ').trim();
        var acct = getActiveAccount();
        if (!acct) return;
        var exp = acct.expenses.find(function(x){ return x.id === editForm.dataset.id; });
        if (exp){ exp.amount = amt; exp.note = note; exp.tags = tags; save(state); }
        editingId = null;
        render();
      });
    }
    var cancelEdit = app.querySelector('[data-act="cancelEdit"]');
    if (cancelEdit) cancelEdit.addEventListener('click', function(){ editingId = null; render(); });
    var deleteEdit = app.querySelector('[data-act="deleteEdit"]');
    if (deleteEdit){
      deleteEdit.addEventListener('click', function(){
        pendingDelete = [deleteEdit.dataset.id];
        render();
      });
    }
    var breakdown = app.querySelector('.tag-breakdown');
    if (breakdown) breakdown.addEventListener('toggle', function(){
      tagBreakdownOpen = breakdown.open;
      if (breakdown.open) animateBars();
    });
    var gear = app.querySelector('[data-act="settings"]');
    if (gear) gear.addEventListener('click', function(){ panelOpen = 'settings'; render(); });
    var cancel = app.querySelector('[data-act="cancelPanel"]');
    if (cancel) cancel.addEventListener('click', function(){ panelOpen = null; editingAccountId = null; render(); });
    var saveBtn = app.querySelector('[data-act="savePanel"]');
    if (saveBtn) saveBtn.addEventListener('click', function(){
      var mb = parseFloat(document.getElementById('mbInput').value);
      var rd = parseInt(document.getElementById('rdInput').value, 10);
      if (!mb || mb <= 0 || !rd || rd < 1 || rd > 31) return;
      var ed = document.getElementById('edInput').value || null;
      if (panelOpen === 'setup' && (!state || !state.accounts)){
        state = {
          accounts: [{
            id: 'acct-main',
            name: 'Main Budget',
            type: 'budget',
            balance: 0,
            monthlyBudget: mb,
            refreshDay: rd,
            endDate: ed,
            expenses: [],
            color: 0
          }],
          transfers: [],
          activeAccountId: 'acct-main'
        };
      } else {
        var acct = getActiveAccount();
        if (acct && acct.type === 'budget'){
          acct.monthlyBudget = mb;
          acct.refreshDay = rd;
          acct.endDate = ed;
        }
      }
      save(state);
      panelOpen = null;
      render();
    });

    // ---- Account management ----
    var openAddAcct = app.querySelector('[data-act="openAddAccount"]');
    if (openAddAcct) openAddAcct.addEventListener('click', function(){
      newAccountType = 'budget';
      panelOpen = 'addAccount';
      render();
    });

    app.querySelectorAll('[data-act="setNewType"]').forEach(function(btn){
      btn.addEventListener('click', function(){
        newAccountType = btn.dataset.type;
        render();
      });
    });

    var saveNewAcct = app.querySelector('[data-act="saveNewAccount"]');
    if (saveNewAcct) saveNewAcct.addEventListener('click', function(){
      var name = (document.getElementById('newAcctName').value || '').trim();
      if (!name) return;
      var newAcct = {
        id: genId('acct'),
        name: name,
        type: newAccountType,
        balance: 0,
        expenses: [],
        color: state.accounts.length
      };
      if (newAccountType === 'budget'){
        var mb = parseFloat(document.getElementById('newAcctBudget').value);
        var rd = parseInt(document.getElementById('newAcctRefresh').value, 10);
        if (!mb || mb <= 0 || !rd || rd < 1 || rd > 31) return;
        newAcct.monthlyBudget = mb;
        newAcct.refreshDay = rd;
        newAcct.endDate = document.getElementById('newAcctEnd').value || null;
      } else {
        var bal = parseFloat(document.getElementById('newAcctBal').value) || 0;
        newAcct.balance = bal;
      }
      state.accounts.push(newAcct);
      save(state);
      panelOpen = null;
      render();
    });

    // Select account (opens edit panel from accounts tab)
    app.querySelectorAll('[data-act="selectAccount"]').forEach(function(card){
      card.addEventListener('click', function(){
        editingAccountId = card.dataset.id;
        panelOpen = 'editAccount';
        render();
      });
    });

    // Save edited account
    var saveEditAcct = app.querySelector('[data-act="saveEditAccount"]');
    if (saveEditAcct) saveEditAcct.addEventListener('click', function(){
      var ea = getAccountById(editingAccountId);
      if (!ea) return;
      var name = (document.getElementById('editAcctName').value || '').trim();
      if (!name) return;
      ea.name = name;
      if (ea.type === 'budget'){
        var mb = parseFloat(document.getElementById('editAcctBudget').value);
        var rd = parseInt(document.getElementById('editAcctRefresh').value, 10);
        if (!mb || mb <= 0 || !rd || rd < 1 || rd > 31) return;
        ea.monthlyBudget = mb;
        ea.refreshDay = rd;
        ea.endDate = document.getElementById('editAcctEnd').value || null;
      } else {
        ea.balance = parseFloat(document.getElementById('editAcctBal').value) || 0;
      }
      save(state);
      panelOpen = null;
      editingAccountId = null;
      render();
    });

    // Delete account
    var delAcctBtn = app.querySelector('[data-act="deleteAccount"]');
    if (delAcctBtn) delAcctBtn.addEventListener('click', function(){
      var id = delAcctBtn.dataset.id;
      if (state.accounts.length <= 1){
        alert('You must have at least one account.');
        return;
      }
      if (!confirm('Delete this account and all its data?')) return;
      
      // Find all transfers linked to this account to clean up sibling expenses
      var linkedTxIds = (state.transfers || [])
        .filter(function(t){ return t.fromId === id || t.toId === id; })
        .map(function(t){ return t.id; });

      state.accounts = state.accounts.filter(function(a){ return a.id !== id; });

      // Remove orphaned transfer expenses from remaining accounts
      if (linkedTxIds.length > 0) {
        state.accounts.forEach(function(a){
          if (a.expenses) {
            a.expenses = a.expenses.filter(function(x){
              return !x.transferId || linkedTxIds.indexOf(x.transferId) === -1;
            });
          }
        });
      }

      state.transfers = (state.transfers || []).filter(function(t){ return t.fromId !== id && t.toId !== id; });
      if (state.activeAccountId === id){
        var budgets = state.accounts.filter(function(a){ return a.type === 'budget'; });
        state.activeAccountId = budgets.length ? budgets[0].id : state.accounts[0].id;
      }
      save(state);
      panelOpen = null;
      editingAccountId = null;
      render();
    });

    // ---- Transfer ----
    var openTransfer = app.querySelector('[data-act="openTransfer"]');
    if (openTransfer) openTransfer.addEventListener('click', function(){
      panelOpen = 'transfer';
      render();
    });
    var doTransfer = app.querySelector('[data-act="doTransfer"]');
    if (doTransfer) doTransfer.addEventListener('click', function(){
      var fromId = document.getElementById('txFrom').value;
      var toId = document.getElementById('txTo').value;
      var amt = parseFloat(document.getElementById('txAmt').value);
      var note = (document.getElementById('txNote').value || '').trim();
      if (!amt || amt <= 0) return;
      if (fromId === toId){ alert('Cannot transfer to the same account.'); return; }

      var now = Date.now();
      // Create transfer record
      if (!state.transfers) state.transfers = [];
      var txId = genId('tx');
      state.transfers.push({
        id: txId,
        fromId: fromId,
        toId: toId,
        amount: amt,
        note: note,
        ts: now
      });

      // Log as zero-amount visibility entries on budget accounts (actual
      // balance math is handled by budgetRemaining via state.transfers).
      // Each expense stores transferId so deletion stays in sync.
      var fromAcct = getAccountById(fromId);
      var toAcct = getAccountById(toId);
      var fromName = fromAcct ? fromAcct.name : '?';
      var toName = toAcct ? toAcct.name : '?';

      if (fromAcct && fromAcct.type === 'budget'){
        fromAcct.expenses.push({
          id: genId('exp'),
          amount: 0,
          note: 'Transfer to ' + toName + ' (' + THB2.format(amt) + ')',
          tags: ['transfer'],
          transferId: txId,
          ts: now
        });
      }
      if (toAcct && toAcct.type === 'budget'){
        toAcct.expenses.push({
          id: genId('exp'),
          amount: 0,
          note: 'Received from ' + fromName + ' (' + THB2.format(amt) + ')',
          tags: ['transfer'],
          transferId: txId,
          ts: now
        });
      }

      save(state);
      panelOpen = null;
      render();
    });

    wireInstallButton();
    var exportBtn = app.querySelector('[data-act="export"]');
    if (exportBtn) exportBtn.addEventListener('click', doExport);

    // Delete transfer from recent transfers
    app.querySelectorAll('[data-act="deleteTx"]').forEach(function(btn){
      btn.addEventListener('click', function(ev){
        ev.stopPropagation();
        var txId = btn.dataset.id;
        if (!confirm('Delete this transfer record?')) return;
        if (state.transfers){
          state.transfers = state.transfers.filter(function(t){ return t.id !== txId; });
        }
        if (state.accounts){
          state.accounts.forEach(function(a){
            if (!a.expenses) return;
            a.expenses = a.expenses.filter(function(x){ return x.transferId !== txId; });
          });
        }
        save(state);
        render();
      });
    });
  }

  // ---- Export ----
  function buildCsv(expenses){
    var rows = [['Date','Note','Tags','Amount (THB)']];
    expenses.slice().sort(function(a,b){ return a.ts - b.ts; }).forEach(function(e){
      var d = new Date(e.ts);
      var dateStr = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
      var note = '"' + (e.note || '').replace(/"/g,'""') + '"';
      var tags = '"' + (e.tags||[]).join(' ') + '"';
      rows.push([dateStr, note, tags, e.amount.toFixed(2)]);
    });
    return rows.map(function(r){ return r.join(','); }).join('\n');
  }
  async function getDownloads(){
    try{
      if (typeof claude === 'undefined' || !claude.use) return null;
      return await claude.use('downloads');
    } catch(e){ return null; }
  }
  function fallbackDownload(csv, filename){
    try{
      var blob = new Blob([csv], {type:'text/csv'});
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch(e){}
  }
  async function doExport(){
    var acct = getActiveAccount();
    if (!acct || !acct.expenses || !acct.expenses.length) return;
    var csv = buildCsv(acct.expenses);
    var filename = 'budget-export-' + acct.name.replace(/\s+/g,'-').toLowerCase() + '-' + new Date().toISOString().slice(0,10) + '.csv';
    var dl = await getDownloads();
    if (!dl){ fallbackDownload(csv, filename); return; }
    try{ await dl.save({ filename: filename, data: csv }); }
    catch(e){ fallbackDownload(csv, filename); }
  }

  // ---- Install / download (PWA) ----
  var deferredPrompt = null;
  function isIosSafari(){
    var ua = window.navigator.userAgent || '';
    var iOS = /iphone|ipad|ipod/i.test(ua);
    var isSafari = /^((?!chrome|crios|fxios|edgios).)*safari/i.test(ua);
    return iOS && isSafari;
  }
  function isStandalone(){
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || window.navigator.standalone === true;
  }
  window.addEventListener('beforeinstallprompt', function(e){
    e.preventDefault();
    deferredPrompt = e;
    var btn = document.getElementById('installBtn');
    if (btn) btn.classList.add('show');
  });
  window.addEventListener('appinstalled', function(){
    deferredPrompt = null;
    var btn = document.getElementById('installBtn');
    if (btn) btn.classList.remove('show');
    var help = document.getElementById('installHelp');
    if (help) help.classList.remove('show');
  });
  function wireInstallButton(){
    var btn = document.getElementById('installBtn');
    var help = document.getElementById('installHelp');
    if (!btn) return;
    // Already installed: hide everything.
    if (isStandalone()) return;
    // Chrome/Edge/Android: show once beforeinstallprompt has fired.
    if (deferredPrompt) btn.classList.add('show');
    // iOS Safari has no prompt: show manual instructions.
    if (isIosSafari() && help){
      btn.classList.add('show');
      btn.textContent = 'Download app';
      help.textContent = 'Tap Share, then "Add to Home Screen" to install.';
      help.classList.add('show');
    }
    btn.addEventListener('click', function(){
      if (deferredPrompt){
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(function(){ deferredPrompt = null; });
      } else if (help){
        var isiOS = /iphone|ipad|ipod/i.test(window.navigator.userAgent || '');
        help.textContent = isiOS
          ? 'Tap Share, then "Add to Home Screen" to install.'
          : 'In your browser menu choose "Install app" or "Add to Home screen". Serving over http(s) is required for the automatic prompt.';
        help.classList.add('show');
      }
    });
  }

  // Offline support: no-op on file://, works when served over http(s).
  if ('serviceWorker' in navigator && /^https?:$/.test(window.location.protocol)){
    window.addEventListener('load', function(){
      try { navigator.serviceWorker.register('./sw.js'); } catch (e) {}
    });
  }

  render();

  setInterval(function(){
    var active = document.activeElement;
    var typing = active && app.contains(active) && active.tagName === 'INPUT';
    if (!typing) render();
  }, 60000);
})();