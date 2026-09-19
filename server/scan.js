const crypto = require('crypto');
const { load, save, LEVELS, STATUS_ENABLED, MAX_SCANS_KEPT } = require('./store');
const { ApiError, pickText } = require('./errors');

// 一条规则管不管这个文件：适用文件类型写成全部的管所有文件，否则只认同类型的
function ruleAppliesToFile(rule, file) {
  return rule.fileType === '全部' || rule.fileType === file.type;
}

function levelOrder(level) {
  const index = LEVELS.indexOf(level);
  return index === -1 ? LEVELS.length : index;
}

// 命中记下来的字段：规则字段按当时扫描的内容快照，另带当时管事的版本号
function hitFrom(rule, file, lineNo, lineText) {
  return {
    ruleId: rule.id,
    code: rule.code,
    ruleName: rule.name,
    level: rule.level,
    pattern: rule.pattern,
    ruleVersion: rule.version,
    fileId: file.id,
    path: file.path,
    fileType: file.type,
    lineNo,
    lineText: lineText.trim(),
  };
}

function summarizeHits(hits) {
  const byLevel = {};
  LEVELS.forEach((item) => { byLevel[item] = 0; });
  hits.forEach((hit) => { byLevel[hit.level] += 1; });

  const byRuleMap = new Map();
  hits.forEach((hit) => {
    const key = hit.code;
    if (!byRuleMap.has(key)) {
      byRuleMap.set(key, {
        code: hit.code,
        ruleName: hit.ruleName,
        level: hit.level,
        ruleVersion: hit.ruleVersion,
        count: 0,
      });
    }
    byRuleMap.get(key).count += 1;
  });

  const byFileMap = new Map();
  hits.forEach((hit) => {
    const key = hit.path;
    if (!byFileMap.has(key)) byFileMap.set(key, { path: hit.path, fileType: hit.fileType, count: 0 });
    byFileMap.get(key).count += 1;
  });

  return {
    total: hits.length,
    byLevel,
    byRule: Array.from(byRuleMap.values()).sort((a, b) => (a.code < b.code ? -1 : 1)),
    byFile: Array.from(byFileMap.values()).sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
}

// 扫一遍：只有启用态的规则逐条去比对范围内的文件，命中记到具体行上并带上规则版本；整轮结果落盘
function scan(options) {
  const input = options && typeof options === 'object' ? options : {};
  const level = pickText(input.level);
  const fileId = pickText(input.fileId);
  const ruleId = pickText(input.ruleId);
  const operator = pickText(input.operator);
  if (!operator) {
    throw new ApiError(400, 'OPERATOR_REQUIRED', '请先在页面右上角填上当前操作者，再开始扫描', 'operator');
  }

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

  const enabled = data.rules.filter((item) => item.status === STATUS_ENABLED);
  const warning = scopeRule && scopeRule.status !== STATUS_ENABLED
    ? `${scopeRule.code}（第 ${scopeRule.version} 版）当前是${scopeRule.status}状态，这一轮不参与比对`
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
          hits.push(hitFrom(rule, file, index + 1, text));
        }
      });
    });
  });

  hits.sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.lineNo - b.lineNo;
  });

  const record = {
    id: crypto.randomUUID(),
    scannedAt: new Date().toISOString(),
    by: operator,
    level,
    fileId: scopeFile ? scopeFile.id : '',
    ruleId: scopeRule ? scopeRule.id : '',
    scopeRuleCode: scopeRule ? scopeRule.code : '',
    scopeFilePath: scopeFile ? scopeFile.path : '',
    enabledRules: enabled.length,
    rulesUsed: rulesUsed.length,
    filesInScope: filesInScope.length,
    filesTotal: data.files.length,
    rulesTotal: data.rules.length,
    warning,
    hits,
    summary: summarizeHits(hits),
  };

  data.scans.unshift(record);
  if (data.scans.length > MAX_SCANS_KEPT) data.scans.length = MAX_SCANS_KEPT;
  save(data);
  return record;
}

// 历史扫描清单：只回概要，不把每轮命中都带回来；规则或文件删掉之后概要仍按快照保留
function listScans() {
  const data = load();
  const scans = data.scans.map((item) => ({
    id: item.id,
    scannedAt: item.scannedAt,
    by: item.by,
    level: item.level,
    scopeRuleCode: item.scopeRuleCode || '',
    scopeFilePath: item.scopeFilePath || '',
    enabledRules: item.enabledRules,
    rulesUsed: item.rulesUsed,
    filesInScope: item.filesInScope,
    warning: item.warning,
    total: item.summary ? item.summary.total : 0,
  }));
  return { scans, kept: MAX_SCANS_KEPT };
}

function getScan(id) {
  const data = load();
  const found = data.scans.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'SCAN_NOT_FOUND', '这轮扫描记录不存在，可能已被更早的记录挤出留存范围', '');
  return found;
}

module.exports = { scan, listScans, getScan, ruleAppliesToFile, levelOrder };
