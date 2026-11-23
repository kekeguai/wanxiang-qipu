import { isAntiBotMessage, dedupeFailures, assembleOutput, InvariantError } from './variant-invariants.mjs';

let pass = 0, fail = 0;
const ok = (name, condition, detail) => {
  if (condition) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
};
const W = () => {
  const box = { wrote: null };
  box.fn = (p, t) => { box.wrote = { p, t }; };
  return box;
};

// 1-5 风控识别
ok('antibot 系统异常', isAntiBotMessage('系统异常，请联系站长协助处理~'));
ok('antibot 42000', isAntiBotMessage('HTTP 42000'));
ok('antibot 请求参数异常（恢复的旧模式）', isAntiBotMessage('请求参数异常'));
ok('antibot 正常响应不误判', !isAntiBotMessage('{"variants":[]}'));
ok('antibot 空串', !isAntiBotMessage(''));

// 6 去重
const ded = dedupeFailures([
  { rosterKey: 'A', n: 1 },
  { rosterKey: 'A', n: 2 },
  { rosterKey: 'B' },
]);
ok('dedupe 同 key 只留第一条',
  ded.kept.length === 2 && ded.kept[0].n === 1 && ded.dropped.length === 1 && ded.dropped[0] === 'A',
  ded);

// 7-9 正常完整窗口
let b = W();
const r1 = assembleOutput({
  keys: ['A', 'B'],
  items: [{ rosterKey: 'A', variants: [1, 2] }],
  failures: [{ rosterKey: 'B' }, { rosterKey: 'B' }],
  attemptedKeys: ['A', 'B'],
  outPath: 'X.json',
  writeFile: b.fn,
  meta: { batch: { selection: 'keys-file' } },
});
ok('完整窗口 succeeded=1 failed=1', r1.succeeded === 1 && r1.failed === 1, r1);
ok('完整窗口失败已去重且事实落盘字段存在',
  r1.failures.length === 1 && r1.failuresDeduped === 1 &&
  JSON.stringify(r1.failuresDedupedKeys) === JSON.stringify(['B']));
ok('完整窗口已写盘且 unattempted 为空',
  !!b.wrote && JSON.parse(b.wrote.t).succeeded === 1 && r1.unattempted === 0);

// 10-11 历史缺陷：2 key 全失败且各记两次，去重后 0+2===2
b = W();
let threw = null;
let r2 = null;
try {
  r2 = assembleOutput({
    keys: ['A', 'B'],
    items: [],
    failures: [{ rosterKey: 'A' }, { rosterKey: 'A' }, { rosterKey: 'B' }, { rosterKey: 'B' }],
    attemptedKeys: ['A', 'B'],
    outPath: 'H.json',
    writeFile: b.fn,
  });
} catch (e) { threw = e; }
ok('历史缺陷已修复：0+2===2 不抛',
  threw === null && r2 && r2.failed === 2 && r2.succeeded === 0,
  threw ? threw.message : r2);
ok('历史缺陷场景文件已写盘', !!b.wrote && JSON.parse(b.wrote.t).failed === 2);

// 12-14 完整窗口里出现未请求 key：写盘前拒绝
b = W();
threw = null;
try {
  assembleOutput({
    keys: ['A'],
    items: [],
    failures: [{ rosterKey: 'C' }],
    attemptedKeys: ['A'],
    outPath: 'Y.json',
    writeFile: b.fn,
  });
} catch (e) { threw = e; }
ok('完整窗口含未请求 key 触发 InvariantError', threw instanceof InvariantError, threw && threw.message);
ok('外来 key 写盘前拒绝', b.wrote === null);
ok('外来 key 错误保留具体 key', threw && /C/.test(threw.message));

// 15-16 写盘前硬拒绝：items 重复、keys 重复
b = W();
threw = null;
try {
  assembleOutput({
    keys: ['A', 'A'],
    items: [{ rosterKey: 'A' }, { rosterKey: 'A' }],
    failures: [],
    outPath: 'Z.json',
    writeFile: b.fn,
  });
} catch (e) { threw = e; }
ok('keys 重复直接抛', threw instanceof InvariantError, threw && threw.message);
ok('keys 重复不写盘', b.wrote === null);

// 17-18 写盘前硬拒绝：item 缺 rosterKey
b = W();
threw = null;
try {
  assembleOutput({
    keys: ['A'],
    items: [{ variants: [1] }],
    failures: [{ rosterKey: 'A' }],
    attemptedKeys: ['A'],
    outPath: 'E.json',
    writeFile: b.fn,
  });
} catch (e) { threw = e; }
ok('item 缺 rosterKey 直接抛', threw instanceof InvariantError, threw && threw.message);
ok('item 缺 rosterKey 不写盘', b.wrote === null);

// 19-20 写盘前硬拒绝：failure 缺 rosterKey
b = W();
threw = null;
try {
  assembleOutput({
    keys: ['A'],
    items: [],
    failures: [{ error: 'boom' }],
    attemptedKeys: ['A'],
    outPath: 'F.json',
    writeFile: b.fn,
  });
} catch (e) { threw = e; }
ok('failure 缺 rosterKey 直接抛', threw instanceof InvariantError, threw && threw.message);
ok('failure 缺 rosterKey 不写盘', b.wrote === null);

// 21 单 key 中止：恰好记账
const r6 = assembleOutput({
  keys: ['A'],
  items: [],
  failures: [{ rosterKey: 'A' }],
  attemptedKeys: ['A'],
  outPath: 'R6.json',
  writeFile: W().fn,
  aborted: true,
  abortReason: 'anti-bot',
});
ok('单 key 中止：aborted 与原因正确', r6.aborted === true && r6.abortReason === 'anti-bot', r6);

// 22-23 风控中止窗口：3 key 只试第一个
let r7 = null;
let threw7 = null;
try {
  r7 = assembleOutput({
    keys: ['A', 'B', 'C'],
    items: [],
    failures: [{ rosterKey: 'A', error: 'anti-bot' }],
    attemptedKeys: ['A'],
    outPath: 'R7.json',
    writeFile: W().fn,
    aborted: true,
    abortReason: 'anti-bot',
  });
} catch (e) { threw7 = e; }
ok('中止窗口 3 key 只试 1 个不抛', threw7 === null, threw7 && threw7.message);
ok('中止窗口计数与 unattempted 正确、未伪造失败',
  !!r7 && r7.requested === 3 && r7.attempted === 1 && r7.succeeded === 0 &&
  r7.failed === 1 && r7.unattempted === 2 && r7.failures.length === 1,
  r7);

// 24 探针与循环重复尝试同一 key：attempted 按 Set 去重
const r8 = assembleOutput({
  keys: ['A', 'B', 'C'],
  items: [],
  failures: [{ rosterKey: 'A' }],
  attemptedKeys: ['A', 'A'],
  outPath: 'R8.json',
  writeFile: W().fn,
  aborted: true,
  abortReason: 'anti-bot',
});
ok('重复尝试同一 key 只计一次', r8.attempted === 1 && r8.unattempted === 2, r8);

// 25 已记账但未标记为尝试：先写盘，再抛 InvariantError
b = W();
threw = null;
try {
  assembleOutput({
    keys: ['k0'],
    items: [{ rosterKey: 'k0' }],
    failures: [],
    attemptedKeys: [],
    outPath: 'K0.json',
    writeFile: b.fn,
    aborted: false,
  });
} catch (e) { threw = e; }
ok('已记账但未标记为尝试：先写盘后抛',
  threw instanceof InvariantError && /已记账但未标记为尝试：k0/.test(threw.message) && b.wrote !== null,
  threw && threw.message);

// 26 失败去重事实必须落盘
b = W();
let r9 = null;
let threw9 = null;
try {
  r9 = assembleOutput({
    keys: ['A', 'B'],
    items: [{ rosterKey: 'A' }],
    failures: [{ rosterKey: 'B' }, { rosterKey: 'B' }],
    attemptedKeys: ['A', 'B'],
    outPath: 'K26.json',
    writeFile: b.fn,
    aborted: false,
  });
} catch (e) { threw9 = e; }
const disk26 = b.wrote && JSON.parse(b.wrote.t);
ok('失败去重事实必须落盘',
  threw9 === null && r9 && disk26 && disk26.failed === 1 &&
  disk26.failuresDeduped === 1 && JSON.stringify(disk26.failuresDedupedKeys) === JSON.stringify(['B']),
  threw9 ? threw9.message : disk26);

console.log(`RESULT pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
