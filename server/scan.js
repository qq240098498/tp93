const crypto = require('crypto');
const { load, save, LEVELS, STATUS, MAX_OPERATOR_LENGTH } = require('./store');
const { ApiError, pickText } = require('./errors');

// 一条规则管不管这个文件：适用文件类型写成全部的管所有文件，否则只认同类型的
function ruleAppliesToFile(rule, file) {
  return rule.fileType === '全部' || rule.fileType === file.type;
}

function levelOrder(level) {
  const index = LEVELS.indexOf(level);
  return index === -1 ? LEVELS.length : index;
}

function validateOperator(value) {
  const operator = pickText(value);
  if (!operator) throw new ApiError(400, 'OPERATOR_REQUIRED', '请先在页面右上角填上当前操作者，再扫描', 'operator');
  if (operator.length > MAX_OPERATOR_LENGTH) {
    throw new ApiError(400, 'OPERATOR_TOO_LONG', `操作者名字不能超过 ${MAX_OPERATOR_LENGTH} 个字符`, 'operator');
  }
  return operator;
}

// 扫一遍：启用的规则逐条去比对范围内的文件，命中记到具体行上。
// 参与比对的规则各字段连同版本号一起快照进批次，事后规则停用或改版，
// 历史批次里仍然看得出当时是哪一版在管事
function scan(options) {
  const input = options && typeof options === 'object' ? options : {};
  const level = pickText(input.level);
  const fileId = pickText(input.fileId);
  const ruleId = pickText(input.ruleId);
  const operator = validateOperator(input.operator);

  if (level && !LEVELS.includes(level)) {
    throw new ApiError(400, 'LEVEL_INVALID', `级别只能是 ${LEVELS.join('、')} 其中之一`, 'scanLevel');
  }

  const data = load();

  let scopeFile = null;
  if (fileId) {
    scopeFile = data.files.find((item) => item.id === fileId);
    if (!scopeFile) throw new ApiError(404, 'FILE_NOT_FOUND', '选中的文件不在清单里', 'scanFile');
  }

  let scopeRule = null;
  if (ruleId) {
    scopeRule = data.rules.find((item) => item.id === ruleId);
    if (!scopeRule) throw new ApiError(404, 'RULE_NOT_FOUND', '选中的规则不在清单里', 'scanRule');
  }

  const enabled = data.rules.filter((item) => item.status === STATUS.ENABLED);
  const warning = scopeRule && scopeRule.status !== STATUS.ENABLED
    ? `${scopeRule.code} 当前是${scopeRule.status}状态，这一轮不参与比对`
    : '';

  const rulesUsed = enabled
    .filter((item) => !scopeRule || item.id === scopeRule.id)
    .filter((item) => !level || item.level === level);

  const filesInScope = scopeFile ? [scopeFile] : data.files;

  const hits = [];
  rulesUsed.forEach((rule) => {
    filesInScope.filter((file) => ruleAppliesToFile(rule, file)).forEach((file) => {
      file.content.split('\n').forEach((text, index) => {
        if (text.includes(rule.pattern)) {
          hits.push({
            ruleId: rule.id,
            ruleVersion: rule.version,
            code: rule.code,
            ruleName: rule.name,
            level: rule.level,
            pattern: rule.pattern,
            fileType: rule.fileType,
            fileId: file.id,
            path: file.path,
            hitFileType: file.type,
            lineNo: index + 1,
            lineText: text.trim(),
          });
        }
      });
    });
  });

  hits.sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.lineNo - b.lineNo;
  });

  const byLevel = {};
  LEVELS.forEach((item) => { byLevel[item] = 0; });
  hits.forEach((hit) => { byLevel[hit.level] += 1; });

  const byRuleMap = new Map();
  hits.forEach((hit) => {
    const key = hit.code;
    if (!byRuleMap.has(key)) {
      byRuleMap.set(key, { code: hit.code, ruleName: hit.ruleName, level: hit.level, count: 0 });
    }
    byRuleMap.get(key).count += 1;
  });

  const byFileMap = new Map();
  hits.forEach((hit) => {
    const key = hit.path;
    if (!byFileMap.has(key)) byFileMap.set(key, { path: hit.path, fileType: hit.hitFileType, count: 0 });
    byFileMap.get(key).count += 1;
  });

  // 这一轮实际管事的规则版本：快照存进批次，历史回看不靠规则现状反推
  const ruleSnapshots = rulesUsed.map((rule) => ({
    ruleId: rule.id,
    code: rule.code,
    ruleName: rule.name,
    level: rule.level,
    fileType: rule.fileType,
    pattern: rule.pattern,
    ruleVersion: rule.version,
  }));

  const scannedAt = new Date().toISOString();
  const batch = {
    id: crypto.randomUUID(),
    scannedAt,
    scannedBy: operator,
    scope: {
      level: level || '',
      fileId: scopeFile ? scopeFile.id : '',
      filePath: scopeFile ? scopeFile.path : '',
      ruleId: scopeRule ? scopeRule.id : '',
      ruleCode: scopeRule ? scopeRule.code : '',
    },
    enabledRules: enabled.length,
    rulesUsed: rulesUsed.length,
    filesInScope: filesInScope.length,
    filesTotal: data.files.length,
    rulesTotal: data.rules.length,
    warning,
    rules: ruleSnapshots,
    hits,
    summary: {
      total: hits.length,
      byLevel,
      byRule: Array.from(byRuleMap.values()).sort((a, b) => (a.code < b.code ? -1 : 1)),
      byFile: Array.from(byFileMap.values()).sort((a, b) => (a.path < b.path ? -1 : 1)),
    },
  };

  data.scanBatches.push(batch);
  save(data);

  return batch;
}

// 批次列表：新扫的在前，只给概要不给命中明细
function listBatches() {
  const data = load();
  return {
    batches: data.scanBatches
      .map((batch) => ({
        id: batch.id,
        scannedAt: batch.scannedAt,
        scannedBy: batch.scannedBy,
        scope: batch.scope,
        enabledRules: batch.enabledRules,
        rulesUsed: batch.rulesUsed,
        filesInScope: batch.filesInScope,
        filesTotal: batch.filesTotal,
        rulesTotal: batch.rulesTotal,
        warning: batch.warning,
        total: batch.summary ? batch.summary.total : 0,
      }))
      .sort((a, b) => (a.scannedAt < b.scannedAt ? 1 : -1)),
  };
}

// 批次详情：每条命中对照规则现状标出后来有没有停用、改版或被删
function getBatch(id) {
  const data = load();
  const batch = data.scanBatches.find((item) => item.id === id);
  if (!batch) throw new ApiError(404, 'BATCH_NOT_FOUND', '这次扫描的批次不存在，记录可能已被清理', '');

  const rulesById = new Map(data.rules.map((rule) => [rule.id, rule]));

  const annotate = (entry) => {
    const current = rulesById.get(entry.ruleId);
    if (!current) {
      return { ...entry, ruleExists: false, currentStatus: '', currentVersion: 0, changed: false, stateNote: '规则已删除' };
    }
    const changed = current.version !== entry.ruleVersion;
    let stateNote = current.status;
    if (changed) stateNote += `（已从第 ${entry.ruleVersion} 版改到第 ${current.version} 版）`;
    return {
      ...entry,
      ruleExists: true,
      currentStatus: current.status,
      currentVersion: current.version,
      changed,
      stateNote,
    };
  };

  return {
    ...batch,
    rules: (batch.rules || []).map(annotate),
    hits: (batch.hits || []).map(annotate),
  };
}

module.exports = { scan, listBatches, getBatch, ruleAppliesToFile, levelOrder };
