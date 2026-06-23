const VERSION = 6;
const SIZE = 21 + (VERSION - 1) * 4;
const DATA_CODEWORDS = 136;
const BLOCK_DATA_CODEWORDS = 68;
const ECC_CODEWORDS = 18;

function multiply(left, right) {
  let result = 0;
  for (let index = 0; index < 8; index += 1) {
    if (right & 1) result ^= left;
    right >>>= 1;
    left = (left << 1) ^ ((left >>> 7) * 0x11d);
  }
  return result;
}

function divisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let index = 0; index < degree; index += 1) {
    for (let offset = 0; offset < degree; offset += 1) {
      result[offset] = multiply(result[offset], root);
      if (offset + 1 < degree) result[offset] ^= result[offset + 1];
    }
    root = multiply(root, 2);
  }
  return result;
}

function remainder(data, polynomial) {
  const result = new Uint8Array(polynomial.length);
  for (const value of data) {
    const factor = value ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let index = 0; index < result.length; index += 1) result[index] ^= multiply(polynomial[index], factor);
  }
  return result;
}

function appendBits(bits, value, length) {
  for (let index = length - 1; index >= 0; index -= 1) bits.push((value >>> index) & 1);
}

function dataCodewords(text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 134) throw new Error("QR link is too long");
  const bits = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 8);
  for (const value of bytes) appendBits(bits, value, 8);
  appendBits(bits, 0, Math.min(4, DATA_CODEWORDS * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const result = [];
  for (let index = 0; index < bits.length; index += 8) result.push(Number.parseInt(bits.slice(index, index + 8).join(""), 2));
  for (let pad = 0; result.length < DATA_CODEWORDS; pad += 1) result.push(pad % 2 ? 0x11 : 0xec);
  return result;
}

function encodedCodewords(text) {
  const data = dataCodewords(text);
  const blocks = [data.slice(0, BLOCK_DATA_CODEWORDS), data.slice(BLOCK_DATA_CODEWORDS)];
  const polynomial = divisor(ECC_CODEWORDS);
  const errorBlocks = blocks.map((block) => [...remainder(block, polynomial)]);
  const result = [];
  for (let index = 0; index < BLOCK_DATA_CODEWORDS; index += 1) for (const block of blocks) result.push(block[index]);
  for (let index = 0; index < ECC_CODEWORDS; index += 1) for (const block of errorBlocks) result.push(block[index]);
  return result;
}

function formatBits(mask) {
  const data = (1 << 3) | mask; // Error-correction level L.
  let remainderBits = data;
  for (let index = 0; index < 10; index += 1) remainderBits = (remainderBits << 1) ^ (((remainderBits >>> 9) & 1) * 0x537);
  return ((data << 10) | remainderBits) ^ 0x5412;
}

function createMatrix(text) {
  const modules = Array.from({ length:SIZE }, () => Array(SIZE).fill(false));
  const functions = Array.from({ length:SIZE }, () => Array(SIZE).fill(false));
  const setFunction = (x, y, dark) => { if (x >= 0 && y >= 0 && x < SIZE && y < SIZE) { modules[y][x] = dark; functions[y][x] = true; } };
  const finder = (centerX, centerY) => {
    for (let y = -4; y <= 4; y += 1) for (let x = -4; x <= 4; x += 1) {
      const distance = Math.max(Math.abs(x), Math.abs(y));
      setFunction(centerX + x, centerY + y, distance !== 2 && distance !== 4);
    }
  };
  finder(3, 3); finder(SIZE - 4, 3); finder(3, SIZE - 4);
  for (let index = 8; index < SIZE - 8; index += 1) { setFunction(6, index, index % 2 === 0); setFunction(index, 6, index % 2 === 0); }
  for (const y of [6, 34]) for (const x of [6, 34]) {
    if (functions[y][x]) continue;
    for (let offsetY = -2; offsetY <= 2; offsetY += 1) for (let offsetX = -2; offsetX <= 2; offsetX += 1) setFunction(x + offsetX, y + offsetY, Math.max(Math.abs(offsetX), Math.abs(offsetY)) !== 1);
  }
  const drawFormat = (mask) => {
    const bits = formatBits(mask);
    const bit = (index) => ((bits >>> index) & 1) !== 0;
    for (let index = 0; index <= 5; index += 1) setFunction(8, index, bit(index));
    setFunction(8, 7, bit(6)); setFunction(8, 8, bit(7)); setFunction(7, 8, bit(8));
    for (let index = 9; index < 15; index += 1) setFunction(14 - index, 8, bit(index));
    for (let index = 0; index < 8; index += 1) setFunction(SIZE - 1 - index, 8, bit(index));
    for (let index = 8; index < 15; index += 1) setFunction(8, SIZE - 15 + index, bit(index));
    setFunction(8, SIZE - 8, true);
  };
  drawFormat(0);

  const bits = [];
  for (const codeword of encodedCodewords(text)) appendBits(bits, codeword, 8);
  bits.push(0, 0, 0, 0, 0, 0, 0);
  let bitIndex = 0;
  for (let right = SIZE - 1, upward = true; right >= 1; right -= 2, upward = !upward) {
    if (right === 6) right -= 1;
    for (let vertical = 0; vertical < SIZE; vertical += 1) {
      const y = upward ? SIZE - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;
        if (functions[y][x]) continue;
        const value = bitIndex < bits.length && bits[bitIndex] !== 0;
        modules[y][x] = value !== ((x + y) % 2 === 0);
        bitIndex += 1;
      }
    }
  }
  drawFormat(0);
  return modules;
}

export function qrSvg(text, { title = "QR code" } = {}) {
  const matrix = createMatrix(String(text));
  const border = 4;
  const paths = [];
  for (let y = 0; y < SIZE; y += 1) for (let x = 0; x < SIZE; x += 1) if (matrix[y][x]) paths.push(`M${x + border},${y + border}h1v1h-1z`);
  const safeTitle = String(title).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<svg class="qr-code" viewBox="0 0 ${SIZE + border * 2} ${SIZE + border * 2}" role="img" aria-label="${safeTitle}"><rect width="100%" height="100%" fill="#fff"/><path d="${paths.join("")}" fill="#05070c"/></svg>`;
}
