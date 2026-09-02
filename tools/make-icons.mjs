/**
 * アプリのアイコン(角丸の四角にチェックマーク)を生成する。
 * Node標準の zlib だけでPNGを書き出すため、画像ライブラリを足さない。
 *
 *   node tools/make-icons.mjs
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const BG = [0xff, 0xff, 0xff]; // 白背景
const FG = [0x18, 0x63, 0xdc]; // 寒色(青)のチェック

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, pixel) {
  // 各行の先頭にフィルタ種別のバイト(0 = なし)を置く
  const raw = Buffer.alloc(size * (1 + size * 4));
  let at = 0;
  for (let y = 0; y < size; y++) {
    raw[at++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[at++] = r;
      raw[at++] = g;
      raw[at++] = b;
      raw[at++] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // ビット深度
  ihdr[9] = 6; // カラータイプ: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 点と線分の距離 */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function draw(size) {
  const r = size * 0.22; // 角丸の半径
  // チェックマークの2本の線分(サイズに対する比率で置く)
  const strokes = [
    [0.26, 0.52, 0.43, 0.69],
    [0.43, 0.69, 0.75, 0.34],
  ].map((s) => s.map((v) => v * size));
  const thickness = size * 0.075;

  return (x, y) => {
    // 角丸の外側は透明にする
    const cx = Math.min(Math.max(x + 0.5, r), size - r);
    const cy = Math.min(Math.max(y + 0.5, r), size - r);
    if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > r) return [0, 0, 0, 0];

    const d = Math.min(...strokes.map((s) => distanceToSegment(x + 0.5, y + 0.5, ...s)));
    // 境界の1px分を混ぜて、階段状のギザつきを抑える
    const mix = Math.min(1, Math.max(0, thickness - d));
    return [
      Math.round(BG[0] + (FG[0] - BG[0]) * mix),
      Math.round(BG[1] + (FG[1] - BG[1]) * mix),
      Math.round(BG[2] + (FG[2] - BG[2]) * mix),
      255,
    ];
  };
}

for (const size of [192, 512]) {
  const file = `public/icon-${size}.png`;
  writeFileSync(file, png(size, draw(size)));
  console.log("wrote", file);
}
