// news-image-20261121 — Saturday 21 November 2026 in one image.
// A program that draws a newspaper front page (1024x1024 PNG) from the
// day's verified news. Standard library only, no network, deterministic:
// two runs write the same bytes.
//
// How it works: a tiny canvas (raw RGB buffer) + a hand-built single-stroke
// vector font (scales cleanly from 9px briefs to the 58px masthead) +
// a hand-rolled PNG writer (zlib via node:zlib, CRC32 table).
// Every story below was verified from news sources on 21 Nov 2026; see
// RESEARCH.md in the work dir for the source list.

import * as fs from "node:fs";
import * as zlib from "node:zlib";

const W = 1024;
const H = 1024;
const MARGIN = 16;
const CW = W - MARGIN * 2; // content width 992

// ---------- palette (a cream broadsheet, ink, and flat accent colours) ----------
const PAPER = [246, 241, 231];
const INK = [26, 26, 26];
const INK_SOFT = [70, 66, 60];
const RED = [180, 35, 24];
const RED_DARK = [140, 25, 16];
const NAVY = [31, 56, 100];
const NAVY_DARK = [22, 42, 78];
const TEAL = [14, 107, 107];
const OCHRE = [166, 124, 0];
const GREEN = [46, 125, 50];
const PURPLE = [106, 27, 154];
const AMBER = [180, 83, 9];
const SKY = [37, 99, 235];
const GREY = [55, 65, 81];
const LINE = [120, 110, 95];
const PANEL_BG = [255, 253, 247];
const MAP_LAND = [214, 196, 158];
const MAP_SEA = [196, 216, 228];
const WHITE = [255, 255, 255];

// ---------- canvas ----------
const buf = Buffer.alloc(W * H * 3);
function setPx(x, y, c) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
}
function fillRect(x, y, w, h, c) {
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(W, Math.ceil(x + w)), y1 = Math.min(H, Math.ceil(y + h));
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) setPx(xx, yy, c);
  }
}
function fillCanvas(c) { fillRect(0, 0, W, H, c); }
function hline(x, y, w, c, t = 1) { fillRect(x, y, w, t, c); }
function vline(x, y, h, c, t = 1) { fillRect(x, y, t, h, c); }

// Bresenham line with round-ish thickness.
function line(x0, y0, x1, y1, c, t = 1) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  const r = Math.floor(t / 2);
  for (;;) {
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) setPx(x + a, y + b, c);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}
function polyline(pts, c, t = 1) {
  for (let i = 0; i + 1 < pts.length; i++) line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], c, t);
}
function circle(cx, cy, r, c, filled = true) {
  const r2 = r * r;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (filled ? d <= r2 : d <= r2 && d >= (r - 1) * (r - 1)) setPx(x, y, c);
    }
  }
}
// Scanline fill of a simple polygon (array of [x,y]).
function fillPoly(pts, c) {
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  for (let y = Math.ceil(minY); y <= Math.floor(maxY); y++) {
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (let x = Math.ceil(xs[i]); x <= Math.floor(xs[i + 1]); x++) setPx(x, y, c);
    }
  }
}

// ---------- PNG writer (signature, IHDR, IDAT via zlib, IEND) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}
function encodePNG() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0; // filter: none
    buf.copy(raw, y * (1 + W * 3) + 1, y * W * 3, (y + 1) * W * 3);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- single-stroke vector font ----------
// Grid: x 0..8, y up, baseline 0, cap height 10, x-height 7, descender -3.
// Each glyph: [advanceWidth, [stroke, stroke, ...]]; a stroke is [[x,y],...].
const FONT = {
  "A": [8, [[[0,0],[4,10],[8,0]], [[2,4],[6,4]]]],
  "B": [8, [[[0,0],[0,10],[5,10],[7,8],[5,6],[0,6]], [[0,6],[6,6],[7,5],[6,2],[5,0],[0,0]]]],
  "C": [8, [[[7,9],[5,10],[2,10],[0,8],[0,2],[2,0],[5,0],[7,1]]]],
  "D": [8, [[[0,0],[0,10],[5,10],[8,8],[8,2],[5,0],[0,0]]]],
  "E": [7, [[[7,10],[0,10],[0,0],[7,0]], [[0,5],[5,5]]]],
  "F": [7, [[[0,0],[0,10],[7,10]], [[0,5],[5,5]]]],
  "G": [8, [[[7,9],[5,10],[2,10],[0,8],[0,2],[2,0],[5,0],[7,2],[7,4],[4,4]]]],
  "H": [8, [[[0,0],[0,10]], [[7,0],[7,10]], [[0,5],[7,5]]]],
  "I": [8, [[[4,0],[4,10]], [[1,10],[7,10]], [[1,0],[7,0]]]],
  "J": [8, [[[7,10],[7,2],[5,0],[2,0],[0,2]]]],
  "K": [8, [[[0,0],[0,10]], [[7,10],[0,4],[7,0]]]],
  "L": [7, [[[0,10],[0,0],[7,0]]]],
  "M": [9, [[[0,0],[0,10],[4,4],[8,10],[8,0]]]],
  "N": [9, [[[0,0],[0,10],[8,0],[8,10]]]],
  "O": [8, [[[2,0],[0,2],[0,8],[2,10],[6,10],[8,8],[8,2],[6,0],[2,0]]]],
  "P": [8, [[[0,0],[0,10],[6,10],[8,8],[6,6],[0,6]]]],
  "Q": [8, [[[2,0],[0,2],[0,8],[2,10],[6,10],[8,8],[8,2],[6,0],[2,0]], [[5,2],[8,-1]]]],
  "R": [8, [[[0,0],[0,10],[6,10],[8,8],[6,6],[0,6]], [[4,6],[8,0]]]],
  "S": [8, [[[7,9],[5,10],[2,10],[0,8],[0,6],[2,5],[5,5],[7,4],[7,2],[5,0],[2,0],[0,1]]]],
  "T": [8, [[[0,10],[8,10]], [[4,10],[4,0]]]],
  "U": [8, [[[0,10],[0,2],[2,0],[5,0],[7,2],[7,10]]]],
  "V": [8, [[[0,10],[4,0],[8,10]]]],
  "W": [9, [[[0,10],[2,0],[4,6],[6,0],[8,10]]]],
  "X": [8, [[[0,10],[8,0]], [[8,10],[0,0]]]],
  "Y": [8, [[[0,10],[4,5],[8,10]], [[4,5],[4,0]]]],
  "Z": [8, [[[0,10],[8,10],[0,0],[8,0]]]],
  "a": [8, [[[7,0],[7,7],[5,7],[3,7],[2,6],[2,2],[3,0],[5,0],[7,0]]]],
  "b": [8, [[[0,0],[0,10]], [[0,0],[6,0],[7,1],[7,5],[6,7],[0,7]]]],
  "c": [7, [[[7,6],[5,7],[2,7],[0,5],[0,2],[2,0],[5,0],[7,1]]]],
  "d": [8, [[[7,0],[7,10]], [[7,0],[2,0],[0,2],[0,5],[2,7],[5,7],[7,6]]]],
  "e": [7, [[[7,1],[5,0],[2,0],[0,2],[0,5],[2,7],[5,7],[7,5],[6,3],[0,3]]]],
  "f": [7, [[[3,10],[4,10],[6,9],[6,8],[6,0]], [[1,4],[5,4]]]],
  "g": [8, [[[7,7],[5,7],[2,7],[1,6],[1,2],[2,0],[5,0],[7,1],[7,-1],[6,-2],[4,-2],[2,-2]]]],
  "h": [7, [[[0,0],[0,10]], [[0,3],[0,7],[2,7],[5,7],[6,6],[6,0]]]],
  "i": [4, [[[3,0],[3,7]], [[2,10],[4,10]]]],
  "j": [6, [[[5,0],[5,7]], [[4,10],[6,10]], [[5,0],[5,-2],[3,-2],[1,-2]]]],
  "k": [7, [[[0,0],[0,10]], [[6,7],[0,2],[6,0]]]],
  "l": [4, [[[3,0],[3,10]]]],
  "m": [8, [[[0,0],[0,7],[2,7],[3,5],[3,0]], [[3,5],[3,7],[5,7],[6,5],[6,0]]]],
  "n": [7, [[[0,0],[0,7]], [[0,4],[0,7],[2,7],[5,7],[6,6],[6,0]]]],
  "o": [8, [[[2,0],[0,2],[0,5],[2,7],[5,7],[7,5],[7,2],[5,0],[2,0]]]],
  "p": [8, [[[0,-2],[0,7]], [[0,0],[5,0],[7,2],[7,5],[5,7],[0,7]]]],
  "q": [8, [[[7,-2],[7,7]], [[7,0],[2,0],[0,2],[0,5],[2,7],[5,7],[7,6]]]],
  "r": [6, [[[0,0],[0,7]], [[0,5],[2,7],[4,7],[5,6]]]],
  "s": [7, [[[6,6],[4,7],[2,7],[0,6],[0,4],[2,3],[5,3],[7,2],[7,1],[5,0],[2,0],[0,1]]]],
  "t": [6, [[[3,0],[3,10]], [[1,4],[5,4]], [[3,0],[4,0],[5,1]]]],
  "u": [7, [[[0,7],[0,2],[1,0],[3,0],[5,1],[6,3],[6,7]]]],
  "v": [7, [[[0,7],[3,0],[6,7]]]],
  "w": [7, [[[0,7],[1,0],[3,4],[5,0],[6,7]]]],
  "x": [7, [[[0,7],[6,0]], [[6,7],[0,0]]]],
  "y": [7, [[[0,7],[3,0],[6,7]], [[3,0],[3,-2],[2,-2]]]],
  "z": [7, [[[0,7],[6,7],[0,0],[6,0]]]],
  "0": [8, [[[2,0],[0,2],[0,8],[2,10],[6,10],[8,8],[8,2],[6,0],[2,0]]]],
  "1": [8, [[[2,8],[4,10],[4,0]], [[1,0],[7,0]]]],
  "2": [8, [[[0,9],[2,10],[6,10],[8,8],[8,6],[6,3],[0,0],[8,0]]]],
  "3": [8, [[[1,9],[3,10],[6,10],[8,8],[7,6],[5,5],[7,5],[8,4],[8,2],[6,0],[3,0],[1,1]]]],
  "4": [8, [[[6,10],[6,0]], [[0,4],[7,4]], [[0,4],[6,10]]]],
  "5": [8, [[[8,10],[0,10],[0,6],[6,6],[8,4],[8,2],[6,0],[2,0],[0,1]]]],
  "6": [8, [[[7,9],[6,10],[2,10],[0,8],[0,3],[2,0],[6,0],[8,2],[8,5],[6,7],[2,7],[0,5]]]],
  "7": [8, [[[0,10],[8,10],[4,0]]]],
  "8": [8, [[[2,10],[0,8],[0,6],[2,5],[6,5],[8,6],[8,8],[6,10],[2,10]], [[2,5],[0,3],[0,2],[2,0],[6,0],[8,2],[8,3],[6,5]]]],
  "9": [8, [[[2,10],[0,8],[0,5],[2,3],[6,3],[8,5],[8,8],[6,10],[2,10],[0,8]], [[8,5],[8,0],[6,0]]]],
  " ": [4, []],
  ".": [4, [[[2,0],[3,0]]]],
  ",": [4, [[[3,2],[3,0],[2,-2],[1,-2]]]],
  ":": [4, [[[3,7],[3,8]], [[3,0],[3,1]]]],
  ";": [4, [[[3,7],[3,8]], [[3,2],[3,0],[2,-2],[1,-2]]]],
  "!": [4, [[[3,10],[3,3]], [[3,0],[3,1]]]],
  "?": [7, [[[1,9],[2,10],[5,10],[6,8],[5,6],[3,5],[3,3]], [[3,0],[3,1]]]],
  "'": [4, [[[3,10],[2,7]]]],
  '"': [6, [[[2,10],[1,7]], [[5,10],[4,7]]]],
  "(": [6, [[[5,10],[3,8],[3,2],[5,0]]]],
  ")": [6, [[[1,10],[3,8],[3,2],[1,0]]]],
  "-": [6, [[[0,5],[6,5]]]],
  "–": [8, [[[0,5],[8,5]]]],
  "—": [10, [[[0,5],[10,5]]]],
  "·": [6, [[[3,5],[4,5]]]],
  "/": [7, [[[1,0],[6,10]]]],
  "%": [8, [[[1,0],[7,10]], [[3,7],[2,8],[2,9],[3,10],[4,9],[4,8],[3,7]], [[5,2],[4,3],[4,4],[5,5],[6,4],[6,3],[5,2]]]],
  "$": [8, [[[6,9],[4,10],[2,10],[1,8],[1,6],[3,5],[6,5],[7,4],[7,2],[5,0],[2,0],[1,1]], [[4,11],[4,-1]]]],
  "+": [8, [[[4,2],[4,8]], [[1,5],[7,5]]]],
  "=": [8, [[[0,7],[7,7]], [[0,3],[7,3]]]],
  "*": [8, [[[4,2],[4,8]], [[1,6],[7,4]], [[1,4],[7,6]]]],
  "°": [6, [[[3,8],[2,9],[2,10],[3,11],[4,10],[4,9],[3,8]]]],
};

// Draw one glyph at (x, baselineY); size = cap height in px. Returns advance.
function drawGlyph(ch, x, baselineY, size, c, opts = {}) {
  const g = FONT[ch];
  if (!g) return size * 0.5; // unknown char: half-space
  const [adv, strokes] = g;
  const s = size / 10;
  // Thick single pass: thin strokes were unreadable at small sizes, and the
  // old double-draw bold pass blurred letters instead of thickening them.
  const t = Math.max(size < 14 ? 2 : 1, Math.round(s * (opts.bold ? 1.5 : 1.2)));
  const slant = opts.italic ? 0.18 : 0;
  for (const st of strokes) {
    const pts = st.map(([gx, gy]) => [x + (gx + slant * (10 - gy)) * s, baselineY - gy * s]);
    if (pts.length === 1) {
      circle(pts[0][0], pts[0][1], Math.max(1, t / 2), c);
    } else {
      polyline(pts, c, t);
    }
  }
  return adv * s + (opts.tracking || 0);
}
function textWidth(str, size, opts = {}) {
  let w = 0;
  for (const ch of str) {
    const g = FONT[ch];
    w += g ? g[0] * (size / 10) + (opts.tracking || 0) : size * 0.5;
  }
  return w;
}
// Draw text at (x, baselineY). align: "l" | "c" | "r".
function text(str, x, baselineY, size, c, opts = {}) {
  let startX = x;
  if (opts.align === "c") startX = x - textWidth(str, size, opts) / 2;
  if (opts.align === "r") startX = x - textWidth(str, size, opts);
  let cx = startX;
  for (const ch of str) cx += drawGlyph(ch, cx, baselineY, size, c, opts);
  return cx;
}
// Wrap text to lines that fit maxW. Returns array of lines.
function wrap(str, size, maxW, opts = {}) {
  const words = str.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (textWidth(test, size, opts) <= maxW || !cur) cur = test;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}
// Draw wrapped lines starting at (x, firstBaselineY) with leading px.
function textBlock(str, x, firstBaselineY, size, maxW, leading, c, opts = {}) {
  const lines = wrap(str, size, maxW, opts);
  lines.forEach((ln, i) => text(ln, x, firstBaselineY + i * leading, size, c, opts));
  return lines.length;
}

// ---------- content: 58 stories, all dated Saturday 21 November 2026 ----------
// Headlines and bodies are my own short wording; sources are named beside
// each story. Full source list in RESEARCH.md (work dir).

const LEADS = [
  { n: 1, color: NAVY, title: "COP31: OVERTIME", kicker: "ANTALYA — CONFIRMED",
    head: "Summit runs into Saturday with no deal",
    body: "No deal as talks run past the deadline; the draft drops fossil fuels.",
    src: "AP, AFP", art: "globe" },
  { n: 2, color: RED_DARK, title: "SAUDI: MISSILES", kicker: "RIYADH — CONFIRMED",
    head: "Five missiles shot down over Saudi Arabia",
    body: "Three over Riyadh, two over Jizan; the coalition says all were stopped.",
    src: "AFP", art: "missiles" },
  { n: 3, color: AMBER, title: "PERU: QUAKE 6.7", kicker: "JUNIN — CONFIRMED",
    head: "Strong quake shakes central Peru",
    body: "Felt across central Peru and in Lima; no deaths reported so far.",
    src: "USGS, IGP", art: "quake" },
];

const SMALLS = [
  { n: 4, color: NAVY_DARK, title: "KYIV: BARRAGE", kicker: "KYIV — REPORTED",
    head: "Russia fires 400+ drones and 110 missiles overnight",
    body: "Two missiles land in Poland; Kyiv hit hard.", src: "France 24, CBS", art: "barrage" },
  { n: 5, color: TEAL, title: "HORMUZ: DRONE", kicker: "HORMUZ — REPORTED",
    head: "Iran says it shot down a US drone",
    body: "No confirmation from Washington so far.", src: "IRIB", art: "drone" },
  { n: 6, color: PURPLE, title: "IRAN: URANIUM", kicker: "TEHRAN — REPORTED",
    head: "Iran: uranium stock stays in the country",
    body: "Minister still seeks 'a fair solution'.", src: "Times of Israel", art: "atom" },
  { n: 7, color: RED, title: "TRUMP: AI TAX", kicker: "WASHINGTON — REPORTED",
    head: "Trump vows 'tremendous' tax on data centres",
    body: "The tax would hit centres built abroad.", src: "FT, ABC", art: "chip" },
  { n: 8, color: SKY, title: "CHINA-JAPAN", kicker: "BEIJING — CONFIRMED",
    head: "China tells Japan to 'correct' Taiwan words",
    body: "Tokyo says its stance is unchanged.", src: "AFP", art: "flags" },
  { n: 9, color: GREEN, title: "DAVAO: 146 SAFE", kicker: "DAVAO — CONFIRMED",
    head: "Air Niugini jet lands safely after alert",
    body: "All 146 on board safe after fire alert.", src: "AP", art: "plane" },
  { n: 10, color: OCHRE, title: "CANBERRA: AI", kicker: "CANBERRA — CONFIRMED",
    head: "Australia and China agree to AI talks",
    body: "Albanese ends an 11-day trip to China.", src: "ABC", art: "flags" },
  { n: 11, color: AMBER, title: "BITCOIN: $58,983", kicker: "WORLD — CONFIRMED",
    head: "Bitcoin trades below $59,000 on Saturday",
    body: "Down 3.9% in 24 hours; ether $1,625.", src: "CoinGecko", art: "chart" },
  { n: 12, color: RED_DARK, title: "LAS VEGAS: POLE", kicker: "LAS VEGAS — CONFIRMED",
    head: "Antonelli fastest, but pole goes to Verstappen",
    body: "A grid penalty drops Antonelli; Russell P2.", src: "Formula 1, FIA", art: "race" },
  { n: 13, color: GREEN, title: "RAHUL: 124*", kicker: "WELLINGTON — CONFIRMED",
    head: "Rahul hits a century against New Zealand",
    body: "A first: a hundred in every SENA land.", src: "AFP", art: "bat" },
  { n: 14, color: NAVY, title: "WASHINGTON: FBI", kicker: "WASHINGTON — REPORTED",
    head: "FBI probes breach of its crime database",
    body: "The second FBI system hit in months.", src: "CNN", art: "shield" },
  { n: 15, color: TEAL, title: "INDIA: INFLOW", kicker: "MUMBAI — CONFIRMED",
    head: "Record foreign money pours into Indian shares",
    body: "Record 1.22 lakh crore rupees in November.", src: "Depository data", art: "rupee" },
];

// Briefs 16-58: one line each, number shown in red at the line start.
const BRIEFS = [
  "Kryvyi Rih: Double strike kills 2, injures 42",
  "Copenhagen: Russian attache expelled over plot",
  "Antalya: EU warns COP31 risks 'fossil summit' (AFP)",
  "Panama: Panama threatens to block climate text (AJ)",
  "Antalya: Indonesia PLN signs clean-power deals",
  "Yemen: Houthis threaten Jeddah and Red Sea ports (AJ)",
  "Vance: Iran strikes were Trump's call (Reuters)",
  "Washington: Lawmaker threatens SpaceX's funding (CNN)",
  "Texas: Execution of man of 70 takes 63 minutes (ABC)",
  "Los Angeles: Man convicted in Palisades fire (ABC)",
  "Vancouver: Canada rests defence in climate trial",
  "Pyongyang: Kim tours factories, no Trump meeting",
  "Sejong: Freight train derails, no one hurt",
  "Taipei: Budget and cash payout passed (Taipei Times)",
  "Bangkok: Six-point plan on arsenic in rivers (Nation)",
  "New Delhi: Pakistani minister joins SCO forum (Dawn)",
  "East India: Rain alerts as Akyan remnants move in",
  "Myanmar: Rights groups urge sanctions after ruling",
  "Port Louis: African rating agency talks to 15 states",
  "Melbourne: Cummins keeps the Australian captaincy",
  "Las Vegas: Verstappen sent to stewards (Autosport)",
  "Estonia: To close border crossings with Russia (AP)",
  "Iraq: Moves into militia stronghold Jurf al-Sakhar (AP)",
  "New York: Indian man gets 19 years in Pannun plot (AP)",
  "Nigeria: Boat carrying funeral mourners capsizes (AP)",
  "Tanzania: Opposition leader Lissu convicted (AP)",
  "Paris: France probes Depardieu and Houellebecq (AFP)",
  "Paris: Police sentenced for racist beating of Zecler",
  "Tokyo: Saudi, Japan agree oil stockpile deal (Rtrs)",
  "Buenos Aires: Country risk tops 1,000, bonds drop",
  "Kenya: Begins onshore crude drilling in Turkana (Rtrs)",
  "United States: US loses measles elimination status (AP)",
  "Kampala: Uganda restricts gatherings over Ebola threat",
  "Geneva: CERN finds first ultra-rare decay (CERN)",
  "United States: YouTube nears multibillion school deal",
  "London: Trial pill clears cancer in 1 in 12 (AP)",
  "Turin: Alcaraz stays unbeaten in ATP Finals group play",
  "Naples: A Lim Kim leads LPGA finale after hole-in-one",
  "Washington: Spirit reach NWSL Championship final (AP)",
  "Nepal: PM Balendra Shah to make first India visit (AP)",
  "Seoul: Ruling party moves to impeach chief justice (AP)",
  "Vatican: Giant Christmas tree up in St Peter's Sq",
  "Australia: Teen accused of arsons on Signal (AP)",
];

const NUMBERS = [
  { big: "DAY 13", cap: "COP31, planned for 12" },
  { big: "5", cap: "missiles shot down over Saudi Arabia" },
  { big: "6.7", cap: "Peru quake, magnitude" },
  { big: "146", cap: "safe after Davao jet alert" },
  { big: "$58,983", cap: "bitcoin on Saturday" },
  { big: "124*", cap: "Rahul vs New Zealand" },
];

const TIMELINE = [
  { t: "00:09", s: "Peru quake 6.7" },
  { t: "01:30", s: "Davao jet lands, 146 safe" },
  { t: "02:23", s: "FBI crime-database breach" },
  { t: "05:00", s: "Antonelli fastest in Vegas" },
  { t: "06:00", s: "Russia barrage, Poland hit" },
  { t: "14:00", s: "COP31 still deadlocked" },
];

const REGIONS = [
  { name: "EUROPE", n: 11, c: SKY },
  { name: "ASIA", n: 15, c: RED },
  { name: "MIDDLE EAST", n: 5, c: AMBER },
  { name: "AFRICA", n: 5, c: GREEN },
  { name: "AMERICAS", n: 17, c: PURPLE },
  { name: "OCEANIA", n: 3, c: TEAL },
  { name: "GLOBAL", n: 2, c: GREY },
];

const DATECHECK_TITLE = "DATE CHECK — WHAT WE LEFT OUT (AND WHY)";
const DATECHECK_LINES = [
  "20 Nov: Wall Street correction · UK-EU deals · Gen Z strikes in 25 countries · GTA VI $3.79bn day one · Cyclone Akvan",
  "19 Nov: ICJ ruling on Myanmar genocide · 18 Nov: Voyager 1 reaches one light-day · Not yet: BepiColombo in orbit · final COP31 text",
];

const SOURCES_LINE = "SOURCES: REUTERS · AP · AFP · BBC · CNN · AL JAZEERA · USGS · IGP · FORMULA 1 · FIA · AND OTHERS";
const FOOTER_LINE = "Every story here happened, or was first reported, on Saturday 21 November 2026. Officials' counts and claims are attributed.";

// ---------- flat vector illustrations (own drawings, one per panel) ----------
function drawArt(kind, x, y, w, h, c) {
  const cx = x + w / 2, cy = y + h / 2;
  if (kind === "globe") {
    circle(cx - 6, cy, 16, c);
    circle(cx - 6, cy, 16, PAPER, false);
    line(cx - 22, cy, cx + 10, cy, PAPER, 1);
    line(cx - 6, cy - 16, cx - 6, cy + 16, PAPER, 1);
    polyline([[cx - 18, cy - 10], [cx - 6, cy - 14], [cx + 6, cy - 10]], PAPER, 1);
    polyline([[cx - 18, cy + 10], [cx - 6, cy + 14], [cx + 6, cy + 10]], PAPER, 1);
    fillRect(cx + 16, cy - 12, 5, 24, RED);
    circle(cx + 18, cy - 14, 4, RED);
    line(cx + 30, cy + 12, cx + 44, cy + 12, INK, 2);
    line(cx + 34, cy + 6, cx + 40, cy + 12, INK, 2);
  } else if (kind === "missiles") {
    fillRect(x, y, w, h, [24, 30, 46]);
    const base = y + h - 6;
    fillRect(x + 8, base - 14, 18, 14, [60, 66, 84]);
    fillRect(x + 32, base - 22, 16, 22, [60, 66, 84]);
    fillRect(x + 54, base - 10, 20, 10, [60, 66, 84]);
    fillRect(x + 80, base - 18, 14, 18, [60, 66, 84]);
    for (let i = 0; i < 5; i++) {
      const sx = x + 30 + i * 52, sy = y + 8 + (i % 2) * 8;
      line(sx, sy + 26, sx + 22, sy, [255, 200, 90], 2);
      circle(sx + 24, sy - 2, 3, [255, 220, 130]);
      line(sx + 20, sy - 6, sx + 28, sy + 2, [255, 220, 130], 1);
      line(sx + 20, sy + 2, sx + 28, sy - 6, [255, 220, 130], 1);
    }
  } else if (kind === "quake") {
    line(x, y + h - 8, x + w, y + h - 8, INK, 2);
    polyline([[x + 6, cy], [x + 20, cy - 8], [x + 30, cy + 8], [x + 42, cy - 14], [x + 54, cy + 10], [x + 66, cy - 4], [x + 80, cy], [x + 96, cy + 6]], RED, 2);
    fillRect(x + w - 52, y + h - 34, 34, 26, c);
    fillPoly([[x + w - 56, y + h - 34], [x + w - 35, y + h - 50], [x + w - 14, y + h - 34]], RED_DARK);
    line(x + w - 35, y + h - 34, x + w - 28, y + h - 20, INK, 1);
    line(x + w - 28, y + h - 20, x + w - 32, y + h - 12, INK, 1);
  } else if (kind === "barrage") {
    fillRect(x, y, w, h, [24, 30, 46]);
    const bursts = [[x + 30, y + 14], [x + 80, y + 10], [x + 120, y + 18]];
    for (const [bx, by] of bursts) {
      for (let a = 0; a < 8; a++) {
        const ang = (a * Math.PI) / 4;
        line(bx, by, bx + Math.cos(ang) * 12, by + Math.sin(ang) * 12, [255, 190, 80], 2);
      }
      circle(bx, by, 3, [255, 220, 130]);
    }
    fillRect(x + 10, y + h - 12, 20, 12, [60, 66, 84]);
    fillRect(x + 36, y + h - 20, 16, 20, [60, 66, 84]);
    fillRect(x + 58, y + h - 10, 22, 10, [60, 66, 84]);
    fillRect(x + 120, y + h - 16, 18, 16, [60, 66, 84]);
  } else if (kind === "drone") {
    fillRect(x, y, w, h, [214, 230, 240]);
    fillRect(cx - 14, cy - 16, 28, 8, INK);
    circle(cx - 18, cy - 18, 4, INK);
    circle(cx + 18, cy - 18, 4, INK);
    line(cx - 26, cy - 18, cx - 10, cy - 18, INK, 1);
    line(cx + 10, cy - 18, cx + 26, cy - 18, INK, 1);
    line(cx - 4, cy - 8, cx - 4, cy + 2, INK, 1);
    line(cx + 4, cy - 8, cx + 4, cy + 2, INK, 1);
    for (let i = 0; i < 4; i++) line(x + 8 + i * 34, y + h - 6, x + 22 + i * 34, y + h - 12, [90, 130, 160], 2);
    fillRect(x + 100, y + h - 22, 34, 14, [70, 66, 60]);
    fillRect(x + 108, y + h - 30, 18, 8, [70, 66, 60]);
  } else if (kind === "atom") {
    circle(cx, cy, 4, c);
    const ell = (rx, ry, rot) => {
      const pts = [];
      for (let a = 0; a <= 24; a++) {
        const t = (a / 24) * Math.PI * 2;
        const px = Math.cos(t) * rx, py = Math.sin(t) * ry;
        pts.push([cx + px * Math.cos(rot) - py * Math.sin(rot), cy + px * Math.sin(rot) + py * Math.cos(rot)]);
      }
      polyline(pts, c, 1);
    };
    ell(26, 9, 0); ell(26, 9, Math.PI / 3); ell(26, 9, -Math.PI / 3);
  } else if (kind === "chip") {
    fillRect(cx - 22, cy - 14, 44, 28, [40, 44, 52]);
    for (let i = 0; i < 4; i++) {
      line(cx - 22 + i * 12, cy - 20, cx - 22 + i * 12, cy - 14, [40, 44, 52], 2);
      line(cx - 22 + i * 12, cy + 14, cx - 22 + i * 12, cy + 20, [40, 44, 52], 2);
    }
    text("AI", cx - 12, cy + 5, 14, WHITE, { bold: true });
    text("%", cx + 30, cy + 6, 16, RED, { bold: true });
  } else if (kind === "flags") {
    line(cx - 22, cy - 16, cx - 22, cy + 16, INK, 2);
    line(cx + 22, cy - 16, cx + 22, cy + 16, INK, 2);
    fillRect(cx - 22, cy - 16, 26, 16, [200, 30, 30]);
    circle(cx - 14, cy - 11, 2, [255, 220, 80]);
    circle(cx - 8, cy - 13, 1, [255, 220, 80]);
    fillRect(cx + 22, cy - 16, 26, 16, WHITE);
    vline(cx + 22, cy - 16, 16, LINE, 1); hline(cx + 22, cy - 16, 26, LINE, 1); hline(cx + 22, cy, 26, LINE, 1);
    circle(cx + 35, cy - 8, 5, [200, 30, 30]);
  } else if (kind === "plane") {
    fillRect(x, y, w, h, [214, 230, 240]);
    polyline([[x + 12, cy + 2], [x + 60, cy - 2], [x + 108, cy - 4], [x + 128, cy - 2]], INK, 3);
    fillPoly([[x + 60, cy - 2], [x + 76, cy - 16], [x + 88, cy - 2]], INK);
    fillPoly([[x + 60, cy - 2], [x + 72, cy + 12], [x + 84, cy - 2]], INK);
    fillPoly([[x + 118, cy - 2], [x + 128, cy - 12], [x + 134, cy - 2]], INK);
    for (let i = 0; i < 8; i++) line(x + 10 + i * 16, y + h - 6, x + 20 + i * 16, y + h - 6, [90, 130, 160], 2);
    circle(x + 140, cy - 10, 3, GREEN);
  } else if (kind === "chart") {
    line(x + 6, y + 4, x + 6, y + h - 6, INK, 1);
    line(x + 6, y + h - 6, x + w - 6, y + h - 6, INK, 1);
    polyline([[x + 10, y + 8], [x + 30, y + 12], [x + 50, y + 10], [x + 70, y + 20], [x + 90, y + 26], [x + 110, y + 24], [x + 130, y + h - 10]], RED, 2);
    circle(x + w - 30, y + 12, 11, [240, 180, 60]);
    text("B", x + w - 35, y + 17, 13, INK, { bold: true });
  } else if (kind === "race") {
    const rx = w / 2 - 10, ry = h / 2 - 4;
    const pts = [];
    for (let a = 0; a <= 32; a++) {
      const t = (a / 32) * Math.PI * 2;
      pts.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
    }
    polyline(pts, INK, 2);
    circle(cx + rx, cy, 4, RED);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      if ((i + j) % 2 === 0) fillRect(x + 8 + i * 5, y + 4 + j * 5, 5, 5, INK);
    }
    line(x + 8, y + 24, x + 28, y + 24, INK, 1);
  } else if (kind === "bat") {
    fillRect(cx - 4, cy - 16, 10, 26, [190, 160, 100]);
    fillRect(cx - 1, cy + 10, 4, 12, [120, 90, 50]);
    circle(cx + 22, cy + 8, 6, RED);
    line(cx - 24, cy + 14, cx - 24, cy - 6, INK, 2);
    line(cx - 16, cy + 14, cx - 16, cy - 6, INK, 2);
    line(cx - 8, cy + 14, cx - 8, cy - 6, INK, 2);
    line(cx - 28, cy + 14, cx - 4, cy + 14, INK, 2);
  } else if (kind === "shield") {
    fillPoly([[cx - 14, cy - 14], [cx + 14, cy - 14], [cx + 14, cy + 2], [cx, cy + 16], [cx - 14, cy + 2]], NAVY);
    circle(cx + 12, cy + 4, 8, c);
    line(cx + 18, cy + 10, cx + 26, cy + 18, c, 2);
    text("?", cx + 9, cy + 8, 12, WHITE, { bold: true });
  } else if (kind === "rupee") {
    polyline([[x + 8, y + h - 10], [x + 40, y + h - 18], [x + 66, y + h - 14], [x + 96, y + 8], [x + 126, y + 4]], GREEN, 2);
    fillPoly([[x + 126, y + 4], [x + 114, y + 2], [x + 122, y + 14]], GREEN);
    circle(x + 18, y + 12, 8, [240, 180, 60]);
    circle(x + 34, y + 16, 8, [240, 180, 60]);
    text("Rs", x + 44, y + 22, 11, INK, { bold: true });
  }
}

// ---------- world map (rough continent outlines, own coordinates) ----------
const MAP_X = 16, MAP_Y = 718, MAP_W = 340, MAP_H = 210;
function mapPt(lon, lat) {
  return [MAP_X + (lon + 180) * (MAP_W / 360), MAP_Y + (75 - lat) * (MAP_H / 135)];
}
const CONTINENTS = [
  [[-168,66],[-140,70],[-125,72],[-110,68],[-95,69],[-85,66],[-80,73],[-70,62],[-60,55],[-55,47],[-65,45],[-75,40],[-80,32],[-85,30],[-90,21],[-97,16],[-105,20],[-110,23],[-120,34],[-125,40],[-125,48],[-135,58],[-150,60],[-165,60]],
  [[-80,9],[-75,11],[-62,10],[-52,5],[-50,0],[-44,-3],[-35,-8],[-40,-20],[-48,-28],[-55,-35],[-65,-40],[-70,-50],[-73,-53],[-73,-40],[-72,-20],[-80,-5],[-81,0]],
  [[-17,15],[-10,30],[0,36],[10,37],[20,32],[30,31],[35,28],[43,12],[51,11],[48,0],[40,-10],[35,-18],[32,-28],[20,-35],[15,-27],[12,-18],[9,-1],[9,4],[-8,4],[-13,8]],
  [[-10,36],[-9,43],[-2,48],[0,50],[5,53],[8,57],[10,59],[18,56],[21,55],[24,58],[28,60],[30,62],[30,70],[20,70],[15,68],[10,64],[5,60],[0,55],[-5,50],[-10,43]],
  [[30,70],[40,68],[55,68],[70,72],[90,75],[110,76],[130,72],[150,70],[160,66],[162,60],[158,52],[142,50],[140,40],[135,35],[130,33],[127,35],[122,38],[120,30],[110,20],[105,10],[100,8],[97,15],[92,20],[88,22],[80,15],[75,10],[72,20],[66,25],[60,25],[55,26],[50,28],[48,30],[45,30],[40,35],[35,36],[30,36],[28,42],[30,46]],
  [[113,-22],[114,-30],[115,-35],[124,-33],[130,-32],[136,-35],[140,-38],[145,-38],[150,-37],[153,-27],[146,-19],[142,-11],[137,-12],[132,-12],[126,-14],[122,-17],[118,-20]],
  [[-5,50],[-3,53],[-5,56],[-3,58],[-1,57],[0,53],[-1,51]],
  [[130,31],[132,33],[135,34],[138,35],[140,38],[141,41],[143,43],[145,44],[142,42],[140,39],[137,37],[133,35]],
  [[95,5],[100,0],[105,-5],[110,-7],[115,-8],[120,-10],[125,-9],[130,-3],[135,-2],[140,-4],[138,-8],[132,-4],[128,0],[122,0],[118,2],[112,0],[105,0],[100,3]],
  [[167,-45],[170,-42],[174,-39],[176,-37],[178,-38],[176,-40],[173,-42],[168,-46]],
  [[44,-16],[47,-15],[50,-16],[50,-22],[47,-25],[44,-25],[43,-20]],
];
// [lon, lat, story number] — pins for the 15 panels + 6 briefs (no overlaps).
const PINS = [
  [30.7, 36.9, 1], [46.7, 24.7, 2], [-75.2, -11.2, 3], [30.5, 50.4, 4],
  [60, 29, 5], [51.4, 35.7, 6], [-77, 38.9, 7], [116.4, 39.9, 8],
  [125.6, 7.1, 9], [149.1, -35.3, 10], [0, 0, 11], [-115.2, 36.2, 12],
  [172, -41, 13], [-65, 44, 14], [72.9, 19.1, 15], [12.6, 55.7, 17],
  [-79.5, 9, 19], [6.3, 4.8, 40], [39.3, -6.8, 41], [-58.4, -34.6, 45],
  [85.3, 27.7, 55],
];

// ---------- layout ----------
function drawHeader() {
  text("THE WORLD IN ONE DAY", MARGIN, 21, 11, RED, { bold: true });
  text("58 STORIES · 7 REGIONS · EVERY ONE DATED SATURDAY 21 NOVEMBER 2026", W - MARGIN, 21, 11, INK, { bold: true, align: "r" });
  hline(MARGIN, 28, CW, INK, 2);
  text("Saturday 21 November 2026", W / 2, 88, 55, INK, { bold: true, align: "c" });
  text("COP31 runs past its deadline · Five missiles over Saudi Arabia · Peru quake 6.7", W / 2, 112, 17, INK_SOFT, { italic: true, align: "c" });
  hline(MARGIN, 118, CW, INK, 2);
}
function drawNumbers() {
  const colW = CW / 6;
  NUMBERS.forEach((s, i) => {
    const x = MARGIN + i * colW;
    hline(x + 2, 124, colW - 10, RED, 2);
    text(s.big, x + 2, 146, 28, INK, { bold: true });
    textBlock(s.cap, x + 2, 160, 9.5, colW - 10, 12, INK_SOFT);
  });
  hline(MARGIN, 178, CW, LINE, 1);
}
function drawRegions() {
  let total = 0;
  const parts = REGIONS.map((r) => {
    const w = 12 + textWidth(r.name + " " + r.n, 11, { bold: true }) + 18;
    total += w;
    return w;
  });
  let x = (W - total) / 2;
  REGIONS.forEach((r, i) => {
    circle(x + 5, 186, 5, r.c);
    text(r.name + " " + r.n, x + 14, 191, 11, INK, { bold: true });
    x += parts[i];
  });
  hline(MARGIN, 198, CW, LINE, 1);
}
function drawTimeline() {
  const colW = CW / 6;
  TIMELINE.forEach((t, i) => {
    const x = MARGIN + i * colW + 2;
    text(t.t, x, 212, 10, RED, { bold: true });
    text(t.s, x, 224, 8.5, INK);
  });
  hline(MARGIN, 230, CW, INK, 2);
}
function drawPanelBox(x, y, w, h) {
  fillRect(x, y, w, h, PANEL_BG);
  hline(x, y, w, LINE, 1); hline(x, y + h - 1, w, LINE, 1);
  vline(x, y, h, LINE, 1); vline(x + w - 1, y, h, LINE, 1);
}
function drawLead(p, x, y, w, h) {
  drawPanelBox(x, y, w, h);
  fillRect(x, y, w, 24, p.color);
  text(p.n + "  " + p.title, x + 8, y + 17, 14, WHITE, { bold: true });
  fillRect(x + 1, y + 25, w - 2, 39, [238, 232, 220]);
  drawArt(p.art, x + 6, y + 26, w - 12, 37, p.color);
  text(p.kicker, x + 8, y + 78, 10, RED, { bold: true });
  textBlock(p.head, x + 8, y + 98, 17, w - 16, 20, INK, { bold: true });
  textBlock(p.body, x + 8, y + 135, 11, w - 16, 12, INK_SOFT);
  text("(" + p.src + ")", x + 8, y + 160, 9, INK_SOFT);
}
function drawSmall(p, x, y, w, h) {
  drawPanelBox(x, y, w, h);
  fillRect(x, y, w, 20, p.color);
  text(p.n + " " + p.title, x + 6, y + 14, 11, WHITE, { bold: true });
  fillRect(x + 1, y + 21, w - 2, 33, [238, 232, 220]);
  drawArt(p.art, x + 4, y + 22, w - 8, 31, p.color);
  text(p.kicker, x + 6, y + 64, 9.5, RED, { bold: true });
  textBlock(p.head, x + 6, y + 78, 12, w - 12, 13, INK, { bold: true });
  textBlock(p.body, x + 6, y + 117, 9.5, w - 12, 11, INK_SOFT);
  text("(" + p.src + ")", x + 6, y + 141, 8.5, INK_SOFT);
}
function drawMapList() {
  text("WHERE IT HAPPENED", MARGIN, 706, 11, INK, { bold: true });
  text("ALSO ON SATURDAY 21 NOVEMBER — 43 MORE STORIES", 368, 706, 11, INK, { bold: true });
  fillRect(MAP_X, MAP_Y, MAP_W, MAP_H, MAP_SEA);
  for (const cont of CONTINENTS) fillPoly(cont.map(([lo, la]) => mapPt(lo, la)), MAP_LAND);
  hline(MAP_X, MAP_Y, MAP_W, LINE, 1); hline(MAP_X, MAP_Y + MAP_H - 1, MAP_W, LINE, 1);
  vline(MAP_X, MAP_Y, MAP_H, LINE, 1); vline(MAP_X + MAP_W - 1, MAP_Y, MAP_H, LINE, 1);
  for (const [lo, la, n] of PINS) {
    const [px, py] = mapPt(lo, la);
    circle(px, py, n > 9 ? 7 : 6, RED);
    text(String(n), px, py + 2.5, 7, WHITE, { bold: true, align: "c" });
  }
  text("Red pins: the 15 big stories above. Numbers match the panels.", MAP_X + MAP_W / 2, 940, 8, INK_SOFT, { align: "c" });
  const colX = [368, 694], colW = 314;
  for (let c = 0; c < 2; c++) {
    for (let r = 0; r < 22; r++) {
      const idx = c * 22 + r;
      if (idx >= BRIEFS.length) break;
      const y = 712 + r * 11.5;
      text(String(16 + idx) + ".", colX[c], y, 7.5, RED, { bold: true });
      text(BRIEFS[idx], colX[c] + 19, y, 7.5, INK, { bold: true });
    }
  }
}
function drawDateCheck() {
  const y0 = 956, y1 = 1000;
  fillRect(MARGIN, y0, CW, y1 - y0, [253, 240, 235]);
  hline(MARGIN, y0, CW, RED, 2); hline(MARGIN, y1 - 1, CW, RED, 2);
  vline(MARGIN, y0, y1 - y0, RED, 2); vline(W - MARGIN - 2, y0, y1 - y0, RED, 2);
  text(DATECHECK_TITLE, MARGIN + 10, y0 + 14, 11, RED, { bold: true });
  text(DATECHECK_LINES[0], MARGIN + 10, y0 + 28, 10, INK);
  text(DATECHECK_LINES[1], MARGIN + 10, y0 + 42, 10, INK);
}
function drawFooter() {
  text(FOOTER_LINE, W / 2, 1008, 9.5, INK_SOFT, { align: "c" });
  text(SOURCES_LINE, W / 2, 1019, 8.5, INK_SOFT, { align: "c" });
}

function main() {
  fillCanvas(PAPER);
  drawHeader();
  drawNumbers();
  drawRegions();
  drawTimeline();
  const leadW = 325, leadY = 232, leadH = 164;
  LEADS.forEach((p, i) => drawLead(p, MARGIN + i * (leadW + 8), leadY, leadW, leadH));
  const smallW = 158, smallH = 144;
  SMALLS.forEach((p, i) => {
    const row = Math.floor(i / 6), col = i % 6;
    drawSmall(p, 18 + col * 166, 402 + row * 148, smallW, smallH);
  });
  drawMapList();
  drawDateCheck();
  drawFooter();
  const out = process.env.MAKEFUN_OUTPUT_DIR || "out";
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(out + "/entry.png", encodePNG());
  console.log("wrote " + out + "/entry.png");
}
main();
