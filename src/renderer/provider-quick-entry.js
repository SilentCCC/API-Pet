(function (root) {
  const labels = '站点名称|站点名|名称|name|provider|endpoint|base[ _-]?url|登录地址|请求地址|网址|api[ _-]?key|密钥|令牌';
  function field(text, names) {
    const pattern = new RegExp(`(?:^|[\\s|;,，；])(?:${names})[ \\t]*(?:[:：=][ \\t]*|\\r?\\n|[ \\t]+)([^\\r\\n]+?)(?=[ \\t|;,，；]+(?:${labels})(?:\\s*[:：=]|\\s)|[\\r\\n]|$)`, 'i');
    return text.match(pattern)?.[1]?.trim().replace(/^["'“]+|["'”]+$/g, '') || '';
  }
  function parse(text) {
    const plain = String(text || '').replace(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/gi, '$2')
      .replace(/\*\*|__|`/g, '').trim();
    const endpoint = field(plain, 'endpoint|base[ _-]?url|登录地址|请求地址|网址');
    const urlText = (endpoint || plain).match(/https?:\/\/[^\s<>"'\[\]()，；。]+/i)?.[0]?.replace(/[.,;!?，；。！？]+$/, '');
    let loginUrl = '';
    let hostname = '';
    if (urlText) {
      try {
        const url = new URL(urlText);
        if (url.hostname && !url.username && !url.password) {
          loginUrl = url.href.replace(/\/+$/, '');
          hostname = url.hostname;
        }
      } catch {}
    }
    const labeledKey = field(plain, 'api[ _-]?key|密钥|令牌').replace(/^Bearer\s+/i, '').replace(/[;,，；。]+$/, '');
    const apiKey = /^[A-Za-z0-9._~+\/=-]+$/.test(labeledKey) ? labeledKey : (plain.match(/\bsk-[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/)?.[0] || '');
    let name = field(plain, '站点名称|站点名|名称|name|provider');
    if (!name && hostname) {
      const parts = hostname.split('.');
      const isAddress = hostname === 'localhost' || hostname.includes(':') || /^\d+(?:\.\d+){3}$/.test(hostname);
      const compoundSuffix = parts.length > 2 && /^(?:com|net|org|co|gov|edu|ac)$/.test(parts.at(-2)) && parts.at(-1).length === 2;
      name = isAddress ? hostname : parts.at(compoundSuffix ? -3 : -2) || hostname;
    }
    return { name, loginUrl, apiKey };
  }
  if (typeof module === 'object' && module.exports) module.exports = { parse };
  else root.ProviderQuickEntry = { parse };
})(typeof window === 'object' ? window : globalThis);
