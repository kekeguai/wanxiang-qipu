# scripts/ CLI 契约

> 用法段落由各脚本的 `USAGE` 常量自动摘录；改脚本时请同步本文件。

## 用法

### `scripts/fetch_stats.mjs`

```text
usage: node scripts/fetch_stats.mjs [--out <json>] [--max-pages 40]
```

### `scripts/fetch_variants.mjs`

```text
usage: node scripts/fetch_variants.mjs [--out <json>] [--keys-file <json>] [--expect-version <v>] [--gap <ms>] [--max-retry <n>] [--proxy <url>]
```

### `scripts/merge_stats.mjs`

```text
usage: node scripts/merge_stats.mjs [--in <json>] [--dry] [--allow-partial] [--emit-pending]
```

### `scripts/merge_variants.mjs`

```text
usage: node scripts/merge_variants.mjs [--in <json>] [--dry] [--allow-partial]
```

## 主要退出码

| 脚本 | 码 | 含义 |
|---|---|---|
| fetch_variants.mjs | 0 | 待抓清单为空，或未中止且批次正常结束。部分 key 失败时也可能返回 0，请检查输出的 `failed`。 |
| fetch_variants.mjs | 2 | 参数不合法，或 `--keys-file` 缺失、无法读取或格式不合法。 |
| fetch_variants.mjs | 1 | 页面请求模板的版本与 `--expect-version` 不符、全部 key 失败（未中止），或发生运行错误。 |
| fetch_variants.mjs | 3 | 命中风控，立即中止窗口、不重试；写出结果并通过不变量检查后退出。 |
| merge_stats.mjs | 1 | 输入快照不完整且未加 `--allow-partial`，或输入无效。 |
| merge_variants.mjs | 1 | 变阵覆盖不完整且未加 `--allow-partial`，或存在失败记录、结构校验不通过。 |

四个脚本均支持 `--help`（退出 0）。`--allow-partial` 只放行覆盖不完整，不豁免结构校验。

## 待抓清单的生成

`merge_stats.mjs --emit-pending` 只读取现有 `data/comps.json` 并导出 `snapshots/probe-variants/pending-keys.json`，不合并统计。
清单是排序后的 `rosterKey` 字符串数组，只包含已有 datawxq 统计、尚无变阵且未列入永久跳过表的 key。
`fetch_variants.mjs` 需通过 `--keys-file` 指定清单。缺参会在启动 Chrome 前被拒绝，不会产生站点请求。
命中风控即停止；不要切换代理、并发抓取或缩短请求间隔来继续该窗口。

## 已跟踪的审计文件

- `snapshots/probe-variants/fetch-attempt-2026-11-22-1459.json`
- `snapshots/probe-variants/fetch-block-2026-11-22.json`
- `snapshots/probe-variants/heroes-coverage-gap-2026-11-21.json`
- `snapshots/probe-variants/known-skip-keys.json`
- `snapshots/probe-variants/merge-gaps-2026-11-21T1458.json`
- `snapshots/probe-variants/merge-report-2026-11-21T1455.json`
- `snapshots/probe-variants/variants-backlog-2026-11-22.json`

`known-skip-keys.json` 是永久跳过表，`keys` 数组的条目含 `rosterKey` 和 `reason`。
当前原因包括 `parent-roster-mismatch` 和 `over-caliber`。延期与暂停的 key 见 `variants-backlog-*.json`。

## CI

- `.github/workflows/verify.yml`：PR、推送 `main` 和手动触发。Linux job 运行 `validate.mjs`、站点与 UI 校验、
  copilot 回放、README 一致性检查和变阵不变量回归（26 项）。本地可运行 `npm run test:invariants`。
- `.github/workflows/auto-update.yml`：定时触发已暂停，只保留 `workflow_dispatch`。CI 中官方源反复超时，根因待日志定位。
