// pikpak-shared-crawler/cli/tui.ts
import type { CrawlJob } from "../src/engine";
import type { CrawlItemEvent } from "../src/types";

const ESC = "\x1b[";
const ANSI_RE = /\x1b\[[0-9;]*m/g;

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

interface BoxChars {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
  lt: string;
  rt: string;
}

export interface CrawlTuiOptions {
  /** Number of recent items kept in the ring buffer. */
  listSize?: number;
  /** Target frames per second. */
  fps?: number;
  /** Database file name to display in the header. */
  dbFile?: string;
}

// ---- text helpers (display-width aware, ANSI-safe) ----

function hasUtf8(): boolean {
  const loc = (process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "").toLowerCase();
  return loc.includes("utf8") || loc.includes("utf-8") || process.platform === "darwin";
}

function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function width(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI_RE, "")) w += charWidth(ch.codePointAt(0)!);
  return w;
}

function sliceWidth(s: string, max: number): string {
  if (max <= 0) return "";
  let w = 0;
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i)!;
    const cw = charWidth(cp);
    if (w + cw > max) break;
    out += String.fromCodePoint(cp);
    w += cw;
    i += cp > 0xffff ? 2 : 1;
  }
  return out;
}

function padEnd(s: string, target: number): string {
  const w = width(s);
  return w >= target ? s : s + " ".repeat(target - w);
}

function center(s: string, target: number): string {
  const w = width(s);
  if (w >= target) return s;
  const left = Math.floor((target - w) / 2);
  const right = target - w - left;
  return " ".repeat(left) + s + " ".repeat(right);
}

function truncateEnd(s: string, max: number, ell: string): string {
  if (width(s) <= max) return s;
  const ew = width(ell);
  if (max <= ew) return sliceWidth(s, max);
  return sliceWidth(s, max - ew) + ell;
}

function truncateKeepExt(name: string, max: number, ell: string): string {
  if (width(name) <= max) return name;
  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0 && dot < name.length - 1;
  const ext = hasExt ? name.slice(dot) : "";
  const ew = width(ell);
  const extW = width(ext);
  if (!hasExt || extW + ew >= max) return truncateEnd(name, max, ell);
  const stem = name.slice(0, dot);
  return sliceWidth(stem, max - extW - ew) + ell + ext;
}

/** Fits a path into `max` columns, keeping the basename + extension and
 *  progressively dropping parent segments (prefixed with an ellipsis). */
function fitPath(path: string, max: number, ell: string): string {
  if (max <= 0) return "";
  if (width(path) <= max) return path;
  const parts = path.split("/").filter(Boolean);
  if (!parts.length) return truncateEnd(path, max, ell);

  let best = "";
  for (let k = 1; k <= parts.length; k++) {
    const cand = parts.slice(parts.length - k).join("/");
    const prefix = k < parts.length ? ell + "/" : "";
    if (width(prefix) + width(cand) <= max) {
      best = prefix + cand;
    } else if (k === 1) {
      return truncateKeepExt(parts[parts.length - 1]!, max, ell);
    } else {
      break;
    }
  }
  return best || truncateEnd(path, max, ell);
}

function formatSize(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i > 0 && n < 10 ? 2 : 1)} ${units[i]}`;
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

// ---- box drawing ----

function boxChars(unicode: boolean): BoxChars {
  return unicode
    ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", lt: "├", rt: "┤" }
    : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", lt: "+", rt: "+" };
}

function boxTop(title: string, w: number, ch: BoxChars): string {
  const inner = w - 2;
  if (!title) return ch.tl + ch.h.repeat(inner) + ch.tr;
  const label = ` ${C.bold}${title}${C.reset} `;
  const lw = width(label);
  if (lw + 2 > inner) return ch.tl + ch.h.repeat(inner) + ch.tr;
  return ch.tl + ch.h + label + ch.h.repeat(inner - 1 - lw) + ch.tr;
}

function boxRow(content: string, w: number, ch: BoxChars): string {
  const inner = w - 2;
  const contentW = inner - 2;
  return ch.v + " " + padEnd(sliceWidth(content, contentW), contentW) + " " + ch.v;
}

function boxDivider(w: number, ch: BoxChars): string {
  return ch.lt + ch.h.repeat(w - 2) + ch.rt;
}

function boxSection(title: string, w: number, ch: BoxChars): string {
  const inner = w - 2;
  const label = ` ${title} `;
  const lw = width(label);
  if (lw + 2 > inner) return ch.lt + ch.h.repeat(inner) + ch.rt;
  return ch.lt + ch.h + label + ch.h.repeat(inner - 1 - lw) + ch.rt;
}

function boxBottom(w: number, ch: BoxChars, prompt?: string): string {
  const inner = w - 2;
  if (!prompt) return ch.bl + ch.h.repeat(inner) + ch.br;
  const label = ` ${prompt} `;
  const lw = width(label);
  if (lw > inner) return ch.bl + ch.h.repeat(inner) + ch.br;
  const left = Math.floor((inner - lw) / 2);
  const right = inner - lw - left;
  return ch.bl + ch.h.repeat(left) + label + ch.h.repeat(right) + ch.br;
}

// ---- TUI ----

export class CrawlTui {
  private readonly job: CrawlJob;
  private readonly listSize: number;
  private readonly frameMs: number;
  private readonly dbFile: string;
  private readonly ch: BoxChars;
  private readonly ell: string;
  private items: CrawlItemEvent[] = [];
  private totalBytes = 0;
  private timer?: ReturnType<typeof setInterval>;
  private startedAt = Date.now();
  private stopped = false;

  private readonly onData: (data: string) => void;
  private readonly onResize: () => void;
  private readonly onItem: (item: CrawlItemEvent) => void;

  constructor(job: CrawlJob, options: CrawlTuiOptions = {}) {
    this.job = job;
    this.listSize = options.listSize ?? 15;
    this.frameMs = Math.max(50, Math.round(1000 / (options.fps ?? 10)));
    this.dbFile = options.dbFile ?? "database.sqlite";
    this.ch = boxChars(hasUtf8());
    this.ell = hasUtf8() ? "…" : "...";

    this.onData = (data: string) => {
      if (data === "q" || data === "\u0003") this.job.cancel();
    };
    this.onResize = () => this.render();
    this.onItem = (item: CrawlItemEvent) => {
      if (item.ok && !item.folder && item.size) {
        this.totalBytes += item.size;
      }
      this.items.push(item);
      if (this.items.length > this.listSize) {
        this.items.splice(0, this.items.length - this.listSize);
      }
    };

    this.job.on("item", this.onItem);
  }

  start(): void {
    this.startedAt = Date.now();
    process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}2J${ESC}H`);

    const stdin = process.stdin as unknown as {
      isTTY?: boolean;
      setRawMode?: (v: boolean) => void;
      resume?: () => void;
      pause?: () => void;
      setEncoding?: (e: string) => void;
      on: (e: string, cb: (d: string) => void) => void;
      off: (e: string, cb: (d: string) => void) => void;
    };
    if (stdin.isTTY) {
      stdin.setRawMode?.(true);
      stdin.resume?.();
      stdin.setEncoding?.("utf8");
    }
    stdin.on("data", this.onData);
    process.on("SIGWINCH", this.onResize);

    this.timer = setInterval(() => this.render(), this.frameMs);
    this.render();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.job.off("item", this.onItem);

    const stdin = process.stdin as unknown as {
      isTTY?: boolean;
      setRawMode?: (v: boolean) => void;
      pause?: () => void;
      off: (e: string, cb: (d: string) => void) => void;
    };
    stdin.off("data", this.onData);
    process.on("SIGWINCH", this.onResize);
    if (stdin.isTTY) {
      stdin.setRawMode?.(false);
      stdin.pause?.();
    }
    process.stdout.write(`${ESC}?25h${ESC}?1049l`);
  }

  private formatItem(item: CrawlItemEvent, innerWidth: number): string {
    const time = new Date(item.at).toLocaleTimeString("en-GB", { hour12: false });
    const useUnicode = hasUtf8();
    let icon = useUnicode ? "📄" : "F ";
    let iconColor = C.reset;
    if (!item.ok) {
      icon = useUnicode ? "❌" : "! ";
      iconColor = C.red;
    } else if (item.folder) {
      icon = useUnicode ? "📁" : "D ";
      iconColor = C.cyan;
    }

    const isRegularFolder = item.folder && item.ok;
    const sizeW = 9;
    const prefixW = 14;
    const pathW = isRegularFolder
      ? Math.max(8, innerWidth - prefixW)
      : Math.max(8, innerWidth - prefixW - 1 - sizeW);
    const path = fitPath(item.path, pathW, this.ell);
    const pathCol = item.ok ? path : `${C.red}${path}${C.reset}`;

    let line = `${C.dim}${time}${C.reset}  ${iconColor}${icon}${C.reset}  `;
    if (isRegularFolder) {
      line += padEnd(pathCol, pathW);
    } else {
      const sizeStr = item.ok ? formatSize(item.size) : "error";
      const sizeColor = item.ok ? C.dim : C.red;
      line += `${padEnd(pathCol, pathW)} ${sizeColor}${sizeStr.padStart(sizeW)}${C.reset}`;
    }
    return sliceWidth(line, innerWidth);
  }

  private render(): void {
    if (this.stopped) return;
    const termCols = process.stdout.columns ?? 80;
    const termRows = process.stdout.rows ?? 24;
    const ch = this.ch;
    const p = this.job.progress;

    // Fixed compact width capped at 72, with 2-space left margin if space permits
    const cardWidth = Math.min(Math.max(termCols, 48), 72);
    const inner = cardWidth - 2;
    const contentW = inner - 2;
    const margin = termCols > 74 ? "  " : "";

    const elapsedMs = Date.now() - this.startedAt;
    const total = p.items + p.folders;
    const rate = elapsedMs > 0 ? total / (elapsedMs / 1000) : 0;

    let statusColor = C.cyan;
    if (p.status === "done") statusColor = C.green;
    else if (p.status === "running") statusColor = C.green;
    else if (p.status === "error" || p.status === "cancelled" || p.status === "interrupted") {
      statusColor = C.red;
    } else {
      statusColor = C.yellow;
    }

    // --- Header Section ---
    const leftW = Math.max(20, Math.floor(contentW * 0.55));
    const rightW = contentW - leftW;

    const shareVal = truncateEnd(p.shareId, leftW - 11, this.ell);
    const headerRow1 =
      padEnd(`${C.dim}Share ID :${C.reset} ${shareVal}`, leftW) +
      padEnd(
        `${C.dim}Status :${C.reset} ${statusColor}● ${C.bold}${p.status.toUpperCase()}${C.reset} ${C.dim}(${fmtDuration(elapsedMs)})${C.reset}`,
        rightW,
      );

    const dbVal = fitPath(this.dbFile, leftW - 11, this.ell);
    const headerRow2 =
      padEnd(`${C.dim}Database :${C.reset} ${dbVal}`, leftW) +
      padEnd(
        `${C.dim}Speed  :${C.reset} ${C.bold}${rate.toFixed(0)}${C.reset} items/s`,
        rightW,
      );

    // --- Metrics Section ---
    const numCols = 5;
    const baseColW = Math.floor(inner / numCols);
    const colWidths = [
      baseColW,
      baseColW,
      baseColW,
      baseColW,
      inner - baseColW * (numCols - 1),
    ];

    const colHeaders = ["FILES", "FOLDERS", "SUCCESS", "ERRORS", "STORAGE"];
    const metricsHeader = colHeaders
      .map((h, i) => center(`${C.dim}${h}${C.reset}`, colWidths[i]!))
      .join("");

    const errStr = p.errors > 0 ? `${C.red}${C.bold}${p.errors}${C.reset}` : `${C.dim}0${C.reset}`;
    const colValues = [
      `${C.bold}${p.items.toLocaleString("en-US")}${C.reset}`,
      `${C.bold}${p.folders.toLocaleString("en-US")}${C.reset}`,
      `${C.green}${C.bold}${total.toLocaleString("en-US")}${C.reset}`,
      errStr,
      `${C.cyan}${C.bold}${formatSize(this.totalBytes)}${C.reset}`,
    ];
    const metricsValues = colValues
      .map((v, i) => center(v, colWidths[i]!))
      .join("");

    // --- Current Path Section ---
    const currPrefix = `${C.dim}Current :${C.reset} `;
    const currPathW = Math.max(10, contentW - width(currPrefix));
    const currPathStr = fitPath(p.currentPath || "/", currPathW, this.ell);
    const currentLine = padEnd(`${currPrefix}${currPathStr}`, contentW);

    // --- Activity Feed Section ---
    // Fixed lines: top(1), 2 headers(2), div1(1), 2 metrics(2), div2(1), current(1), sec(1), bottom(1) = 10 lines
    const fixedRows = 10;
    const maxItems = Math.min(this.listSize, Math.max(3, termRows - fixedRows - 2));
    const shown = this.items.slice(-maxItems);
    const itemLines: string[] = [];
    for (let i = 0; i < maxItems; i++) {
      const it = shown[i];
      if (it) {
        itemLines.push(boxRow(this.formatItem(it, contentW), cardWidth, ch));
      } else if (i === 0 && this.items.length === 0) {
        itemLines.push(boxRow(center(`${C.dim}Waiting for items...${C.reset}`, contentW), cardWidth, ch));
      } else {
        itemLines.push(boxRow("", cardWidth, ch));
      }
    }

    const lines = [
      boxTop("PikPak Shared Crawler", cardWidth, ch),
      boxRow(headerRow1, cardWidth, ch),
      boxRow(headerRow2, cardWidth, ch),
      boxDivider(cardWidth, ch),
      ch.v + metricsHeader + ch.v,
      ch.v + metricsValues + ch.v,
      boxDivider(cardWidth, ch),
      boxRow(currentLine, cardWidth, ch),
      boxSection("Recent Activity", cardWidth, ch),
      ...itemLines,
      boxBottom(
        cardWidth,
        ch,
        `Press [${C.bold}q${C.reset}] or [${C.bold}Ctrl+C${C.reset}] to stop`,
      ),
    ];

    process.stdout.write(
      `${ESC}H` + lines.map((l) => `${ESC}2K${margin}${l}`).join("\r\n") + `${ESC}0J`,
    );
  }
}
