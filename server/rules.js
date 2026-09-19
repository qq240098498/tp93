const crypto = require('crypto');
const {
  load, save,
  LEVELS, STATUSES, STATUS, FILE_TYPES, RULE_FILE_TYPES,
  MAX_CODE_LENGTH, MAX_RULE_NAME_LENGTH, MAX_PATTERN_LENGTH, MAX_NOTE_LENGTH, MAX_OPERATOR_LENGTH,
  snapshotOf,
} = require('./store');
const { ApiError, pickText } = require('./errors');

// 规则编码固定成大写字母加分段的数字，方便在命中清单里引用
const CODE_PATTERN = /^[A-Z]{2,6}-\d{2,4}$/;

// 状态流转里允许的动作，以及每个动作的来向与去向
const TRANSITIONS = {
  review: { action: '提交复核', from: [STATUS.DRAFT], to: STATUS.REVIEWED },
  enable: { action: '启用', from: [STATUS.REVIEWED, STATUS.DISABLED], to: STATUS.ENABLED },
  disable: { action: '停用', from: [STATUS.ENABLED], to: STATUS.DISABLED },
};

// 改了哪些字段算“内容有变化”，变化后已复核/停用的规则要退回起草
const CONTENT_FIELDS = ['code', 'name', 'level', 'fileType', 'pattern', 'note'];
const CONTENT_FIELD_LABELS = {
  code: '规则编码',
  name: '规则名称',
  level: '级别',
  fileType: '适用文件类型',
  pattern: '匹配写法',
  note: '说明',
};

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

function validatePattern(value) {
  const pattern = typeof value === 'string' ? value : '';
  if (!pattern.trim()) throw new ApiError(400, 'PATTERN_REQUIRED', '请填写要匹配的写法', 'pattern');
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

// 适用文件类型允许为空串：起草时可以先不选，但启用把关会拦住
function validateFileType(value) {
  if (value === undefined || value === null) return '';
  const fileType = pickText(value);
  if (!fileType) return '';
  if (!FILE_TYPES.includes(fileType)) {
    throw new ApiError(400, 'FILE_TYPE_INVALID', `适用文件类型只能是 ${FILE_TYPES.join('、')} 其中之一，或先不选`, 'fileType');
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

// 状态变更说明可以为空（页面上会显示“未写说明”），但填了就得有长度限制
function validateTransitionNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ApiError(400, 'TRANSITION_NOTE_INVALID', '说明需要是文本', 'note');
  if (value.length > MAX_NOTE_LENGTH) {
    throw new ApiError(400, 'TRANSITION_NOTE_TOO_LONG', `说明不能超过 ${MAX_NOTE_LENGTH} 个字符`, 'note');
  }
  return value.trim();
}

// 每次状态流转都要知道是谁做的：名字取页面右上角的当前操作者
function validateOperator(value) {
  const operator = pickText(value);
  if (!operator) throw new ApiError(400, 'OPERATOR_REQUIRED', '请先在页面右上角填上当前操作者，再做这个动作', 'operator');
  if (operator.length > MAX_OPERATOR_LENGTH) {
    throw new ApiError(400, 'OPERATOR_TOO_LONG', `操作者名字不能超过 ${MAX_OPERATOR_LENGTH} 个字符`, 'operator');
  }
  return operator;
}

function appendTransition(rule, entry) {
  const record = {
    id: crypto.randomUUID(),
    action: entry.action,
    from: entry.from,
    to: entry.to,
    at: new Date().toISOString(),
    by: entry.by,
    note: entry.note || '',
  };
  rule.transitions.push(record);
  rule.updatedAt = record.at;
  return record;
}

function sortRules(list) {
  return list.slice().sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
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

  const usedFileTypes = Array.from(new Set(data.rules.map((item) => item.fileType).filter(Boolean)));
  return {
    rules: sortRules(list),
    levels: LEVELS.slice(),
    statuses: STATUSES.slice(),
    fileTypes: FILE_TYPES.slice(),
    ruleFileTypes: RULE_FILE_TYPES.filter(Boolean),
    usedFileTypes,
  };
}

function findRule(data, id) {
  const found = data.rules.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'RULE_NOT_FOUND', '这条规则不存在或已被删除', '');
  return found;
}

function getRule(id) {
  return findRule(load(), id);
}

// 新建出来的规则一律是起草，写完先自己复核，不允许直接落成启用
function createRule(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const now = new Date().toISOString();
  const created = {
    id: crypto.randomUUID(),
    code: validateCode(input.code, data, ''),
    name: validateName(input.name),
    level: validateLevel(input.level),
    status: STATUS.DRAFT,
    fileType: validateFileType(input.fileType),
    pattern: validatePattern(input.pattern),
    note: validateNote(input.note),
    version: 0,
    versions: [],
    transitions: [],
    createdAt: now,
    updatedAt: now,
  };
  appendTransition(created, { action: '新建', from: '', to: STATUS.DRAFT, by: validateOperator(input.operator), note: validateTransitionNote(input.transitionNote) });
  data.rules.push(created);
  save(data);
  return created;
}

// 启用中的规则不能直接改：要先停用；已复核或停用状态下改内容，自动退回起草重走
function updateRule(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const found = findRule(data, id);

  if (found.status === STATUS.ENABLED) {
    throw new ApiError(409, 'RULE_ENABLED_LOCKED', '启用中的规则不能直接修改，先停用再改，改完重新复核后再启用', 'status');
  }

  const before = CONTENT_FIELDS.map((field) => found[field]);
  found.code = input.code === undefined ? found.code : validateCode(input.code, data, found.id);
  found.name = input.name === undefined ? found.name : validateName(input.name);
  found.level = input.level === undefined ? found.level : validateLevel(input.level);
  found.fileType = input.fileType === undefined ? found.fileType : validateFileType(input.fileType);
  found.pattern = input.pattern === undefined ? found.pattern : validatePattern(input.pattern);
  found.note = input.note === undefined ? found.note : validateNote(input.note);

  const changedFields = CONTENT_FIELDS.filter((field, index) => found[field] !== before[index]);
  found.updatedAt = new Date().toISOString();

  if (changedFields.length > 0 && (found.status === STATUS.REVIEWED || found.status === STATUS.DISABLED)) {
    const labels = changedFields.map((field) => CONTENT_FIELD_LABELS[field]).join('、');
    const operator = validateOperator(input.operator);
    const from = found.status;
    found.status = STATUS.DRAFT;
    appendTransition(found, {
      action: '退回起草',
      from,
      to: STATUS.DRAFT,
      by: operator,
      note: `修改了${labels}，需要重新复核`,
    });
  }

  save(data);
  return found;
}

// 启用前的四项把关，逐项给出过没过和说明；任何一项没过都不允许启用
function runEnableChecks(rule, data) {
  const checks = [];

  const patternOk = typeof rule.pattern === 'string' && rule.pattern.trim().length > 0
    && rule.pattern.length <= MAX_PATTERN_LENGTH;
  checks.push({
    key: 'pattern',
    label: '匹配写法',
    passed: patternOk,
    message: patternOk ? '已填写匹配写法' : '匹配写法还没写，先补上再启用',
  });

  const fileTypeOk = FILE_TYPES.includes(rule.fileType);
  checks.push({
    key: 'fileType',
    label: '适用文件类型',
    passed: fileTypeOk,
    message: fileTypeOk ? `适用文件类型已选为 ${rule.fileType}` : '适用文件类型还没选，先选定再启用',
  });

  const codeHit = data.rules.find((item) => item.id !== rule.id && item.code.toLowerCase() === rule.code.toLowerCase());
  checks.push({
    key: 'code',
    label: '规则编码',
    passed: !codeHit,
    message: codeHit ? `编码 ${codeHit.code} 与清单里已有的 ${codeHit.name} 撞上了` : `编码 ${rule.code} 在清单里没有重复`,
  });

  // 同类写法：匹配写法一字不差、适用的文件类型又有交集，且另一条正启用着
  const overlap = data.rules.find((item) => item.id !== rule.id
    && item.status === STATUS.ENABLED
    && item.pattern === rule.pattern
    && (item.fileType === '全部' || rule.fileType === '全部' || item.fileType === rule.fileType));
  checks.push({
    key: 'duplicate',
    label: '同类写法',
    passed: !overlap,
    message: overlap
      ? `同样的匹配写法已经有启用规则 ${overlap.code} ${overlap.name} 在管（适用类型有交集），先停用对方或改掉写法`
      : '没有另一条启用中的规则在管同样的写法',
  });

  return checks;
}

// 状态流转的统一入口：提交复核、启用、停用都走这里，每次变化都落一条记录
function transitionRule(id, kind, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const spec = TRANSITIONS[kind];
  if (!spec) throw new ApiError(400, 'TRANSITION_INVALID', '不认识这个状态动作', '');

  const data = load();
  const rule = findRule(data, id);
  const operator = validateOperator(input.operator);
  const note = validateTransitionNote(input.note);

  if (!spec.from.includes(rule.status)) {
    throw new ApiError(409, 'TRANSITION_NOT_ALLOWED', `${spec.action}只能从${spec.from.join('、')}状态操作，这条规则当前是${rule.status}`, 'status');
  }

  if (kind === 'enable') {
    const checks = runEnableChecks(rule, data);
    const failed = checks.filter((item) => !item.passed);
    if (failed.length > 0) {
      throw new ApiError(
        409,
        'ENABLE_CHECK_FAILED',
        `启用前的把关还有 ${failed.length} 项没过：${failed.map((item) => item.message).join('；')}`,
        '',
        { checks },
      );
    }
    rule.version += 1;
    rule.versions.push(snapshotOf(rule, rule.version, new Date().toISOString(), operator));
  }

  const from = rule.status;
  rule.status = spec.to;
  appendTransition(rule, { action: spec.action, from, to: spec.to, by: operator, note });
  save(data);
  return rule;
}

// 只跑把关不改状态，给页面在点启用前先看卡在哪
function previewEnable(id) {
  const data = load();
  const rule = findRule(data, id);
  const checks = runEnableChecks(rule, data);
  return { id: rule.id, code: rule.code, status: rule.status, checks };
}

function deleteRule(id) {
  const data = load();
  const index = data.rules.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'RULE_NOT_FOUND', '这条规则不存在或已被删除', '');
  if (data.rules[index].status === STATUS.ENABLED) {
    throw new ApiError(409, 'RULE_ENABLED_LOCKED', '启用中的规则不能删除，先停用再删；停用后历史扫描里的命中仍然保留', 'status');
  }
  const [removed] = data.rules.splice(index, 1);
  save(data);
  return { id: removed.id, code: removed.code, name: removed.name };
}

module.exports = {
  listRules,
  getRule,
  createRule,
  updateRule,
  deleteRule,
  transitionRule,
  previewEnable,
  runEnableChecks,
  TRANSITIONS,
};
