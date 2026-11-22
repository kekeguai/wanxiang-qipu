// 把 datawxq 的统计合并进 data/comps.json。
// 用法：node scripts/merge_stats.mjs [--in snapshots/probe-stats/search-stats.json] [--out data/comps.json] [--dry]
//
// 规则：
//   - rosterKey = <英雄数>|<id 字符串升序>，与 datawxq 的 lineupKey/rosterKey 同构。
//   - 命中：stats 追加 appearanceRate/avgPlacement/firstRate/top3Rate/count/variantCount，
//           并把 stats.source 置为 "datawxq.com"。
//   - 未命中：stats 只补 source: ""，原有 4 个 null 字段原样不动，绝不留占位数值。
//   - beginner（isPreset）是官方预置阵容，不参与对局统计，永远不合并。
//   - 输入不完整（coverage.lineupsFetched < sampleCount 或字段缺失）默认拒绝合并；
//     加 --allow-partial 才放行，并在 statsSnapshot 记 partial: true。
// 只改 stats / statsNote，不动任何其他字段。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const USAGE = 'usage: node scripts/merge_stats.mjs [--in <json>] [--dry] [--allow-partial] [--emit-pending]';
const opts = { in: path.join(ROOT, 'snapshots', 'probe-stats', 'search-stats.json'), dry: false, allowPartial: false, emitPending: false };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) {
        console.error(USAGE);
        process.exit(2);
      }
      opts.in = path.resolve(v);
    } else if (a === '--dry') {
      opts.dry = true;
    } else if (a === '--allow-partial') {
      opts.allowPartial = true;
    } else if (a === '--emit-pending') {
      opts.emitPending = true;
    } else if (a === '-h' || a === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}\n${USAGE}`);
      process.exit(2);
    }
  }
}

const DWXQ_SOURCE = 'datawxq.com';
const DWXQ_STAT_KEYS = ['appearanceRate', 'avgPlacement', 'firstRate', 'top3Rate', 'count', 'variantCount'];
const STATS_NOTE =
  '官网阵容列表页不提供平均排名 / 选取率 / 难度 / 穿戴率，未推算。' +
  '登场率 / 平均名次 / 登顶率 / 前三率 / 场次 / 变阵数来自 datawxq.com，匹配不到则留 null。' +
  'heroList[].level 源数据恒为 1，不是真实等级。';

const rosterKeyOf = (heroList) =>
  [heroList.length, ...heroList.map((h) => String(h.id)).sort()].join('|');

// skip 清单加载 —— 必须最前
const SKIP_PATH = path.join(ROOT, 'snapshots', 'probe-variants', 'known-skip-keys.json');
const loadSkipKeys = () => {
  if (!fs.existsSync(SKIP_PATH)) return new Map();
  const raw = JSON.parse(fs.readFileSync(SKIP_PATH, 'utf8'));
  if (!Array.isArray(raw.keys)) throw new Error('known-skip-keys.json: keys 必须是数组');
  const m = new Map();
  for (const e of raw.keys) {
    if (!e || typeof e.rosterKey !== 'string' || !e.rosterKey) {
      throw new Error(`known-skip-keys.json 条目缺 rosterKey: ${JSON.stringify(e)}`);
    }
    if (typeof e.reason !== 'string' || !e.reason.trim()) {
      throw new Error(`known-skip-keys.json ${e.rosterKey} 缺 reason（不许空着）`);
    }
    m.set(e.rosterKey, e.reason);
  }
  return m;
};
const skipKeys = loadSkipKeys();

// comps 提前加载
const compsPath = path.join(ROOT, 'data', 'comps.json');
const comps = JSON.parse(fs.readFileSync(compsPath, 'utf8'));

// pending 导出函数
const exportPendingKeys = () => {
  const pkPath = path.join(ROOT, 'snapshots', 'probe-variants', 'pending-keys.json');
  if (fs.existsSync(pkPath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
    fs.renameSync(pkPath, path.join(ROOT, 'snapshots', 'probe-variants', `pending-keys-${ts}.json`));
  }
  const needed = new Set();
  const covered = new Set();
  for (const r of comps.records) {
    if (r?.stats?.source !== DWXQ_SOURCE) continue;
    const k = rosterKeyOf(r.heroList || []);
    if (skipKeys.has(k)) continue;
    needed.add(k);
    if (Array.isArray(r.variants)) covered.add(k);
  }

  // 陈旧性护栏
  const noStats = comps.records.filter(
    (r) => r && r.stats && r.stats.source === '' &&
           r.stats.count === undefined && r.stats.appearanceRate === undefined,
  );
  if (noStats.length) {
    const keys = [...new Set(noStats.map((r) => rosterKeyOf(r.heroList || [])))];
    console.warn('');
    console.warn('!!! STATS_INCOMPLETE=' + noStats.length + ' 条记录尚未合并统计');
    console.warn('!!! 涉及 ' + keys.length + ' 个 rosterKey：' + keys.join(', '));
    console.warn('!!! 这些 key 不在本 pending 清单内，直接抓取会漏。');
    console.warn('!!! 正确顺序：先重抓 stats → merge_stats 成功 → 再 --emit-pending');
    console.warn('');
  }

  const pending = [...needed].filter((k) => !covered.has(k)).sort();
  fs.writeFileSync(pkPath, JSON.stringify(pending, null, 2) + '\n', 'utf8');
  console.log(
    `pending-keys: 需要 ${needed.size}，已覆盖 ${covered.size}，` +
    `待抓 ${pending.length}，跳过 ${skipKeys.size}`,
  );
  return pending;
};

// --emit-pending 独立入口
if (opts.emitPending) {
  exportPendingKeys();
  process.exit(0);
}

// 断言 --in 存在 + 读 snap
if (!fs.existsSync(opts.in)) {
  console.error(`找不到抓取结果: ${opts.in}\n先跑 node scripts/fetch_stats.mjs`);
  process.exit(1);
}

const snap = JSON.parse(fs.readFileSync(opts.in, 'utf8'));
if (typeof snap.fetchedAt !== 'string' || !snap.fetchedAt) {
  console.error(`输入快照缺 fetchedAt，拒绝合并: ${opts.in}`);
  process.exit(1);
}
const byKey = new Map();
for (const l of snap.lineups || []) {
  if (l && typeof l.rosterKey === 'string') byKey.set(l.rosterKey, l);
}
if (!byKey.size) {
  console.error('抓取结果里没有 lineups，不合并');
  process.exit(1);
}

// 算 neededKeys（排除 skip）+ 集合差 missingKeys
const neededKeys = new Set(
  comps.records
    .filter((r) => r?.stats?.source === DWXQ_SOURCE)
    .map((r) => rosterKeyOf(r.heroList || []))
    .filter((k) => !skipKeys.has(k)),
);
const snapKeys = new Set((snap.lineups || []).map((l) => l.rosterKey));
const missingKeys = [...neededKeys].filter((k) => !snapKeys.has(k));

// partial 判据：
// ① 分页是否走完 —— 真截断信号
// ② 集合覆盖（已有统计的 key 是否全被抓到）
// ③ 环比上份快照 —— warn only
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const fetched = snap.coverage?.lineupsFetched;
const total = snap.total;
const partialReasons = [];

// ① 分页是否走完
if (!isNum(fetched) || !isNum(total)) {
  partialReasons.push(`coverage.lineupsFetched 或 total 缺失（fetched=${fetched}, total=${total}）`);
} else if (fetched !== total) {
  partialReasons.push(`分页未走完：lineupsFetched=${fetched} < total=${total}`);
}

// ② 集合覆盖（已有）
if (missingKeys.length) partialReasons.push(`缺 ${missingKeys.length} 个 key：${missingKeys.join(', ')}`);

// ③ 环比上份快照 —— warn only，不进 partialReasons
const prev = fs.readdirSync(path.join(ROOT,'snapshots','probe-stats'))
  .filter((f) => /^stats-\d{8}-\d{6}\.json$/.test(f))
  .map((f) => path.join(ROOT,'snapshots','probe-stats',f))
  .filter((p) => path.resolve(p) !== path.resolve(opts.in))
  .sort();
if (prev.length) {
  const prevSnap = JSON.parse(fs.readFileSync(prev[prev.length-1],'utf8'));
  if (isNum(prevSnap.sampleCount) && isNum(snap.sampleCount)
      && snap.sampleCount < prevSnap.sampleCount * 0.8) {
    console.warn(`WARN 样本量倒退：${snap.sampleCount} < 上份 ${prevSnap.sampleCount} 的 80%`);
  }
}

const partial = partialReasons.length > 0;
if (partial) {
  partialReasons.forEach((reason) => console.error(reason));
  if (!opts.allowPartial) {
    console.error('确认要合并请加 --allow-partial');
    process.exit(1);
  }
  console.warn('--allow-partial：允许合并部分数据');
}

let hit = 0;
let skippedPreset = 0;
const hitKeys = new Set();
for (const r of comps.records) {
  const st = r.stats && typeof r.stats === 'object' ? r.stats : { avgRank: null, pickRate: null, difficulty: null, equipRate: null };
  // 原有 4 个字段保住；缺就补 null，绝不删
  for (const f of ['avgRank', 'pickRate', 'difficulty', 'equipRate']) if (!(f in st)) st[f] = null;

  const k = rosterKeyOf(r.heroList || []);
  const l = r.isPreset ? null : byKey.get(k);
  if (l) {
    for (const f of DWXQ_STAT_KEYS) {
      if (!(f in l)) throw new Error(`datawxq 返回缺字段 ${f}（rosterKey=${k}）`);
      st[f] = l[f];
    }
    st.source = DWXQ_SOURCE;
    hit++; hitKeys.add(k);
  } else {
    // 未命中：保持原 stats 字节不动（不 delete、不写 source）
    if (r.isPreset) skippedPreset++;
  }
  // 不补 variantCount，让 merge_variants.mjs 来填
  r.stats = st;
  r.statsNote = STATS_NOTE;
}

// 覆盖情况（按记录数，同名 rosterKey 会算多条）
const recordsCovered = comps.records.filter((r) => r.stats.source === DWXQ_SOURCE).length;
const rosterKeysTotal = new Set(comps.records.map((r) => rosterKeyOf(r.heroList || []))).size;

console.log('comps records:', comps.records.length, 'rosterKeys:', rosterKeysTotal);
console.log('datawxq lineups:', byKey.size, 'rosterKeys matched:', hitKeys.size, 'records filled:', recordsCovered);
console.log('preset (beginner) skipped:', skippedPreset);

if (opts.dry) {
  console.log('--dry：不写文件');
  process.exit(0);
}

comps.notes = (comps.notes || []).map((n) =>
  n.startsWith('stats 四个字段官网不提供') || n.startsWith('stats 的 avgRank')
    ? 'stats 的 avgRank / pickRate / difficulty / equipRate 官网不提供，保持 null；登场率 / 平均名次 / 登顶率 / 前三率 / 场次 / 变阵数来自 datawxq.com（scripts/fetch_stats.mjs + merge_stats.mjs），按 rosterKey 匹配；不要用 operationDetails 推 variants，不要用 equipList 算穿戴率。'
    : n,
);
comps.statsSnapshot = {
  source: DWXQ_SOURCE,
  fetchedAt: snap.fetchedAt,
  statisticsScope: snap.statisticsScope ?? null,
  sampleCount: snap.sampleCount ?? null,
  rosterKeysMatched: hitKeys.size,
  recordsFilled: recordsCovered,
};

fs.writeFileSync(compsPath, JSON.stringify(comps, null, 2) + '\n', 'utf8');
console.log('written:', path.relative(ROOT, compsPath), 'bytes:', fs.statSync(compsPath).size);

// 末尾导出 pending-keys（在写盘之后）
exportPendingKeys();
