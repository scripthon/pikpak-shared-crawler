import { test, expect, beforeEach, afterEach } from "bun:test";
import { CrawlStore } from "../src/store";
import { Crawler, type CrawlClient } from "../src/engine";

const TREE: Record<string, any[]> = {
  "": [
    { kind: "drive#folder", id: "d1", name: "dir", size: "0" },
    { kind: "drive#file", id: "f1", name: "a.bin", size: "10" },
  ],
  d1: [{ kind: "drive#file", id: "f2", name: "b.bin", size: "20" }],
};

function fakeClient(): CrawlClient {
  return {
    share: {
      listShareFiles: async (_shareId, options) => {
        const parent = options?.parentId ?? "";
        return {
          share_status: "OK",
          files: TREE[parent] ?? [],
          next_page_token: "",
        } as any;
      },
      getShareFileInfo: async () => ({ file_info: { web_content_link: "https://cdn/x" } }),
      getPassCodeToken: async () => "",
    },
  };
}

let store: CrawlStore;

beforeEach(() => {
  store = new CrawlStore(":memory:");
});

afterEach(() => {
  store.close();
});

test("crawls a share tree into the store", async () => {
  const crawler = new Crawler({ store, client: fakeClient() });
  const result = await crawler.crawlShare({ url: "https://mypikpak.com/s/S1" });

  expect(result.status).toBe("done");
  expect(result.shareId).toBe("S1");
  expect(result.items).toBe(2);
  expect(result.folders).toBe(1);
  expect(result.foldersDone).toBe(2);

  expect(store.getStats()).toEqual({ files: 2, folders: 1, size: 30, shares: 1 });
  expect(store.listChildren("S1", "", 10, 0).total).toBe(2);
  expect(store.listChildren("S1", "d1", 10, 0).total).toBe(1);
  expect(store.isFolderDone("S1", "")).toBe(true);
  expect(store.isFolderDone("S1", "d1")).toBe(true);

  const raw = (store.getFile("f1") as any).raw;
  expect(JSON.parse(raw).name).toBe("a.bin");
});

test("persists crawl_jobs progress and settles as done", async () => {
  const crawler = new Crawler({ store, client: fakeClient() });
  const job = crawler.start({ url: "S1" });
  await job.done;

  const row = store.getJob(job.id)!;
  expect(row.status).toBe("done");
  expect(row.items).toBe(2);
  expect(row.folders).toBe(1);
  expect(row.folders_done).toBe(2);
  expect(row.started_at).not.toBeNull();
  expect(row.finished_at).not.toBeNull();
});

test("emits progress events", async () => {
  const crawler = new Crawler({ store, client: fakeClient() });
  const job = crawler.start({ url: "S1" });
  const seen: string[] = [];
  job.on("progress", (p) => seen.push(p.status));
  job.on("done", () => seen.push("done"));
  await job.done;

  expect(seen).toContain("running");
  expect(seen).toContain("done");
});

test("resumes: already-done folders are skipped", async () => {
  store.markFolderDone("S1", "");
  store.markFolderDone("S1", "d1");
  store.upsertShare("S1");

  const crawler = new Crawler({ store, client: fakeClient() });
  const result = await crawler.crawlShare({ url: "S1" });

  expect(result.status).toBe("done");
  expect(result.items).toBe(0);
  expect(result.folders).toBe(0);
});

test("rejects an invalid share url", () => {
  const crawler = new Crawler({ store, client: fakeClient() });
  expect(() => crawler.start({ url: "" })).toThrow();
});

test("emits item events and counts folder errors", async () => {
  const client: CrawlClient = {
    share: {
      listShareFiles: async (_shareId, options) => {
        const parent = options?.parentId ?? "";
        if (parent === "d1") throw new Error("boom");
        return { share_status: "OK", files: TREE[parent] ?? [], next_page_token: "" } as any;
      },
      getShareFileInfo: async () => ({}),
      getPassCodeToken: async () => "",
    },
  };
  const crawler = new Crawler({ store, client });
  const job = crawler.start({ url: "S1" });
  const items: any[] = [];
  job.on("item", (e) => items.push(e));

  const result = await job.done;
  expect(result.status).toBe("done");
  expect(job.progress.errors).toBe(1);
  expect(items.some((i) => i.ok === true && i.name === "a.bin")).toBe(true);
  expect(items.some((i) => i.ok === false && i.error === "boom")).toBe(true);

  const row = store.getJob(job.id)!;
  expect(row.errors).toBe(1);
});
