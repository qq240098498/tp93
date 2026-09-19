const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const TEMP_FILE = path.join(DATA_DIR, 'db.json.tmp');

const LEVELS = ['提示', '警告', '错误'];
// 规则的一生：起草 → 待复核 → 启用 → 停用（停用之后还可以改版再重新启用）
const STATUSES = ['草稿', '待复核', '启用', '停用'];
const STATUS_DRAFT = '草稿';
const STATUS_REVIEW = '待复核';
const STATUS_ENABLED = '启用';
const STATUS_DISABLED = '停用';
const FILE_TYPES = ['全部', 'js', 'sh', 'md', 'yml'];
const MAX_CODE_LENGTH = 20;
const MAX_RULE_NAME_LENGTH = 40;
const MAX_PATTERN_LENGTH = 60;
const MAX_NOTE_LENGTH = 200;
const MAX_PATH_LENGTH = 120;
const MAX_CONTENT_LENGTH = 4000;
const MAX_OPERATOR_LENGTH = 40;
const MAX_REASON_LENGTH = 200;
const MAX_SCANS_KEPT = 200;

// 检查规则的初始数据。十二条规则里启用的算第 1 版，停用的停在第 1 版停用状态，
// 另有一条从未启用过的草稿规则（CODE-013），用来观察起草到启用这条链
function seedRules() {
  const at = '2026-09-02T02:00:00.000Z';
  const seed = (id, code, name, level, status, fileType, pattern, note) => ({
    id,
    code,
    name,
    level,
    status,
    fileType,
    pattern,
    note,
    version: 1,
    enabledVersion: status === STATUS_ENABLED ? 1 : null,
    createdBy: '初始清单',
    updatedBy: '初始清单',
    createdAt: at,
    updatedAt: at,
  });
  return [
    seed('rule-1001', 'CODE-001', '禁止提交调试输出', '警告', STATUS_ENABLED, 'js', 'console.log', '上线前要换成统一日志'),
    seed('rule-1002', 'CODE-002', '变量声明统一用 let 或 const', '错误', STATUS_ENABLED, 'js', 'var ', '老代码里还有不少'),
    seed('rule-1003', 'CODE-003', '待办事项需要收口', '提示', STATUS_ENABLED, '全部', 'TODO', '带人名与期限的可以留'),
    seed('rule-1004', 'CODE-004', '禁止动态执行代码', '错误', STATUS_ENABLED, '全部', 'eval(', ''),
    seed('rule-1005', 'CODE-005', '禁止把口令写进代码', '错误', STATUS_ENABLED, '全部', 'password =', '口令一律走统一配置'),
    seed('rule-1006', 'CODE-006', '空捕获块要写清原因', '警告', STATUS_ENABLED, 'js', 'catch (e) {}', ''),
    seed('rule-1007', 'CODE-007', '调试开关上线前要关掉', '警告', STATUS_DISABLED, 'js', 'DEBUG = true', '等联调结束再打开'),
    seed('rule-1008', 'CODE-008', '数据库地址不许写死在代码里', '错误', STATUS_ENABLED, '全部', 'postgres://', ''),
    seed('rule-1009', 'CODE-009', '取配置项要走统一封装', '提示', STATUS_ENABLED, 'js', 'process.env[', '直接按名字取容易拼错'),
    seed('rule-1010', 'CODE-010', '遗留注释要清理', '提示', STATUS_DISABLED, '全部', 'FIXME', ''),
    seed('rule-1011', 'CODE-011', '脚本里禁止直接用强制删除', '警告', STATUS_ENABLED, 'sh', 'rm -rf', '脚本里改用受控的清理命令'),
    seed('rule-1012', 'CODE-012', '文档里的临时占位要删掉', '提示', STATUS_ENABLED, 'md', '待补', ''),
    seed('rule-1013', 'CODE-013', '新增检查写法先登记在这里', '提示', STATUS_DRAFT, '全部', '', '还没写完，先不起用'),
  ];
}

// 给初始规则把账补上：什么时候、由谁、从什么状态到什么状态
function seedRuleHistory() {
  const at = '2026-09-02T02:00:00.000Z';
  const records = [];
  seedRules().forEach((rule, index) => {
    records.push({
      id: `rh-seed-${index + 1}`,
      ruleId: rule.id,
      kind: 'transition',
      action: '登记',
      fromStatus: '',
      toStatus: rule.status === STATUS_DRAFT ? STATUS_DRAFT : STATUS_ENABLED,
      version: 1,
      at,
      by: '初始清单',
      reason: '随初始清单导入',
    });
    if (rule.status === STATUS_DISABLED) {
      records.push({
        id: `rh-seed-${index + 1}-off`,
        ruleId: rule.id,
        kind: 'transition',
        action: '停用',
        fromStatus: STATUS_ENABLED,
        toStatus: STATUS_DISABLED,
        version: 1,
        at,
        by: '初始清单',
        reason: '初始清单里即为停用',
      });
    }
  });
  return records;
}

// 纳入检查的文件。里面有干净的、有踩了好几处的，也有踩到停用规则里那个写法的
function seedFiles() {
  const at = '2026-09-02T03:00:00.000Z';
  return [
    {
      id: 'file-2001',
      path: 'src/server/api.js',
      type: 'js',
      content: [
        'const express = require("express");',
        'const router = express.Router();',
        '',
        'router.get("/users", (req, res) => {',
        '  console.log("查询用户列表");',
        '  var limit = Number(req.query.limit || 20);',
        '  // TODO 分页参数还要补校验',
        '  const parsed = eval("(" + req.query.filter + ")");',
        '  res.json({ limit, parsed });',
        '});',
        '',
        'module.exports = router;',
      ].join('\n'),
      note: '用户相关接口',
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'file-2002',
      path: 'src/server/store.js',
      type: 'js',
      content: [
        'const fs = require("fs");',
        '',
        'function dataFile() {',
        '  const dir = process.env["DATA_DIR"] || "./data";',
        '  console.log("数据目录", dir);',
        '  return dir + "/db.json";',
        '}',
        '',
        'function load() {',
        '  return JSON.parse(fs.readFileSync(dataFile(), "utf8"));',
        '}',
        '',
        'module.exports = { load };',
      ].join('\n'),
      note: '',
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'file-2003',
      path: 'src/server/user.js',
      type: 'js',
      content: [
        'const db = require("./db");',
        '',
        'const conn = "postgres://app:app@127.0.0.1:5432/member";',
        'const password = "app-2026";',
        '',
        'function findUser(id) {',
        '  try {',
        '    return db.query("select * from users where id = $1", [id]);',
        '  } catch (e) {}',
        '}',
        '',
        'module.exports = { findUser, conn, password };',
      ].join('\n'),
      note: '账号查询',
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'file-2004',
      path: 'src/server/report.js',
      type: 'js',
      content: [
        'function summarize(rows) {',
        '  var total = 0;',
        '  rows.forEach((row) => {',
        '    total += row.amount;',
        '  });',
        '  // TODO 还要区分已退款的部分',
        '  return { total, count: rows.length };',
        '}',
        '',
        'module.exports = { summarize };',
      ].join('\n'),
      note: '',
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'file-2005',
      path: 'src/web/app.js',
      type: 'js',
      content: [
        'const state = { list: [] };',
        '',
        'async function load() {',
        '  console.log("开始加载");',
        '  const res = await fetch("/api/users");',
        '  state.list = await res.json();',
        '  render();',
        '}',
        '',
        'function render() {',
        '  var box = document.getElementById("list");',
        '  box.textContent = state.list.length + " 条";',
        '}',
      ].join('\n'),
      note: '页面入口',
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'file-2006',
      path: 'src/web/format.js',
      type: 'js',
      content: [
        'const PAD = (num) => String(num).padStart(2, "0");',
        '',
        'function formatTime(value) {',
        '  const date = new Date(value);',
        '  return date.getFullYear() + "-" + PAD(date.getMonth() + 1) + "-" + PAD(date.getDate());',
        '}',
        '',
        'function formatAmount(cents) {',
        '  return (cents / 100).toFixed(2);',
        '}',
        '',
        'module.exports = { formatTime, formatAmount };',
      ].join('\n'),
      note: '格式化工具，比较干净',
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'file-2007',
      path: 'src/web/legacy/old-util.js',
      type: 'js',
      content: [
        '// FIXME 这个文件准备整体删掉，暂时先用着',
        'function pick(source, keys) {',
        '  var out = {};',
        '  keys.forEach(function (key) {',
        '    out[key] = source[key];',
        '  });',
        '  console.log("pick", keys.length);',
        '  return out;',
        '}',
        '',
        'function run(expr) {',
        '  return eval(expr);',
        '}',
        '',
        'module.exports = { pick, run };',
      ].join('\n'),
      note: '历史遗留工具',
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'file-2008',
      path: 'src/config/default.js',
      type: 'js',
      content: [
        'const DEBUG = true;',
        '',
        'const config = {',
        '  port: Number(process.env["PORT"] || 4000),',
        '  password = "member-2026",',
        '  redis: "redis://127.0.0.1:6379/0",',
        '};',
        '',
        'module.exports = config;',
      ].join('\n'),
      note: '默认配置，里面有调试开关',
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'file-2009',
      path: 'scripts/deploy.sh',
      type: 'sh',
      content: [
        '#!/usr/bin/env bash',
        'set -e',
        '',
        'APP_DIR=/opt/member',
        '',
        '# TODO 换机器之后要改掉这个路径',
        'cd "$APP_DIR"',
        'git pull --ff-only',
        'npm ci --omit=dev',
        'npm start &',
        '',
        'echo "发布完成"',
      ].join('\n'),
      note: '发布脚本',
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'file-2010',
      path: 'scripts/migrate.sh',
      type: 'sh',
      content: [
        '#!/usr/bin/env bash',
        'set -e',
        '',
        'DB_URL="postgres://app:app@127.0.0.1:5432/member"',
        '',
        'psql "$DB_URL" -f sql/2026-09-01-member.sql',
        'echo "迁移完成"',
      ].join('\n'),
      note: '迁移脚本',
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'file-2011',
      path: 'docs/readme.md',
      type: 'md',
      content: [
        '# 会员中心',
        '',
        '## 启动',
        '',
        '先装依赖再启动，端口默认 4000。',
        '',
        '## 部署',
        '',
        '待补',
        '',
        '<!-- TODO 补上回滚步骤 -->',
      ].join('\n'),
      note: '',
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'file-2012',
      path: 'config/deploy.yml',
      type: 'yml',
      content: [
        'service: member',
        'replicas: 2',
        'database: postgres://app:app@127.0.0.1:5432/member',
        'healthcheck: /health',
        'resources:',
        '  cpu: 500m',
        '  memory: 512Mi',
      ].join('\n'),
      note: '部署描述',
      createdAt: at,
      updatedAt: at,
    },
  ];
}

// 旧版本里状态只有启用、停用两个值，升级时把它们翻译成新状态机
function migrateStatus(value) {
  if (value === '停用' || value === STATUS_DISABLED) return STATUS_DISABLED;
  if (value === STATUS_DRAFT) return STATUS_DRAFT;
  if (value === STATUS_REVIEW) return STATUS_REVIEW;
  return STATUS_ENABLED;
}

// 把单条规则整理成固定结构。旧数据（只有启用/停用、没有版本号）在这里一次性补齐
function normalizeRule(item, fallbackIndex) {
  const source = item && typeof item === 'object' ? item : {};
  const createdAt = typeof source.createdAt === 'string' && source.createdAt ? source.createdAt : new Date().toISOString();
  const level = LEVELS.includes(source.level) ? source.level : LEVELS[0];
  const status = migrateStatus(source.status);
  const fileType = FILE_TYPES.includes(source.fileType) ? source.fileType : FILE_TYPES[0];
  const version = Number.isInteger(source.version) && source.version >= 1 ? source.version : 1;
  const enabledVersion = Number.isInteger(source.enabledVersion) && source.enabledVersion >= 1
    ? source.enabledVersion
    : (status === STATUS_ENABLED ? version : null);
  return {
    id: typeof source.id === 'string' && source.id ? source.id : `rule-restored-${fallbackIndex + 1}`,
    code: typeof source.code === 'string' ? source.code.trim() : '',
    name: typeof source.name === 'string' ? source.name.trim() : '',
    level,
    status,
    fileType,
    pattern: typeof source.pattern === 'string' ? source.pattern : '',
    note: typeof source.note === 'string' ? source.note : '',
    version,
    enabledVersion,
    createdBy: typeof source.createdBy === 'string' && source.createdBy ? source.createdBy : '初始清单',
    updatedBy: typeof source.updatedBy === 'string' && source.updatedBy ? source.updatedBy : '初始清单',
    createdAt,
    updatedAt: typeof source.updatedAt === 'string' && source.updatedAt ? source.updatedAt : createdAt,
  };
}

// 把单个文件整理成固定结构，类型不在清单里的一律从路径后缀推断
function normalizeFile(item, fallbackIndex) {
  const source = item && typeof item === 'object' ? item : {};
  const createdAt = typeof source.createdAt === 'string' && source.createdAt ? source.createdAt : new Date().toISOString();
  const filePath = typeof source.path === 'string' ? source.path.trim() : '';
  const ext = filePath.includes('.') ? filePath.split('.').pop().toLowerCase() : '';
  const type = FILE_TYPES.includes(source.type) && source.type !== '全部' ? source.type : (FILE_TYPES.includes(ext) ? ext : 'js');
  const content = typeof source.content === 'string' ? source.content : '';
  return {
    id: typeof source.id === 'string' && source.id ? source.id : `file-restored-${fallbackIndex + 1}`,
    path: filePath,
    type,
    content,
    note: typeof source.note === 'string' ? source.note : '',
    createdAt,
    updatedAt: typeof source.updatedAt === 'string' && source.updatedAt ? source.updatedAt : createdAt,
  };
}

function normalizeHistoryItem(item, fallbackIndex) {
  const source = item && typeof item === 'object' ? item : {};
  const at = typeof source.at === 'string' && source.at ? source.at : (
    typeof source.createdAt === 'string' && source.createdAt ? source.createdAt : new Date().toISOString()
  );
  const kind = source.kind === 'revision' ? 'revision' : 'transition';
  return {
    id: typeof source.id === 'string' && source.id ? source.id : `rh-restored-${fallbackIndex + 1}`,
    ruleId: typeof source.ruleId === 'string' ? source.ruleId : '',
    kind,
    action: typeof source.action === 'string' ? source.action : '',
    fromStatus: typeof source.fromStatus === 'string' ? source.fromStatus : '',
    toStatus: typeof source.toStatus === 'string' ? source.toStatus : '',
    version: Number.isInteger(source.version) && source.version >= 1 ? source.version : 1,
    snapshot: source.snapshot && typeof source.snapshot === 'object' ? source.snapshot : null,
    at,
    by: typeof source.by === 'string' && source.by ? source.by : '初始清单',
    reason: typeof source.reason === 'string' ? source.reason : '',
  };
}

// 扫描历史只留必要字段，命中里带上当时的规则版本，旧条目缺字段时按未知补
function normalizeScan(item, fallbackIndex) {
  const source = item && typeof item === 'object' ? item : {};
  const scannedAt = typeof source.scannedAt === 'string' && source.scannedAt
    ? source.scannedAt
    : (typeof source.at === 'string' && source.at ? source.at : new Date().toISOString());
  const hits = Array.isArray(source.hits) ? source.hits.map((hit) => ({
    ruleId: typeof hit.ruleId === 'string' ? hit.ruleId : '',
    code: typeof hit.code === 'string' ? hit.code : '',
    ruleName: typeof hit.ruleName === 'string' ? hit.ruleName : '',
    level: LEVELS.includes(hit.level) ? hit.level : LEVELS[0],
    pattern: typeof hit.pattern === 'string' ? hit.pattern : '',
    ruleVersion: Number.isInteger(hit.ruleVersion) && hit.ruleVersion >= 1 ? hit.ruleVersion : null,
    fileId: typeof hit.fileId === 'string' ? hit.fileId : '',
    path: typeof hit.path === 'string' ? hit.path : '',
    fileType: typeof hit.fileType === 'string' ? hit.fileType : '',
    lineNo: Number.isInteger(hit.lineNo) && hit.lineNo >= 1 ? hit.lineNo : 0,
    lineText: typeof hit.lineText === 'string' ? hit.lineText : '',
  })) : [];
  const summary = source.summary && typeof source.summary === 'object' ? source.summary : {
    total: hits.length,
    byLevel: {},
    byRule: [],
    byFile: [],
  };
  return {
    id: typeof source.id === 'string' && source.id ? source.id : `scan-restored-${fallbackIndex + 1}`,
    scannedAt,
    by: typeof source.by === 'string' && source.by ? source.by : '',
    level: typeof source.level === 'string' ? source.level : '',
    fileId: typeof source.fileId === 'string' ? source.fileId : '',
    ruleId: typeof source.ruleId === 'string' ? source.ruleId : '',
    scopeRuleCode: typeof source.scopeRuleCode === 'string' ? source.scopeRuleCode : '',
    scopeFilePath: typeof source.scopeFilePath === 'string' ? source.scopeFilePath : '',
    enabledRules: Number.isInteger(source.enabledRules) ? source.enabledRules : 0,
    rulesUsed: Number.isInteger(source.rulesUsed) ? source.rulesUsed : hits.length,
    filesInScope: Number.isInteger(source.filesInScope) ? source.filesInScope : 0,
    filesTotal: Number.isInteger(source.filesTotal) ? source.filesTotal : 0,
    rulesTotal: Number.isInteger(source.rulesTotal) ? source.rulesTotal : 0,
    warning: typeof source.warning === 'string' ? source.warning : '',
    hits,
    summary,
  };
}

// 旧数据升级：缺流转记录的规则，按它当前状态补一条建账记录，时间用规则自己的创建时间
function backfillHistory(rules, history) {
  const existing = new Set(history.map((item) => item.ruleId));
  const added = [];
  rules.forEach((rule, index) => {
    if (existing.has(rule.id)) return;
    const toStatus = rule.status === STATUS_DRAFT || rule.status === STATUS_REVIEW ? rule.status : STATUS_ENABLED;
    added.push({
      id: `rh-backfill-${rule.id || index + 1}`,
      ruleId: rule.id,
      kind: 'transition',
      action: '登记',
      fromStatus: '',
      toStatus,
      version: rule.version,
      at: rule.createdAt,
      by: rule.createdBy,
      reason: '旧版数据升级，按当前状态补登记',
    });
    if (rule.status === STATUS_DISABLED) {
      added.push({
        id: `rh-backfill-${rule.id}-off`,
        ruleId: rule.id,
        kind: 'transition',
        action: '停用',
        fromStatus: STATUS_ENABLED,
        toStatus: STATUS_DISABLED,
        version: rule.version,
        at: rule.updatedAt,
        by: rule.updatedBy,
        reason: '旧版数据升级，按当前状态补登记',
      });
    }
  });
  return history.concat(added);
}

// 整份数据保证规则、文件、流转记录与扫描历史结构一致，缺编号、缺名称、缺路径的条目一律丢掉
function normalize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const seed = { rules: seedRules(), files: seedFiles(), ruleHistory: seedRuleHistory(), scans: [] };

  const rawRules = Array.isArray(source.rules) ? source.rules : seed.rules;
  const seenRuleIds = new Set();
  const seenCodes = new Set();
  const rules = [];
  rawRules.forEach((item, index) => {
    const rule = normalizeRule(item, index);
    if (!rule.id || !rule.code || !rule.name) return;
    const lower = rule.code.toLowerCase();
    if (seenRuleIds.has(rule.id) || seenCodes.has(lower)) return;
    seenRuleIds.add(rule.id);
    seenCodes.add(lower);
    rules.push(rule);
  });

  const rawFiles = Array.isArray(source.files) ? source.files : seed.files;
  const seenFileIds = new Set();
  const seenPaths = new Set();
  const files = [];
  rawFiles.forEach((item, index) => {
    const file = normalizeFile(item, index);
    if (!file.id || !file.path) return;
    const lower = file.path.toLowerCase();
    if (seenFileIds.has(file.id) || seenPaths.has(lower)) return;
    seenFileIds.add(file.id);
    seenPaths.add(lower);
    files.push(file);
  });

  const knownRuleIds = new Set(rules.map((item) => item.id));
  const rawHistory = Array.isArray(source.ruleHistory)
    ? source.ruleHistory
    : (Array.isArray(source.rules) ? [] : seed.ruleHistory);
  const seenHistoryIds = new Set();
  let ruleHistory = [];
  rawHistory.forEach((item, index) => {
    const record = normalizeHistoryItem(item, index);
    if (!record.ruleId || !knownRuleIds.has(record.ruleId)) return;
    if (seenHistoryIds.has(record.id)) return;
    seenHistoryIds.add(record.id);
    ruleHistory.push(record);
  });
  ruleHistory = backfillHistory(rules, ruleHistory);

  const rawScans = Array.isArray(source.scans) ? source.scans : seed.scans;
  const seenScanIds = new Set();
  const scans = [];
  rawScans.forEach((item, index) => {
    const scan = normalizeScan(item, index);
    if (seenScanIds.has(scan.id)) return;
    seenScanIds.add(scan.id);
    scans.push(scan);
  });
  scans.sort((a, b) => (a.scannedAt < b.scannedAt ? 1 : a.scannedAt > b.scannedAt ? -1 : 0));

  return { rules, files, ruleHistory, scans };
}

// 读取数据文件：文件缺失或内容损坏时回落到初始数据并立刻补写
function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return normalize(JSON.parse(raw));
  } catch (err) {
    const data = { rules: seedRules(), files: seedFiles(), ruleHistory: seedRuleHistory(), scans: [] };
    save(data);
    return data;
  }
}

// 先写临时文件再改名，写入中途被打断也不会把正式数据文件写坏
function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const clean = normalize(data);
  // 扫描历史只留最近的若干轮，避免本机数据文件越滚越大
  clean.scans = clean.scans.slice(0, MAX_SCANS_KEPT);
  const text = `${JSON.stringify(normalizedForWrite(clean), null, 2)}\n`;
  fs.writeFileSync(TEMP_FILE, text, 'utf8');
  fs.renameSync(TEMP_FILE, DATA_FILE);
}

// 落盘前再过一遍结构，保证写出去的字段齐整
function normalizedForWrite(data) {
  return {
    rules: data.rules.map((rule) => ({ ...rule })),
    files: data.files.map((file) => ({ ...file })),
    ruleHistory: data.ruleHistory.map((item) => ({ ...item })),
    scans: data.scans.map((item) => ({ ...item })),
  };
}

module.exports = {
  load,
  save,
  normalize,
  normalizeRule,
  normalizeFile,
  seedRules,
  seedFiles,
  seedRuleHistory,
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
  MAX_PATH_LENGTH,
  MAX_CONTENT_LENGTH,
  MAX_OPERATOR_LENGTH,
  MAX_REASON_LENGTH,
  MAX_SCANS_KEPT,
  DATA_FILE,
};
