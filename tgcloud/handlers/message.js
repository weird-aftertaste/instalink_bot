import { api, db, fetch, InputFile } from 'sdk';
import { createBot } from '../lib/bot.js';
import { createCache } from '../lib/cache.js';
import { config } from '../lib/config.js';

export default createBot({ api, fetch, InputFile, cache: createCache(db), config });
