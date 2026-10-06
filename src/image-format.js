(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ImageFormat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function detectMime(bytes, fallback = '') {
    const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
    if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) return 'image/png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (/^GIF8[79]a$/.test(ascii(0, 6))) return 'image/gif';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
    if (ascii(0, 2) === 'BM') return 'image/bmp';
    if (ascii(4, 8) === 'ftyp' && /avif|avis/.test(ascii(8, Math.min(bytes.length, 32)))) return 'image/avif';
    return fallback;
  }
  return { detectMime };
});
