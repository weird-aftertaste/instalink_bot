import { extractPosts, httpsHost } from './links.js';
import { downloadVideo, MediaError, resolveVideos } from './resolver.js';

// Only media-specific 400s should trigger another transfer. Permissions and
// flood-control errors must propagate, rather than cause more API calls.
function isMediaFailure(error) {
  return error?.code === 400 && /(?:wrong (?:file|remote)|file (?:id|identifier|reference)|(?:failed to|could not|can'?t) (?:get|fetch|download)|webpage|wrong type|video.*(?:invalid|unsupported)|file (?:is )?too (?:big|large)|content.*type|invalid.*(?:file|video)|http url.*invalid)/i.test((error.description || error.message || '').replaceAll('_', ' '));
}

export function createBot({ api, fetch, InputFile, cache, config, logger = console }) {
  async function cacheCall(operation) {
    try { return await operation(); }
    catch { logger.warn('Media cache unavailable; check that database migrations were applied.'); return null; }
  }

  return async function handleMessage(message) {
    if (!message?.chat || message.from?.is_bot) return;
    const destination = {
      chat_id: message.chat.id,
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    };
    const command = /^\/(start|help)(?:@[\w]+)?(?:\s|$)/i.exec(message.text || '');
    if (command) {
      await api.sendMessage({ ...destination, text: 'Send an Instagram Reel, video post, or X/Twitter post link. I will send the first video as a Telegram attachment without a caption. Public posts only; if downloading fails, I will offer an embed link.' });
      return;
    }
    const posts = extractPosts(message, config.maxLinksPerMessage);
    if (!posts.length) return;
    for (const post of posts) {
      const params = { ...destination, supports_streaming: true };
      const fileId = await cacheCall(() => cache.get(post.cacheKey));
      if (fileId) {
        try {
          await api.sendVideo({ ...params, video: fileId });
          continue;
        } catch (error) {
          if (!isMediaFailure(error)) throw error;
          await cacheCall(() => cache.remove(post.cacheKey));
        }
      }
      let sent;
      let failure = new MediaError('No public video could be resolved.');
      for await (const url of resolveVideos(post, { fetch, config, logger })) {
        try {
          try {
            // Telegram fetches the file itself: no bytes enter our isolate.
            sent = await api.sendVideo({ ...params, video: url });
          } catch (error) {
            if (!isMediaFailure(error)) throw error;
            logger.warn('Telegram URL delivery failed; downloading for upload', { provider: httpsHost(url), code: error.code });
            const bytes = await downloadVideo(url, { fetch, config, logger });
            try {
              sent = await api.sendVideo({ ...params, video: new InputFile(bytes, `${post.shortcode}.mp4`, { type: 'video/mp4' }) });
            } catch (error) {
              if (!isMediaFailure(error)) throw error;
              throw new MediaError('Telegram could not accept this video.', 'TELEGRAM_REJECTED');
            }
          }
          break;
        } catch (error) {
          if (!(error instanceof MediaError)) throw error;
          failure = error;
          logger.warn('Video delivery failed; trying another provider', { provider: httpsHost(url), code: error.code, ...error.details });
        }
      }
      if (!sent) {
        const origin = post.platform === 'x' ? config.xEmbedOrigin : config.embedOrigins[0];
        const explanations = {
          TOO_LARGE: `This video exceeds my ${Math.round(config.maxUploadBytes / 1_000_000)} MB upload limit.`,
          DOWNLOAD_FAILED: 'I found the video, but could not download it. Please try again shortly.',
          INVALID_MEDIA: 'The download service returned an unsupported file instead of an MP4 video.',
          UNSUPPORTED_HOST: 'The download service returned a video address I cannot use.',
          TELEGRAM_REJECTED: 'Telegram could not accept this video file.',
        };
        await api.sendMessage({
          ...destination,
          text: explanations[failure.code] || 'The download services did not return a video. Please try again shortly, or use the links below.',
          reply_markup: { inline_keyboard: [[{ text: post.platform === 'x' ? 'Open X' : 'Open Instagram', url: post.url },
            ...(origin ? [{ text: 'Try embed', url: `${origin.replace(/\/$/, '')}${post.path}` }] : [])]] },
        });
        continue;
      }
      // A failed cache write must never resend an already delivered video.
      if (sent?.video?.file_id) await cacheCall(() => cache.put(post.cacheKey, sent.video.file_id));
    }
  };
}
