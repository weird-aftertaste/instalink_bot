import { httpsHost, isAllowedMediaUrl, videoFromHtml } from './links.js';

export class MediaError extends Error {
  constructor(message, code = 'RESOLVE_FAILED', details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function networkCode(error) {
  return /timed?\s*out|timeout/i.test(error?.message || '') ? 'TIMEOUT' : 'NETWORK_ERROR';
}

async function fetchWithRetry(url, options, { fetch, config, logger = console }) {
  const attempts = Math.max(1, Math.min(config.fetchAttempts || 2, 3));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, options);
      // Move to another provider on 429; don't immediately hit it again.
      if (attempt === attempts || response.status < 500) return response;
      logger.warn('Media HTTP retry', { provider: httpsHost(url), attempt, status: response.status });
    } catch (error) {
      logger.warn('Media HTTP failure', { provider: httpsHost(url), attempt, code: networkCode(error) });
      if (attempt === attempts) throw new MediaError('The download service could not be reached.', 'NETWORK_ERROR');
    }
  }
}

// Lazy iteration lets the bot try another provider when a resolved URL fails
// during download or Telegram delivery. Resolution alone is not proof it works.
export async function* resolveVideos(post, { fetch, config, logger = console }) {
  const seen = new Set();
  const checked = url => {
    if (!isAllowedMediaUrl(url, config)) throw new MediaError('Resolver returned an unsupported media host.', 'UNSUPPORTED_HOST');
    return url;
  };
  const dependencies = { fetch, config, logger };
  if (config.cobaltApiUrl) {
    try {
      if (!httpsHost(config.cobaltApiUrl)) throw new MediaError('Cobalt requires an HTTPS URL.');
      const response = await fetchWithRetry(config.cobaltApiUrl, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: post.url, videoQuality: '720', localProcessing: 'disabled' }),
      }, dependencies);
      if (!response.ok) throw new MediaError('Cobalt is unavailable.', 'PROVIDER_HTTP', { status: response.status });
      const data = await response.json();
      let url;
      if (data.status === 'redirect' || data.status === 'tunnel') url = data.url;
      if (data.status === 'picker') {
        const item = data.picker?.find(item => item.type === 'video');
        if (item) url = item.url;
      }
      if (!url) throw new MediaError('Cobalt did not return a ready-to-send video.', 'NO_VIDEO');
      checked(url);
      seen.add(url);
      yield url;
    } catch (error) {
      logger.warn('Cobalt resolution failed', { code: error.code || 'PROVIDER_RESPONSE', ...error.details });
    }
  }
  if (post.platform === 'x' && config.xApiOrigin) {
    try {
      if (!httpsHost(config.xApiOrigin)) throw new MediaError('FxTwitter requires HTTPS.');
      const response = await fetchWithRetry(`${config.xApiOrigin.replace(/\/$/, '')}/2/status/${post.shortcode}`, {
        headers: { Accept: 'application/json' },
      }, dependencies);
      if (!response.ok) throw new MediaError('FxTwitter is unavailable.', 'PROVIDER_HTTP', { status: response.status });
      const data = await response.json();
      if (data.code !== 200) throw new MediaError('The X post is unavailable.', 'POST_UNAVAILABLE');
      const videos = data.status?.media?.videos || data.status?.media?.all || [];
      const video = videos.find(item => item.type === 'video' || item.type === 'gif');
      if (!video) throw new MediaError('The X post does not contain a video.', 'NO_VIDEO');
      // Prefer H.264 MP4 variants at up to 720p. HLS and separate audio/video
      // streams cannot be assembled inside this runtime.
      const formats = (video.formats || []).filter(format =>
        (format.container === 'mp4' || /\.mp4(?:[?#]|$)/i.test(format.url || '')) &&
        (!format.codec || format.codec === 'h264') && isAllowedMediaUrl(format.url, config)
      ).map(format => {
        // Live responses may omit width/height on variants. The Twitter CDN
        // path includes dimensions, e.g. /vid/avc1/1280x720/file.mp4.
        const dimensions = /\/(\d{2,5})x(\d{2,5})\//.exec(format.url);
        const width = format.width || Number(dimensions?.[1]) || 0;
        const height = format.height || Number(dimensions?.[2]) || 0;
        return { ...format, resolution: width && height ? Math.min(width, height) : height };
      }).sort((a, b) => {
        const aOver = a.resolution > 720 ? 1 : 0;
        const bOver = b.resolution > 720 ? 1 : 0;
        return aOver - bOver || b.resolution - a.resolution || (b.bitrate || 0) - (a.bitrate || 0);
      });
      const incompatibleDefault = (video.formats || []).some(format => format.url === video.url &&
        ((format.codec && format.codec !== 'h264') || (format.container && format.container !== 'mp4')));
      const urls = formats.length ? formats.slice(0, 3).map(format => format.url) : (incompatibleDefault ? [] : [video.url]);
      for (const url of urls) {
        if (isAllowedMediaUrl(url, config) && /\.mp4(?:[?#]|$)/i.test(url) && !seen.has(url)) {
          seen.add(url);
          yield url;
        }
      }
    } catch (error) {
      logger.warn('FxTwitter resolution failed', { provider: httpsHost(config.xApiOrigin), code: error.code || 'PROVIDER_RESPONSE', ...error.details });
    }
  }
  const embedOrigins = post.platform === 'x' ? [config.xEmbedOrigin].filter(Boolean) : config.embedOrigins;
  for (const origin of embedOrigins) {
    try {
      if (!httpsHost(origin)) continue;
      const response = await fetchWithRetry(`${origin.replace(/\/$/, '')}${post.path}`, {
        headers: { 'User-Agent': 'TelegramBot (like TwitterBot)', Accept: 'text/html' },
      }, dependencies);
      if (!response.ok) throw new MediaError('Embed service is unavailable.', 'PROVIDER_HTTP', { status: response.status });
      const type = (response.headers.get('content-type') || '').toLowerCase();
      // Some resolvers redirect straight to a media file.
      let url;
      if (type.startsWith('video/mp4')) {
        url = response.url;
      } else {
        if (!type.includes('text/html')) throw new MediaError('Embed service did not return video metadata.', 'NO_VIDEO');
        const length = Number(response.headers.get('content-length'));
        if (length > config.maxMetadataChars) throw new MediaError('Metadata is too large.', 'METADATA_TOO_LARGE');
        const html = await response.text();
        if (html.length > config.maxMetadataChars) throw new MediaError('Metadata is too large.', 'METADATA_TOO_LARGE');
        url = videoFromHtml(html);
        if (!url) throw new MediaError('Embed service did not return video metadata.', 'NO_VIDEO');
      }
      checked(url);
      if (!seen.has(url)) {
        seen.add(url);
        yield url;
      }
    } catch (error) {
      // Never log signed media URLs, cookies, or full provider responses.
      logger.warn('Embed resolution failed', { provider: httpsHost(origin), code: error.code || 'PROVIDER_RESPONSE', ...error.details });
    }
  }
}

export async function resolveVideo(post, dependencies) {
  for await (const url of resolveVideos(post, dependencies)) return url;
  throw new MediaError('No public video could be resolved.');
}

export async function downloadVideo(url, { fetch, config, logger = console }) {
  if (!isAllowedMediaUrl(url, config)) throw new MediaError('Unsupported media host.', 'UNSUPPORTED_HOST');
  let response;
  try {
    response = await fetchWithRetry(url, { headers: { Accept: 'video/mp4' } }, { fetch, config, logger });
  } catch {
    throw new MediaError('Video download failed.', 'DOWNLOAD_FAILED');
  }
  if (!response.ok) throw new MediaError('Video download failed.', 'DOWNLOAD_FAILED', { status: response.status });
  if (!isAllowedMediaUrl(response.url, config)) throw new MediaError('Unsupported redirect target.', 'UNSUPPORTED_HOST');
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!['video/mp4', 'application/octet-stream'].includes(type)) throw new MediaError('The response is not an MP4 video.', 'INVALID_MEDIA');
  if (Number(response.headers.get('content-length')) > config.maxUploadBytes) throw new MediaError('Video is too large.', 'TOO_LARGE');
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > config.maxUploadBytes) throw new MediaError('Video is too large.', 'TOO_LARGE');
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError('Video download was interrupted.', 'DOWNLOAD_FAILED');
  }
  if (!size) throw new MediaError('The video is empty.', 'INVALID_MEDIA');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
