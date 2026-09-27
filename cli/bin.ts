#!/usr/bin/env bun
import { parseShareUrl } from "pikpak-sdk";
import { openCrawlDb } from "../src/store";
import { createCrawlClient } from "../src/client";
import { Crawler } from "../src/engine";
import type { CrawlLogger, CrawlProgress, CrawlResult } from "../src/types";
import { CrawlTui } from "./tui";

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--") && !a.endsWith(".sqlite"));
const resolveLinks = args.includes("--links");
const debug = args.includes("--debug");
const storeRaw = !args.includes("--no-raw");
const dbFile = args.find((a) => a.endsWith(".sqlite")) ?? "database.sqlite";

if (!url) {
  console.error(
    "Usage: pikpak-shared-crawl <share-url> [--links] [--debug] [--no-raw] [--tui|--no-tui] [database.sqlite]",
  );
  process.exit(1);
}

const useTui =
  !args.includes("--no-tui") &&
  !debug &&
  (args.includes("--tui") || Boolean(process.stdout.isTTY));

const store = openCrawlDb(dbFile);
const logger: CrawlLogger | false = useTui
  ? false
  : { log: (m) => console.log(m), warn: (m) => console.warn(m) };
const crawler = new Crawler({ store, client: createCrawlClient(), logger });

const { shareId } = parseShareUrl(url);
const job = crawler.start({ url, resolveLinks, debug, storeRaw });

process.on("SIGINT", () => job.cancel());

function printFinal(result: CrawlResult): void {
  if (result.status === "done") {
    console.log(
      `\nSelesai. ${result.items} file, ${result.folders} folder disimpan ke ${dbFile}`,
    );
  } else {
    const detail = job.progress.error ? ` (${job.progress.error})` : "";
    console.log(`\nBerhenti dengan status: ${result.status}${detail}`);
  }
}

if (useTui) {
  const tui = new CrawlTui(job);
  tui.start();
  const result = await job.done;
  tui.stop();
  printFinal(result);
} else {
  console.log(`share_id: ${shareId}`);
  console.log(`database: ${dbFile}`);

  let lastPrinted = 0;
  job.on("progress", (p: CrawlProgress) => {
    if (p.items - lastPrinted >= 5000) {
      lastPrinted = p.items;
      console.log(`  ... ${p.items} file, ${p.folders} folder (${p.currentPath.slice(0, 80)})`);
    }
  });

  const result = await job.done;
  printFinal(result);
}

const status = job.progress.status;
store.close();
process.exit(status === "done" ? 0 : 1);
