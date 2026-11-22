// 风控识别、失败去重、抓取窗口记账不变量。纯函数，无网络、无浏览器依赖。
import fs from 'node:fs';

export const ANTI_BOT_PATTERNS = [
  /请求参数异常/,
  /系统异常/,
  /请联系站长/,
  /风控/,
  /访问过于频繁/,
  /\b42000\b/,
  /rate.?limit/i,
];

export class AntiBotError extends Error {
  constructor(message, info = {}) {
    super(String(message));
    this.name = 'AntiBotError';
    this.key = info.key || '';
    this.raw = info.raw || '';
  }
}

export class InvariantError extends Error {
  constructor(problems) {
    const list = Array.isArray(problems) ? problems : [String(problems)];
    super(list.join('；'));
    this.name = 'InvariantError';
    this.problems = list;
  }
}

export const isAntiBotMessage = (text) =>
  typeof text === 'string' && text.length > 0 && ANTI_BOT_PATTERNS.some((re) => re.test(text));

// 同一 rosterKey 只保留第一条失败记录。返回 kept / dropped 两份，便于把去重事实写进证据。
// 空 rosterKey 原样保留在 kept 里，交给 assembleOutput 硬拒绝。
export function dedupeFailures(failures = []) {
  const seen = new Set();
  const kept = [];
  const dropped = [];
  for (const rec of failures) {
    const k = String(rec?.rosterKey ?? '').trim();
    if (k && seen.has(k)) {
      dropped.push(k);
      continue;
    }
    if (k) seen.add(k);
    kept.push(rec);
  }
  return { kept, dropped };
}

export function assembleOutput({
  keys = [],
  items = [],
  failures = [],
  attemptedKeys = [],
  outPath,
  meta = {},
  aborted = false,
  abortReason = '',
  writeFile = fs.writeFileSync,
} = {}) {
  if (!outPath) throw new Error('assembleOutput: 缺 outPath');

  const pre = [];

  if (!Array.isArray(keys) || keys.length === 0) pre.push('keys 为空或不是数组');
  const keyInput = Array.isArray(keys) ? keys : [];
  const keySet = new Set();
  for (const raw of keyInput) {
    const k = String(raw ?? '').trim();
    if (!k) {
      pre.push('keys 里有空 rosterKey');
      continue;
    }
    if (keySet.has(k)) pre.push(`keys 里重复的 rosterKey：${k}`);
    keySet.add(k);
  }

  // 每条记录必须带非空 rosterKey（对原始列表检查）
  const idsOf = (list, label) => {
    const ids = [];
    for (const rec of list) {
      const k = String(rec?.rosterKey ?? '').trim();
      if (!k) pre.push(`${label} 里有缺 rosterKey 的记录`);
      ids.push(k);
    }
    return ids;
  };
  const itemInput = Array.isArray(items) ? items : [];
  const failureInput = Array.isArray(failures) ? failures : [];
  const rawItemIds = idsOf(itemInput, 'items');
  const rawFailIds = idsOf(failureInput, 'failures');

  // items 内部不许重复
  const seenItems = new Set();
  for (const k of rawItemIds) {
    if (!k) continue;
    if (seenItems.has(k)) pre.push(`items 里重复的 rosterKey：${k}`);
    seenItems.add(k);
  }

  // 外来 key：对原始列表检查，避免「重复 → 去重」把外来 key 掩盖掉
  for (const k of [...rawItemIds, ...rawFailIds]) {
    if (k && !keySet.has(k)) pre.push(`记录里的 rosterKey 不在请求清单：${k}`);
  }

  // 失败记录重复是已知缺陷（同一 key 被记两次），内部去重后再对账；去重事实写进输出。
  const { kept: dedupedFailures, dropped: droppedFailIds } = dedupeFailures(failureInput);

  // 记一次账：items 内部已查过，这里只查 items 与 failures 之间
  const accounted = new Set();
  for (const k of rawItemIds) if (k) accounted.add(k);
  for (const rec of dedupedFailures) {
    const k = String(rec?.rosterKey ?? '').trim();
    if (!k) continue;
    if (accounted.has(k)) pre.push(`同一 rosterKey 被重复记账：${k}（既成功又失败）`);
    accounted.add(k);
  }

  if (aborted && !abortReason) pre.push('aborted=true 但 abortReason 为空');

  if (pre.length) throw new InvariantError(pre);

  const attempted = new Set(
    (Array.isArray(attemptedKeys) ? attemptedKeys : [])
      .map((k) => String(k ?? '').trim())
      .filter(Boolean),
  );
  const unattempted = [...keySet].filter((k) => !attempted.has(k));
  const unattemptedAccounts = [...accounted].filter((k) => !attempted.has(k));
  const unaccountedAttempts = [...attempted].filter((k) => !accounted.has(k));

  const output = {
    ...meta,
    requested: keySet.size,
    attempted: attempted.size,
    succeeded: itemInput.length,
    withVariants: itemInput.filter((it) => (it?.variants || []).length > 0).length,
    failed: dedupedFailures.length,
    failuresDeduped: droppedFailIds.length,
    failuresDedupedKeys: [...new Set(droppedFailIds)],
    unattempted: unattempted.length,
    unaccountedAttempts: unaccountedAttempts.length,
    failures: dedupedFailures,
    items: itemInput,
    aborted: Boolean(aborted),
    abortReason: aborted ? abortReason : '',
  };

  // 先落盘，再判「尝试 ↔ 记账」；对不上时证据已经在盘上。
  writeFile(outPath, `${JSON.stringify(output, null, 2)}\n`);

  const post = [];
  for (const k of unattemptedAccounts) post.push(`已记账但未标记为尝试：${k}`);
  for (const k of unaccountedAttempts) post.push(`已尝试但未记账：${k}`);
  if (aborted) {
    if (!abortReason) post.push('aborted=true 但 abortReason 为空');
  } else {
    if (unattempted.length) post.push(`完整窗口却有未尝试的 key：${unattempted.join(', ')}`);
    if (itemInput.length + dedupedFailures.length !== keySet.size) {
      post.push(
        `记账不完整：items(${itemInput.length}) + failures(${dedupedFailures.length}) !== keys(${keySet.size})`,
      );
    }
  }
  if (post.length) throw new InvariantError(post);
  return output;
}
