const crypto = require('crypto');
const {
  load,
  save,
  LEVELS,
  STATUSES,
  STATUS_DRAFT,
  STATUS_REVIEW,
  STATUS_ENABLED,
  STATUS_DISABLED,
  FILE_TYPES,
  MAX_CODE_LENGTH,
  MAX_RULE_NAME_LENGTH,
  MAX_PATTERN_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_OPERATOR_LENGTH,
  MAX_REASON_LENGTH,
} = require('./store');
const { ApiError, pickText } = require('./errors');

// 规则编码固定成大写字母加分段的数字，方便在命中清单里引用
const CODE_PATTERN = /^[A-Z]{2,6}-\d{2,4}$/;

// 允许的状态动作，以及每个动作要求的起点与终点
const TRANSITIONS = {
  提交复核: { from: [STATUS_DRAFT], to: STATUS_REVIEW },
  退回起草: { from: [STATUS_REVIEW], to: STATUS_DRAFT },
  启用: { from: [STATUS_REVIEW, STATUS_DISABLED], to: STATUS_ENABLED },
  停用: { from: [STATUS_ENABLED], to: STATUS_DISABLED },
};

// 每种状态下页面上可以点的流转动作
const ACTIONS_BY_STATUS = {
  [STATUS_DRAFT]: ['提交复核'],
  [STATUS_REVIEW]: ['启用', '退回起草'],
  [STATUS_ENABLED]: ['停用'],
  [STATUS_DISABLED]: ['启用'],
};

// 启用中不能改正文，草稿与停用可以改；只有没启用过的草稿/待复核可以删
const EDITABLE_STATUSES = [STATUS_DRAFT, STATUS_DISABLED];
const DELETABLE_STATUSES = [STATUS_DRAFT, STATUS_REVIEW];

function validateOperator(value) {
  const operator = pickText(value);
  if (!operator) throw new ApiError(400, 'OPERATOR_REQUIRED', '请先在页面右上角填上当前操作者，再做这个动作', 'operator');
  if (operator.length > MAX_OPERATOR_LENGTH) {
    throw new ApiError(400, 'OPERATOR_TOO_LONG', `操作者名称不能超过 ${MAX_OPERATOR_LENGTH} 个字符`, 'operator');
  }
  return operator;
}

function validateReason(value) {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length > MAX_REASON_LENGTH) {
    throw new ApiError(400, 'REASON_TOO_LONG', `说明不能超过 ${MAX_REASON_LENGTH} 个字符`, 'reason');
  }
  return reason;
}

function validateAction(value) {
  const action = pickText(value);
  if (!TRANSITIONS[action]) {
    throw new ApiError(400, 'ACTION_INVALID', `动作只能是 ${Object.keys(TRANSITIONS).join('、')} 其中之一`, 'action');
  }
  return action;
}

function validateCode(value, data, selfId) {
  const code = pickText(value);
  if (!code) throw new ApiError(400, 'CODE_REQUIRED', '请填写规则编码', 'code');
  if (code.length > MAX_CODE_LENGTH) {
    throw new ApiError(400, 'CODE_TOO_LONG', `规则编码不能超过 ${MAX_CODE_LENGTH} 个字符`, 'code');
  }
  if (!CODE_PATTERN.test(code)) {
    throw new ApiError(400, 'CODE_INVALID', '规则编码要写成大写字母加短横线加数字，例如 CODE-001', 'code');
  }
  const hit = data.rules.find((item) => item.id !== selfId && item.code.toLowerCase() === code.toLowerCase());
  if (hit) throw new ApiError(409, 'CODE_DUPLICATED', `编码 ${hit.code} 已经被 ${hit.name} 用了`, 'code');
  return code;
}

function validateName(value) {
  const name = pickText(value);
  if (!name) throw new ApiError(400, 'NAME_REQUIRED', '请填写规则名称', 'name');
  if (name.length > MAX_RULE_NAME_LENGTH) {
    throw new ApiError(400, 'NAME_TOO_LONG', `规则名称不能超过 ${MAX_RULE_NAME_LENGTH} 个字符`, 'name');
  }
  return name;
}

// 起草阶段允许先空着匹配写法，启用前的把关会拦住；长度任何时候都管
function validatePattern(value) {
  const pattern = typeof value === 'string' ? value : '';
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new ApiError(400, 'PATTERN_TOO_LONG', `匹配写法不能超过 ${MAX_PATTERN_LENGTH} 个字符`, 'pattern');
  }
  return pattern;
}

function validateLevel(value) {
  const level = pickText(value);
  if (!level) return LEVELS[0];
  if (!LEVELS.includes(level)) {
    throw new ApiError(400, 'LEVEL_INVALID', `级别只能是 ${LEVELS.join('、')} 其中之一`, 'level');
  }
  return level;
}

function validateFileType(value) {
  const fileType = pickText(value);
  if (!fileType) return FILE_TYPES[0];
  if (!FILE_TYPES.includes(fileType)) {
    throw new ApiError(400, 'FILE_TYPE_INVALID', `适用文件类型只能是 ${FILE_TYPES.join('、')} 其中之一`, 'fileType');
  }
  return fileType;
}

function validateNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ApiError(400, 'NOTE_INVALID', '说明需要是文本', 'note');
  if (value.length > MAX_NOTE_LENGTH) {
    throw new ApiError(400, 'NOTE_TOO_LONG', `说明不能超过 ${MAX_NOTE_LENGTH} 个字符`, 'note');
  }
  return value.trim();
}

function sortRules(list) {
  return list.slice().sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

// 两个适用范围有没有重叠：任意一边写成全部，或者两边类型相同
function scopeOverlaps(typeA, typeB) {
  return typeA === '全部' || typeB === '全部' || typeA === typeB;
}

// 启用前把该把关的地方逐项过一遍，所有不过的项一次性带回去
function enableGuards(rule, data) {
  const checks = [];
  if (!rule.pattern || !rule.pattern.trim()) {
    checks.push({ code: 'PATTERN_EMPTY', message: '匹配写法还没写，先补全再启用', field: 'pattern' });
  } else if (rule.pattern.length > MAX_PATTERN_LENGTH) {
    checks.push({ code: 'PATTERN_TOO_LONG', message: `匹配写法不能超过 ${MAX_PATTERN_LENGTH} 个字符`, field: 'pattern' });
  }
  if (!rule.fileType || !FILE_TYPES.includes(rule.fileType)) {
    checks.push({ code: 'FILE_TYPE_EMPTY', message: '适用文件类型还没选，先选定再启用', field: 'fileType' });
  }
  const codeHit = data.rules.find((item) => item.id !== rule.id && item.code.toLowerCase() === rule.code.toLowerCase());
  if (codeHit) {
    checks.push({ code: 'CODE_DUPLICATED', message: `编码与清单里已有的规则撞上了：${codeHit.code}（${codeHit.name}）已经在用`, field: 'code' });
  }
  if (rule.pattern && rule.pattern.trim()) {
    const sameKind = data.rules.find((item) => item.id !== rule.id
      && item.status === STATUS_ENABLED
      && item.pattern === rule.pattern
      && scopeOverlaps(item.fileType, rule.fileType));
    if (sameKind) {
      checks.push({
        code: 'PATTERN_ALREADY_ENABLED',
        message: `同类写法已经有另一条启用规则在管：${sameKind.code}（${sameKind.name}）适用 ${sameKind.fileType}，先停掉或改一条`,
        field: 'pattern',
      });
    }
  }
  return checks;
}

// 给页面对象补上当前状态允许点的动作，不改动落库的结构
function presentRule(rule) {
  return {
    ...rule,
    editable: EDITABLE_STATUSES.includes(rule.status),
    deletable: DELETABLE_STATUSES.includes(rule.status),
    allowedActions: ACTIONS_BY_STATUS[rule.status] || [],
  };
}

function appendHistory(data, record) {
  data.ruleHistory.push({ id: crypto.randomUUID(), ...record });
}

function snapshotOf(rule) {
  return {
    code: rule.code,
    name: rule.name,
    level: rule.level,
    fileType: rule.fileType,
    pattern: rule.pattern,
    note: rule.note,
  };
}

// 规则清单：按级别、状态、适用文件类型筛选，再按编码、名称或匹配写法搜索
function listRules(options) {
  const input = options && typeof options === 'object' ? options : {};
  const level = pickText(input.level);
  const status = pickText(input.status);
  const fileType = pickText(input.fileType);
  const keyword = pickText(input.keyword).toLowerCase();
  const data = load();

  let list = data.rules;
  if (level) list = list.filter((item) => item.level === level);
  if (status) list = list.filter((item) => item.status === status);
  if (fileType) list = list.filter((item) => item.fileType === fileType || item.fileType === '全部');
  if (keyword) {
    list = list.filter((item) => item.code.toLowerCase().includes(keyword)
      || item.name.toLowerCase().includes(keyword)
      || item.pattern.toLowerCase().includes(keyword));
  }

  const usedFileTypes = Array.from(new Set(data.rules.map((item) => item.fileType)));
  return {
    rules: sortRules(list).map(presentRule),
    levels: LEVELS.slice(),
    statuses: STATUSES.slice(),
    fileTypes: FILE_TYPES.slice(),
    usedFileTypes,
  };
}

function findRule(data, id) {
  const found = data.rules.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'RULE_NOT_FOUND', '这条规则不存在或已被删除', '');
  return found;
}

function getRule(id) {
  const data = load();
  return presentRule(findRule(data, id));
}

// 一条规则的完整流转记录：状态变化与改版都在里面，按时间正序返回
function getRuleHistory(id) {
  const data = load();
  const rule = findRule(data, id);
  const history = data.ruleHistory
    .filter((item) => item.ruleId === id)
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : (a.id < b.id ? -1 : 1)));
  return { rule: presentRule(rule), history };
}

// 新规则一律先进草稿，把内容写完、自己复核过、启用把关通过之后才参与扫描
function createRule(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const operator = validateOperator(input.operator);
  const data = load();
  const now = new Date().toISOString();
  const created = {
    id: crypto.randomUUID(),
    code: validateCode(input.code, data, ''),
    name: validateName(input.name),
    level: validateLevel(input.level),
    status: STATUS_DRAFT,
    fileType: validateFileType(input.fileType),
    pattern: validatePattern(input.pattern),
    note: validateNote(input.note),
    version: 1,
    enabledVersion: null,
    createdBy: operator,
    updatedBy: operator,
    createdAt: now,
    updatedAt: now,
  };
  data.rules.push(created);
  appendHistory(data, {
    ruleId: created.id,
    kind: 'transition',
    action: '登记',
    fromStatus: '',
    toStatus: STATUS_DRAFT,
    version: 1,
    snapshot: snapshotOf(created),
    at: now,
    by: operator,
    reason: validateReason(input.reason),
  });
  save(data);
  return presentRule(created);
}

function updateRule(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const operator = validateOperator(input.operator);
  const changeReason = validateReason(input.reason);
  const data = load();
  const found = findRule(data, id);

  if (!EDITABLE_STATUSES.includes(found.status)) {
    throw new ApiError(409, 'RULE_NOT_EDITABLE', '启用或待复核中的规则不能直接修改：启用中的先停用再改版，待复核的先退回起草', '');
  }

  const before = snapshotOf(found);
  found.code = input.code === undefined ? found.code : validateCode(input.code, data, found.id);
  found.name = input.name === undefined ? found.name : validateName(input.name);
  found.level = input.level === undefined ? found.level : validateLevel(input.level);
  found.fileType = input.fileType === undefined ? found.fileType : validateFileType(input.fileType);
  found.pattern = input.pattern === undefined ? found.pattern : validatePattern(input.pattern);
  found.note = input.note === undefined ? found.note : validateNote(input.note);

  const now = new Date().toISOString();
  let revised = false;
  // 停用中的规则一旦改正文就升一版，重新启用后历史命中能和这一版区分开
  if (found.status === STATUS_DISABLED) {
    const after = snapshotOf(found);
    revised = Object.keys(before).some((key) => before[key] !== after[key]);
    if (revised) found.version += 1;
  }
  found.updatedAt = now;
  found.updatedBy = operator;

  if (revised) {
    appendHistory(data, {
      ruleId: found.id,
      kind: 'revision',
      action: '改版',
      fromStatus: STATUS_DISABLED,
      toStatus: STATUS_DISABLED,
      version: found.version,
      snapshot: snapshotOf(found),
      at: now,
      by: operator,
      reason: changeReason,
    });
  }
  save(data);
  return presentRule(found);
}

// 状态流转：每一步都核对当前状态，启用要过把关，每一次变化都落一条记录
function transitionRule(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const operator = validateOperator(input.operator);
  const reason = validateReason(input.reason);
  const action = validateAction(input.action);
  const data = load();
  const rule = findRule(data, id);

  const flow = TRANSITIONS[action];
  if (!flow.from.includes(rule.status)) {
    throw new ApiError(
      409,
      'STATUS_FLOW_INVALID',
      `规则现在是「${rule.status}」，不能直接${action}；可以做的动作：${(ACTIONS_BY_STATUS[rule.status] || []).join('、') || '无'}`,
      'action',
    );
  }

  if (action === '启用') {
    const failed = enableGuards(rule, data);
    if (failed.length > 0) {
      throw new ApiError(422, 'ENABLE_GUARDS_FAILED', '启用前的把关没有通过，按下面列的项改完再启用', '', failed);
    }
  }

  const fromStatus = rule.status;
  const toStatus = flow.to;
  const now = new Date().toISOString();
  rule.status = toStatus;
  rule.updatedAt = now;
  rule.updatedBy = operator;
  if (toStatus === STATUS_ENABLED) rule.enabledVersion = rule.version;

  appendHistory(data, {
    ruleId: rule.id,
    kind: 'transition',
    action,
    fromStatus,
    toStatus,
    version: rule.version,
    snapshot: snapshotOf(rule),
    at: now,
    by: operator,
    reason,
  });
  save(data);
  return presentRule(rule);
}

function deleteRule(id) {
  const data = load();
  const index = data.rules.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'RULE_NOT_FOUND', '这条规则不存在或已被删除', '');
  const removed = data.rules[index];
  if (!DELETABLE_STATUSES.includes(removed.status)) {
    throw new ApiError(409, 'RULE_NOT_DELETABLE', `${removed.status}中的规则不能删除：停用后历史命中还要留着查，启用中的请先停用`, '');
  }
  data.rules.splice(index, 1);
  data.ruleHistory = data.ruleHistory.filter((item) => item.ruleId !== id);
  save(data);
  return { id: removed.id, code: removed.code, name: removed.name };
}

module.exports = {
  listRules,
  getRule,
  getRuleHistory,
  createRule,
  updateRule,
  transitionRule,
  deleteRule,
  enableGuards,
  TRANSITIONS,
  ACTIONS_BY_STATUS,
};
