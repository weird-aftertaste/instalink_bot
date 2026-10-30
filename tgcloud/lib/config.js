// Public configuration only. Never put access tokens or Instagram cookies here.
export const config = {
  // Optional Cobalt v10+ API you host or have permission to use. No trailing path.
  // Leave empty to use the public embed resolvers below.
  cobaltApiUrl: '',
  embedOrigins: ['https://www.vxinstagram.com', 'https://www.kkinstagram.com'],
  xApiOrigin: 'https://api.fxtwitter.com',
  xEmbedOrigin: 'https://fxtwitter.com',
  // Retry transient resolver/network failures once, within this invocation.
  fetchAttempts: 2,
  maxLinksPerMessage: 3,
  // Uploads are buffered in memory. Lower this if your runtime needs a smaller cap.
  maxUploadBytes: 49_000_000,
  maxMetadataChars: 1_000_000,
};
