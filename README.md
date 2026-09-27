# pikpak-shared-crawler

Crawler/indexer for **public PikPak share links**. Walks a share link, stores
every file/folder into SQLite, supports resume, cancellation and progress
events. Built on [`pikpak-sdk`](https://github.com/scripthon/pikpak-sdk) and
`bun:sqlite`.

- Library-first (no HTTP/UI): usable from a CLI, a web API, or any Bun app.
- Resumable: finished folders are recorded in `done_folders` and skipped on re-run.
- Progress: `progress` events + persisted `crawl_jobs` rows.

## Install

```sh
bun add git+ssh://git@github.com/scripthon/pikpak-shared-crawler.git
```

## CLI

```sh
bun run crawl <share-url> [--links] [--debug] [--no-raw] [--tui|--no-tui] [database.sqlite]
# or after install:
pikpak-shared-crawl https://mypikpak.com/s/xxxxxxxxxxxx database.sqlite
```

`--links` also resolves a direct download URL per file (slower).
`--no-raw` skips storing the full raw API object (smaller database).

### TUI

When stdout is a TTY the crawler renders a live terminal UI: stat boxes for
**FILES / FOLDERS / SUKSES / ERROR** plus a **TERBARU** list of recent items
(timestamp, `D`/`F`, path, size). Long names are truncated width-aware, keeping
the basename and extension (`…/13V/video_042.mp4`). Use `q` / `Ctrl-C` to stop.

- `--tui` forces the TUI, `--no-tui` forces plain logs.
- `--debug` also uses plain logs (per-folder detail lines).
- Falls back to ASCII box-drawing when the locale is not UTF-8.
- Non-TTY output (e.g. piping to a file) automatically uses plain logs.


## Library

```ts
import { openCrawlDb, Crawler, createCrawlClient } from "pikpak-shared-crawler";

const store = openCrawlDb("database.sqlite");           // shares/files/done_folders/crawl_jobs
const crawler = new Crawler({ store, client: createCrawlClient() });

const job = crawler.start({ url: "https://mypikpak.com/s/<id>" });
job.on("progress", (p) => console.log(p.items, p.errors, p.currentPath));
job.on("item", (it) => console.log(it.at, it.ok ? "ok" : "err", it.path));
job.on("done", (r) => console.log("done", r.items));

await job.done;          // CrawlResult
job.cancel();            // cooperative cancel
store.close();
```

Or simply:

```ts
const result = await crawler.crawlShare({ url });
```

## Data model

| Table | Purpose |
|---|---|
| `shares` | one row per crawled share |
| `files` | every file/folder, with the full set of API fields |
| `done_folders` | resume markers |
| `crawl_jobs` | job status + progress (`queued\|running\|done\|error\|cancelled\|interrupted`) |

`files` stores (columns): `file_id`, `share_id`, `parent_id`, `name`, `kind`,
`size`, `path`, `mime_type`, `file_extension`, `user_id`, `revision`, `hash`,
`phase`, `created_time`, `modified_time`, `user_modified_time`, `delete_time`,
`web_content_link`, `icon_link`, `thumbnail_link`, `folder_type`, `space`,
`trashed`, `starred`, `writable`, plus JSON columns `links`, `medias`, `audit`,
`params`, `apps`, `tags`, `reference_events` and `raw` (the complete original
API object).

Existing databases are migrated automatically: missing columns are added with
`ALTER TABLE` on open. Rows crawled before a migration have `NULL` in the new
columns until they are re-crawled.

Read helpers: `getStats`, `listShares`, `listChildren`, `searchFiles`,
`getFile`, `getAncestors`, `getDescendants`.

## Notes

- Public shares are crawled anonymously. To crawl as an account, pass explicit
  tokens: `createCrawlClient({ accessToken, refreshToken, deviceId })`.
- `bun:sqlite` runs in WAL mode with a 30s busy timeout, so multiple
  processes (e.g. a web API) can read the same file concurrently.
- `storeRaw: false` (or CLI `--no-raw`) keeps only the scalar/JSON columns
  above and skips the `raw` blob if you want a smaller database.

## Development

```sh
bun install
bun test
bun run typecheck
```
