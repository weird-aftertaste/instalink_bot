import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createBot } from '../tgcloud/lib/bot.js';
import { createCache } from '../tgcloud/lib/cache.js';
import { config as defaults } from '../tgcloud/lib/config.js';
import { extractPosts, isAllowedMediaUrl, videoFromHtml } from '../tgcloud/lib/instagram.js';
import { downloadVideo, MediaError, resolveVideo } from '../tgcloud/lib/resolver.js';

const source = 'https://www.instagram.com/reel/AbC123/';
const media = 'https://scontent.cdninstagram.com/video.mp4?a=1&b=2';
const message = { chat: { id: -10042, type: 'supergroup' }, from: { id: 42 }, message_id: 7, message_thread_id: 99, text: source };
const post = extractPosts(message)[0];
const logger = { warn() {} };

function apiError(code, description) {
  return Object.assign(new Error(description), { code, description });
}

function htmlResponse() {
  return new Response(`<meta content="${media.replaceAll('&', '&amp;')}" property="og:video:secure_url">`, { headers: { 'content-type': 'text/html' } });
}

function videoResponse(chunks = [new Uint8Array([0, 0, 0, 24]), new Uint8Array([102, 116, 121, 112])], headers = {}) {
  return { ok: true, status: 200, url: media, headers: new Headers({ 'content-type': 'video/mp4', ...headers }),
    body: (async function* () { yield* chunks; })() };
}

function fixture(t, overrides = {}) {
  // Exercise the real cache SQL against SQLite, rather than mocking its queries.
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('CREATE TABLE media_cache (shortcode TEXT PRIMARY KEY, file_id TEXT NOT NULL, created_at INTEGER NOT NULL)');
  const db = {
    async get(sql, params) { return sqlite.prepare(sql).get(params); },
    async run(sql, params) { return sqlite.prepare(sql).run(params); },
  };
  const calls = { video: [], text: [], http: [] };
  class InputFile {
    constructor(bytes, filename, options) { Object.assign(this, { bytes, filename, options }); }
  }
  const cache = createCache(db);
  const dependencies = {
    api: {
      async sendVideo(params) { calls.video.push(params); return { video: { file_id: 'telegram-file-123' } }; },
      async sendMessage(params) { calls.text.push(params); },
    },
    async fetch(url) { calls.http.push(url); return htmlResponse(); },
    InputFile, cache, config: { ...defaults }, logger,
    ...overrides,
  };
  return { handle: createBot(dependencies), calls, cache, dependencies, sqlite, InputFile };
}

test('extracts canonical links from captions and hidden entities, deduplicates and caps work', () => {
  const posts = extractPosts({
    caption: 'https://instagram.com/reels/AbC123/?igsh=tracking https://instagram.com/p/AbC123/ https://instagram.com/tv/Second/',
    caption_entities: [{ type: 'text_link', url: 'https://m.instagram.com/p/Third/?x=1' }],
  });
  assert.deepEqual(posts.map(p => p.shortcode), ['AbC123', 'Second', 'Third']);
  assert.equal(posts[0].url, source);
  assert.equal(extractPosts({ text: `${source} https://instagram.com/p/Second/` }, 1).length, 1);
  for (const text of ['https://evilinstagram.com/p/abc/', 'https://evil.com/instagram.com/p/abc/', 'https://instagram.com.evil.com/p/abc/', 'https://instagram.com/p/abc%2Fmalformed', 'https://instagram.com@evil.com/p/abc/']) {
    assert.equal(extractPosts({ text }).length, 0, text);
  }
});

test('parses metadata attribute order, quoting, HTML entities, and rejects iframe-only players', () => {
  assert.equal(videoFromHtml(`<meta CONTENT='https://a.cdninstagram.com/v.mp4?a=1&#x26;b=2' PROPERTY='og:video'>`), 'https://a.cdninstagram.com/v.mp4?a=1&b=2');
  assert.equal(videoFromHtml('<meta name="twitter:player" content="https://example.com/iframe">'), null);
  assert.equal(isAllowedMediaUrl('https://cdninstagram.com.evil.com/a.mp4', defaults), false);
  assert.equal(isAllowedMediaUrl('https://a.cdninstagram.com@evil.com/a.mp4', defaults), false);
  assert.equal(isAllowedMediaUrl('http://127.0.0.1/a.mp4', defaults), false);
  assert.equal(isAllowedMediaUrl('https://a.cdninstagram.com:443/a.mp4', defaults), false);
});

test('first send stores file_id; the next message reuses it without any HTTP request', async t => {
  const f = fixture(t);
  await f.handle(message);
  assert.equal(f.calls.video[0].video, media);
  assert.equal(f.calls.video[0].message_thread_id, 99);
  assert.equal(f.calls.video[0].reply_parameters.message_id, 7);
  assert.equal(await f.cache.get(post.shortcode), 'telegram-file-123');
  await f.handle({ ...message, message_id: 8 });
  assert.equal(f.calls.video[1].video, 'telegram-file-123');
  assert.equal(f.calls.http.length, 1);
});

test('URL fetch failure triggers binary upload and caches the uploaded video', async t => {
  const f = fixture(t);
  f.dependencies.api.sendVideo = async params => {
    f.calls.video.push(params);
    if (typeof params.video === 'string') throw apiError(400, 'Bad Request: failed to get HTTP URL content');
    return { video: { file_id: 'uploaded-file' } };
  };
  f.dependencies.fetch = async url => url === media ? videoResponse() : htmlResponse();
  await createBot(f.dependencies)(message);
  assert.equal(f.calls.video.length, 2);
  const upload = f.calls.video[1].video;
  assert.ok(upload instanceof f.InputFile);
  assert.equal(upload.filename, 'AbC123.mp4');
  assert.deepEqual([...upload.bytes], [0, 0, 0, 24, 102, 116, 121, 112]);
  assert.equal(await f.cache.get(post.shortcode), 'uploaded-file');
});

test('stale cached IDs are removed and resolved again', async t => {
  const f = fixture(t);
  await f.cache.put(post.shortcode, 'stale-file');
  f.dependencies.api.sendVideo = async params => {
    f.calls.video.push(params);
    if (params.video === 'stale-file') throw apiError(400, 'Bad Request: wrong file identifier/HTTP URL specified');
    return { video: { file_id: 'fresh-file' } };
  };
  await f.handle(message);
  assert.equal(f.calls.video.length, 2);
  assert.equal(await f.cache.get(post.shortcode), 'fresh-file');
});

test('Telegram rate limits, permissions, and unrelated errors propagate without upload or fallback spam', async t => {
  for (const [code, description] of [[429, 'Too Many Requests'], [403, 'Forbidden'], [400, 'Bad Request: chat not found']]) {
    const f = fixture(t);
    f.dependencies.api.sendVideo = async () => { throw apiError(code, description); };
    await assert.rejects(f.handle(message), { code });
    assert.equal(f.calls.http.length, 1);
    assert.equal(f.calls.text.length, 0);
  }
});

test('a missing cache table does not prevent delivery or cause a second send', async t => {
  const f = fixture(t);
  f.sqlite.exec('DROP TABLE media_cache');
  await f.handle(message);
  assert.equal(f.calls.video.length, 1);
  assert.equal(f.calls.text.length, 0);
});

test('failed providers produce a clickable fallback; unrelated and bot messages are ignored', async t => {
  const f = fixture(t, { fetch: async () => new Response('Unavailable', { status: 503 }) });
  await f.handle(message);
  assert.equal(f.calls.video.length, 0);
  assert.equal(f.calls.text.length, 1);
  assert.equal(f.calls.text[0].reply_markup.inline_keyboard[0][0].url, source);
  await f.handle({ ...message, text: 'hello' });
  await f.handle({ ...message, from: { is_bot: true } });
  assert.equal(f.calls.text.length, 1);
  await f.handle({ ...message, text: '/help@bruhinstalink_bot' });
  assert.equal(f.calls.text.length, 2);
});

test('Cobalt picker selects the first video; provider failures fall back to embed metadata', async () => {
  const config = { ...defaults, cobaltApiUrl: 'https://cobalt.example.com/' };
  let request;
  const url = await resolveVideo(post, { config, logger, fetch: async (url, options) => {
    request = JSON.parse(options.body);
    return Response.json({ status: 'picker', picker: [{ type: 'photo', url: 'https://example.com/image.jpg' }, { type: 'video', url: media }] });
  } });
  assert.equal(url, media);
  assert.equal(request.localProcessing, 'disabled');
  assert.equal(request.url, source);
  assert.equal(await resolveVideo(post, { config, logger, fetch: async url => url === config.cobaltApiUrl ? Response.json({ status: 'error' }) : htmlResponse() }), media);
});

test('Cobalt tunnel and direct-video redirects are accepted, unsafe metadata is rejected', async () => {
  const config = { ...defaults, cobaltApiUrl: 'https://cobalt.example.com/' };
  assert.equal(await resolveVideo(post, { config, logger, fetch: async () => Response.json({ status: 'tunnel', url: `${config.cobaltApiUrl}tunnel?id=123` }) }), `${config.cobaltApiUrl}tunnel?id=123`);
  assert.equal(await resolveVideo(post, { config: defaults, logger, fetch: async () => ({ ok: true, url: media, headers: new Headers({ 'content-type': 'video/mp4' }) }) }), media);
  await assert.rejects(resolveVideo(post, { config: defaults, logger, fetch: async () => new Response('<meta property="og:video" content="https://127.0.0.1/internal">', { headers: { 'content-type': 'text/html' } }) }), MediaError);
});

test('download guard stops oversized streams, oversized headers, empty files, HTML, and unsafe redirects', async () => {
  const config = { ...defaults, maxUploadBytes: 5 };
  for (const response of [
    videoResponse(),
    videoResponse([], { 'content-length': '6' }),
    videoResponse([]),
    videoResponse([], { 'content-type': 'text/html' }),
    { ...videoResponse(), url: 'https://evil.com/file.mp4' },
  ]) {
    await assert.rejects(downloadVideo(media, { config, fetch: async () => response }), MediaError);
  }
});

test('oversized videos fall back without attempting an upload', async t => {
  const f = fixture(t, { config: { ...defaults, maxUploadBytes: 5 } });
  f.dependencies.api.sendVideo = async params => {
    f.calls.video.push(params);
    throw apiError(400, 'Bad Request: failed to get HTTP URL content');
  };
  f.dependencies.fetch = async url => url === media ? videoResponse() : htmlResponse();
  await createBot(f.dependencies)(message);
  assert.equal(f.calls.video.length, 1);
  assert.equal(f.calls.text.length, 1);
});

test('network failures and interrupted video streams produce a fallback instead of an unhandled error', async t => {
  for (const failure of ['connection', 'stream']) {
    const f = fixture(t);
    f.dependencies.api.sendVideo = async () => { throw apiError(400, 'Bad Request: failed to get HTTP URL content'); };
    f.dependencies.fetch = async url => {
      if (url !== media) return htmlResponse();
      if (failure === 'connection') throw new TypeError('fetch failed');
      return { ...videoResponse(), body: (async function* () {
        yield new Uint8Array([1, 2]);
        throw new Error('connection reset');
      })() };
    };
    await createBot(f.dependencies)(message);
    assert.equal(f.calls.text.length, 1);
    assert.equal(await f.cache.get(post.shortcode), null);
  }
});

test('retries a transient metadata timeout for the reported Reel instead of returning a fallback', async t => {
  const f = fixture(t);
  let requests = 0;
  f.dependencies.fetch = async () => {
    if (++requests === 1) throw new Error('fetch: request timed out');
    return htmlResponse();
  };
  await createBot(f.dependencies)({ ...message, text: 'https://www.instagram.com/reel/DfAIhWMN92z/' });
  assert.equal(requests, 2);
  assert.equal(f.calls.video.length, 1);
  assert.equal(f.calls.text.length, 0);
});

test('tries the next provider after a resolved video fails to download', async t => {
  const f = fixture(t);
  const secondMedia = 'https://scontent.cdninstagram.com/second.mp4';
  f.dependencies.api.sendVideo = async params => {
    f.calls.video.push(params);
    if (params.video === media) throw apiError(400, 'failed to get HTTP URL content');
    return { video: { file_id: 'second-provider-file' } };
  };
  f.dependencies.fetch = async url => {
    if (url === media) return new Response('Blocked', { status: 403 });
    if (url.startsWith(defaults.embedOrigins[1])) return new Response(`<meta property="og:video" content="${secondMedia}">`, { headers: { 'content-type': 'text/html' } });
    return htmlResponse();
  };
  await createBot(f.dependencies)(message);
  assert.deepEqual(f.calls.video.map(p => p.video), [media, secondMedia]);
  assert.equal(await f.cache.get(post.shortcode), 'second-provider-file');
  assert.equal(f.calls.text.length, 0);
});

test('resolver retries are bounded, skip rate-limited providers, and log no signed URLs', async () => {
  const entries = [];
  const logger = { warn(...args) { entries.push(args); } };
  for (const status of [503, 429, 404]) {
    let requests = 0;
    const config = { ...defaults, embedOrigins: [defaults.embedOrigins[0]] };
    await assert.rejects(resolveVideo(post, { config, logger, fetch: async () => {
      requests++;
      return new Response('Unavailable', { status });
    } }), MediaError);
    assert.equal(requests, status === 503 ? 2 : 1);
  }
  await assert.rejects(resolveVideo(post, { config: defaults, logger, fetch: async () => { throw new Error(`fetch failed: ${media}`); } }), MediaError);
  assert.ok(!JSON.stringify(entries).includes(media));
});

test('fallback explains whether the video was too large or no metadata was available', async t => {
  const f = fixture(t, { config: { ...defaults, embedOrigins: [defaults.embedOrigins[0]], maxUploadBytes: 5 } });
  f.dependencies.api.sendVideo = async () => { throw apiError(400, 'failed to get HTTP URL content'); };
  f.dependencies.fetch = async url => url === media ? videoResponse() : htmlResponse();
  await createBot(f.dependencies)(message);
  assert.match(f.calls.text[0].text, /upload limit/);
  assert.doesNotMatch(f.calls.text[0].text, /temporarily blocked/);
});
