// 抓 datawxq.com 的变阵（variants），只抓已经拿到统计数据的阵容。
// 用法：node scripts/fetch_variants.mjs [--out <json>] [--keys-file <json>] [--expect-version v261112] [--gap 2500] [--max-retry 4] [--proxy http://127.0.0.1:7890]
//
// 签名由页面自己算：脚本在 Runtime.evaluate 里 import 页面已经加载的 seo 模块，
// 调用它导出的请求封装（内部生成 t/did/nonce/signature）。
// 不要在 Node 里重放请求头 —— nonce 一次性，重放必返 42000。
//
// 只读：不写 data/ 下任何文件。输出默认落 snapshots/probe-variants/fetch-variants.json（已 gitignore）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const USAGE = 'usage: node scripts/fetch_variants.mjs [--out <json>] [--keys-file <json>] [--expect-version <v>] [--gap <ms>] [--max-retry <n>] [--proxy <url>]';
const opts = {
  out: path.join(ROOT, 'snapshots', 'probe-variants', 'fetch-variants.json'),
  keysFile: '',
  expectVersion: 'v261112',
  gap: 2500,
  maxRetry: 4,
  proxy: '',
};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) {
        console.error(USAGE);
        process.exit(2);
      }
      opts.out = path.resolve(v);
    } else if (a === '--proxy') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) {
        console.error(USAGE);
        process.exit(2);
      }
      opts.proxy = v;
    } else if (a === '--keys-file') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) {
        console.error(USAGE);
        process.exit(2);
      }
      opts.keysFile = v;
    } else if (a === '--expect-version') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) {
        console.error(USAGE);
        process.exit(2);
      }
      opts.expectVersion = v;
    } else if (a === '--gap' || a === '--max-retry') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) {
        console.error(USAGE);
        process.exit(2);
      }
      if (a === '--gap') opts.gap = v;
      else opts.maxRetry = v;
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
const DETAIL_PATH = '/wzwxq/lineups/detail';

// rosterKey：<英雄数>|<id 字符串升序>，与 datawxq 的 lineupKey / rosterKey 同构。
const rosterKeyOf = (heroList) => [heroList.length, ...heroList.map((h) => String(h.id)).sort()].join('|');

const compsPath = path.join(ROOT, 'data', 'comps.json');
const comps = JSON.parse(fs.readFileSync(compsPath, 'utf8'));

// 只抓已经有 datawxq 统计的阵容：没统计的连样本都不够，变阵更不会有。
const targets = new Map(); // rosterKey -> 记录数
for (const r of comps.records) {
  if (r?.stats?.source !== DWXQ_SOURCE) continue;
  const k = rosterKeyOf(r.heroList || []);
  targets.set(k, (targets.get(k) || 0) + 1);
}
if (!targets.size) {
  console.error('data/comps.json 里没有 stats.source === "datawxq.com" 的记录，先跑 fetch_stats.mjs + merge_stats.mjs');
  process.exit(1);
}

// 分批抓取：必须用 --keys-file 传入 rosterKey 数组（pending-keys.json），只抓这些 key。
// 校验在启动 Chrome 之前完成，坏输入不会产生任何站点请求。
if (!opts.keysFile) {
  console.error('必须用 --keys-file 指定 pending-keys.json（先跑 merge_stats.mjs 生成）');
  process.exit(2);
}
const keysPath = path.resolve(opts.keysFile);
let list;
try {
  list = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
} catch (e) {
  console.error(`读不了 --keys-file：${keysPath}（${e.message}）`);
  process.exit(2);
}
if (!Array.isArray(list) || !list.every((k) => typeof k === 'string' && k)) {
  console.error('--keys-file 必须是字符串数组（rosterKey）');
  process.exit(2);
}
if (list.length === 0) {
  console.error('--keys-file 为空，无待抓 key');
  process.exit(0);
}
if (new Set(list).size !== list.length) {
  console.error('--keys-file 里有重复的 rosterKey');
  process.exit(2);
}
const selectedKeys = list;

const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chrome) {
  console.error('找不到 Chrome，可用 CHROME_PATH 指定');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9000 + Math.floor(Math.random() * 700);
// 固定 profile：localStorage 里的 wxq-device-id（did）会保留下来，重跑时还是同一台设备，
// 不会每次都当新访客重新握手。
const userDataDir = path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'wx-variants-profile');
const proc = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--lang=zh-CN',
  `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`,
  '--window-size=1600,2400',
  // 指定代理时整页流量走它；本地回环（CDP）除外，否则命令行连不上浏览器。
  ...(opts.proxy ? [`--proxy-server=${opts.proxy}`, '--proxy-bypass-list=<-loopback>'] : []),
  // 禁用 WebRTC IP 泄露
  '--disable-features=WebRtcHideLocalIpsWithMdns',
  '--enforce-webrtc-ip-permission-check',
  'about:blank',
], { stdio: 'ignore' });

let targetsList = null;
for (let i = 0; i < 120 && !targetsList; i++) {
  try {
    targetsList = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch {
    await sleep(250);
  }
}
if (!targetsList) {
  proc.kill();
  console.error('Chrome 没起来');
  process.exit(1);
}

const ws = new WebSocket(targetsList.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let msgId = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++msgId;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    return { __exc: String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 400) };
  }
  return r.result?.result?.value;
};

const shutdown = (code) => {
  try { ws.close(); } catch {}
  try { proc.kill(); } catch {}
  process.exit(code);
};

await send('Page.enable');
await send('Runtime.enable');

// 挂钩 fetch，记下页面自己发出的 search 请求体，作为 detail 的模板（version / time 等跟页面一致）。
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
window.__wxqSearchBody = '';
(() => {
  const orig = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url);
    if (url && url.includes('/wzwxq/lineups/search') && init && init.body) {
      window.__wxqSearchBody = String(init.body);
    }
    return orig.apply(this, arguments);
  };
})();
`,
});

console.log('targets:', targets.size, '个 rosterKey；本批:', selectedKeys.length, opts.keysFile ? '（--keys-file）' : '（全部）');

await send('Page.navigate', { url: 'https://www.datawxq.com/lineups' });
await sleep(15000);

const searchBodyRaw = await ev('window.__wxqSearchBody || ""');
let base = null;
try {
  base = JSON.parse(searchBodyRaw);
} catch {}
if (!base) {
  console.error('页面没有发出 /wzwxq/lineups/search，拿不到请求模板（站点可能整体异常）');
  shutdown(1);
}
delete base.page;
delete base.lineupKey;
if (base.version !== opts.expectVersion) {
  console.error(`页面请求模板的 version 是 ${JSON.stringify(base.version)}，不是 ${opts.expectVersion}。站点改版了，先确认口径再跑；确认后可用 --expect-version 显式放行。`);
  shutdown(1);
}

// seo 模块的 URL 会随发布变（index-Bw-LrfrL.js 里的 hash）。从已加载资源里找带签名逻辑的那个。
const modulePath = await ev(`(async () => {
  const urls = performance.getEntriesByType('resource').map((e) => e.name)
    .filter((n) => n.indexOf('/assets/') >= 0 && n.indexOf('.js') >= 0);
  for (const u of urls) {
    try {
      const p = new URL(u).pathname;
      const t = await (await fetch(p)).text();
      if (t.includes('wxq-device-id') && t.includes('/wzwxq/lineups/detail')) return p;
    } catch {}
  }
  return '';
})()`);
if (typeof modulePath !== 'string' || !modulePath) {
  console.error('没找到页面里的签名模块（assets/*.js 里没有 wxq-device-id）');
  shutdown(1);
}
console.log('signer module:', modulePath);

// 在页面上下文里调它导出的签名请求封装。导出名会随版本变，动态查找源码同时含 nonce 和 signature 的函数。
const callDetail = async (rosterKey) => {
  const body = { ...base, page: 1, pageSize: 12, lineupKey: rosterKey, detailSections: ['ordinary'] };
  const out = await ev(`(async () => {
    try {
      const m = await import(${JSON.stringify(modulePath)});
      const names = Object.keys(m).filter((n) => {
        const f = m[n];
        if (typeof f !== 'function') return false;
        const s = Function.prototype.toString.call(f);
        return s.includes('nonce') && s.includes('signature');
      });
      if (names.length !== 1) return JSON.stringify({ ok: false, err: 'signer candidates=' + names.join(',') });
      const d = await m[names[0]](${JSON.stringify(DETAIL_PATH)}, { method: 'POST', body: ${JSON.stringify(body)} });
      return JSON.stringify({ ok: true, data: d });
    } catch (e) {
      return JSON.stringify({ ok: false, err: String(e && e.message || e) });
    }
  })()`);
  if (out && typeof out === 'object' && out.__exc) return { ok: false, err: out.__exc };
  try {
    return JSON.parse(out);
  } catch {
    return { ok: false, err: `evaluate 返回值异常: ${String(out).slice(0, 200)}` };
  }
};

const isBlocked = (err) => /系统异常|42000|请求参数异常/.test(String(err || ''));
const isTooFew = (err) => /样本过少/.test(String(err || ''));

// 抓取阶段只挑字段、不造值：缺什么就留缺，缺字段由 merge_variants.mjs 报错，不在这里补 null。
const VARIANT_KEYS = ['lineupKey', 'lineupCode', 'heroes', 'addedHeroes', 'removedHeroes',
  'count', 'appearanceRate', 'avgPlacement', 'firstRate', 'top3Rate', 'similarity'];

const pickVariant = (v) => {
  const out = {};
  for (const k of VARIANT_KEYS) if (v && k in v) out[k] = v[k];
  return out;
};

const items = [];
const failures = [];
let blockedStreak = 0;
let requestCount = 0;

const keys = selectedKeys;

// 先探一次：站点把本机 IP 拒了的时候（42000），逐个重试只是白等。探不通就早退，别烧时间。
// 探通了就当成第一个 key 的结果，不再重复请求。遇风控记录失败，继续下一个。
let firstRes = null;
requestCount++;
const probeRes = await callDetail(keys[0]);
if (isBlocked(probeRes.err)) {
  console.log('探针被拒：', String(probeRes.err).slice(0, 200));
  console.log('站点风控生效，记录失败并继续。');
  failures.push({ rosterKey: keys[0], err: String(probeRes.err || 'probe-blocked') });
} else {
  firstRes = probeRes;
}

for (let idx = 0; idx < keys.length; idx++) {
  const key = keys[idx];
  let res = firstRes;
  firstRes = null;
  if (!res) {
    requestCount++;
    res = await callDetail(key);
  }

  if (res && res.ok) {
    blockedStreak = 0;
    const d = res.data || {};
    const variants = (d.variants || []).map(pickVariant);
    items.push({ rosterKey: key, variantCount: d.variantCount ?? null, variants });
    console.log(`  [${idx + 1}/${keys.length}] ${key} → variants ${variants.length}（声明 ${d.variantCount ?? '?'}）`);
  } else if (res && isTooFew(res.err)) {
    blockedStreak = 0;
    items.push({ rosterKey: key, variantCount: 0, variants: [] });
    console.log(`  [${idx + 1}/${keys.length}] ${key} → 无数据（${res.err}）`);
  } else {
    failures.push({ rosterKey: key, err: String(res?.err || 'unknown') });
    console.log(`  [${idx + 1}/${keys.length}] ${key} → 失败：${String(res?.err || '').slice(0, 200)}`);
    if (isBlocked(res?.err)) {
      console.log('遇到风控错误，记录失败并继续下一个 key。');
      blockedStreak++;
    }
  }
  if (idx < keys.length - 1) await sleep(opts.gap);
}

// 断言：requested === keys.length，succeeded + failed === requested，items 里每个 key ∈ keys
const keySet = new Set(keys);
if (items.length + failures.length !== keys.length) {
  console.error(`错误：items.length(${items.length}) + failures.length(${failures.length}) !== keys.length(${keys.length})`);
  process.exit(1);
}
for (const item of items) {
  if (!keySet.has(item.rosterKey)) {
    console.error(`错误：items 里的 ${item.rosterKey} 不在 keys 里`);
    process.exit(1);
  }
}
for (const f of failures) {
  console.error(`ERR ${f.rosterKey}: ${f.err}`);
}

const covered = items.filter((i) => i.variants.length > 0).length;
const payload = {
  source: DWXQ_SOURCE,
  endpoint: `https://api.datatft.com${DETAIL_PATH}`,
  fetchedAt: new Date().toISOString(),
  query: base,
  queryNote: '请求体由页面自己的签名封装发出（seo 模块导出的 gs/dz）；签名与 nonce 绑定，无法在 Node 里重放。',
  requested: keys.length,
  succeeded: items.length,
  withVariants: covered,
  failed: failures.length,
  requestCount,
  batch: { selection: opts.keysFile ? 'keys-file' : 'all', requestedKeys: keys.length },
  items,
  failures,
};

fs.mkdirSync(path.dirname(opts.out), { recursive: true });
fs.writeFileSync(opts.out, JSON.stringify(payload, null, 1) + '\n', 'utf8');

console.log('out:', path.relative(ROOT, opts.out) || opts.out);
console.log('rosterKeys:', keys.length, '有变阵:', covered, '失败:', failures.length, '请求次数:', requestCount);
console.log('bytes:', fs.statSync(opts.out).size);

shutdown(failures.length && !items.length ? 1 : 0);
