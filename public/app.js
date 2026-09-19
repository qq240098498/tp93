// 页面交互：规则、文件、状态流转与扫描批次都从服务端拉取，
// 任何一步失败都把说明显示在顶部，并尽量标到对应输入项上

const state = {
  rules: [],
  files: [],
  levels: [],
  statuses: [],
  fileTypes: [],
  ruleFileTypes: [],
  editingRuleId: '',
  editingFileId: '',
  lastScan: null,
  batches: [],
};

const el = (id) => document.getElementById(id);

const STATUS_LABEL = {
  draft: '起草',
  reviewed: '已复核',
  enabled: '启用',
  disabled: '停用',
};

// 统一的请求入口：出错时把服务端给的错误码、说明、出错位置与附加明细一起抛出去
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
    failure.details = error.details || null;
    throw failure;
  }
  return payload;
}

function notify(message, kind) {
  const box = el('notice');
  box.textContent = message;
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
  return String(text === undefined || text === null ? '' : text)
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
  if (status === STATUS_LABEL.enabled) return 'st-enabled';
  if (status === STATUS_LABEL.disabled) return 'st-disabled';
  if (status === STATUS_LABEL.reviewed) return 'st-reviewed';
  return 'st-draft';
}

function statusBadge(status) {
  return `<span class="tag ${statusClass(status)}">${escapeHtml(status)}</span>`;
}

const OPERATOR_KEY = 'check-hits-operator';

function currentOperator() {
  return el('operator').value.trim();
}

function restoreOperator() {
  el('operator').value = window.localStorage.getItem(OPERATOR_KEY) || '';
}

function requireOperator() {
  const operator = currentOperator();
  if (!operator) {
    notify('请先在页面右上角填上当前操作者，再做这个动作', 'error');
    el('operator').focus();
    return '';
  }
  return operator;
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

async function loadBatches() {
  const payload = await request('/api/scan-batches');
  state.batches = payload.batches || [];
  renderBatches();
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
    + state.fileTypes.filter((item) => item).map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.fileTypes.includes(typeCurrent)) typeSelect.value = typeCurrent;

  const formLevel = el('rule-level');
  const formLevelCurrent = formLevel.value;
  formLevel.innerHTML = state.levels.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.levels.includes(formLevelCurrent)) formLevel.value = formLevelCurrent;

  // 起草阶段允许先不选适用文件类型，启用把关会拦
  const formType = el('rule-file-type');
  const formTypeCurrent = formType.value;
  formType.innerHTML = '<option value="">（先不选，启用前要补）</option>'
    + state.fileTypes.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  formType.value = formTypeCurrent;

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
    + state.rules.map((item) => {
      const suffix = item.status === STATUS_LABEL.enabled ? '' : `（${item.status}，不参与）`;
      return `<option value="${escapeHtml(item.id)}">${escapeHtml(item.code)} ${escapeHtml(item.name)}${escapeHtml(suffix)}</option>`;
    }).join('');
  if (state.rules.some((item) => item.id === current)) select.value = current;
}

function renderScanFileOptions() {
  const select = el('scan-file');
  const current = select.value;
  select.innerHTML = '<option value="">全部文件</option>'
    + state.files.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.path)}</option>`).join('');
  if (state.files.some((item) => item.id === current)) select.value = current;
}

// 每条规则按当前状态给出能走的动作：起草先复核，已复核才能启用，启用可停用
function ruleActionButtons(item) {
  const id = escapeHtml(item.id);
  const buttons = [];
  if (item.status === STATUS_LABEL.draft) {
    buttons.push(`<button type="button" class="link" data-rule-review="${id}">提交复核</button>`);
    buttons.push(`<button type="button" class="link" data-rule-edit="${id}">编辑</button>`);
    buttons.push(`<button type="button" class="link danger" data-rule-delete="${id}">删除</button>`);
  } else if (item.status === STATUS_LABEL.reviewed) {
    buttons.push(`<button type="button" class="link ok-link" data-rule-enable="${id}">启用</button>`);
    buttons.push(`<button type="button" class="link" data-rule-edit="${id}">编辑</button>`);
    buttons.push(`<button type="button" class="link danger" data-rule-delete="${id}">删除</button>`);
  } else if (item.status === STATUS_LABEL.enabled) {
    buttons.push(`<button type="button" class="link danger" data-rule-disable="${id}">停用</button>`);
  } else {
    buttons.push(`<button type="button" class="link ok-link" data-rule-enable="${id}">启用</button>`);
    buttons.push(`<button type="button" class="link" data-rule-edit="${id}">修订</button>`);
    buttons.push(`<button type="button" class="link danger" data-rule-delete="${id}">删除</button>`);
  }
  buttons.push(`<button type="button" class="link" data-rule-history="${id}">流转记录</button>`);
  return buttons.join('');
}

function renderRules() {
  const body = el('rule-body');
  body.innerHTML = state.rules.map((item) => `<tr>
      <td class="mono">${escapeHtml(item.code)}</td>
      <td>${escapeHtml(item.name)}</td>
      <td><span class="tag ${levelClass(item.level)}">${escapeHtml(item.level)}</span></td>
      <td>${statusBadge(item.status)}</td>
      <td class="mono">${item.version > 0 ? `v${item.version}` : '—'}</td>
      <td>${escapeHtml(item.fileType || '未选')}</td>
      <td class="mono">${escapeHtml(item.pattern)}</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td class="mono">${escapeHtml(formatTime(item.updatedAt))}</td>
      <td class="actions">${ruleActionButtons(item)}</td>
    </tr>`).join('');
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
  el('rule-form-title').textContent = rule ? `编辑规则：${rule.code}（保存不改变状态；启用中的规则需先停用）` : '新建规则';
  el('rule-code').value = rule ? rule.code : '';
  el('rule-name').value = rule ? rule.name : '';
  el('rule-level').value = rule ? rule.level : (state.levels[0] || '提示');
  el('rule-file-type').value = rule ? rule.fileType : '';
  el('rule-pattern').value = rule ? rule.pattern : '';
  el('rule-note').value = rule ? rule.note : '';
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
    operator,
  };
  const editing = state.editingRuleId;
  const previousStatus = editing ? (state.rules.find((item) => item.id === editing) || {}).status : '';
  try {
    if (editing) {
      const saved = await request(`/api/rules/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      if (previousStatus === STATUS_LABEL.reviewed || previousStatus === STATUS_LABEL.disabled) {
        notify(`规则已保存；因为改了内容，状态已从${previousStatus}退回起草，需要重新复核`, 'ok');
      } else {
        notify('规则已保存', 'ok');
      }
      void saved;
    } else {
      await request('/api/rules', { method: 'POST', body: JSON.stringify(payload) });
      notify('规则已保存为起草，写完点“提交复核”', 'ok');
    }
    closeRuleForm();
    await loadRules();
  } catch (err) {
    notify(err.message, 'error');
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

// ── 弹层：状态动作、流转记录、批次详情共用一个模态框 ──────────────────────────

function openModal(title, bodyHtml, actions) {
  el('modal-title').textContent = title;
  el('modal-body').innerHTML = bodyHtml;
  const box = el('modal-actions');
  box.innerHTML = '';
  (actions || []).forEach((action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.text;
    if (action.ghost) button.className = 'ghost';
    if (action.danger) button.classList.add('danger-btn');
    button.disabled = !!action.disabled;
    button.addEventListener('click', () => action.onClick(button));
    box.appendChild(button);
  });
  el('modal-mask').classList.remove('hidden');
}

function closeModal() {
  el('modal-mask').classList.add('hidden');
  el('modal-body').innerHTML = '';
  el('modal-actions').innerHTML = '';
}

function renderChecks(checks) {
  const rows = (checks || []).map((item) => `
    <li class="check-item ${item.passed ? 'passed' : 'failed'}">
      <span class="check-mark">${item.passed ? '✓' : '✗'}</span>
      <div>
        <div class="check-label">${escapeHtml(item.label)}</div>
        <div class="check-message">${escapeHtml(item.message)}</div>
      </div>
    </li>`).join('');
  return `<ul class="check-list" id="modal-checks">${rows}</ul>`;
}

const TRANSITION_META = {
  review: { label: '提交复核', to: STATUS_LABEL.reviewed },
  enable: { label: '启用', to: STATUS_LABEL.enabled },
  disable: { label: '停用', to: STATUS_LABEL.disabled },
};

async function openTransitionModal(ruleId, kind) {
  clearNotice();
  const operator = requireOperator();
  if (!operator) return;
  const rule = state.rules.find((item) => item.id === ruleId);
  if (!rule) return;
  const meta = TRANSITION_META[kind];

  let checksHtml = '';
  if (kind === 'enable') {
    try {
      const preview = await request(`/api/rules/${encodeURIComponent(ruleId)}/enable-checks`);
      checksHtml = renderChecks(preview.checks);
    } catch (err) {
      notify(err.message, 'error');
      return;
    }
  }

  const body = `
    <p class="modal-flow">${statusBadge(rule.status)} <span class="arrow">→</span> ${statusBadge(meta.to)}</p>
    <p class="modal-meta">操作者：<strong>${escapeHtml(operator)}</strong>　规则：${escapeHtml(rule.code)} ${escapeHtml(rule.name)}</p>
    ${checksHtml}
    <label class="modal-field">说明（可不填；没填记录里会显示“未写说明”）
      <textarea id="modal-note" rows="3" maxlength="200" placeholder="这一步为什么这么做，例如：自查已覆盖存量文件"></textarea>
    </label>`;
  openModal(`${meta.label}：${rule.code}`, body, [
    { text: `确认${meta.label}`, danger: kind === 'disable', onClick: () => submitTransition(ruleId, kind) },
    { text: '取消', ghost: true, onClick: closeModal },
  ]);
}

async function submitTransition(ruleId, kind) {
  const operator = requireOperator();
  if (!operator) return;
  const noteNode = el('modal-note');
  const note = noteNode ? noteNode.value : '';
  const meta = TRANSITION_META[kind];
  try {
    await request(`/api/rules/${encodeURIComponent(ruleId)}/${kind}`, {
      method: 'POST',
      body: JSON.stringify({ operator, note }),
    });
    closeModal();
    notify(`已${meta.label}`, 'ok');
    await loadRules();
  } catch (err) {
    // 启用把关没过：把每一项的结果刷进弹层，页面上能看清卡在哪一项
    if (err.code === 'ENABLE_CHECK_FAILED' && err.details && Array.isArray(err.details.checks)) {
      const checksNode = el('modal-checks');
      if (checksNode) checksNode.outerHTML = renderChecks(err.details.checks);
    }
    notify(err.message, 'error');
    markField(err.field);
  }
}

// 流转记录与历史版本：从状态、来向去向、时间、操作者、说明到每一版快照都摊开
function openHistoryModal(ruleId) {
  const rule = state.rules.find((item) => item.id === ruleId);
  if (!rule) return;

  const transitions = (rule.transitions || []).map((item) => `
    <li class="tl-item">
      <div class="tl-head">
        <span class="tag tl-action">${escapeHtml(item.action)}</span>
        <span class="mono">${item.from ? `${escapeHtml(item.from)} → ${escapeHtml(item.to)}` : `→ ${escapeHtml(item.to)}`}</span>
      </div>
      <div class="tl-meta mono">${escapeHtml(formatTime(item.at))}　操作者：${escapeHtml(item.by || '未知')}</div>
      <div class="tl-note ${item.note ? '' : 'no-note'}">${item.note ? escapeHtml(item.note) : '未写说明'}</div>
    </li>`).join('') || '<li class="tl-empty">还没有流转记录</li>';

  const versions = (rule.versions || []).map((version) => `
    <tr>
      <td class="mono">v${version.version}</td>
      <td class="mono">${escapeHtml(formatTime(version.enabledAt))}</td>
      <td>${escapeHtml(version.enabledBy || '未知')}</td>
      <td><span class="tag ${levelClass(version.level)}">${escapeHtml(version.level)}</span></td>
      <td>${escapeHtml(version.fileType || '未选')}</td>
      <td class="mono">${escapeHtml(version.pattern)}</td>
      <td class="note-cell">${escapeHtml(version.note)}</td>
    </tr>`).join('');

  const body = `
    <div class="history-block">
      <h4>流转记录</h4>
      <ul class="timeline">${transitions}</ul>
    </div>
    <div class="history-block">
      <h4>启用过的版本（历史命中按这里的版本号对回当时管事的内容）</h4>
      ${versions ? `<div class="table-wrap"><table class="grid mini">
        <thead><tr><th>版本</th><th>启用时间</th><th>启用者</th><th>级别</th><th>适用类型</th><th>匹配写法</th><th>说明</th></tr></thead>
        <tbody>${versions}</tbody>
      </table></div>` : '<p class="empty-tip">还没有启用过，暂时没有版本快照</p>'}
    </div>`;
  openModal(`流转记录：${rule.code} ${rule.name}`, body, [{ text: '关闭', ghost: true, onClick: closeModal }]);
}

// ── 扫描与批次历史 ────────────────────────────────────────────────────────────

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
    renderScan(result);
    notify(`扫描完成，命中 ${result.summary.total} 条，已存为批次`, 'ok');
    await loadBatches();
  } catch (err) {
    notify(err.message, 'error');
  }
}

function renderScan(result) {
  el('scan-meta').textContent = `扫描时刻 ${formatTime(result.scannedAt)}　操作者 ${result.scannedBy || ''}　参与比对的规则 ${result.rulesUsed} 条（启用共 ${result.enabledRules} 条）　范围里的文件 ${result.filesInScope} 个（清单共 ${result.filesTotal} 个）`;

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
    .map((item) => `${item.code} ${item.count} 条`)
    .join('　') || '没有规则命中';
  const fileText = result.summary.byFile
    .map((item) => `${item.path} ${item.count} 条`)
    .join('　') || '没有文件命中';
  summaryBox.innerHTML = `
    <div class="summary-line"><strong>一共命中 ${result.summary.total} 条</strong>　${escapeHtml(levelText)}</div>
    <div class="summary-line">按规则：${escapeHtml(ruleText)}</div>
    <div class="summary-line">按文件：${escapeHtml(fileText)}</div>`;
  summaryBox.classList.remove('hidden');

  const body = el('hit-body');
  body.innerHTML = result.hits.map((hit) => `<tr>
      <td class="mono">${escapeHtml(hit.code)}</td>
      <td class="mono"><span class="ver-tag">v${hit.ruleVersion}</span></td>
      <td><span class="tag ${levelClass(hit.level)}">${escapeHtml(hit.level)}</span></td>
      <td>${escapeHtml(hit.ruleName)}</td>
      <td class="mono">${escapeHtml(hit.path)}</td>
      <td class="mono">${hit.lineNo}</td>
      <td class="mono line-cell">${escapeHtml(hit.lineText)}</td>
    </tr>`).join('');
  el('hit-empty').classList.toggle('hidden', result.hits.length > 0);
}

function scopeText(scope) {
  const parts = [];
  if (scope && scope.ruleCode) parts.push(`规则 ${scope.ruleCode}`);
  if (scope && scope.filePath) parts.push(`文件 ${scope.filePath}`);
  if (scope && scope.level) parts.push(`级别 ${scope.level}`);
  return parts.length ? parts.join('；') : '全部规则与文件';
}

function renderBatches() {
  const body = el('batch-body');
  body.innerHTML = state.batches.map((batch) => `<tr>
      <td class="mono">${escapeHtml(formatTime(batch.scannedAt))}</td>
      <td>${escapeHtml(batch.scannedBy || '未知')}</td>
      <td>${escapeHtml(scopeText(batch.scope))}</td>
      <td class="mono">${batch.rulesUsed} / ${batch.enabledRules} 条</td>
      <td class="mono">${batch.filesInScope} 个</td>
      <td class="mono">${batch.total} 条</td>
      <td class="actions"><button type="button" class="link" data-batch-view="${escapeHtml(batch.id)}">查看详情</button></td>
    </tr>`).join('');
  el('batch-empty').classList.toggle('hidden', state.batches.length > 0);
}

async function openBatchModal(batchId) {
  clearNotice();
  try {
    const batch = await request(`/api/scan-batches/${encodeURIComponent(batchId)}`);
    const ruleRows = (batch.rules || []).map((item) => `
      <tr>
        <td class="mono">${escapeHtml(item.code)} <span class="ver-tag">v${item.ruleVersion}</span></td>
        <td>${escapeHtml(item.ruleName)}</td>
        <td><span class="tag ${levelClass(item.level)}">${escapeHtml(item.level)}</span></td>
        <td>${escapeHtml(item.fileType || '未选')}</td>
        <td class="mono">${escapeHtml(item.pattern)}</td>
        <td class="note-cell">${item.ruleExists ? escapeHtml(item.stateNote) : '规则已删除'}</td>
      </tr>`).join('');

    const hitRows = (batch.hits || []).map((hit) => `
      <tr>
        <td class="mono">${escapeHtml(hit.code)} <span class="ver-tag">v${hit.ruleVersion}</span></td>
        <td><span class="tag ${levelClass(hit.level)}">${escapeHtml(hit.level)}</span></td>
        <td class="note-cell ${hit.ruleExists && hit.currentStatus === STATUS_LABEL.enabled ? '' : 'state-changed'}">${hit.ruleExists ? escapeHtml(hit.stateNote) : '规则已删除'}</td>
        <td class="mono">${escapeHtml(hit.path)}</td>
        <td class="mono">${hit.lineNo}</td>
        <td class="mono line-cell">${escapeHtml(hit.lineText)}</td>
      </tr>`).join('');

    const body = `
      <p class="modal-meta mono">${escapeHtml(formatTime(batch.scannedAt))}　操作者：${escapeHtml(batch.scannedBy || '未知')}　范围：${escapeHtml(scopeText(batch.scope))}</p>
      ${batch.warning ? `<p class="scan-warning">${escapeHtml(batch.warning)}</p>` : ''}
      <div class="history-block">
        <h4>当时参与比对的规则版本（共 ${batch.rulesUsed} 条，启用共 ${batch.enabledRules} 条）</h4>
        <div class="table-wrap"><table class="grid mini">
          <thead><tr><th>编码 / 版本</th><th>名称</th><th>级别</th><th>适用类型</th><th>匹配写法</th><th>规则现状</th></tr></thead>
          <tbody>${ruleRows || '<tr><td colspan="6" class="empty-tip">这一轮没有规则参与比对</td></tr>'}</tbody>
        </table></div>
      </div>
      <div class="history-block">
        <h4>命中清单（共 ${batch.summary.total} 条）</h4>
        <div class="table-wrap"><table class="grid mini">
          <thead><tr><th>编码 / 版本</th><th>级别</th><th>规则现状</th><th>文件</th><th>行号</th><th>那一行的内容</th></tr></thead>
          <tbody>${hitRows || '<tr><td colspan="6" class="empty-tip">这一轮没有命中</td></tr>'}</tbody>
        </table></div>
      </div>`;
    openModal(`扫描批次详情`, body, [{ text: '关闭', ghost: true, onClick: closeModal }]);
  } catch (err) {
    notify(err.message, 'error');
  }
}

// 列表上的操作用事件委托统一处理，列表重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;

  if (node.dataset.ruleReview) {
    await openTransitionModal(node.dataset.ruleReview, 'review');
    return;
  }

  if (node.dataset.ruleEnable) {
    await openTransitionModal(node.dataset.ruleEnable, 'enable');
    return;
  }

  if (node.dataset.ruleDisable) {
    await openTransitionModal(node.dataset.ruleDisable, 'disable');
    return;
  }

  if (node.dataset.ruleHistory) {
    openHistoryModal(node.dataset.ruleHistory);
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
    if (!window.confirm(`确定删除规则 ${found ? found.code : ''} 吗？启用中的规则需要先停用。`)) return;
    try {
      await request(`/api/rules/${encodeURIComponent(node.dataset.ruleDelete)}`, { method: 'DELETE' });
      if (state.editingRuleId === node.dataset.ruleDelete) closeRuleForm();
      notify('规则已删除；历史扫描批次里的命中仍然保留', 'ok');
      await loadRules();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.batchView) {
    await openBatchModal(node.dataset.batchView);
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
el('batch-refresh').addEventListener('click', () => {
  clearNotice();
  loadBatches().catch((err) => notify(err.message, 'error'));
});
el('rule-filter-level').addEventListener('change', () => {
  loadRules().catch((err) => notify(err.message, 'error'));
});
el('rule-filter-status').addEventListener('change', () => {
  loadRules().catch((err) => notify(err.message, 'error'));
});
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});
el('modal-close').addEventListener('click', closeModal);
el('modal-mask').addEventListener('click', (event) => {
  if (event.target === el('modal-mask')) closeModal();
});

// 页面打开时把规则、文件与批次历史都拉一遍，扫描的范围下拉依赖规则与文件清单
restoreOperator();
loadHealth();
loadRules()
  .then(loadFiles)
  .then(loadBatches)
  .catch((err) => notify(err.message, 'error'));
