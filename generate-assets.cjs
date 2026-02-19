#!/usr/bin/env node
// Generates minimal valid PNG placeholder assets for Expo.
// Solid SwiftClear brand colors — replace with real design assets before app store submission.

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── CRC32 ─────────────────────────────────────────────────────
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── PNG chunk builder ─────────────────────────────────────────
function chunk(type, data) {
  const t   = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);   len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);   crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

// ── Solid-colour PNG ──────────────────────────────────────────
function makePNG(w, h, r, g, b) {
  const sig  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

  // One scanline (filter byte 0 + RGB pixels), repeated h times
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) {
    row[1 + x * 3]     = r;
    row[1 + x * 3 + 1] = g;
    row[1 + x * 3 + 2] = b;
  }
  const raw  = Buffer.concat(Array.from({ length: h }, () => row));
  const idat = zlib.deflateSync(raw, { level: 1 });

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── Brand colours ─────────────────────────────────────────────
const NAVY = [8,  12,  20];   // SwiftClear dark background
const BLUE = [59, 130, 246];  // SwiftClear accent

const assetsDir = path.join(__dirname, 'apps/mobile/assets');
fs.mkdirSync(assetsDir, { recursive: true });

const files = [
  { name: 'icon.png',          w: 1024, h: 1024, color: NAVY },
  { name: 'splash.png',        w: 1242, h: 2436, color: NAVY },
  { name: 'adaptive-icon.png', w: 1024, h: 1024, color: BLUE },
];

for (const { name, w, h, color } of files) {
  const [r, g, b] = color;
  const dest = path.join(assetsDir, name);
  fs.writeFileSync(dest, makePNG(w, h, r, g, b));
  const kb = (fs.statSync(dest).size / 1024).toFixed(1);
  console.log(`✓ ${name.padEnd(22)} ${w}x${h}  ${kb} KB`);
}
console.log('\nAssets written to apps/mobile/assets/');
