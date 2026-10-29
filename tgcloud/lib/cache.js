export function createCache(db) {
  return {
    async get(shortcode) {
      const row = await db.get('SELECT file_id FROM media_cache WHERE shortcode = :shortcode', { ':shortcode': shortcode });
      return row?.file_id || null;
    },
    async put(shortcode, fileId) {
      await db.run(`INSERT INTO media_cache (shortcode, file_id, created_at)
        VALUES (:shortcode, :fileId, :createdAt)
        ON CONFLICT(shortcode) DO UPDATE SET file_id = excluded.file_id, created_at = excluded.created_at`, {
        ':shortcode': shortcode, ':fileId': fileId, ':createdAt': Date.now(),
      });
    },
    async remove(shortcode) {
      await db.run('DELETE FROM media_cache WHERE shortcode = :shortcode', { ':shortcode': shortcode });
    },
  };
}
