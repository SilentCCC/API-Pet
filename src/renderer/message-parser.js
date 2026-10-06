(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../image-format'));
  else root.ChatMessageParser = factory(root.ImageFormat);
})(typeof globalThis !== 'undefined' ? globalThis : this, ImageFormat => {
  const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
  const URI = 'data:image/[a-z0-9.+-]+;base64,[a-z0-9+/=]+';

  function extractText(payload) {
    if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text;
    const content = payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(item => item?.text || item?.content || '').join('');
    if (Array.isArray(payload?.output)) return payload.output.flatMap(item => item?.content || []).map(item => item?.text || '').join('');
    return '';
  }

  // Protect literal code examples before looking for embedded image resources.
  function codeRanges(text) {
    const ranges = [];
    const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/gm;
    let match;
    while ((match = fence.exec(text))) {
      const marker = match[1];
      const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*(?:\\r?\\n|$)`, 'gm');
      close.lastIndex = fence.lastIndex;
      const end = close.exec(text);
      ranges.push([match.index, end ? close.lastIndex : text.length]);
      fence.lastIndex = ranges.at(-1)[1];
    }
    const inline = /`+/g;
    inline.lastIndex = 0;
    while ((match = inline.exec(text))) {
      const block = ranges.find(([start, end]) => start <= match.index && match.index < end);
      if (block) { inline.lastIndex = block[1]; continue; }
      let closing;
      while ((closing = inline.exec(text)) && closing[0].length !== match[0].length) {}
      if (closing) ranges.push([match.index, inline.lastIndex]);
      else break;
    }
    return ranges.sort((a, b) => a[0] - b[0]);
  }

  function decodeImage(uri, alt) {
    const encoded = uri.slice(uri.indexOf(',') + 1).replace(/\s/g, '');
    if (!encoded || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[a-z0-9+/]*={0,2}$/i.test(encoded)
        || encoded.length % 4 === 1) return { type: 'image-error', alt, error: '图片数据无效或超过 40 MB' };
    try {
      const binary = atob(encoded);
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      const mime = ImageFormat.detectMime(bytes);
      if (!mime || !bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('图片格式无法识别');
      return { type: 'image', blob: new Blob([bytes], { type: mime }), alt, mime };
    } catch { return { type: 'image-error', alt, error: '图片数据无法解码' }; }
  }

  function parse(text, options = {}) {
    const source = String(text || '');
    const protectedRanges = codeRanges(source);
    const matches = [];
    const add = (start, end, uri, alt = '') => {
      if (protectedRanges.some(([left, right]) => start < right && end > left)) return;
      matches.push({ start, end, uri, alt });
    };
    const markdown = new RegExp(`!\\[((?:\\\\.|[^\\]\\\\])*)\\]\\(\\s*<?(${URI})>?(?:\\s+["'][^"']*["'])?\\s*\\)`, 'ig');
    const html = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/ig;
    const direct = new RegExp(URI, 'ig');
    let match;
    while ((match = markdown.exec(source))) add(match.index, markdown.lastIndex, match[2], match[1]);
    while ((match = html.exec(source))) {
      const parseHtml = options.parseHtmlImage || (typeof DOMParser !== 'undefined' ? raw => {
        const element = new DOMParser().parseFromString(raw, 'text/html').querySelector('img');
        return { src: element?.getAttribute('src'), alt: element?.getAttribute('alt') || '' };
      } : null);
      const image = parseHtml?.(match[0]);
      if (image && /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]*$/i.test(image.src || '')) add(match.index, html.lastIndex, image.src, image.alt);
    }
    while ((match = direct.exec(source))) add(match.index, direct.lastIndex, match[0]);
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    const segments = [];
    let cursor = 0;
    for (const item of matches) {
      if (item.start < cursor) continue;
      if (cursor < item.start) segments.push({ type: 'text', text: source.slice(cursor, item.start) });
      segments.push(decodeImage(item.uri, item.alt));
      cursor = item.end;
    }
    if (cursor < source.length || !segments.length) segments.push({ type: 'text', text: source.slice(cursor) });
    return { segments, historyText: segments.map(segment => segment.type === 'text' ? segment.text : '[图片]').join('') };
  }
  function parseResponse(payload, options) { return parse(extractText(payload).trim(), options); }
  return { parse, parseResponse, extractText, MAX_IMAGE_BYTES };
});
