// Generate a 128x128 PNG icon for the extension using only Node built-ins.
// Draws a rounded dark-blue square with a green terminal prompt ">_" motif.
const zlib = require('zlib');
const fs = require('fs');

const W = 128, H = 128;

// RGBA buffer
const buf = Buffer.alloc(W * H * 4);

function setPixel(x, y, r, g, b, a = 255) {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = (y * W + x) * 4;
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = a;
}

// Rounded-rect test: returns true if (x,y) inside rounded rect with corner radius r
function insideRoundedRect(x, y, x0, y0, x1, y1, r) {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.max(x0 + r, Math.min(x, x1 - r));
    const cy = Math.max(y0 + r, Math.min(y, y1 - r));
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= r * r + 0.5;
}

// Colors
const bg = [31, 41, 55];       // slate-800
const accent = [16, 185, 129];  // emerald-500 (terminal green)
const fg = [236, 253, 245];    // near-white with green tint

// Background rounded rect (margin 6, radius 24)
for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        if (insideRoundedRect(x, y, 6, 6, W - 7, H - 7, 24)) {
            setPixel(x, y, bg[0], bg[1], bg[2]);
        } else {
            setPixel(x, y, 0, 0, 0, 0); // transparent
        }
    }
}

// Prompt glyphs: ">_" drawn as thick strokes
const stroke = 7;
const glyphColor = accent;

function drawLine(x0, y0, x1, y1, w, r, g, b) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = Math.round(x0 + (x1 - x0) * t);
        const y = Math.round(y0 + (y1 - y0) * t);
        for (let dy = -w; dy <= w; dy++) {
            for (let dx = -w; dx <= w; dx++) {
                if (dx * dx + dy * dy <= w * w + 0.5) {
                    setPixel(x + dx, y + dy, r, g, b);
                }
            }
        }
    }
}

// ">" shape: two lines meeting at a point, lower-left to upper-right then upper-right to lower-right
const cx = 40, cy = 64;
drawLine(cx - 22, cy + 22, cx + 22, cy, stroke, accent[0], accent[1], accent[2]);
drawLine(cx + 22, cy, cx - 22, cy - 22, stroke, accent[0], accent[1], accent[2]);

// "_" cursor: horizontal line under the prompt
drawLine(cx - 14, cy + 40, cx + 26, cy + 40, stroke, fg[0], fg[1], fg[2]);

// Encode PNG
function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = zlib.crc32 ? null : null; // Node has no built-in crc32
    // Manually compute CRC32
    let crcVal = crc32(typeBuf, crc32(data));
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crcVal >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// CRC32 table
const table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        t[n] = c;
    }
    return t;
})();

function crc32(buf, seed = 0) {
    let c = ~seed;
    for (let i = 0; i < buf.length; i++) {
        c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return ~c;
}

// Build raw scanlines with filter byte 0
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
    const rowStart = y * (W * 4 + 1);
    raw[rowStart] = 0; // filter: None
    buf.copy(raw, rowStart + 1, y * W * 4, (y + 1) * W * 4);
}

const idat = zlib.deflateSync(raw, { level: 9 });

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type RGBA
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
]);

fs.writeFileSync('icon.png', png);
console.log('icon.png written:', png.length, 'bytes');