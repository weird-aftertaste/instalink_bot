import { table, integer, text } from 'sdk/db';

export const mediaCache = table('media_cache', {
  shortcode: text('shortcode').primaryKey(),
  fileId: text('file_id').notNull(),
  createdAt: integer('created_at').notNull(),
});
