// Deliberately avoid Node/DOM dependencies: these modules also run in tgcloud V8.
export function extractPosts(message, limit = 3) {
  const sources = [message.text, message.caption];
  for (const entity of [...(message.entities || []), ...(message.caption_entities || [])]) {
    if (entity.type === 'text_link') sources.push(entity.url);
  }
  const posts = new Map();
  const pattern = /(?:https?:\/\/)?(?:(?:www\.|m\.)?instagram\.com\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)|(?:www\.|mobile\.|m\.)?(?:x\.com|twitter\.com)\/(?:([A-Za-z0-9_]{1,15})\/status|i\/(?:web\/)?status)\/([0-9]{2,20}))(?=\/|[?#\s<>"'()[\]{},.!]|$)/gi;
  for (const source of sources) {
    if (typeof source !== 'string') continue;
    for (const match of source.matchAll(pattern)) {
      // Don't match a suffix of an unrelated hostname, path or user-info URL.
      if (match.index > 0 && /[\w./@:\-]/.test(source[match.index - 1])) continue;
      const platform = match[1] ? 'instagram' : 'x';
      const shortcode = match[2] || match[4];
      // Keep existing Instagram cache entries valid. X IDs have their own prefix
      // so a numeric Instagram shortcode can never collide with an X post.
      const cacheKey = platform === 'x' ? `x:${shortcode}` : shortcode;
      if (posts.has(cacheKey)) continue;
      const kind = match[1]?.toLowerCase() === 'reels' ? 'reel' : match[1]?.toLowerCase();
      const path = platform === 'x' ? `/${match[3] || 'i'}/status/${shortcode}/` : `/${kind}/${shortcode}/`;
      const url = `${platform === 'x' ? 'https://x.com' : 'https://www.instagram.com'}${path}`;
      posts.set(cacheKey, { platform, shortcode, cacheKey, path, url });
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
  if (host === 'video.twimg.com') return true;
  if (['cdninstagram.com', 'fbcdn.net'].some(suffix => host.endsWith(`.${suffix}`))) return true;
  return [...config.embedOrigins, config.cobaltApiUrl, config.xEmbedOrigin].filter(Boolean).some(origin => host === httpsHost(origin));
}
