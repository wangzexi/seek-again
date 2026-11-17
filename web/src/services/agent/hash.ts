/**
 * 内容哈希（SHA-256，十六进制）。优先用浏览器的 crypto.subtle；它只在安全上下文
 * （https 或 localhost）可用，通过局域网 IP 的 http 访问时没有，所以保留纯 JS 实现兜底。
 */

const K = new Uint32Array(64);
const H0 = new Uint32Array(8);
{
  // 前 64 个素数的立方根、前 8 个素数的平方根的小数部分，是 SHA-256 的标准常量。
  let count = 0;
  for (let candidate = 2; count < 64; candidate++) {
    let prime = true;
    for (let factor = 2; factor * factor <= candidate; factor++) {
      if (candidate % factor === 0) {
        prime = false;
        break;
      }
    }
    if (!prime) {
      continue;
    }
    if (count < 8) {
      H0[count] = (Math.sqrt(candidate) % 1) * 2 ** 32;
    }
    K[count] = (Math.cbrt(candidate) % 1) * 2 ** 32;
    count++;
  }
}

const rotr = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));

export const sha256HexSync = (data: Uint8Array): string => {
  const padded = new Uint8Array((((data.length + 9 + 63) >> 6) << 6) as number);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((data.length * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (data.length * 8) >>> 0);

  const hash = new Uint32Array(H0);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choice + K[i] + w[i]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    hash[0] += a;
    hash[1] += b;
    hash[2] += c;
    hash[3] += d;
    hash[4] += e;
    hash[5] += f;
    hash[6] += g;
    hash[7] += h;
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("");
};

export const sha256Hex = async (data: Uint8Array): Promise<string> => {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", data as BufferSource);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
  return sha256HexSync(data);
};
