/**
 * node:zlib 的替身，只在打包 just-bash 的浏览器版时使用（见 vite.config.ts）。
 * 它只被 gzip / gunzip / zcat 命令引用，浏览器里没有 zlib，这三个命令运行时会抛出这个错误；其余命令不受影响。
 */
const unavailable = (): never => {
  throw new Error("gzip is not available in the browser");
};

export const gzipSync = unavailable;
export const gunzipSync = unavailable;
export const constants: Record<string, number> = {};
