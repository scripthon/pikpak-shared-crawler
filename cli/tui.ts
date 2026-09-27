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
}

export interface CrawlTuiOptions {
  /** Number of recent items kept in the ring buffer. */
  listSize?: number;
  /** Target frames per second. */
  fps?: number;
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
    ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" }
    : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
}

function boxTop(title: string, w: number, ch: BoxChars): string {
  const inner = w - 2;
  if (!title) return ch.tl + ch.h.repeat(inner) + ch.tr;
  const label = ` ${title} `;
  const lw = width(label);
  if (lw + 1 > inner) return ch.tl + ch.h.repeat(inner) + ch.tr;
  return ch.tl + ch.h + label + ch.h.repeat(inner - 1 - lw) + ch.tr;
}

function boxMid(content: string, w: number, ch: BoxChars): string {
  const inner = w - 2;
  return ch.v + padEnd(sliceWidth(content, inner), inner) + ch.v;
}

function boxBottom(w: number, ch: BoxChars): string {
  return ch.bl + ch.h.repeat(w - 2) + ch.br;
}

interface StatBox {
  title: string;
  lines: string[];
}

/** Renders several boxes side-by-side across `total` columns. */
function renderBoxes(boxes: StatBox[], total: number, gap: number, ch: BoxChars): string[] {
  const n = boxes.length;
  const avail = total - gap * (n - 1);
  const base = Math.floor(avail / n);
  const widths = boxes.map((_, i) => (i === n - 1 ? avail - base * (n - 1) : base));
  const maxLines = Math.max(...boxes.map((b) => b.lines.length));
  const rows = maxLines + 2;
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    boxes.forEach((b, i) => {
      const w = widths[i]!;
      let seg: string;
      if (r === 0) seg = boxTop(b.title, w, ch);
      else if (r === rows - 1) seg = boxBottom(w, ch);
      else seg = boxMid(b.lines[r - 1] ?? "", w, ch);
      line += (i ? " ".repeat(gap) : "") + seg;
    });
    out.push(line);
  }
  return out;
}

// ---- TUI ----

export class CrawlTui {
  private readonly job: CrawlJob;
  private readonly listSize: number;
  private readonly frameMs: number;
  private readonly ch: BoxChars;
  private readonly ell: string;
  private items: CrawlItemEvent[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private startedAt = Date.now();
  private stopped = false;

  private readonly onData: (data: string) => void;
  private readonly onResize: () => void;

  constructor(job: CrawlJob, options: CrawlTuiOptions = {}) {
    this.job = job;
    this.listSize = options.listSize ?? 15;
    this.frameMs = Math.max(50, Math.round(1000 / (options.fps ?? 10)));
    this.ch = boxChars(hasUtf8());
    this.ell = hasUtf8() ? "…" : "...";
    this.onData = (data: string) => {
      if (data === "q" || data === "\u0003") this.job.cancel();
    };
    this.onResize = () => this.render();
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

    this.job.on("item", (item: CrawlItemEvent) => {
      this.items.push(item);
      if (this.items.length > this.listSize) {
        this.items.splice(0, this.items.length - this.listSize);
      }
    });

    this.timer = setInterval(() => this.render(), this.frameMs);
    this.render();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    const stdin = process.stdin as unknown as {
      isTTY?: boolean;
      setRawMode?: (v: boolean) => void;
      pause?: () => void;
      off: (e: string, cb: (d: string) => void) => void;
    };
    stdin.off("data", this.onData);
    process.off("SIGWINCH", this.onResize);
    if (stdin.isTTY) {
      stdin.setRawMode?.(false);
      stdin.pause?.();
    }
    process.stdout.write(`${ESC}?25h${ESC}?1049l`);
  }

  private formatItem(item: CrawlItemEvent, inner: number): string {
    const time = new Date(item.at).toLocaleTimeString("en-GB", { hour12: false });
    const tag = item.ok ? (item.folder ? "D" : "F") : "!";
    const tagColor = !item.ok ? C.red : item.folder ? C.cyan : C.green;
    const sizeW = 9;
    // time(8) + 3 spaces + tag(1) + size(sizeW)
    const fixedW = 8 + 3 + 1 + sizeW;
    const pathW = Math.max(8, inner - fixedW);
    const path = fitPath(item.path, pathW, this.ell);
    const sizeStr = item.ok ? (item.folder ? "" : formatSize(item.size)) : "error";
    const pathCol = item.ok ? path : `${C.red}${path}${C.reset}`;
    const line =
      `${C.dim}${time}${C.reset} ${tagColor}${tag}${C.reset} ` +
      `${padEnd(pathCol, pathW)} ${C.dim}${sizeStr.padStart(sizeW)}${C.reset}`;
    return sliceWidth(line, inner);
  }

  private render(): void {
    if (this.stopped) return;
    const cols = Math.max(48, process.stdout.columns ?? 80);
    const rows = Math.max(12, process.stdout.rows ?? 24);
    const ch = this.ch;
    const p = this.job.progress;

    const elapsedMs = Date.now() - this.startedAt;
    const total = p.items + p.folders;
    const rate = elapsedMs > 0 ? total / (elapsedMs / 1000) : 0;
    const statusColor =
      p.status === "done"
        ? C.green
        : p.status === "error"
          ? C.red
          : p.status === "running"
            ? C.cyan
            : C.yellow;

    const header = [
      boxTop(`${C.bold}PikPak Shared Crawler${C.reset}`, cols, ch),
      boxMid(
        `${C.dim}share:${C.reset} ${p.shareId}    ${statusColor}● ${p.status}${C.reset}`,
        cols,
        ch,
      ),
      boxMid(
        `${C.dim}elapsed${C.reset} ${fmtDuration(elapsedMs)}   ` +
          `${C.dim}${rate.toFixed(0)} item/s${C.reset}   ` +
          `${C.dim}cur:${C.reset} ${fitPath(p.currentPath || "-", cols - 24, this.ell)}`,
        cols,
        ch,
      ),
      boxBottom(cols, ch),
    ];

    const statBoxes: StatBox[] = [
      { title: "FILES", lines: [`${C.bold}${p.items.toLocaleString("en-US")}${C.reset}`] },
      {
        title: "FOLDERS",
        lines: [
          `${C.bold}${p.folders.toLocaleString("en-US")}${C.reset}`,
          `${C.dim}${p.foldersDone.toLocaleString("en-US")} selesai${C.reset}`,
        ],
      },
      { title: "SUKSES", lines: [`${C.green}${total.toLocaleString("en-US")}${C.reset}`] },
      {
        title: "ERROR",
        lines: [
          p.errors > 0 ? `${C.red}${p.errors}${C.reset}` : `${C.dim}0${C.reset}`,
        ],
      },
    ];
    const stats = renderBoxes(statBoxes, cols, 1, ch);

    const reserved = header.length + 1 + stats.length + 1 + 1 + 2;
    const maxItems = Math.max(1, rows - reserved);
    const inner = cols - 2;
    const shown = this.items.slice(-maxItems);
    const itemLines: string[] = [];
    for (let i = 0; i < maxItems; i++) {
      const item = shown[i];
      itemLines.push(item ? this.formatItem(item, inner) : "");
    }
    const list = [
      boxTop("TERBARU", cols, ch),
      ...itemLines.map((l) => boxMid(l, cols, ch)),
      boxBottom(cols, ch),
    ];

    const out = [
      ...header,
      "",
      ...stats,
      "",
      ...list,
      `${C.dim}Ctrl-C / q = batal${C.reset}`,
    ];

    process.stdout.write(`${ESC}H` + out.map((l) => `${ESC}2K${l}`).join("\r\n") + `${ESC}0J`);
  }
}
