import zlib from 'node:zlib';

export type QmpMouseButton = 'left' | 'right' | 'middle';

export interface QmpInputEvent {
  type: 'abs' | 'btn' | 'key';
  data: Record<string, unknown>;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Pure Node.js P6 PPM -> PNG converter using built-in zlib (no ImageMagick/ffmpeg spawn overhead).
 */
export function convertP6PpmToPng(ppmBuffer: Buffer): { png: Buffer; width: number; height: number } | null {
  if (ppmBuffer.length < 16 || ppmBuffer[0] !== 0x50 || ppmBuffer[1] !== 0x36) {
    return null;
  }

  // Parse P6 header tokens (skipping whitespace & '#' comments)
  const tokens: string[] = [];
  let offset = 0;
  while (offset < ppmBuffer.length && tokens.length < 4) {
    // Skip whitespace
    while (offset < ppmBuffer.length && (ppmBuffer[offset] === 0x20 || ppmBuffer[offset] === 0x0a || ppmBuffer[offset] === 0x0d || ppmBuffer[offset] === 0x09)) {
      offset++;
    }
    if (offset >= ppmBuffer.length) break;
    // Skip comment lines
    if (ppmBuffer[offset] === 0x23) {
      while (offset < ppmBuffer.length && ppmBuffer[offset] !== 0x0a) {
        offset++;
      }
      continue;
    }
    const start = offset;
    while (
      offset < ppmBuffer.length &&
      ppmBuffer[offset] !== 0x20 &&
      ppmBuffer[offset] !== 0x0a &&
      ppmBuffer[offset] !== 0x0d &&
      ppmBuffer[offset] !== 0x09
    ) {
      offset++;
    }
    tokens.push(ppmBuffer.subarray(start, offset).toString('ascii'));
  }

  if (tokens.length < 4 || tokens[0] !== 'P6') return null;
  const width = parseInt(tokens[1], 10);
  const height = parseInt(tokens[2], 10);
  const maxVal = parseInt(tokens[3], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || maxVal !== 255) {
    return null;
  }

  // Exactly one whitespace byte separates maxVal from binary RGB pixels
  const pixelOffset = offset + 1;
  const expectedPixelBytes = width * height * 3;
  if (pixelOffset + expectedPixelBytes > ppmBuffer.length) {
    return null;
  }

  // PNG color type 2 = RGB (3 bytes per pixel) + 1 filter byte (0x00) per row
  const rowBytes = width * 3;
  const rawScanlines = Buffer.allocUnsafe((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const dstStart = y * (rowBytes + 1);
    rawScanlines[dstStart] = 0; // Filter None
    const srcStart = pixelOffset + y * rowBytes;
    ppmBuffer.copy(rawScanlines, dstStart + 1, srcStart, srcStart + rowBytes);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const compressed = zlib.deflateSync(rawScanlines, { level: 1 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const png = Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);

  return { png, width, height };
}

export function clamp01(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.max(0, Math.min(1, val));
}

export function buildMouseMoveEvents(normX: number, normY: number): QmpInputEvent[] {
  const x = Math.round(clamp01(normX) * 32767);
  const y = Math.round(clamp01(normY) * 32767);
  return [
    { type: 'abs', data: { axis: 'x', value: x } },
    { type: 'abs', data: { axis: 'y', value: y } },
  ];
}

export function buildMouseButtonEvents(
  button: QmpMouseButton,
  down: boolean,
  normX?: number,
  normY?: number
): QmpInputEvent[] {
  const events: QmpInputEvent[] = [];
  if (typeof normX === 'number' && typeof normY === 'number') {
    events.push(...buildMouseMoveEvents(normX, normY));
  }
  events.push({ type: 'btn', data: { down, button } });
  return events;
}

export function buildMouseClickEvents(
  normX: number,
  normY: number,
  button: QmpMouseButton = 'left',
  doubleClick = false
): QmpInputEvent[] {
  const events: QmpInputEvent[] = [
    ...buildMouseMoveEvents(normX, normY),
    { type: 'btn', data: { down: true, button } },
    { type: 'btn', data: { down: false, button } },
  ];
  if (doubleClick) {
    events.push(
      { type: 'btn', data: { down: true, button } },
      { type: 'btn', data: { down: false, button } }
    );
  }
  return events;
}

export function buildMouseWheelEvents(
  direction: 'up' | 'down',
  normX?: number,
  normY?: number
): QmpInputEvent[] {
  const events: QmpInputEvent[] = [];
  if (typeof normX === 'number' && typeof normY === 'number') {
    events.push(...buildMouseMoveEvents(normX, normY));
  }
  const btn = direction === 'up' ? 'wheel-up' : 'wheel-down';
  events.push(
    { type: 'btn', data: { down: true, button: btn } },
    { type: 'btn', data: { down: false, button: btn } }
  );
  return events;
}

export function buildKeyComboEvents(qcodes: string[]): QmpInputEvent[] {
  const valid = qcodes.map((q) => q.trim()).filter(Boolean);
  if (valid.length === 0) return [];
  const press = valid.map<QmpInputEvent>((q) => ({
    type: 'key',
    data: { down: true, key: { type: 'qcode', data: q } },
  }));
  const release = [...valid].reverse().map<QmpInputEvent>((q) => ({
    type: 'key',
    data: { down: false, key: { type: 'qcode', data: q } },
  }));
  return [...press, ...release];
}

const CHAR_TO_QCODE: Record<string, { qcode: string; shift: boolean }> = {
  ' ': { qcode: 'spc', shift: false },
  '\n': { qcode: 'ret', shift: false },
  '\t': { qcode: 'tab', shift: false },
  '-': { qcode: 'minus', shift: false },
  '_': { qcode: 'minus', shift: true },
  '=': { qcode: 'equal', shift: false },
  '+': { qcode: 'equal', shift: true },
  '[': { qcode: 'bracket_left', shift: false },
  '{': { qcode: 'bracket_left', shift: true },
  ']': { qcode: 'bracket_right', shift: false },
  '}': { qcode: 'bracket_right', shift: true },
  '\\': { qcode: 'backslash', shift: false },
  '|': { qcode: 'backslash', shift: true },
  ';': { qcode: 'semicolon', shift: false },
  ':': { qcode: 'semicolon', shift: true },
  "'": { qcode: 'apostrophe', shift: false },
  '"': { qcode: 'apostrophe', shift: true },
  '`': { qcode: 'grave_accent', shift: false },
  '~': { qcode: 'grave_accent', shift: true },
  ',': { qcode: 'comma', shift: false },
  '<': { qcode: 'comma', shift: true },
  '.': { qcode: 'dot', shift: false },
  '>': { qcode: 'dot', shift: true },
  '/': { qcode: 'slash', shift: false },
  '?': { qcode: 'slash', shift: true },
  '!': { qcode: '1', shift: true },
  '@': { qcode: '2', shift: true },
  '#': { qcode: '3', shift: true },
  '$': { qcode: '4', shift: true },
  '%': { qcode: '5', shift: true },
  '^': { qcode: '6', shift: true },
  '&': { qcode: '7', shift: true },
  '*': { qcode: '8', shift: true },
  '(': { qcode: '9', shift: true },
  ')': { qcode: '0', shift: true },
};

export function mapCharToQcodeCombo(ch: string): string[] | null {
  if (/^[a-z]$/.test(ch)) return [ch];
  if (/^[A-Z]$/.test(ch)) return ['shift', ch.toLowerCase()];
  if (/^[0-9]$/.test(ch)) return [ch];
  const special = CHAR_TO_QCODE[ch];
  if (!special) return null;
  return special.shift ? ['shift', special.qcode] : [special.qcode];
}
