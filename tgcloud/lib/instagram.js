// Deliberately avoid Node/DOM dependencies: these modules also run in tgcloud V8.
export function extractPosts(message, limit = 3) {
  const sources = [message.text, message.caption];
  for (const entity of [...(message.entities || []), ...(message.caption_entities || [])]) {
    if (entity.type === 'text_link') sources.push(entity.url);
  }
  const posts = new Map();
  const pattern = /(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)(?=\/|[?#\s<>"'()[\]{},.!]|$)/gi;
  for (const source of sources) {
    if (typeof source !== 'string') continue;
    for (const match of source.matchAll(pattern)) {
      // Don't match a suffix of an unrelated hostname, path or user-info URL.
      if (match.index > 0 && /[\w./@:\-]/.test(source[match.index - 1])) continue;
      const shortcode = match[2];
      if (posts.has(shortcode)) continue;
      const kind = match[1].toLowerCase() === 'reels' ? 'reel' : match[1].toLowerCase();
      posts.set(shortcode, { shortcode, path: `/${kind}/${shortcode}/`, url: `https://www.instagram.com/${kind}/${shortcode}/` });
      if (posts.size >= limit) return [...posts.values()];
    }
  }
  return [...posts.values()];
}

export function decodeEntities(value) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (whole, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] || whole;
    const hex = entity[1].toLowerCase() === 'x';
    const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

export function videoFromHtml(html) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4]);
    }
    const property = (attrs.property || attrs.name || '').toLowerCase();
    if (['og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player:stream'].includes(property) && attrs.content) {
      return attrs.content;
    }
  }
  return null;
}

export function httpsHost(url) {
  if (typeof url !== 'string' || /[\s\\]/.test(url)) return null;
  // No credentials, IP literals, custom ports, or protocol-relative URLs.
  const match = /^https:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?:[/?#]|$)/i.exec(url);
  return match ? match[1].toLowerCase() : null;
}

export function isAllowedMediaUrl(url, config) {
  const host = httpsHost(url);
  if (!host) return false;
  if (['cdninstagram.com', 'fbcdn.net'].some(suffix => host.endsWith(`.${suffix}`))) return true;
  return [...config.embedOrigins, config.cobaltApiUrl].filter(Boolean).some(origin => host === httpsHost(origin));
}
