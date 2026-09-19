// 页面交互：规则的起草、复核、启用、停用整条链，以及文件与扫描两块都从服务端拉取。
// 任何一步失败都把说明显示在顶部；启用把关不过时把每一项卡点逐条列出来。

const state = {
  rules: [],
  files: [],
  levels: [],
  statuses: [],
  fileTypes: [],
  ruleFileTypes: [],
  scans: [],
  editingRuleId: '',
  editingFileId: '',
  lastScan: null,
  // 弹层里正在做的流转动作
  transition: null,
  // 当前命中表看的是新一轮扫描还是某一轮历史
  viewingScanId: '',
};

const el = (id) => document.getElementById(id);

// 统一的请求入口：出错时把服务端给的错误码、说明、出错位置与卡点明细一起抛出去
async function request(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }
  if (!res.ok) {
    const error = (payload && payload.error) || {};
    const failure = new Error(error.message || `请求失败（状态码 ${res.status}）`);
    failure.code = error.code || '';
    failure.field = error.field || '';
    failure.details = Array.isArray(error.details) ? error.details : [];
    throw failure;
  }
  return payload;
}

function notify(message, kind, details) {
  const box = el('notice');
  const lines = [message];
  if (Array.isArray(details) && details.length > 0) {
    details.forEach((item) => {
      lines.push(`· ${item.message || item.code || '有一项没通过'}`);
    });
  }
  box.innerHTML = lines.map((text) => escapeHtml(text)).join('<br>');
  box.className = `notice ${kind === 'ok' ? 'ok' : 'error'}`;
}

function clearNotice() {
  const box = el('notice');
  box.className = 'notice hidden';
  box.textContent = '';
}

function clearFieldMarks() {
  document.querySelectorAll('.invalid').forEach((node) => node.classList.remove('invalid'));
}

// 把出错位置标到具体输入项上：规则区与文件区共用一套标记
function markField(field) {
  if (!field) return;
  const target = document.querySelector(`[data-field="${field}"]`);
  if (!target) return;
  target.classList.add('invalid');
  const input = target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA'
    ? target
    : target.querySelector('input, select, textarea');
  if (input) input.focus();
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function levelClass(level) {
  if (level === '错误') return 'lv-error';
  if (level === '警告') return 'lv-warn';
  return 'lv-hint';
}

function statusClass(status) {
  if (status === '启用') return 'st-enabled';
  if (status === '停用') return 'st-disabled';
  if (status === '待复核') return 'st-review';
  return 'st-draft';
}

const OPERATOR_KEY = 'check-hits-operator';

function currentOperator() {
  return el('operator').value.trim();
}

// 需要署名的动作先过这一关：没填操作者直接拦下
function requireOperator() {
  const operator = currentOperator();
  if (!operator) {
    notify('请先在页面右上角填上当前操作者，这样每一次状态变化才知道是谁做的', 'error');
    el('operator').focus();
    return '';
  }
  return operator;
}

function restoreOperator() {
  el('operator').value = window.localStorage.getItem(OPERATOR_KEY) || '';
}

async function loadHealth() {
  try {
    await request('/api/health');
    el('health').textContent = '服务正常';
    el('health').className = 'health ok';
  } catch (err) {
    el('health').textContent = '服务连不上';
    el('health').className = 'health bad';
  }
}

async function loadRules() {
  const params = new URLSearchParams();
  const level = el('rule-filter-level').value;
  const status = el('rule-filter-status').value;
  const fileType = el('rule-filter-type').value;
  const keyword = el('rule-filter-keyword').value.trim();
  if (level) params.set('level', level);
  if (status) params.set('status', status);
  if (fileType) params.set('fileType', fileType);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/rules${query ? `?${query}` : ''}`);
  state.rules = payload.rules || [];
  state.levels = payload.levels || [];
  state.statuses = payload.statuses || [];
  state.fileTypes = payload.fileTypes || [];
  renderRuleFilters();
  renderRules();
  renderScanRuleOptions();
}

async function loadFiles() {
  const params = new URLSearchParams();
  const type = el('file-filter-type').value;
  const keyword = el('file-filter-keyword').value.trim();
  if (type) params.set('type', type);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/files${query ? `?${query}` : ''}`);
  state.files = payload.files || [];
  state.ruleFileTypes = payload.fileTypes || [];
  renderFileFilters();
  renderFiles();
  renderScanFileOptions();
}

async function loadScans() {
  const payload = await request('/api/scans');
  state.scans = payload.scans || [];
  renderScanHistory();
}

function renderRuleFilters() {
  const levelSelect = el('rule-filter-level');
  const levelCurrent = levelSelect.value;
  levelSelect.innerHTML = '<option value="">全部级别</option>'
    + state.levels.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.levels.includes(levelCurrent)) levelSelect.value = levelCurrent;

  const statusSelect = el('rule-filter-status');
  const statusCurrent = statusSelect.value;
  statusSelect.innerHTML = '<option value="">全部状态</option>'
    + state.statuses.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.statuses.includes(statusCurrent)) statusSelect.value = statusCurrent;

  const typeSelect = el('rule-filter-type');
  const typeCurrent = typeSelect.value;
  typeSelect.innerHTML = '<option value="">全部适用文件类型</option>'
    + state.fileTypes.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.fileTypes.includes(typeCurrent)) typeSelect.value = typeCurrent;

  const formLevel = el('rule-level');
  const formLevelCurrent = formLevel.value;
  formLevel.innerHTML = state.levels.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.levels.includes(formLevelCurrent)) formLevel.value = formLevelCurrent;

  const formType = el('rule-file-type');
  const formTypeCurrent = formType.value;
  formType.innerHTML = state.fileTypes.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.fileTypes.includes(formTypeCurrent)) formType.value = formTypeCurrent;

  const scanLevel = el('scan-level');
  const scanLevelCurrent = scanLevel.value;
  scanLevel.innerHTML = '<option value="">全部级别</option>'
    + state.levels.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.levels.includes(scanLevelCurrent)) scanLevel.value = scanLevelCurrent;
}

function renderFileFilters() {
  const typeSelect = el('file-filter-type');
  const current = typeSelect.value;
  typeSelect.innerHTML = '<option value="">全部类型</option>'
    + state.ruleFileTypes.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.ruleFileTypes.includes(current)) typeSelect.value = current;
}

function renderScanRuleOptions() {
  const select = el('scan-rule');
  const current = select.value;
  select.innerHTML = '<option value="">全部规则</option>'
    + state.rules.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.code)} ${escapeHtml(item.name)}</option>`).join('');
  if (state.rules.some((item) => item.id === current)) select.value = current;
}

function renderScanFileOptions() {
  const select = el('scan-file');
  const current = select.value;
  select.innerHTML = '<option value="">全部文件</option>'
    + state.files.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.path)}</option>`).join('');
  if (state.files.some((item) => item.id === current)) select.value = current;
}

// 规则行：状态色签、当前版本、按状态给出可点的动作，任何动作都能在记录里查
function renderRules() {
  const body = el('rule-body');
  body.innerHTML = state.rules.map((item) => {
    const transitionButtons = (item.allowedActions || []).map((action) => {
      const cls = action === '停用' ? 'link danger' : 'link';
      return `<button type="button" class="${cls}" data-rule-action="${escapeHtml(action)}" data-rule-id="${escapeHtml(item.id)}">${escapeHtml(action)}</button>`;
    }).join('');
    const editButton = item.editable
      ? `<button type="button" class="link" data-rule-edit="${escapeHtml(item.id)}">编辑改版</button>`
      : '';
    const deleteButton = item.deletable
      ? `<button type="button" class="link danger" data-rule-delete="${escapeHtml(item.id)}">删除</button>`
      : '';
    const versionText = item.enabledVersion
      ? `第 ${item.version} 版（启用第 ${item.enabledVersion} 版）`
      : `第 ${item.version} 版（未启用）`;
    return `<tr>
      <td class="mono">${escapeHtml(item.code)}</td>
      <td>${escapeHtml(item.name)}</td>
      <td><span class="tag ${levelClass(item.level)}">${escapeHtml(item.level)}</span></td>
      <td><span class="tag ${statusClass(item.status)}">${escapeHtml(item.status)}</span></td>
      <td class="mono">${versionText}</td>
      <td>${escapeHtml(item.fileType)}</td>
      <td class="mono">${escapeHtml(item.pattern) || '<span class="placeholder">起草中，未填写</span>'}</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td class="mono">${escapeHtml(formatTime(item.updatedAt))}<br><span class="by-line">${escapeHtml(item.updatedBy)}</span></td>
      <td class="actions">
        ${editButton}
        ${transitionButtons}
        <button type="button" class="link" data-rule-history="${escapeHtml(item.id)}">记录</button>
        ${deleteButton}
      </td>
    </tr>`;
  }).join('');
  el('rule-empty').classList.toggle('hidden', state.rules.length > 0);
}

function renderFiles() {
  const body = el('file-body');
  body.innerHTML = state.files.map((item) => `<tr>
      <td class="mono">${escapeHtml(item.path)}</td>
      <td>${escapeHtml(item.type)}</td>
      <td>${item.lineCount} 行</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td class="mono">${escapeHtml(formatTime(item.updatedAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-file-view="${escapeHtml(item.id)}">看内容</button>
        <button type="button" class="link" data-file-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-file-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('file-empty').classList.toggle('hidden', state.files.length > 0);
}

function openRuleForm(rule) {
  state.editingRuleId = rule ? rule.id : '';
  el('rule-form-title').textContent = rule
    ? `停用中改版：${rule.code}（当前第 ${rule.version} 版，保存后升为第 ${rule.version + 1} 版）`
    : '新建规则（保存后进草稿，写完先自己复核，再点启用）';
  el('rule-code').value = rule ? rule.code : '';
  el('rule-name').value = rule ? rule.name : '';
  el('rule-level').value = rule ? rule.level : (state.levels[0] || '提示');
  el('rule-file-type').value = rule ? rule.fileType : (state.fileTypes[0] || '全部');
  el('rule-pattern').value = rule ? rule.pattern : '';
  el('rule-note').value = rule ? rule.note : '';
  el('rule-reason').value = '';
  el('rule-form').classList.remove('hidden');
  el('rule-code').focus();
}

function closeRuleForm() {
  state.editingRuleId = '';
  el('rule-form').classList.add('hidden');
  clearFieldMarks();
}

function openFileForm(file) {
  state.editingFileId = file ? file.id : '';
  el('file-form-title').textContent = file ? `编辑文件：${file.path}` : '收录新文件';
  el('file-path').value = file ? file.path : '';
  el('file-content').value = file ? file.content : '';
  el('file-note').value = file ? file.note : '';
  el('file-form').classList.remove('hidden');
  el('file-path').focus();
}

function closeFileForm() {
  state.editingFileId = '';
  el('file-form').classList.add('hidden');
  clearFieldMarks();
}

async function showFileContent(id) {
  clearNotice();
  try {
    const file = await request(`/api/files/${encodeURIComponent(id)}`);
    const preview = el('file-preview');
    preview.textContent = `${file.path}（${file.lineCount} 行）\n${'─'.repeat(40)}\n${file.content}`;
    preview.classList.remove('hidden');
  } catch (err) {
    notify(err.message, 'error');
  }
}

async function submitRule(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const operator = requireOperator();
  if (!operator) return;
  const payload = {
    code: el('rule-code').value,
    name: el('rule-name').value,
    level: el('rule-level').value,
    fileType: el('rule-file-type').value,
    pattern: el('rule-pattern').value,
    note: el('rule-note').value,
    reason: el('rule-reason').value,
    operator,
  };
  const editing = state.editingRuleId;
  try {
    if (editing) {
      await request(`/api/rules/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('规则已改版并升了一版，重新启用后参与扫描', 'ok');
    } else {
      await request('/api/rules', { method: 'POST', body: JSON.stringify(payload) });
      notify('规则已登记为草稿，写完先自己复核一遍，再提交复核、点启用', 'ok');
    }
    closeRuleForm();
    await loadRules();
  } catch (err) {
    notify(err.message, 'error', err.details);
    markField(err.field);
  }
}

async function submitFile(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    path: el('file-path').value,
    content: el('file-content').value,
    note: el('file-note').value,
  };
  const editing = state.editingFileId;
  try {
    if (editing) {
      await request(`/api/files/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('文件已保存', 'ok');
    } else {
      await request('/api/files', { method: 'POST', body: JSON.stringify(payload) });
      notify('文件已收录', 'ok');
    }
    closeFileForm();
    await loadFiles();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

// 打开状态流转弹层：让操作者看清从什么状态到什么状态，并留一句说明
function openTransitionModal(rule, action) {
  const flowMap = {
    提交复核: ['草稿', '待复核'],
    退回起草: ['待复核', '草稿'],
    启用: [rule.status, '启用'],
    停用: ['启用', '停用'],
  };
  const [from, to] = flowMap[action] || [rule.status, ''];
  state.transition = { ruleId: rule.id, action };
  el('transition-title').textContent = `${action}规则`;
  el('transition-rule').textContent = `${rule.code} ${rule.name}（当前第 ${rule.version} 版）`;
  el('transition-flow').innerHTML =
    `<span class="tag ${statusClass(from)}">${escapeHtml(from)}</span>`
    + `<span class="flow-arrow">→</span>`
    + `<span class="tag ${statusClass(to)}">${escapeHtml(to)}</span>`;
  el('transition-reason').value = '';
  const tip = action === '启用'
    ? '点确认前会把该把关的项过一遍：匹配写法、适用文件类型、编码重复、同类写法是否已有启用规则；有一项不过都不会启用。'
    : '停用之后这条规则不再参与扫描，历史上扫出来的命中仍然保留，并能看出当时是哪一版在管事。';
  el('transition-tip').textContent = tip;
  el('transition-modal').classList.remove('hidden');
  el('transition-reason').focus();
}

function closeTransitionModal() {
  state.transition = null;
  el('transition-modal').classList.add('hidden');
  clearFieldMarks();
}

async function confirmTransition() {
  if (!state.transition) return;
  clearNotice();
  clearFieldMarks();
  const operator = requireOperator();
  if (!operator) return;
  const { ruleId, action } = state.transition;
  try {
    await request(`/api/rules/${encodeURIComponent(ruleId)}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ action, operator, reason: el('transition-reason').value }),
    });
    notify(`规则已${action}`, 'ok');
    closeTransitionModal();
    await loadRules();
  } catch (err) {
    // 启用把关不过：弹层里列出每一项卡点，同时标到对应输入项上（编辑表单展开时）
    if (err.code === 'ENABLE_GUARDS_FAILED') {
      const box = el('transition-tip');
      const lines = (err.details || []).map((item) => `· ${item.message}`).join('<br>');
      box.innerHTML = `<span class="guard-failed">启用被拦住，卡在这几项上：</span><br>${lines}`;
      (err.details || []).forEach((item) => markField(item.field));
    } else {
      notify(err.message, 'error', err.details);
    }
  }
}

// 规则记录：从登记到现在的每一次状态变化与改版都列成时间线
async function openHistoryModal(ruleId) {
  clearNotice();
  try {
    const payload = await request(`/api/rules/${encodeURIComponent(ruleId)}/history`);
    el('history-title').textContent = `规则记录：${payload.rule.code} ${payload.rule.name}`;
    const list = el('history-list');
    if (!payload.history.length) {
      list.innerHTML = '<li class="timeline-empty">还没有任何记录</li>';
    } else {
      list.innerHTML = payload.history.map((item) => {
        const revision = item.kind === 'revision';
        let headTail;
        if (revision) {
          headTail = `<span class="timeline-version">停用中改版，升到第 ${item.version} 版</span>`;
        } else {
          const flow = item.fromStatus
            ? `<span class="tag ${statusClass(item.fromStatus)}">${escapeHtml(item.fromStatus)}</span><span class="flow-arrow">→</span><span class="tag ${statusClass(item.toStatus)}">${escapeHtml(item.toStatus)}</span>`
            : `<span class="tag ${statusClass(item.toStatus)}">${escapeHtml(item.toStatus)}</span>`;
          headTail = `<span class="timeline-flow">${flow}</span><span class="timeline-version">第 ${item.version} 版</span>`;
        }
        return `<li class="timeline-item ${revision ? 'is-revision' : ''}">
          <div class="timeline-head">
            <span class="timeline-action">${escapeHtml(item.action)}</span>
            ${headTail}
          </div>
          <div class="timeline-meta">
            ${escapeHtml(formatTime(item.at))}　由 <strong>${escapeHtml(item.by)}</strong>
            ${item.reason ? `　说明：${escapeHtml(item.reason)}` : '　<span class="placeholder">未写说明</span>'}
          </div>
        </li>`;
      }).join('');
    }
    el('history-modal').classList.remove('hidden');
  } catch (err) {
    notify(err.message, 'error');
  }
}

function closeHistoryModal() {
  el('history-modal').classList.add('hidden');
}

// 扫一遍，把概要与命中清单都画出来，并刷新历史扫描
async function runScan() {
  clearNotice();
  const operator = requireOperator();
  if (!operator) return;
  const body = {
    ruleId: el('scan-rule').value,
    fileId: el('scan-file').value,
    level: el('scan-level').value,
    operator,
  };
  try {
    const result = await request('/api/scan', { method: 'POST', body: JSON.stringify(body) });
    state.lastScan = result;
    state.viewingScanId = result.id;
    renderScan(result);
    await loadScans();
  } catch (err) {
    notify(err.message, 'error');
  }
}

function scopeText(result) {
  const parts = [];
  parts.push(result.scopeRuleCode ? `规则 ${result.scopeRuleCode}` : '全部规则');
  parts.push(result.scopeFilePath || '全部文件');
  if (result.level) parts.push(`仅 ${result.level}`);
  return parts.join(' / ');
}

function renderScan(result) {
  el('scan-meta').textContent = `扫描时刻 ${formatTime(result.scannedAt)}　操作者 ${result.by}　参与比对的规则 ${result.rulesUsed} 条（启用共 ${result.enabledRules} 条）　范围里的文件 ${result.filesInScope} 个（清单共 ${result.filesTotal} 个）`;

  const warningBox = el('scan-warning');
  if (result.warning) {
    warningBox.textContent = result.warning;
    warningBox.classList.remove('hidden');
  } else {
    warningBox.classList.add('hidden');
    warningBox.textContent = '';
  }

  const summaryBox = el('scan-summary');
  const levelText = Object.keys(result.summary.byLevel)
    .map((key) => `${key} ${result.summary.byLevel[key]} 条`)
    .join('　');
  const ruleText = result.summary.byRule
    .map((item) => `${item.code}${item.ruleVersion ? `(v${item.ruleVersion})` : ''} ${item.count} 条`)
    .join('　') || '没有规则命中';
  const fileText = result.summary.byFile
    .map((item) => `${item.path} ${item.count} 条`)
    .join('　') || '没有文件命中';
  summaryBox.innerHTML = `
    <div class="summary-line"><strong>一共命中 ${result.summary.total} 条</strong>　${escapeHtml(levelText)}</div>
    <div class="summary-line">按规则（括号里是当时管事的版本）：${escapeHtml(ruleText)}</div>
    <div class="summary-line">按文件：${escapeHtml(fileText)}</div>`;
  summaryBox.classList.remove('hidden');

  renderHits(result.hits);
}

function renderHits(hits) {
  const body = el('hit-body');
  body.innerHTML = hits.map((hit) => `<tr>
      <td class="mono">${escapeHtml(hit.code)}</td>
      <td class="mono">${hit.ruleVersion ? `第 ${hit.ruleVersion} 版` : '<span class="placeholder">未知</span>'}</td>
      <td><span class="tag ${levelClass(hit.level)}">${escapeHtml(hit.level)}</span></td>
      <td>${escapeHtml(hit.ruleName)}</td>
      <td class="mono">${escapeHtml(hit.path)}</td>
      <td class="mono">${hit.lineNo}</td>
      <td class="mono line-cell">${escapeHtml(hit.lineText)}</td>
    </tr>`).join('');
  el('hit-empty').classList.toggle('hidden', hits.length > 0);
}

function renderScanHistory() {
  const body = el('scan-body');
  body.innerHTML = state.scans.map((item) => {
    const scope = [
      item.scopeRuleCode ? `规则 ${item.scopeRuleCode}` : '全部规则',
      item.scopeFilePath || '全部文件',
      item.level ? `仅${item.level}` : '',
    ].filter(Boolean).join(' / ');
    const active = item.id === state.viewingScanId ? ' class="current-row"' : '';
    return `<tr${active}>
      <td class="mono">${escapeHtml(formatTime(item.scannedAt))}</td>
      <td>${escapeHtml(item.by)}</td>
      <td>${escapeHtml(scope)}</td>
      <td class="mono">${item.rulesUsed} / ${item.enabledRules} 条</td>
      <td class="mono">${item.filesInScope} 个</td>
      <td class="mono"><strong>${item.total}</strong> 条</td>
      <td class="note-cell">${item.warning ? escapeHtml(item.warning) : ''}</td>
      <td class="actions">
        <button type="button" class="link" data-scan-view="${escapeHtml(item.id)}">看这一轮</button>
      </td>
    </tr>`;
  }).join('');
  el('scan-empty').classList.toggle('hidden', state.scans.length > 0);
}

async function viewScan(id) {
  clearNotice();
  try {
    const result = await request(`/api/scans/${encodeURIComponent(id)}`);
    state.lastScan = result;
    state.viewingScanId = result.id;
    renderScan(result);
    renderScanHistory();
    notify(`正在回看 ${formatTime(result.scannedAt)} 由 ${result.by} 扫的这一轮，命中里的版本就是当时管事的版本`, 'ok');
  } catch (err) {
    notify(err.message, 'error');
  }
}

// 列表上的操作用事件委托统一处理，列表重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;

  if (node.dataset.ruleAction && node.dataset.ruleId) {
    clearNotice();
    const operator = requireOperator();
    if (!operator) return;
    const found = state.rules.find((item) => item.id === node.dataset.ruleId);
    if (found) openTransitionModal(found, node.dataset.ruleAction);
    return;
  }

  if (node.dataset.ruleHistory) {
    const found = state.rules.find((item) => item.id === node.dataset.ruleHistory);
    await openHistoryModal(node.dataset.ruleHistory);
    return;
  }

  if (node.dataset.ruleEdit) {
    clearNotice();
    const found = state.rules.find((item) => item.id === node.dataset.ruleEdit);
    if (found) openRuleForm(found);
    return;
  }

  if (node.dataset.ruleDelete) {
    clearNotice();
    const found = state.rules.find((item) => item.id === node.dataset.ruleDelete);
    if (!window.confirm(`确定删除规则 ${found ? found.code : ''} 吗？只有起草、待复核中的规则可以删除`)) return;
    const operator = requireOperator();
    if (!operator) return;
    try {
      await request(`/api/rules/${encodeURIComponent(node.dataset.ruleDelete)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      if (state.editingRuleId === node.dataset.ruleDelete) closeRuleForm();
      notify('规则已删除', 'ok');
      await loadRules();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.fileView) {
    await showFileContent(node.dataset.fileView);
    return;
  }

  if (node.dataset.fileEdit) {
    clearNotice();
    try {
      const file = await request(`/api/files/${encodeURIComponent(node.dataset.fileEdit)}`);
      openFileForm(file);
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.fileDelete) {
    clearNotice();
    const found = state.files.find((item) => item.id === node.dataset.fileDelete);
    if (!window.confirm(`确定把 ${found ? found.path : ''} 移出清单吗？`)) return;
    try {
      await request(`/api/files/${encodeURIComponent(node.dataset.fileDelete)}`, { method: 'DELETE' });
      if (state.editingFileId === node.dataset.fileDelete) closeFileForm();
      el('file-preview').classList.add('hidden');
      notify('文件已移出清单', 'ok');
      await loadFiles();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.scanView) {
    await viewScan(node.dataset.scanView);
  }
});

el('rule-form').addEventListener('submit', submitRule);
el('file-form').addEventListener('submit', submitFile);
el('rule-new').addEventListener('click', () => {
  clearNotice();
  openRuleForm(null);
});
el('rule-cancel').addEventListener('click', closeRuleForm);
el('file-new').addEventListener('click', () => {
  clearNotice();
  openFileForm(null);
});
el('file-cancel').addEventListener('click', closeFileForm);
el('transition-confirm').addEventListener('click', confirmTransition);
el('transition-cancel').addEventListener('click', closeTransitionModal);
el('history-close').addEventListener('click', closeHistoryModal);
el('transition-modal').addEventListener('click', (event) => {
  if (event.target === el('transition-modal')) closeTransitionModal();
});
el('history-modal').addEventListener('click', (event) => {
  if (event.target === el('history-modal')) closeHistoryModal();
});
el('rule-filter-apply').addEventListener('click', () => {
  clearNotice();
  loadRules().catch((err) => notify(err.message, 'error'));
});
el('rule-filter-reset').addEventListener('click', () => {
  el('rule-filter-level').value = '';
  el('rule-filter-status').value = '';
  el('rule-filter-type').value = '';
  el('rule-filter-keyword').value = '';
  loadRules().catch((err) => notify(err.message, 'error'));
});
el('rule-refresh').addEventListener('click', () => {
  clearNotice();
  loadRules()
    .then(loadFiles)
    .then(loadScans)
    .catch((err) => notify(err.message, 'error'));
});
el('file-filter-apply').addEventListener('click', () => {
  clearNotice();
  loadFiles().catch((err) => notify(err.message, 'error'));
});
el('file-filter-reset').addEventListener('click', () => {
  el('file-filter-type').value = '';
  el('file-filter-keyword').value = '';
  loadFiles().catch((err) => notify(err.message, 'error'));
});
el('scan-run').addEventListener('click', runScan);
el('rule-filter-level').addEventListener('change', () => {
  loadRules().catch((err) => notify(err.message, 'error'));
});
el('rule-filter-status').addEventListener('change', () => {
  loadRules().catch((err) => notify(err.message, 'error'));
});
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});

// 页面打开时先把规则、文件与历史扫描都拉一遍，扫描的范围下拉依赖规则与文件清单
restoreOperator();
loadHealth();
loadRules()
  .then(loadFiles)
  .then(loadScans)
  .catch((err) => notify(err.message, 'error'));
