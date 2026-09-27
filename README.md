# pikpak-shared-crawler

High-performance crawler and indexer for **public PikPak share links**. Recursively walks share hierarchies, indexes metadata into SQLite, and supports cooperative cancellation, resumable crawling, and live progress events.

Built on [`pikpak-sdk`](https://github.com/scripthon/pikpak-sdk) and `bun:sqlite`.

> **Disclaimer**: This is an **unofficial** tool designed for public share links. It is not affiliated with, sponsored by, or endorsed by PikPak.

---

## Features

- **Library & CLI**: Use as an interactive terminal CLI tool or embed as a library in any Bun application / web server.
- **Resumable Crawls**: Finished folders are tracked in `done_folders` and skipped on subsequent runs.
- **Live TUI & Logging**: Interactive terminal UI with real-time stats and recent items list; automatically falls back to plain logs when piped.
- **Full Metadata Preservation**: Stores all scalar attributes, timestamps, media streams, and original raw API objects.
- **Concurrent-Safe SQLite**: Configured with WAL mode and a 30s busy timeout for concurrent read access by API servers.

---

## Installation

```bash
bun add git+https://github.com/scripthon/pikpak-shared-crawler.git
# or via SSH
bun add git+ssh://git@github.com/scripthon/pikpak-shared-crawler.git
```

---

## CLI Usage

Run directly with Bun:

```bash
bun run crawl <share-url> [flags] [database.sqlite]
# or after installing globally / as a dependency:
pikpak-shared-crawl https://mypikpak.com/s/xxxxxxxxxxxx database.sqlite
```

### Options & Flags

| Flag / Argument | Type | Default | Description |
|---|---|---|---|
| `<share-url>` | `string` | *Required* | Public PikPak share link or raw share ID |
| `[database.sqlite]` | `string` | `database.sqlite` | Destination SQLite database file path |
| `--links` | `boolean` | `false` | Resolves direct streaming/download URL per file (slower) |
| `--no-raw` | `boolean` | `false` | Skips storing full raw API response in `files.raw` (reduces DB size) |
| `--tui` | `boolean` | `auto` | Forces real-time interactive terminal UI dashboard |
| `--no-tui` | `boolean` | `false` | Forces plain sequential log output |
| `--debug` | `boolean` | `false` | Enables verbose per-folder debugging logs |

### TUI Dashboard

When stdout is a TTY, the crawler renders an interactive terminal dashboard:
- **Stat Boxes**: Real-time counters for `FILES`, `FOLDERS`, `SUKSES`, and `ERROR`.
- **Recent Items**: Live ring-buffer showing timestamp, kind (`D`/`F`), truncated path, and human-readable file size.
- Press `q` or `Ctrl-C` to stop cooperatively.

---

## Library Usage

```typescript
import { openCrawlDb, Crawler, createCrawlClient } from "pikpak-shared-crawler";

const store = openCrawlDb("database.sqlite");
const crawler = new Crawler({ store, client: createCrawlClient() });

const job = crawler.start({ url: "https://mypikpak.com/s/xxxxxxxxxxxx" });

job.on("progress", (p) => {
  console.log(`[${p.status}] ${p.items} files, ${p.folders} folders (${p.currentPath})`);
});

job.on("item", (it) => {
  console.log(`${it.ok ? "✓" : "✗"} ${it.folder ? "[DIR]" : "[FILE]"} ${it.path}`);
});

job.on("done", (result) => {
  console.log(`Crawl completed! Total items: ${result.items}`);
});

// Await completion or cancel cooperatively
const result = await job.done;
store.close();
```

### Event Reference

| Event | Payload | Trigger |
|---|---|---|
| `progress` | `CrawlProgress` | Emitted periodically as items and folders are processed |
| `item` | `CrawlItemEvent` | Emitted for each file or folder indexed (or item-level error) |
| `done` | `CrawlResult` | Emitted when the entire crawl finishes successfully |
| `error` | `CrawlProgress & CrawlResult` | Emitted when an unrecoverable error terminates the job |
| `cancelled` | `CrawlProgress & CrawlResult` | Emitted when `job.cancel()` is triggered |

---

## Database Architecture

### SQLite Tables

| Table | Description |
|---|---|
| `shares` | Records each crawled share ID and initial crawl timestamp |
| `files` | Full index of every file and folder discovered across shares |
| `done_folders` | Resume checkpoints marking completed folders |
| `crawl_jobs` | Job lifecycle status, progress metrics, and error logs |

### `files` Schema Breakdown

| Category | Columns | Description |
|---|---|---|
| **Identity & Hierarchy** | `file_id`, `share_id`, `parent_id`, `name`, `kind`, `path` | Primary IDs, parent linkage, and full relative path |
| **File Attributes** | `size`, `mime_type`, `file_extension`, `hash`, `phase` | Byte size, MIME type, extension, GCID hash, and phase |
| **Timestamps** | `created_time`, `modified_time`, `user_modified_time`, `delete_time` | ISO 8601 creation and modification timestamps |
| **Links & Media** | `web_content_link`, `icon_link`, `thumbnail_link` | Direct links, thumbnail images, and file icons |
| **Status Flags** | `trashed`, `starred`, `writable`, `folder_type`, `space` | Audit status and folder classifications |
| **Structured Data** | `links`, `medias`, `audit`, `params`, `apps`, `tags`, `reference_events`, `raw` | JSON columns for media streams, audit info, and raw API object |

Existing databases are automatically migrated on open via `ALTER TABLE ADD COLUMN`.

---

## Store Helper APIs

`CrawlStore` provides built-in query methods for consuming the indexed data:

| Method | Return Type | Description |
|---|---|---|
| `store.getStats()` | `CrawlStats` | Total count of files, folders, shares, and combined byte size |
| `store.listShares()` | `ShareRow[]` | Lists all crawled shares and crawl dates |
| `store.listChildren(shareId, parentId, opts)` | `CrawlFileRow[]` | Lists folder contents with sorting, pagination, and folders-first |
| `store.searchFiles(keyword, opts)` | `CrawlFileRow[]` | Performs case-insensitive search across file names |
| `store.getFile(fileId)` | `CrawlFileRow \| null` | Fetches a single file record by ID |
| `store.getAncestors(fileId)` | `CrawlFileRow[]` | Resolves ancestor chain from root to parent folder |
| `store.getDescendants(folderId)` | `CrawlFileRow[]` | Recursively returns all files and subfolders under a folder |

---

## Development

```bash
# Install dependencies
bun install

# Run test suite
bun test

# Validate TypeScript types
bun run typecheck

# Build bundle
bun run build
```

---

## License

MIT
