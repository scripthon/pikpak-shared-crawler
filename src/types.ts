// pikpak-shared-crawler/src/types.ts

/** Lifecycle status of a crawl job. */
export type CrawlStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled"
  | "interrupted";

/**
 * A single crawled file/folder row (mirrors the `files` table).
 * Scalar fields map to columns; object/array fields are stored as JSON text.
 */
export interface CrawlFileRow {
  file_id: string;
  share_id: string;
  parent_id: string;
  name: string;
  kind: string;
  size: number;
  path: string;

  mime_type?: string | null;
  file_extension?: string | null;
  user_id?: string | null;
  revision?: string | null;
  hash?: string | null;
  phase?: string | null;
  created_time?: string | null;
  modified_time?: string | null;
  user_modified_time?: string | null;
  delete_time?: string | null;
  web_content_link?: string | null;
  icon_link?: string | null;
  thumbnail_link?: string | null;
  folder_type?: string | null;
  space?: string | null;
  trashed?: boolean | number | null;
  starred?: boolean | number | null;
  writable?: boolean | number | null;

  links?: unknown;
  medias?: unknown;
  audit?: unknown;
  params?: unknown;
  apps?: unknown;
  tags?: unknown;
  reference_events?: unknown;

  /** Full original API object, so nothing is ever lost. */
  raw?: unknown;
}

/** Snapshot of a crawl job's progress. */
export interface CrawlProgress {
  jobId: string;
  shareId: string;
  status: CrawlStatus;
  items: number;
  folders: number;
  foldersDone: number;
  currentPath: string;
  errors: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
}

/** Emitted for every scraped entry (or failure) as it happens. */
export interface CrawlItemEvent {
  at: string;
  kind: string;
  folder: boolean;
  name: string;
  path: string;
  size: number;
  ok: boolean;
  error?: string;
}

/** Final result of a crawl job. */
export interface CrawlResult {
  jobId: string;
  shareId: string;
  status: CrawlStatus;
  items: number;
  folders: number;
  foldersDone: number;
}

/** Options accepted by {@link Crawler.start}. */
export interface CrawlOptions {
  /** PikPak share URL or raw share id. */
  url: string;
  /** Resolve a direct content link per file (slower, off by default). */
  resolveLinks?: boolean;
  /** Pass code for protected shares. */
  passCode?: string;
  /** Reuse an existing job id instead of generating one. */
  jobId?: string;
  /** Verbose logging. */
  debug?: boolean;
  /**
   * Store the full raw API object in `files.raw` (default true). Disable to
   * keep the database smaller.
   */
  storeRaw?: boolean;
}

/** Logger contract; pass `false` to silence. */
export interface CrawlLogger {
  log: (message: string) => void;
  warn?: (message: string) => void;
}

export type CrawlEvent = "progress" | "item" | "done" | "error" | "cancelled";
