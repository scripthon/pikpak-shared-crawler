// pikpak-shared-crawler/src/engine.ts
import { parseShareUrl } from "pikpak-sdk";
import type { ShareDetailResponse } from "pikpak-sdk";
import type { CrawlStore } from "./store";
import type {
  CrawlEvent,
  CrawlItemEvent,
  CrawlLogger,
  CrawlOptions,
  CrawlProgress,
  CrawlResult,
  CrawlStatus,
} from "./types";

const FOLDER_KIND = "drive#folder";
const PERSIST_MS = 300;

/** Statuses a job can settle into. */
type TerminalStatus = Extract<CrawlStatus, "done" | "error" | "cancelled">;

/** Minimal share-service surface the engine needs (satisfied by pikpak-sdk). */
export interface CrawlShareService {
  listShareFiles(
    shareId: string,
    options?: {
      parentId?: string;
      passCodeToken?: string;
      pageToken?: string;
      limit?: number;
      filters?: Record<string, any>;
    },
  ): Promise<ShareDetailResponse>;
  getShareFileInfo(shareId: string, fileId: string, passCodeToken?: string): Promise<any>;
  getPassCodeToken(shareId: string, passCode?: string): Promise<string>;
}

/** Minimal client surface the engine needs (satisfied by pikpak-sdk PikPakClient). */
export interface CrawlClient {
  share: CrawlShareService;
}

export interface CrawlerOptions {
  store: CrawlStore;
  client: CrawlClient;
  /** Pass a logger or `false` (default) to silence output. */
  logger?: CrawlLogger | false;
}

/**
 * A running (or finished) crawl. Emits `progress`, then one terminal
 * `done` | `error` | `cancelled` event.
 */
export class CrawlJob {
  readonly id: string;
  readonly url: string;
  readonly shareId: string;
  readonly resolveLinks: boolean;
  readonly progress: CrawlProgress;
  /** Resolves when the crawl settles; never rejects. */
  done!: Promise<CrawlResult>;

  private cancelled = false;
  private readonly handlers = new Map<CrawlEvent, Set<(payload: any) => void>>();

  constructor(id: string, url: string, shareId: string, resolveLinks: boolean) {
    this.id = id;
    this.url = url;
    this.shareId = shareId;
    this.resolveLinks = resolveLinks;
    const now = new Date().toISOString();
    this.progress = {
      jobId: id,
      shareId,
      status: "queued",
      items: 0,
      folders: 0,
      foldersDone: 0,
      currentPath: "",
      errors: 0,
      error: null,
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      finishedAt: null,
    };
  }

  on(event: CrawlEvent, listener: (payload: any) => void): this {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(listener);
    return this;
  }

  off(event: CrawlEvent, listener: (payload: any) => void): this {
    this.handlers.get(event)?.delete(listener);
    return this;
  }

  emit(event: CrawlEvent, payload: any): void {
    for (const listener of this.handlers.get(event) ?? []) listener(payload);
  }

  cancel(): void {
    this.cancelled = true;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }
}

/** Crawls public PikPak share links into a {@link CrawlStore}. */
export class Crawler {
  private readonly store: CrawlStore;
  private readonly client: CrawlClient;
  private readonly logger?: CrawlLogger;
  private readonly lastPersist = new WeakMap<CrawlJob, number>();

  constructor(options: CrawlerOptions) {
    this.store = options.store;
    this.client = options.client;
    this.logger = options.logger === false ? undefined : options.logger;
  }

  /** Creates a job and immediately starts crawling it in the background. */
  start(options: CrawlOptions): CrawlJob {
    const { shareId } = parseShareUrl(options.url);
    if (!shareId) throw new Error(`Bukan link share PikPak yang valid: ${options.url}`);

    const jobId = options.jobId ?? crypto.randomUUID();
    const job = new CrawlJob(jobId, options.url, shareId, Boolean(options.resolveLinks));
    this.store.createJob({
      id: jobId,
      shareId,
      url: options.url,
      resolveLinks: job.resolveLinks,
      passCode: options.passCode ?? null,
    });
    job.done = this.run(job, options);
    return job;
  }

  /** Convenience wrapper that resolves with the final result. */
  async crawlShare(options: CrawlOptions): Promise<CrawlResult> {
    return this.start(options).done;
  }

  private async run(job: CrawlJob, options: CrawlOptions): Promise<CrawlResult> {
    try {
      this.setStatus(job, "running");
      const passCodeToken = options.passCode
        ? await this.client.share.getPassCodeToken(job.shareId, options.passCode)
        : "";
      await this.walk(
        job,
        "",
        "",
        passCodeToken,
        Boolean(options.resolveLinks),
        Boolean(options.debug),
        options.storeRaw !== false,
      );
      if (job.isCancelled) return this.finish(job, "cancelled");
      this.store.upsertShare(job.shareId);
      return this.finish(job, "done");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(`ERROR: ${message}`);
      if (job.isCancelled) return this.finish(job, "cancelled");
      job.progress.error = message;
      return this.finish(job, "error");
    }
  }

  private async walk(
    job: CrawlJob,
    parentId: string,
    pathPrefix: string,
    passCodeToken: string,
    resolveLinks: boolean,
    debug: boolean,
    storeRaw: boolean,
  ): Promise<void> {
    if (job.isCancelled) return;

    if (this.store.isFolderDone(job.shareId, parentId)) {
      if (debug) this.log(`[skip] ${pathPrefix || "(root)"} sudah selesai`);
      return;
    }

    try {
      let pageToken = "";
      do {
        if (job.isCancelled) return;
        if (debug) this.log(`[detail] ${pathPrefix || "(root)"} page=${pageToken || "1"}`);

        const resp = await this.client.share.listShareFiles(job.shareId, {
          parentId,
          pageToken,
          passCodeToken,
        });
        if (resp.share_status && resp.share_status !== "OK") {
          throw new Error(
            `share_status=${resp.share_status} ${resp.share_status_text ?? ""}`.trim(),
          );
        }

        for (const f of resp.files ?? []) {
          if (job.isCancelled) return;
          const isFolder = f.kind === FOLDER_KIND;
          const size = Number(f.size) || 0;
          const path = pathPrefix ? `${pathPrefix}/${f.name}` : f.name;

          let link: string | null = null;
          if (!isFolder && resolveLinks) {
            try {
              const info: any = await this.client.share.getShareFileInfo(
                job.shareId,
                f.id,
                passCodeToken,
              );
              link = extractContentLink(info);
            } catch (err) {
              const message = (err as Error).message;
              if (debug) this.log(`[link] gagal ${f.name}: ${message}`);
              job.progress.errors += 1;
              this.emitItem(job, {
                at: new Date().toISOString(),
                kind: "error",
                folder: false,
                name: f.name,
                path,
                size,
                ok: false,
                error: `link: ${message}`,
              });
            }
          }

          this.store.upsertFile({
            file_id: f.id,
            share_id: job.shareId,
            parent_id: parentId,
            name: f.name,
            kind: f.kind,
            size,
            path,
            mime_type: f.mime_type,
            file_extension: f.file_extension,
            user_id: f.user_id,
            revision: f.revision,
            hash: f.hash,
            phase: f.phase,
            created_time: f.created_time,
            modified_time: f.modified_time ?? null,
            user_modified_time: f.user_modified_time,
            delete_time: f.delete_time,
            web_content_link: link ?? f.web_content_link ?? null,
            icon_link: f.icon_link,
            thumbnail_link: f.thumbnail_link,
            folder_type: f.folder_type,
            space: f.space,
            trashed: f.trashed,
            starred: f.starred,
            writable: f.writable,
            links: f.links,
            medias: f.medias,
            audit: f.audit,
            params: f.params,
            apps: f.apps,
            tags: f.tags,
            reference_events: f.reference_events,
            raw: storeRaw ? f : undefined,
          });

          if (isFolder) job.progress.folders += 1;
          else job.progress.items += 1;
          job.progress.currentPath = path;
          this.tick(job);
          this.emitItem(job, {
            at: new Date().toISOString(),
            kind: f.kind,
            folder: isFolder,
            name: f.name,
            path,
            size,
            ok: true,
          });

          if (isFolder)
            await this.walk(job, f.id, path, passCodeToken, resolveLinks, debug, storeRaw);
        }

        pageToken = resp.next_page_token ?? "";
      } while (pageToken);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(`[folder gagal] ${pathPrefix || "(root)"}: ${message}`);
      job.progress.error = message;
      job.progress.errors += 1;
      this.emitItem(job, {
        at: new Date().toISOString(),
        kind: "error",
        folder: true,
        name: pathPrefix.split("/").pop() || "(root)",
        path: pathPrefix || "(root)",
        size: 0,
        ok: false,
        error: message,
      });
      if (parentId === "") throw e;
      return;
    }

    if (job.isCancelled) return;
    this.store.markFolderDone(job.shareId, parentId);
    job.progress.foldersDone += 1;
    this.tick(job, true);
  }

  private tick(job: CrawlJob, force = false): void {
    job.progress.updatedAt = new Date().toISOString();
    const now = Date.now();
    const last = this.lastPersist.get(job) ?? 0;
    if (!force && now - last < PERSIST_MS) return;
    this.lastPersist.set(job, now);

    this.store.updateJob(job.id, {
      status: job.progress.status,
      items: job.progress.items,
      folders: job.progress.folders,
      folders_done: job.progress.foldersDone,
      current_path: job.progress.currentPath,
      errors: job.progress.errors,
      error: job.progress.error,
      started_at: job.progress.startedAt,
      finished_at: job.progress.finishedAt,
      updated_at: job.progress.updatedAt,
    });
    job.emit("progress", { ...job.progress });
  }

  private emitItem(job: CrawlJob, item: CrawlItemEvent): void {
    job.emit("item", item);
  }

  private setStatus(job: CrawlJob, status: CrawlStatus): void {
    job.progress.status = status;
    if (status === "running" && !job.progress.startedAt) {
      job.progress.startedAt = new Date().toISOString();
    }
    if (status === "done" || status === "error" || status === "cancelled") {
      job.progress.finishedAt = new Date().toISOString();
    }
    this.tick(job, true);
  }

  private finish(job: CrawlJob, status: TerminalStatus): CrawlResult {
    this.setStatus(job, status);
    const result: CrawlResult = {
      jobId: job.id,
      shareId: job.shareId,
      status,
      items: job.progress.items,
      folders: job.progress.folders,
      foldersDone: job.progress.foldersDone,
    };
    if (status === "done") job.emit("done", result);
    else job.emit(status, { ...job.progress, ...result });
    return result;
  }

  private log(message: string): void {
    this.logger?.log(message);
  }
}

function extractContentLink(info: any): string | null {
  const fi = info?.file_info ?? info ?? {};
  const candidates: unknown[] = [
    fi.web_content_link,
    fi.links?.application_octet_stream?.url,
    ...(Array.isArray(fi.medias) ? fi.medias.map((m: any) => m?.link?.url) : []),
  ];
  return candidates.find((u): u is string => typeof u === "string" && u.length > 0) ?? null;
}
