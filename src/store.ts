// pikpak-shared-crawler/src/store.ts
import { Database, type Statement } from "bun:sqlite";
import { join } from "node:path";
import type { CrawlFileRow, CrawlStatus } from "./types";

export interface CrawlJobRow {
  id: string;
  share_id: string;
  url: string;
  status: CrawlStatus;
  resolve_links: number;
  pass_code: string | null;
  items: number;
  folders: number;
  folders_done: number;
  errors: number;
  current_path: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
}

export interface CrawlStats {
  files: number;
  folders: number;
  size: number;
  shares: number;
}

export interface ShareRow {
  share_id: string;
  crawled_at: string;
}

export interface CreateJobInput {
  id: string;
  shareId: string;
  url: string;
  resolveLinks?: boolean;
  passCode?: string | null;
}

export interface ListChildrenOptions {
  sort?: string;
  order?: string;
  foldersFirst?: boolean;
  /** Extra SQL appended to the WHERE clause (e.g. a filter owned by the host app). */
  extraFilter?: string;
}

/** Column order for the `files` table (positional upsert). */
const FILE_COLUMNS = [
  "file_id",
  "share_id",
  "parent_id",
  "name",
  "kind",
  "size",
  "path",
  "mime_type",
  "file_extension",
  "user_id",
  "revision",
  "hash",
  "phase",
  "created_time",
  "modified_time",
  "user_modified_time",
  "delete_time",
  "web_content_link",
  "icon_link",
  "thumbnail_link",
  "folder_type",
  "space",
  "trashed",
  "starred",
  "writable",
  "links",
  "medias",
  "audit",
  "params",
  "apps",
  "tags",
  "reference_events",
  "raw",
] as const;

/** Object/array columns serialized to JSON text. */
const JSON_COLUMNS = new Set([
  "links",
  "medias",
  "audit",
  "params",
  "apps",
  "tags",
  "reference_events",
  "raw",
]);

/** Boolean columns stored as 0/1. */
const BOOL_COLUMNS = new Set(["trashed", "starred", "writable"]);

/** Lightweight projection for list/search (skips heavy JSON columns). */
const DISPLAY_COLUMNS = FILE_COLUMNS.filter((c) => !JSON_COLUMNS.has(c)).join(", ");

/** Extra columns added on top of the original minimal `files` schema. */
const EXTRA_FILES_COLUMNS: Record<string, string> = {
  mime_type: "TEXT",
  file_extension: "TEXT",
  user_id: "TEXT",
  revision: "TEXT",
  hash: "TEXT",
  phase: "TEXT",
  created_time: "TEXT",
  user_modified_time: "TEXT",
  delete_time: "TEXT",
  icon_link: "TEXT",
  thumbnail_link: "TEXT",
  folder_type: "TEXT",
  space: "TEXT",
  trashed: "INTEGER",
  starred: "INTEGER",
  writable: "INTEGER",
  links: "TEXT",
  medias: "TEXT",
  audit: "TEXT",
  params: "TEXT",
  apps: "TEXT",
  tags: "TEXT",
  reference_events: "TEXT",
  raw: "TEXT",
};

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 30000;

  CREATE TABLE IF NOT EXISTS shares (
    share_id   TEXT PRIMARY KEY,
    crawled_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS files (
    file_id    TEXT PRIMARY KEY,
    share_id   TEXT NOT NULL,
    parent_id  TEXT NOT NULL,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL,
    size       INTEGER NOT NULL DEFAULT 0,
    path       TEXT NOT NULL,
    mime_type  TEXT,
    file_extension TEXT,
    user_id    TEXT,
    revision   TEXT,
    hash       TEXT,
    phase      TEXT,
    created_time TEXT,
    modified_time TEXT,
    user_modified_time TEXT,
    delete_time TEXT,
    web_content_link TEXT,
    icon_link  TEXT,
    thumbnail_link TEXT,
    folder_type TEXT,
    space      TEXT,
    trashed    INTEGER,
    starred    INTEGER,
    writable   INTEGER,
    links      TEXT,
    medias     TEXT,
    audit      TEXT,
    params     TEXT,
    apps       TEXT,
    tags       TEXT,
    reference_events TEXT,
    raw        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_files_share ON files(share_id);
  CREATE INDEX IF NOT EXISTS idx_files_parent ON files(share_id, parent_id);
  CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);

  CREATE TABLE IF NOT EXISTS done_folders (
    share_id  TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    done_at   TEXT NOT NULL,
    PRIMARY KEY (share_id, folder_id)
  );

  CREATE TABLE IF NOT EXISTS crawl_jobs (
    id            TEXT PRIMARY KEY,
    share_id      TEXT NOT NULL,
    url           TEXT NOT NULL,
    status        TEXT NOT NULL,
    resolve_links INTEGER NOT NULL DEFAULT 0,
    pass_code     TEXT,
    items         INTEGER NOT NULL DEFAULT 0,
    folders       INTEGER NOT NULL DEFAULT 0,
    folders_done  INTEGER NOT NULL DEFAULT 0,
    errors        INTEGER NOT NULL DEFAULT 0,
    current_path  TEXT,
    error         TEXT,
    created_at    TEXT NOT NULL,
    started_at    TEXT,
    updated_at    TEXT NOT NULL,
    finished_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_crawl_jobs_share ON crawl_jobs(share_id);
`;

const SORT_COLS = {
  name: "name collate nocase",
  modified: "modified_time",
  size: "size",
} as const;

function sortCol(sort: string | undefined): string {
  return (SORT_COLS as Record<string, string>)[sort ?? "name"] ?? SORT_COLS.name;
}

function toJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function toBool(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return value ? 1 : 0;
}

/** Adds any missing columns to an existing table (idempotent migration). */
function ensureColumns(db: Database, table: string, columns: Record<string, string>): void {
  const existing = new Set(
    (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name),
  );
  for (const [name, type] of Object.entries(columns)) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}

const JOB_COLUMNS = new Set<keyof CrawlJobRow>([
  "share_id",
  "url",
  "status",
  "resolve_links",
  "pass_code",
  "items",
  "folders",
  "folders_done",
  "errors",
  "current_path",
  "error",
  "started_at",
  "updated_at",
  "finished_at",
]);

/**
 * SQLite-backed store for crawl results and job state. Owns the
 * `shares`, `files`, `done_folders` and `crawl_jobs` tables so that the CLI
 * and any host application (e.g. a web API) share one contract.
 */
export class CrawlStore {
  readonly db: Database;
  private readonly file: string;
  private readonly upsertStmt: Statement;

  constructor(file: string) {
    this.file = file;
    this.db = new Database(file);
    this.db.exec(SCHEMA);
    ensureColumns(this.db, "files", EXTRA_FILES_COLUMNS);
    ensureColumns(this.db, "crawl_jobs", { errors: "INTEGER NOT NULL DEFAULT 0" });
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_files_mime ON files(mime_type);`);

    const cols = FILE_COLUMNS.join(", ");
    const placeholders = FILE_COLUMNS.map(() => "?").join(", ");
    const updates = FILE_COLUMNS.filter((c) => c !== "file_id")
      .map((c) => `${c}=excluded.${c}`)
      .join(", ");
    this.upsertStmt = this.db.prepare(
      `INSERT INTO files (${cols}) VALUES (${placeholders})
       ON CONFLICT(file_id) DO UPDATE SET ${updates}`,
    );
  }

  static open(file: string): CrawlStore {
    return new CrawlStore(file);
  }

  close(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // ignore
    }
    this.db.close();
  }

  // ---- writes ----

  upsertFile(row: CrawlFileRow): void {
    const r = row as unknown as Record<string, unknown>;
    const values = FILE_COLUMNS.map((col) => {
      const value = r[col];
      if (JSON_COLUMNS.has(col)) return toJson(value);
      if (BOOL_COLUMNS.has(col)) return toBool(value);
      if (value === undefined) return null;
      return value;
    });
    this.upsertStmt.run(...(values as any[]));
  }

  upsertShare(shareId: string, crawledAt: string = new Date().toISOString()): void {
    this.db
      .prepare(
        `INSERT INTO shares (share_id, crawled_at) VALUES (?, ?)
         ON CONFLICT(share_id) DO UPDATE SET crawled_at=excluded.crawled_at`,
      )
      .run(shareId, crawledAt);
  }

  isFolderDone(shareId: string, folderId: string): boolean {
    const row = this.db
      .query(`SELECT 1 AS done FROM done_folders WHERE share_id = ? AND folder_id = ?`)
      .get(shareId, folderId) as { done: number } | null;
    return row !== null;
  }

  markFolderDone(shareId: string, folderId: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO done_folders (share_id, folder_id, done_at) VALUES (?, ?, ?)`,
      )
      .run(shareId, folderId, new Date().toISOString());
  }

  // ---- jobs ----

  createJob(input: CreateJobInput): CrawlJobRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO crawl_jobs (id, share_id, url, status, resolve_links, pass_code, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.shareId,
        input.url,
        input.resolveLinks ? 1 : 0,
        input.passCode ?? null,
        now,
        now,
      );
    return this.getJob(input.id)!;
  }

  updateJob(id: string, patch: Partial<Omit<CrawlJobRow, "id" | "created_at">>): void {
    const entries = Object.entries(patch).filter(([k]) =>
      JOB_COLUMNS.has(k as keyof CrawlJobRow),
    );
    if (!entries.length) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(", ");
    const values = entries.map(([, v]) => (v === undefined ? null : v));
    this.db.prepare(`UPDATE crawl_jobs SET ${sets} WHERE id = ?`).run(...values, id);
  }

  getJob(id: string): CrawlJobRow | null {
    return this.db.query(`SELECT * FROM crawl_jobs WHERE id = ?`).get(id) as CrawlJobRow | null;
  }

  listJobs(limit = 50): CrawlJobRow[] {
    return this.db
      .query(`SELECT * FROM crawl_jobs ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as CrawlJobRow[];
  }

  /** Marks jobs left running/queued (e.g. after a crash) as interrupted. */
  markInterrupted(): number {
    const res = this.db
      .prepare(
        `UPDATE crawl_jobs SET status = 'interrupted', updated_at = ?
         WHERE status IN ('running', 'queued')`,
      )
      .run(new Date().toISOString());
    return Number(res.changes ?? 0);
  }

  // ---- reads ----

  getStats(): CrawlStats {
    return this.db
      .query(
        `SELECT
           (SELECT count(*) FROM files WHERE kind != 'drive#folder') AS files,
           (SELECT count(*) FROM files WHERE kind = 'drive#folder') AS folders,
           (SELECT coalesce(sum(size), 0) FROM files WHERE kind != 'drive#folder') AS size,
           (SELECT count(*) FROM shares) AS shares`,
      )
      .get() as CrawlStats;
  }

  listShares(): ShareRow[] {
    return this.db
      .query(`SELECT share_id, crawled_at FROM shares ORDER BY crawled_at DESC`)
      .all() as ShareRow[];
  }

  listChildren(
    shareId: string,
    parentId: string,
    limit = 100,
    offset = 0,
    options: ListChildrenOptions = {},
  ): { items: CrawlFileRow[]; total: number } {
    const col = sortCol(options.sort);
    const dir = options.order === "desc" ? "desc" : "asc";
    const folderClause =
      options.foldersFirst === false ? "" : "case when kind = 'drive#folder' then 0 else 1 end, ";
    const extra = options.extraFilter ? ` ${options.extraFilter}` : "";

    const items = this.db
      .query(
        `SELECT ${DISPLAY_COLUMNS}
         FROM files
         WHERE share_id = ? AND parent_id = ?${extra}
         ORDER BY ${folderClause}${col} ${dir}
         LIMIT ? OFFSET ?`,
      )
      .all(shareId, parentId, limit, offset) as CrawlFileRow[];

    const { c } = this.db
      .query(
        `SELECT count(*) AS c FROM files WHERE share_id = ? AND parent_id = ?${extra}`,
      )
      .get(shareId, parentId) as { c: number };

    return { items, total: c };
  }

  searchFiles(
    q: string,
    limit = 100,
    offset = 0,
    options: { extraFilter?: string } = {},
  ): { items: CrawlFileRow[]; total: number } {
    const like = `%${q}%`;
    const extra = options.extraFilter ? ` ${options.extraFilter}` : "";

    const items = this.db
      .query(
        `SELECT ${DISPLAY_COLUMNS}
         FROM files
         WHERE (name LIKE ? OR path LIKE ?)${extra}
         ORDER BY size DESC
         LIMIT ? OFFSET ?`,
      )
      .all(like, like, limit, offset) as CrawlFileRow[];

    const { c } = this.db
      .query(`SELECT count(*) AS c FROM files WHERE (name LIKE ? OR path LIKE ?)${extra}`)
      .get(like, like) as { c: number };

    return { items, total: c };
  }

  getFile(id: string): CrawlFileRow | null {
    return this.db.query(`SELECT * FROM files WHERE file_id = ?`).get(id) as CrawlFileRow | null;
  }

  getAncestors(id: string): { id: string; name: string }[] {
    const chain: { id: string; name: string }[] = [];
    const seen = new Set<string>();
    let cur = this.getFile(id);
    while (cur && cur.parent_id && !seen.has(cur.parent_id)) {
      seen.add(cur.parent_id);
      const parent = this.getFile(cur.parent_id);
      if (!parent) break;
      chain.unshift({ id: parent.file_id, name: parent.name });
      cur = parent;
    }
    return chain;
  }

  /** Returns the given ids plus all descendants (recursive). */
  getDescendants(ids: string[]): { file_id: string; share_id: string }[] {
    if (!ids.length) return [];
    const ph = ids.map(() => "?").join(",");
    return this.db
      .query(
        `WITH RECURSIVE sub(file_id, share_id) AS (
           SELECT file_id, share_id FROM files WHERE file_id IN (${ph})
           UNION ALL
           SELECT f.file_id, f.share_id FROM files f JOIN sub s ON f.parent_id = s.file_id
         )
         SELECT file_id, share_id FROM sub`,
      )
      .all(...ids) as { file_id: string; share_id: string }[];
  }

  get path(): string {
    return this.file;
  }
}

/** Opens (and initializes) a crawl store at the given SQLite path. */
export function openCrawlDb(file = join(process.cwd(), "database.sqlite")): CrawlStore {
  return CrawlStore.open(file);
}
