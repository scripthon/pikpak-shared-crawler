import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CrawlStore } from "../src/store";

let store: CrawlStore;

beforeEach(() => {
  store = new CrawlStore(":memory:");
});

afterEach(() => {
  store.close();
});

test("upserts files, lists children (folders first) and computes stats", () => {
  store.upsertShare("S1");
  store.upsertFile({
    file_id: "f1",
    share_id: "S1",
    parent_id: "",
    name: "a.mp4",
    kind: "drive#file",
    size: 10,
    path: "a.mp4",
    modified_time: null,
    web_content_link: null,
  });
  store.upsertFile({
    file_id: "d1",
    share_id: "S1",
    parent_id: "",
    name: "dir",
    kind: "drive#folder",
    size: 0,
    path: "dir",
    modified_time: null,
    web_content_link: null,
  });

  const { items, total } = store.listChildren("S1", "", 10, 0, { foldersFirst: true });
  expect(total).toBe(2);
  expect(items[0]!.name).toBe("dir");
  expect(store.getStats()).toEqual({ files: 1, folders: 1, size: 10, shares: 1 });
});

test("upsertFile is idempotent on file_id", () => {
  store.upsertShare("S1");
  const base = {
    file_id: "f1",
    share_id: "S1",
    parent_id: "",
    name: "old.bin",
    kind: "drive#file",
    size: 1,
    path: "old.bin",
    modified_time: null,
    web_content_link: null,
  };
  store.upsertFile(base);
  store.upsertFile({ ...base, name: "new.bin", size: 42, path: "new.bin" });

  const row = store.getFile("f1")!;
  expect(row.name).toBe("new.bin");
  expect(row.size).toBe(42);
});

test("tracks done folders for resume", () => {
  expect(store.isFolderDone("S1", "")).toBe(false);
  store.markFolderDone("S1", "");
  expect(store.isFolderDone("S1", "")).toBe(true);
});

test("crawl jobs lifecycle and interruption sweep", () => {
  const job = store.createJob({ id: "j1", shareId: "S1", url: "u" });
  expect(job.status).toBe("queued");
  expect(job.errors).toBe(0);

  store.updateJob("j1", { status: "running", items: 5, folders: 2, errors: 3 });
  const running = store.getJob("j1")!;
  expect(running.items).toBe(5);
  expect(running.folders).toBe(2);
  expect(running.errors).toBe(3);

  expect(store.markInterrupted()).toBe(1);
  expect(store.getJob("j1")!.status).toBe("interrupted");

  store.updateJob("j1", { status: "done" });
  expect(store.listJobs()).toHaveLength(1);
  expect(store.getJob("j1")!.status).toBe("done");
});

test("filters and searches files", () => {
  store.upsertShare("S1");
  store.upsertFile({
    file_id: "f1",
    share_id: "S1",
    parent_id: "",
    name: "holiday.mp4",
    kind: "drive#file",
    size: 100,
    path: "2024/holiday.mp4",
    modified_time: null,
    web_content_link: null,
  });
  store.upsertFile({
    file_id: "f2",
    share_id: "S1",
    parent_id: "",
    name: "notes.txt",
    kind: "drive#file",
    size: 1,
    path: "2024/notes.txt",
    modified_time: null,
    web_content_link: null,
  });

  const { items, total } = store.searchFiles("holiday", 10, 0);
  expect(total).toBe(1);
  expect(items[0]!.file_id).toBe("f1");

  const filtered = store.searchFiles("%", 10, 0, { extraFilter: "AND name LIKE '%.txt'" });
  expect(filtered.total).toBe(1);
  expect(filtered.items[0]!.file_id).toBe("f2");
});

test("stores the full set of API fields (scalars + JSON)", () => {
  store.upsertShare("S1");
  store.upsertFile({
    file_id: "f1",
    share_id: "S1",
    parent_id: "",
    name: "v.mp4",
    kind: "drive#file",
    size: 808000335,
    path: "v.mp4",
    mime_type: "video/mp4",
    file_extension: ".mp4",
    hash: "ABC",
    phase: "PHASE_TYPE_COMPLETE",
    created_time: "2025-05-27T12:38:45.975+08:00",
    modified_time: "2025-05-29T18:46:02.459+08:00",
    user_modified_time: "2025-05-29T18:46:02.459+08:00",
    thumbnail_link: "https://thumb",
    icon_link: "https://icon",
    folder_type: "NORMAL",
    space: "",
    trashed: false,
    starred: false,
    writable: true,
    links: {},
    medias: [],
    audit: { status: "STATUS_OK" },
    params: { duration: "601", width: "1080", height: "1920" },
    apps: [],
    tags: [],
    reference_events: [],
    raw: { id: "f1", foo: "bar" },
  });

  const row = store.getFile("f1") as any;
  expect(row.mime_type).toBe("video/mp4");
  expect(row.file_extension).toBe(".mp4");
  expect(row.hash).toBe("ABC");
  expect(row.thumbnail_link).toBe("https://thumb");
  expect(row.trashed).toBe(0);
  expect(row.starred).toBe(0);
  expect(row.writable).toBe(1);
  expect(JSON.parse(row.params).duration).toBe("601");
  expect(JSON.parse(row.medias)).toEqual([]);
  expect(JSON.parse(row.raw).foo).toBe("bar");

  const { items } = store.listChildren("S1", "", 10, 0);
  expect(items[0]!.thumbnail_link).toBe("https://thumb");
  expect((items[0] as any).raw).toBeUndefined();
});

test("migrates an existing minimal files table by adding columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "crawl-"));
  const file = join(dir, "old.sqlite");

  const old = new Database(file);
  old.exec(`CREATE TABLE files (
    file_id TEXT PRIMARY KEY, share_id TEXT NOT NULL, parent_id TEXT NOT NULL,
    name TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
    path TEXT NOT NULL, modified_time TEXT, web_content_link TEXT)`);
  old.exec(`INSERT INTO files (file_id, share_id, parent_id, name, kind, size, path)
            VALUES ('old1','S1','','old.bin','drive#file',7,'old.bin')`);
  old.close();

  const migrated = new CrawlStore(file);
  const row = migrated.getFile("old1") as any;
  expect(row.name).toBe("old.bin");
  expect(row.mime_type).toBeNull();
  const cols = migrated.db
    .query("PRAGMA table_info(files)")
    .all()
    .map((c: any) => c.name);
  expect(cols).toContain("thumbnail_link");
  expect(cols).toContain("raw");
  migrated.close();
  rmSync(dir, { recursive: true, force: true });
});
