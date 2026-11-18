// data/ 数据校验（零依赖，不引入 schema 库）。
// node scripts/validate.mjs [dataDir]   # 不传 dataDir 时校验仓库里的 data/
// 规则来自 docs/ 与维护约定：官网不提供的字段保持 null，不做推算，不按位数猜测阵容码。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'data');
const D = (p) => path.join(DATA_DIR, p);

const problems = [];
const notes = [];
const chk = (ok, msg) => { if (!ok) problems.push(msg); };
const isInt = (v) => Number.isInteger(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string';
const COLUMNS = ['general', 'hot', 'beginner'];

const readJson = (p) => JSON.parse(readFileSync(D(p), 'utf8'));

// ---- data/versions.json ----
const VERSION_FIELDS = ['version', 'seasonLabel', 'source', 'fetchedAt', 'isCurrent', 'note'];
const knownVersions = new Map();
if (!existsSync(D('versions.json'))) {
  problems.push('versions.json：文件不存在');
} else {
  const versions = readJson('versions.json');
  chk(Array.isArray(versions) && versions.length > 0, 'versions.json：顶层必须是数组且非空');
  const list = Array.isArray(versions) ? versions : [];
  let current = 0;
  list.forEach((v, i) => {
    for (const f of VERSION_FIELDS) chk(f in v, `versions.json[${i}]：缺字段 ${f}`);
    chk(isStr(v.version) && v.version.length > 0, `versions.json[${i}]：version 必须是非空字符串`);
    chk(typeof v.isCurrent === 'boolean', `versions.json[${i}]：isCurrent 必须是布尔`);
    chk(isStr(v.source) && v.source.startsWith('https://'), `versions.json[${i}]：source 必须是 https 地址`);
    chk(isStr(v.fetchedAt) && /^\d{4}-\d{2}-\d{2}$/.test(v.fetchedAt), `versions.json[${i}]：fetchedAt 必须是 YYYY-MM-DD`);
    if (v.isCurrent) current++;
    if (isStr(v.version)) knownVersions.set(v.version, v);
  });
  chk(current === 1, `versions.json：isCurrent=true 的条目必须恰好 1 条，实际 ${current}`);
}

// ---- data/comps.json ----
if (!existsSync(D('comps.json'))) {
  problems.push('comps.json：文件不存在');
} else {
  const doc = readJson('comps.json');
  chk(doc && typeof doc === 'object' && !Array.isArray(doc), 'comps.json：顶层必须是对象');
  const records = doc?.records;
  chk(Array.isArray(records), 'comps.json：records 必须是数组');
  const list = Array.isArray(records) ? records : [];

  chk(doc?.count === list.length, `comps.json：count=${doc?.count} 与实际记录数 ${list.length} 不一致`);
  chk(isStr(doc?.version) && knownVersions.has(doc.version), `comps.json：version ${doc?.version} 不在 versions.json 里`);
  chk(
    Array.isArray(doc?.columns) && doc.columns.join() === COLUMNS.join(),
    `comps.json：columns 必须是 ${COLUMNS.join('/')}`
  );
  chk(isStr(doc?.fetchedAt) && !Number.isNaN(Date.parse(doc.fetchedAt)), 'comps.json：fetchedAt 不是合法时间');

  // 外键：heroList[].id。heroes.json 不存在时跳过并提示。
  let heroIds = null;
  if (existsSync(D('heroes.json'))) {
    const h = readJson('heroes.json');
    const arr = Array.isArray(h) ? h : Array.isArray(h?.heroes) ? h.heroes : null;
    if (arr) heroIds = new Set(arr.map((x) => x.id));
    else notes.push('heroes.json 结构未知（既不是数组也没有 heroes 数组），外键校验已跳过');
  } else {
    notes.push('data/heroes.json 不存在，heroList[].id 外键校验已跳过');
  }

  const codeSeen = new Map();
  list.forEach((r, i) => {
    const at = `comps.json.records[${i}]`;
    const tag = isStr(r?.lineupCode) ? `${at}(lineupCode=${r.lineupCode})` : at;

    // 阵容码：只校验非空 + 全数字。实测官网 1-19 位都有，禁止按位数校验。
    chk(isStr(r?.lineupCode), `${at}：lineupCode 必须是字符串`);
    if (isStr(r?.lineupCode)) {
      chk(r.lineupCode.length > 0, `${at}：lineupCode 为空`);
      chk(/^\d+$/.test(r.lineupCode), `${at}：lineupCode 必须全是数字`);
      if (codeSeen.has(r.lineupCode)) problems.push(`${at}：lineupCode 重复（首次出现在 records[${codeSeen.get(r.lineupCode)}]）`);
      else codeSeen.set(r.lineupCode, i);
    }

    chk(isStr(r?.name) && r.name.length > 0, `${tag}：name 必须是非空字符串`);
    chk(isStr(r?.tag), `${tag}：tag 必须是字符串`);

    // column / primaryColumn
    chk(Array.isArray(r?.column) && r.column.length > 0, `${tag}：column 必须是非空数组`);
    const cols = Array.isArray(r?.column) ? r.column : [];
    chk(new Set(cols).size === cols.length, `${tag}：column 有重复项`);
    for (const c of cols) chk(COLUMNS.includes(c), `${tag}：column 出现未知值 ${c}`);
    if (cols.length > 1) {
      chk(isStr(r?.primaryColumn) && cols.includes(r.primaryColumn), `${tag}：多栏记录的 primaryColumn 必填且必须属于 column`);
    } else if (cols.length === 1) {
      chk(r?.primaryColumn === cols[0], `${tag}：单栏记录的 primaryColumn 必须等于该栏`);
    }

    // useNumByColumn：跨栏数值不同，全部保留，不取单值
    const byCol = r?.useNumByColumn;
    chk(byCol && typeof byCol === 'object' && !Array.isArray(byCol), `${tag}：缺 useNumByColumn`);
    if (byCol && typeof byCol === 'object') {
      const keys = Object.keys(byCol);
      chk(keys.length === cols.length && cols.every((c) => keys.includes(c)), `${tag}：useNumByColumn 的键必须与 column 完全一致`);
      for (const k of keys) chk(isInt(byCol[k]) && byCol[k] >= 0, `${tag}：useNumByColumn.${k} 必须是非负整数`);
    }
    chk(!('useNum' in r), `${tag}：不应存在单值 useNum，跨栏数值见 useNumByColumn`);

    // heroList
    chk(Array.isArray(r?.heroList) && r.heroList.length > 0, `${tag}：heroList 必须是非空数组`);
    for (const [j, h] of (Array.isArray(r?.heroList) ? r.heroList : []).entries()) {
      const hAt = `${tag}.heroList[${j}]`;
      chk(isInt(h?.id), `${hAt}：id 必须是整数`);
      chk(isStr(h?.name) && h.name.length > 0, `${hAt}：name 必须是非空字符串`);
      chk([0, 1, 2, 3].includes(h?.type), `${hAt}：type 只能是 0-3`);
      chk(isInt(h?.cardQuality) && h.cardQuality >= 1 && h.cardQuality <= 5, `${hAt}：cardQuality 只能是 1-5`);
      chk(isInt(h?.level), `${hAt}：level 必须是整数`);
      chk(typeof h?.isEvo === 'boolean', `${hAt}：isEvo 必须是布尔`);
      chk(isInt(h?.positionX) && isInt(h?.positionZ), `${hAt}：positionX/positionZ 必须是整数`);
      chk(Array.isArray(h?.equips), `${hAt}：equips 必须是数组`);
      for (const [k, e] of (Array.isArray(h?.equips) ? h.equips : []).entries()) {
        chk(isInt(e?.id), `${hAt}.equips[${k}]：id 必须是整数`);
        chk(isStr(e?.name) && e.name.length > 0, `${hAt}.equips[${k}]：name 必须是非空字符串`);
      }
      if (heroIds && isInt(h?.id)) chk(heroIds.has(h.id), `${hAt}：id ${h.id} 不在 data/heroes.json 里`);
    }

    // interactiveData
    const checkInter = (d, at2) => {
      chk(d && typeof d === 'object', `${at2}：必须是对象`);
      if (!d || typeof d !== 'object') return;
      chk(isNum(d.score) && d.score >= 0 && d.score <= 10, `${at2}.score 必须是 0-10 的数字（用户评分，不是排名）`);
      chk(isInt(d.scoreNum) && d.scoreNum >= 0, `${at2}.scoreNum 必须是非负整数`);
      chk(Array.isArray(d.scores) && d.scores.length === 5, `${at2}.scores 必须是长度 5 的数组`);
      for (const s of (Array.isArray(d.scores) ? d.scores : [])) chk(isInt(s) && s >= 0, `${at2}.scores 的元素必须是非负整数`);
      chk(isInt(d.commentNum) && d.commentNum >= 0, `${at2}.commentNum 必须是非负整数`);
      chk(isInt(d.likeNum) && d.likeNum >= 0, `${at2}.likeNum 必须是非负整数`);
    };
    checkInter(r?.interactiveData, `${tag}.interactiveData`);
    if ('interactiveDataByColumn' in (r || {})) {
      const m = r.interactiveDataByColumn;
      chk(m && typeof m === 'object', `${tag}.interactiveDataByColumn 必须是对象`);
      const keys = Object.keys(m || {});
      chk(keys.length === cols.length && cols.every((c) => keys.includes(c)), `${tag}.interactiveDataByColumn 的键必须与 column 完全一致`);
      for (const k of keys) checkInter(m[k], `${tag}.interactiveDataByColumn.${k}`);
    }

    // stats / variants：官网不给就留 null，禁止填占位值
    const st = r?.stats;
    chk(st && typeof st === 'object', `${tag}：缺 stats`);
    for (const f of ['avgRank', 'pickRate', 'difficulty', 'equipRate']) {
      chk(st && f in st, `${tag}.stats：缺字段 ${f}`);
      chk(st?.[f] === null || isNum(st?.[f]), `${tag}.stats.${f} 只能是 null 或数字`);
    }
    chk(isStr(r?.statsNote) && r.statsNote.length > 0, `${tag}：statsNote 必须说明这些字段为什么是 null`);
    chk(r?.variants === null || Array.isArray(r?.variants), `${tag}：variants 只能是 null 或数组`);

    // 来源字段
    chk(isStr(r?.source) && r.source.startsWith('http'), `${tag}：source 必须是 URL`);
    chk(isStr(r?.sourcePage) && r.sourcePage.startsWith('http'), `${tag}：sourcePage 必须是 URL`);
    chk(isStr(r?.fetchedAt) && !Number.isNaN(Date.parse(r.fetchedAt)), `${tag}：fetchedAt 不是合法时间`);
    chk(r?.version === doc?.version, `${tag}：version 必须与文件级 version 一致`);
    chk(isInt(r?.sourceSeasonId), `${tag}：sourceSeasonId 必须是整数`);
    chk(isInt(r?.seasonIdRaw), `${tag}：seasonIdRaw 必须是整数`);
    chk(r?.sourceSeasonId === r?.seasonIdRaw, `${tag}：sourceSeasonId 与 seasonIdRaw 必须同值（都按官方原值存）`);
    chk(typeof r?.crossSeason === 'boolean', `${tag}：crossSeason 必须是布尔`);
    if (cols.length === 1 && (cols[0] === 'general' || cols[0] === 'hot')) {
      chk(r?.seasonIdRaw === 0, `${tag}：general/hot 的 seasonIdRaw 实测为 0，请核对`);
    }
    if (cols.length === 1 && cols[0] === 'beginner') {
      chk(r?.seasonIdRaw === 1, `${tag}：beginner 的 seasonIdRaw 实测为 1，请核对`);
    }
  });

  // 分组统计：按 (column, seasonIdRaw) 分组，禁止跨组计算
  const groups = {};
  for (const r of list) {
    for (const c of r.column || []) {
      const k = `${c}|seasonIdRaw=${r.seasonIdRaw}`;
      groups[k] = (groups[k] || 0) + 1;
    }
  }
  notes.push('分组计数 ' + JSON.stringify(groups));

  // beginner 样本不足，报告里必须写明
  const beginner = (list.length && groups['beginner|seasonIdRaw=1']) || 0;
  if (beginner > 0) notes.push(`beginner 只有 ${beginner} 条（另一页 pro_2 返回 404），样本不足，暂不作为基准`);
}

// ---- 输出 ----
for (const n of notes) console.log('note:', n);
if (problems.length === 0) {
  console.log('data/ 校验通过：0 个问题');
  process.exit(0);
}
console.log(`data/ 校验失败：${problems.length} 个问题`);
for (const p of problems) console.log(' -', p);
process.exit(1);
