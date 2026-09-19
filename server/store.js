const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const TEMP_FILE = path.join(DATA_DIR, 'db.json.tmp');

const LEVELS = ['提示', '警告', '错误'];
// 规则的状态流转：起草 → 已复核 → 启用 →（可停用）；停用或已复核后改了内容要退回起草重走
const STATUSES = ['起草', '已复核', '启用', '停用'];
const STATUS = {
  DRAFT: '起草',
  REVIEWED: '已复核',
  ENABLED: '启用',
  DISABLED: '停用',
};
const FILE_TYPES = ['全部', 'js', 'sh', 'md', 'yml'];
// 规则的适用文件类型允许先空着：起草阶段可以不选，启用把关时会拦住
const RULE_FILE_TYPES = ['', '全部', 'js', 'sh', 'md', 'yml'];
const MAX_CODE_LENGTH = 20;
const MAX_RULE_NAME_LENGTH = 40;
const MAX_PATTERN_LENGTH = 60;
const MAX_NOTE_LENGTH = 200;
const MAX_OPERATOR_LENGTH = 40;
const MAX_PATH_LENGTH = 120;
const MAX_CONTENT_LENGTH = 4000;

// 初始数据里的流转记录与版本快照都挂在这个操作者名下，方便和真实操作区分
const SEED_OPERATOR = '初始数据';

// 检查规则的初始数据。多数是已启用的，两条走过停用，
// 另外放了一条起草（适用文件类型还没选）和一条已复核，用来观察状态流转
function seedRules() {
  const at = '2026-09-02T02:00:00.000Z';
  const enabledAt = '2026-09-02T02:10:00.000Z';
  const disabledAt = '2026-09-03T08:30:00.000Z';

  // 启用的规则：一版快照 + 一条起草到启用的流转记录
  function enabledRule(id, code, name, level, fileType, pattern, note) {
    return {
      id, code, name, level, status: STATUS.ENABLED, fileType, pattern, note,
      version: 1,
      versions: [{
        version: 1, code, name, level, fileType, pattern, note,
        enabledAt, enabledBy: SEED_OPERATOR,
      }],
      transitions: [{
        id: `${id}-t1`, action: '启用', from: STATUS.DRAFT, to: STATUS.ENABLED,
        at: enabledAt, by: SEED_OPERATOR, note: '初始导入',
      }],
      createdAt: at, updatedAt: at,
    };
  }

  // 停用的规则：先启用再停用，版本快照保留着，能看出当时管事的是哪一版
  function disabledRule(id, code, name, level, fileType, pattern, note, disableNote) {
    const rule = enabledRule(id, code, name, level, fileType, pattern, note);
    rule.status = STATUS.DISABLED;
    rule.updatedAt = disabledAt;
    rule.transitions.push({
      id: `${id}-t2`, action: '停用', from: STATUS.ENABLED, to: STATUS.DISABLED,
      at: disabledAt, by: SEED_OPERATOR, note: disableNote,
    });
    return rule;
  }

  return [
    enabledRule('rule-1001', 'CODE-001', '禁止提交调试输出', '警告', 'js', 'console.log', '上线前要换成统一日志'),
    enabledRule('rule-1002', 'CODE-002', '变量声明统一用 let 或 const', '错误', 'js', 'var ', '老代码里还有不少'),
    enabledRule('rule-1003', 'CODE-003', '待办事项需要收口', '提示', '全部', 'TODO', '带人名与期限的可以留'),
    enabledRule('rule-1004', 'CODE-004', '禁止动态执行代码', '错误', '全部', 'eval(', ''),
    enabledRule('rule-1005', 'CODE-005', '禁止把口令写进代码', '错误', '全部', 'password =', '口令一律走统一配置'),
    enabledRule('rule-1006', 'CODE-006', '空捕获块要写清原因', '警告', 'js', 'catch (e) {}', ''),
    disabledRule('rule-1007', 'CODE-007', '调试开关上线前要关掉', '警告', 'js', 'DEBUG = true', '等联调结束再打开', '联调期间保留，上线前再启'),
    enabledRule('rule-1008', 'CODE-008', '数据库地址不许写死在代码里', '错误', '全部', 'postgres://', ''),
    enabledRule('rule-1009', 'CODE-009', '取配置项要走统一封装', '提示', 'js', 'process.env[', '直接按名字取容易拼错'),
    disabledRule('rule-1010', 'CODE-010', '遗留注释要清理', '提示', '全部', 'FIXME', '', '存量太多，先不拦'),
    enabledRule('rule-1011', 'CODE-011', '脚本里禁止直接用强制删除', '警告', 'sh', 'rm -rf', '脚本里改用受控的清理命令'),
    enabledRule('rule-1012', 'CODE-012', '文档里的临时占位要删掉', '提示', 'md', '待补', ''),
    // 起草：内容还没定全，适用文件类型也没选，此时点启用会被把关拦住
    {
      id: 'rule-1013', code: 'CODE-013', name: '脚本里不要直接拉远程文件', level: '警告',
      status: STATUS.DRAFT, fileType: '', pattern: 'wget ', note: '',
      version: 0, versions: [], transitions: [],
      createdAt: '2026-09-10T06:00:00.000Z', updatedAt: '2026-09-10T06:00:00.000Z',
    },
    // 已复核：自己过完一遍，只差点启用
    {
      id: 'rule-1014', code: 'CODE-014', name: '提交前去掉调试断点', level: '提示',
      status: STATUS.REVIEWED, fileType: 'js', pattern: 'debugger', note: '',
      version: 0, versions: [],
      transitions: [{
        id: 'rule-1014-t1', action: '提交复核', from: STATUS.DRAFT, to: STATUS.REVIEWED,
        at: '2026-09-12T03:20:00.000Z', by: SEED_OPERATOR, note: '自查通过',
      }],
      createdAt: '2026-09-12T03:00:00.000Z', updatedAt: '2026-09-12T03:20:00.000Z',
    },
  ];
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

// 把单条版本快照整理成固定结构，缺字段的不进快照
function normalizeVersion(source, fallbackVersion) {
  const data = source && typeof source === 'object' ? source : {};
  const version = Number.isInteger(data.version) && data.version > 0 ? data.version : fallbackVersion;
  const fileType = RULE_FILE_TYPES.includes(data.fileType) ? data.fileType : '';
  return {
    version,
    code: typeof data.code === 'string' ? data.code.trim() : '',
    name: typeof data.name === 'string' ? data.name.trim() : '',
    level: LEVELS.includes(data.level) ? data.level : LEVELS[0],
    fileType,
    pattern: typeof data.pattern === 'string' ? data.pattern : '',
    note: typeof data.note === 'string' ? data.note : '',
    enabledAt: typeof data.enabledAt === 'string' && data.enabledAt ? data.enabledAt : '',
    enabledBy: typeof data.enabledBy === 'string' ? data.enabledBy.trim() : '',
  };
}

// 把单条流转记录整理成固定结构
function normalizeTransition(source, fallbackIndex) {
  const data = source && typeof source === 'object' ? source : {};
  return {
    id: typeof data.id === 'string' && data.id ? data.id : `transition-restored-${fallbackIndex + 1}`,
    action: typeof data.action === 'string' && data.action ? data.action : '状态变更',
    from: STATUSES.includes(data.from) ? data.from : '',
    to: STATUSES.includes(data.to) ? data.to : '',
    at: typeof data.at === 'string' && data.at ? data.at : '',
    by: typeof data.by === 'string' ? data.by.trim() : '',
    note: typeof data.note === 'string' ? data.note : '',
  };
}

// 旧版本数据没有状态流转：按当时状态补出一条说得通的来历，
// 启用的补一版快照，停用的先补启用再补停用，历史命中才指得上版本
function migrateLegacyTransitions(rule) {
  const firstAt = rule.createdAt;
  const lastAt = rule.updatedAt || rule.createdAt;
  if (rule.status === STATUS.ENABLED) {
    rule.version = 1;
    rule.versions = [snapshotOf(rule, 1, firstAt, SEED_OPERATOR)];
    rule.transitions = [{
      id: `${rule.id}-t-migrate-1`, action: '启用', from: STATUS.DRAFT, to: STATUS.ENABLED,
      at: firstAt, by: SEED_OPERATOR, note: '旧数据补录',
    }];
  } else if (rule.status === STATUS.DISABLED) {
    rule.version = 1;
    rule.versions = [snapshotOf(rule, 1, firstAt, SEED_OPERATOR)];
    rule.transitions = [
      {
        id: `${rule.id}-t-migrate-1`, action: '启用', from: STATUS.DRAFT, to: STATUS.ENABLED,
        at: firstAt, by: SEED_OPERATOR, note: '旧数据补录',
      },
      {
        id: `${rule.id}-t-migrate-2`, action: '停用', from: STATUS.ENABLED, to: STATUS.DISABLED,
        at: lastAt, by: SEED_OPERATOR, note: '旧数据补录',
      },
    ];
  }
}

// 启用那一刻规则各字段拍成的快照
function snapshotOf(rule, version, enabledAt, enabledBy) {
  return {
    version,
    code: rule.code,
    name: rule.name,
    level: rule.level,
    fileType: rule.fileType,
    pattern: rule.pattern,
    note: rule.note,
    enabledAt,
    enabledBy,
  };
}

// 把单条规则整理成固定结构，级别与状态不认识的一律回到默认值
function normalizeRule(item, fallbackIndex) {
  const source = item && typeof item === 'object' ? item : {};
  const createdAt = typeof source.createdAt === 'string' && source.createdAt ? source.createdAt : new Date().toISOString();
  const level = LEVELS.includes(source.level) ? source.level : LEVELS[0];
  const status = STATUSES.includes(source.status) ? source.status : STATUSES[0];
  const fileType = RULE_FILE_TYPES.includes(source.fileType) ? source.fileType : '';
  const rule = {
    id: typeof source.id === 'string' && source.id ? source.id : `rule-restored-${fallbackIndex + 1}`,
    code: typeof source.code === 'string' ? source.code.trim() : '',
    name: typeof source.name === 'string' ? source.name.trim() : '',
    level,
    status,
    fileType,
    pattern: typeof source.pattern === 'string' ? source.pattern : '',
    note: typeof source.note === 'string' ? source.note : '',
    version: Number.isInteger(source.version) && source.version >= 0 ? source.version : 0,
    versions: Array.isArray(source.versions) ? source.versions.map(normalizeVersion) : [],
    transitions: Array.isArray(source.transitions) ? source.transitions.map(normalizeTransition) : [],
    createdAt,
    updatedAt: typeof source.updatedAt === 'string' && source.updatedAt ? source.updatedAt : createdAt,
  };
  // 旧数据迁移：有状态但没有流转记录的，补录来历与版本快照
  if ((status === STATUS.ENABLED || status === STATUS.DISABLED) && rule.transitions.length === 0) {
    migrateLegacyTransitions(rule);
  }
  return rule;
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

// 扫描批次是服务端自己写的，这里只兜住结构：编号、时刻和命中清单必须在
function normalizeBatch(item, fallbackIndex) {
  const source = item && typeof item === 'object' ? item : {};
  if (!source.id) return null;
  return {
    id: source.id,
    scannedAt: typeof source.scannedAt === 'string' && source.scannedAt ? source.scannedAt : '',
    scannedBy: typeof source.scannedBy === 'string' ? source.scannedBy.trim() : '',
    scope: source.scope && typeof source.scope === 'object' ? source.scope : {},
    enabledRules: Number.isInteger(source.enabledRules) ? source.enabledRules : 0,
    rulesUsed: Number.isInteger(source.rulesUsed) ? source.rulesUsed : 0,
    filesInScope: Number.isInteger(source.filesInScope) ? source.filesInScope : 0,
    filesTotal: Number.isInteger(source.filesTotal) ? source.filesTotal : 0,
    rulesTotal: Number.isInteger(source.rulesTotal) ? source.rulesTotal : 0,
    warning: typeof source.warning === 'string' ? source.warning : '',
    rules: Array.isArray(source.rules) ? source.rules : [],
    hits: Array.isArray(source.hits) ? source.hits : [],
    summary: source.summary && typeof source.summary === 'object' ? source.summary : { total: 0 },
  };
}

// 整份数据保证规则与文件结构一致，缺编号、缺名称、缺路径的条目一律丢掉
function normalize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const seed = { rules: seedRules(), files: seedFiles(), scanBatches: [] };

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

  const rawBatches = Array.isArray(source.scanBatches) ? source.scanBatches : seed.scanBatches;
  const seenBatchIds = new Set();
  const scanBatches = [];
  rawBatches.forEach((item, index) => {
    const batch = normalizeBatch(item, index);
    if (!batch || seenBatchIds.has(batch.id)) return;
    seenBatchIds.add(batch.id);
    scanBatches.push(batch);
  });

  return { rules, files, scanBatches };
}

// 读取数据文件：文件缺失或内容损坏时回落到初始数据并立刻补写
function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return normalize(JSON.parse(raw));
  } catch (err) {
    const data = { rules: seedRules(), files: seedFiles(), scanBatches: [] };
    save(data);
    return data;
  }
}

// 先写临时文件再改名，写入中途被打断也不会把正式数据文件写坏
function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const text = `${JSON.stringify(normalize(data), null, 2)}\n`;
  fs.writeFileSync(TEMP_FILE, text, 'utf8');
  fs.renameSync(TEMP_FILE, DATA_FILE);
}

module.exports = {
  load,
  save,
  seedRules,
  seedFiles,
  normalize,
  normalizeRule,
  normalizeFile,
  normalizeVersion,
  normalizeTransition,
  normalizeBatch,
  snapshotOf,
  LEVELS,
  STATUSES,
  STATUS,
  FILE_TYPES,
  RULE_FILE_TYPES,
  MAX_CODE_LENGTH,
  MAX_RULE_NAME_LENGTH,
  MAX_PATTERN_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_OPERATOR_LENGTH,
  MAX_PATH_LENGTH,
  MAX_CONTENT_LENGTH,
  DATA_FILE,
};
