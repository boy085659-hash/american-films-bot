  'use strict';

const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');

// =====================================================
// 1. SETTINGS
// =====================================================

const BOT_TOKEN =
  process.env.BOT_TOKEN ||
  process.env.TELEGRAM_BOT_TOKEN ||
  process.env.TELEGRAM_TOKEN ||
  process.env.TOKEN;

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const ADMIN_ID = 7199419196;
const BOT_USERNAME = 'AmericanFilms252bot';

// Channels are used ONLY as video sources. No join requirement/buttons.
const CHANNELS = [
  { username: '@VEXORAMOVIES' },
  { username: '@somalifilm0' }
];

const SOURCES = [
  'tiktok', 'facebook', 'telegram', 'instagram',
  'youtube', 'other', 'referral'
];

const TMDB_CACHE_TIME = 6 * 60 * 60 * 1000;
const TMDB_TIMEOUT = 5000;

if (!BOT_TOKEN) throw new Error('BOT TOKEN IS MISSING');

const bot = new Telegraf(BOT_TOKEN);
const MOVIES_DB = path.join(__dirname, 'movies.json');
const USERS_DB = path.join(__dirname, 'users.json');
const MISSING_DB = path.join(__dirname, 'missing_movies.json');

const sessions = new Map();
const pendingBroadcasts = new Map();
const tmdbCache = new Map();

// =====================================================
// 2. DATABASE - PRESERVE EXISTING DATA
// =====================================================

function loadArray(file, property) {
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, 'utf8').trim();
  if (!content) {
    throw new Error(
      'Database file is empty: ' + path.basename(file) +
      '. Restore its backup before starting the bot.'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      'Invalid JSON in ' + path.basename(file) +
      '. Restore its .bak backup. ' + error.message
    );
  }

  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed[property])) return parsed[property];
  throw new Error('Database format error: ' + path.basename(file));
}

function safeSave(file, data) {
  const temp = file + '.tmp';
  const backup = file + '.bak';

  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, backup); }
    catch (error) { console.error('BACKUP ERROR:', error.message); }
  }

  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

let movies = loadArray(MOVIES_DB, 'movies');

let users = loadArray(USERS_DB, 'users')
  .map(user => {
    if (typeof user === 'number' || typeof user === 'string') {
      return {
        id: Number(user),
        firstSeen: null,
        lastActiveAt: null,
        favorites: [],
        referralCount: 0
      };
    }

    return {
      ...user,
      id: Number(user.id),
      firstSeen: user.firstSeen || null,
      lastActiveAt: user.lastActiveAt || null,
      favorites: Array.isArray(user.favorites) ? user.favorites : [],
      referralCount: Number(user.referralCount) || 0
    };
  })
  .filter(user => Number.isFinite(user.id));

// Remove duplicate user IDs without losing the latest user fields.
{
  const unique = new Map();
  for (const user of users) unique.set(user.id, { ...unique.get(user.id), ...user });
  users = [...unique.values()];
}

let missingMovies = [];
if (fs.existsSync(MISSING_DB)) {
  try {
    missingMovies = loadArray(MISSING_DB, 'missingMovies');
  } catch (error) {
    console.error('MISSING DATABASE WARNING:', error.message);
    // Do not stop the bot if this newly introduced database is damaged.
    // The original users.json and movies.json remain untouched.
    missingMovies = [];
  }
}

let nextMovieId = movies.reduce(
  (max, movie) => Math.max(max, Number(movie.id) || 0), 0
) + 1;

function saveMovies() { safeSave(MOVIES_DB, movies); }
function saveUsers() { safeSave(USERS_DB, users); }
function saveMissing() { safeSave(MISSING_DB, missingMovies); }

function getUser(userId) {
  return users.find(user => user.id === Number(userId));
}

function getOrCreateUser(userId) {
  let user = getUser(userId);
  if (!user) {
    const now = new Date().toISOString();
    user = {
      id: Number(userId),
      firstSeen: now,
      lastActiveAt: now,
      favorites: [],
      referralCount: 0,
      referredBy: null,
      firstSource: 'unknown'
    };
    users.push(user);
    saveUsers();
  }
  return user;
}

// =====================================================
// 3. REFERRAL + TRAFFIC TRACKING
// =====================================================

function getReferralLink(userId) {
  return `https://t.me/${BOT_USERNAME}?start=ref_${userId}`;
}
function getSourceLink(source) {
  return `https://t.me/${BOT_USERNAME}?start=src_${source}`;
}
function getStartPayload(ctx) {
  const text = ctx.message?.text || '';
  const match = text.match(/^\/start(?:@\w+)?(?:\s+([^\s]+))?/i);
  return match?.[1] || '';
}
function validSource(source) {
  return SOURCES.includes(source) ? source : 'other';
}

function processNewReferral(user, payload) {
  if (!payload || user.referredBy ||
      (user.firstSource && user.firstSource !== 'unknown')) return;

  let source = 'unknown';
  let inviterId = null;

  const referralMatch = payload.match(
    /^ref_(\d+)(?:_src_(tiktok|facebook|telegram|instagram|youtube|other))?$/i
  );
  const sourceMatch = payload.match(
    /^src_(tiktok|facebook|telegram|instagram|youtube|other)$/i
  );

  if (referralMatch) {
    inviterId = Number(referralMatch[1]);
    source = referralMatch[2]
      ? validSource(referralMatch[2].toLowerCase())
      : 'referral';

    if (inviterId === Number(user.id) || !getUser(inviterId)) inviterId = null;
  } else if (sourceMatch) {
    source = validSource(sourceMatch[1].toLowerCase());
  }

  user.firstSource = source;
  if (inviterId) {
    user.referredBy = inviterId;
    const inviter = getUser(inviterId);
    if (inviter) inviter.referralCount = (Number(inviter.referralCount) || 0) + 1;
  }
  saveUsers();
}

function getTotalReferrals() {
  return users.reduce((sum, user) => sum + (Number(user.referralCount) || 0), 0);
}
function getSourceStatistics() {
  const stats = Object.fromEntries(SOURCES.map(source => [source, 0]));
  stats.unknown = 0;
  for (const user of users) {
    const source = user.firstSource || 'unknown';
    if (stats[source] === undefined) stats.unknown++;
    else stats[source]++;
  }
  return stats;
}
function getTopReferrers(limit = 10) {
  return users
    .filter(user => Number(user.referralCount) > 0)
    .sort((a, b) => Number(b.referralCount) - Number(a.referralCount))
    .slice(0, limit);
}

// =====================================================
// 4. USER ACTIVITY
// =====================================================

bot.use(async (ctx, next) => {
  if (ctx.chat?.type === 'private' && ctx.from) {
    const existing = getUser(ctx.from.id);
    ctx.state.isNewUser = !existing;
    const user = getOrCreateUser(ctx.from.id);
    let changed = false;

    const firstName = ctx.from.first_name || '';
    const username = ctx.from.username || '';

    if (user.firstName !== firstName) {
      user.firstName = firstName;
      changed = true;
    }
    if (user.username !== username) {
      user.username = username;
      changed = true;
    }

    const now = new Date();
    const last = user.lastActiveAt ? new Date(user.lastActiveAt) : null;
    if (!last || !Number.isFinite(last.getTime()) ||
        now.getTime() - last.getTime() >= 60 * 60 * 1000) {
      user.lastActiveAt = now.toISOString();
      changed = true;
    }
    if (changed) saveUsers();
  }
  return next();
});

// =====================================================
// 5. TITLE NORMALIZATION + CAPTION PARSING
// =====================================================

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/@[\w]+/g, ' ')
    .replace(/#[\w]+/g, ' ')
    .replace(/[🎬🎥📺🍿⭐🔥❤️✅]/gu, ' ')
    .replace(/\b(?:480p|720p|1080p|1440p|2160p|4k|8k|hd|full\s*hd|uhd|hdr|web\s*dl|bluray|brrip|webrip)\b/gi, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/[|:–—]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:movie|film|filim)\s+/i, '')
    .trim();
}

const SEARCH_ALIASES = {
  'money host': 'money heist',
  'mony heist': 'money heist',
  'moneyhest': 'money heist',
  'money heistt': 'money heist',
  'la casa de papel': 'money heist',
  'john wik': 'john wick',
  'jon wick': 'john wick',
  'topgun': 'top gun'
};

function correctQuery(query) {
  const q = normalize(query);
  return SEARCH_ALIASES[q] || q;
}

function parseCaption(caption) {
  const raw = String(caption || '').replace(/\r/g, '').trim();
  const lines = raw.split('\n').map(x => x.trim()).filter(Boolean);
  let season = null;
  let episode = null;
  let part = null;
  let marker = null;

  const episodePatterns = [
    /\bS\s*0*(\d+)\s*(?:E|EP)\s*0*(\d+)(?:\s*E\s*0*\d+)?\b/i,
    /\bSeason\s*0*(\d+)\s*(?:Episode|Ep)\s*0*(\d+)\b/i,
    /\b(\d{1,2})\s*x\s*(\d{1,3})\b/i
  ];

  for (const re of episodePatterns) {
    const match = raw.match(re);
    if (match) {
      season = Number(match[1]);
      episode = Number(match[2]);
      marker = match.index;
      break;
    }
  }

  if (episode === null) {
    const ep = raw.match(/\b(?:Episode|EP|E)\s*0*(\d+)\b/i);
    if (ep) {
      episode = Number(ep[1]);
      marker = ep.index;
      const sm = raw.match(/\bSeason\s*0*(\d+)\b/i) ||
        raw.match(/\bS\s*0*(\d+)\b/i);
      season = sm ? Number(sm[1]) : 1;
    }
  }

  const partRe =
    /\b(?:part|pt|qeyb(?:ta|teda|teeda)?|qayb(?:ta|teda|teeda)?|cd|disc|disk)\s*[:#-]?\s*0*(\d+)\b/i;
  const pm = raw.match(partRe);
  if (pm) {
    part = Number(pm[1]);
    if (marker === null || pm.index < marker) marker = pm.index;
  }

  let titleLine = lines.find(line =>
    !/^https?:\/\//i.test(line) && !/^[@#]/.test(line)
  ) || '';

  if (marker !== null) {
    const beforeLines = raw.slice(0, marker).split('\n')
      .map(x => x.trim()).filter(Boolean);
    if (beforeLines.length) titleLine = beforeLines[beforeLines.length - 1];
  }

  titleLine = titleLine
    .replace(/\bSeason\s*0*\d+\b.*$/i, '')
    .replace(/\bS\s*0*\d+\s*(?:E|EP)\s*0*\d+.*$/i, '')
    .replace(/\b(?:Episode|EP)\s*0*\d+.*$/i, '')
    .replace(/\b\d{1,2}\s*x\s*\d{1,3}.*$/i, '')
    .replace(partRe, '')
    .replace(/\s*[-–—|:]+\s*$/g, '');

  const title = cleanTitle(titleLine);
  return {
    title,
    key: normalize(title),
    season,
    episode,
    part,
    type: episode !== null ? 'series' : part !== null ? 'part' : 'movie'
  };
}

function getMovieInfo(movie) {
  const captionInfo = parseCaption(movie.caption || '');
  const hasCaptionEpisode = captionInfo.episode !== null;
  const hasCaptionPart = captionInfo.part !== null;

  const season = hasCaptionEpisode ? captionInfo.season :
    movie.season != null ? Number(movie.season) : captionInfo.season;
  const episode = hasCaptionEpisode ? captionInfo.episode :
    movie.episode != null ? Number(movie.episode) : null;
  const part = hasCaptionPart ? captionInfo.part :
    movie.part != null ? Number(movie.part) : null;

  let title;
  if ((hasCaptionEpisode || hasCaptionPart) && captionInfo.title) {
    title = captionInfo.title;
  } else {
    title = cleanTitle(movie.title || captionInfo.title || '');
  }
  if (!title) title = cleanTitle(captionInfo.title || movie.title || '');

  return {
    title,
    key: normalize(title),
    season,
    episode,
    part,
    type: episode !== null || movie.type === 'series'
      ? 'series' : part !== null ? 'parts' : 'movie'
  };
}

// =====================================================
// 6. RECEIVE MOVIES FROM SOURCE CHANNELS
// =====================================================

bot.on('channel_post', ctx => {
  const post = ctx.channelPost;
  const username = ctx.chat.username
    ? '@' + ctx.chat.username.toLowerCase() : '';

  if (!CHANNELS.some(ch => ch.username.toLowerCase() === username)) return;

  const hasVideo = Boolean(post.video) || Boolean(post.document && (
    post.document.mime_type?.startsWith('video/') ||
    /\.(mp4|mkv|avi|mov|webm)$/i.test(post.document.file_name || '')
  ));
  if (!hasVideo || !post.caption) return;

  const info = parseCaption(post.caption);
  if (!info.key) return;

  let record = movies.find(m =>
    String(m.chatId) === String(ctx.chat.id) &&
    Number(m.messageId) === Number(post.message_id)
  );

  if (!record) {
    record = { id: nextMovieId++, chatId: ctx.chat.id, messageId: post.message_id };
    movies.push(record);
  }

  Object.assign(record, {
    caption: post.caption,
    title: info.title,
    key: info.key,
    season: info.season,
    episode: info.episode,
    part: info.part,
    type: info.type,
    sourceChannel: username,
    savedAt: new Date().toISOString()
  });

  saveMovies();
  console.log('SAVED:', info.title);
});

// =====================================================
// 7. SMART SEARCH
// =====================================================

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = old;
    }
  }
  return row[b.length];
}

function wordSimilarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) {
    return 0.85 + (Math.min(a.length, b.length) / Math.max(a.length, b.length)) * 0.15;
  }

  const aw = a.split(' ').filter(Boolean);
  const bw = b.split(' ').filter(Boolean);
  if (!aw.length || !bw.length) return 0;

  let total = 0;
  let matched = 0;
  for (const word of aw) {
    let best = 0;
    for (const other of bw) best = Math.max(best, wordSimilarity(word, other));
    total += best;
    if (best >= 0.65) matched++;
  }

  return (total / aw.length) * 0.65 +
    (matched / aw.length) * 0.25 +
    (Math.min(aw.length, bw.length) / Math.max(aw.length, bw.length)) * 0.10;
}

function newestRecord(a, b) {
  const da = new Date(a.savedAt || 0).getTime() || 0;
  const db = new Date(b.savedAt || 0).getTime() || 0;
  if (da !== db) return da > db ? a : b;
  return Number(a.id) >= Number(b.id) ? a : b;
}

function uniqueEpisodes(records) {
  const map = new Map();
  for (const record of records) {
    const info = getMovieInfo(record);
    const s = Number(info.season);
    const e = Number(info.episode);
    if (!Number.isFinite(s) || !Number.isFinite(e) || s < 1 || e < 1) continue;
    const key = `${s}:${e}`;
    map.set(key, map.has(key) ? newestRecord(map.get(key), record) : record);
  }
  return [...map.values()].sort((a, b) => {
    const A = getMovieInfo(a), B = getMovieInfo(b);
    return Number(A.season) - Number(B.season) ||
      Number(A.episode) - Number(B.episode);
  });
}

function uniqueParts(records) {
  const map = new Map();
  for (const record of records) {
    const p = Number(getMovieInfo(record).part);
    if (!Number.isFinite(p) || p < 1) continue;
    map.set(p, map.has(p) ? newestRecord(map.get(p), record) : record);
  }
  return [...map.values()].sort((a, b) =>
    Number(getMovieInfo(a).part) - Number(getMovieInfo(b).part)
  );
}

function buildGroups() {
  const map = new Map();
  for (const record of movies) {
    if (!record.chatId || !record.messageId) continue;
    const info = getMovieInfo(record);
    if (!info.key) continue;
    if (!map.has(info.key)) {
      map.set(info.key, { title: info.title, key: info.key, records: [] });
    }
    const group = map.get(info.key);
    if (info.title.length > group.title.length && info.title.length < 80) {
      group.title = info.title;
    }
    group.records.push(record);
  }

  return [...map.values()].map(group => {
    group.episodes = uniqueEpisodes(group.records);
    group.parts = uniqueParts(group.records);
    group.kind = group.episodes.length ? 'series' :
      group.parts.length ? 'parts' : 'movie';
    return group;
  });
}

// =====================================================
// 7B. DETECT MISSING PARTS / EPISODES
// Only reports gaps between numbers already present. It does not guess
// the final expected part/episode because total counts may be unknown.
// =====================================================

function getMissingNumbers(values) {
  const numbers = [...new Set(values.map(Number))]
    .filter(n => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
  if (numbers.length < 2) return [];

  const present = new Set(numbers);
  const missing = [];
  for (let n = numbers[0]; n <= numbers[numbers.length - 1]; n++) {
    if (!present.has(n)) missing.push(n);
  }
  return missing;
}

function getIncompleteParts() {
  return buildGroups()
    .filter(group => group.kind === 'parts')
    .map(group => {
      const available = group.parts.map(record => Number(getMovieInfo(record).part));
      return { title: group.title, available, missing: getMissingNumbers(available) };
    })
    .filter(item => item.missing.length > 0)
    .sort((a, b) => a.title.localeCompare(b.title));
}

function getIncompleteEpisodes() {
  const results = [];
  for (const group of buildGroups().filter(item => item.kind === 'series')) {
    const seasons = new Map();
    for (const record of group.episodes) {
      const info = getMovieInfo(record);
      const season = Number(info.season);
      const episode = Number(info.episode);
      if (!Number.isInteger(season) || season < 1 ||
          !Number.isInteger(episode) || episode < 1) continue;
      if (!seasons.has(season)) seasons.set(season, []);
      seasons.get(season).push(episode);
    }

    for (const [season, episodes] of seasons) {
      const missing = getMissingNumbers(episodes);
      if (missing.length) {
        results.push({
          title: group.title,
          season,
          available: [...new Set(episodes)].sort((a, b) => a - b),
          missing
        });
      }
    }
  }
  return results.sort((a, b) =>
    a.title.localeCompare(b.title) || a.season - b.season
  );
}

function formatNumberList(numbers) {
  return numbers.join(', ');
}

async function sendIncompleteReport(ctx, title, items, formatter) {
  if (!items.length) return ctx.reply('✅ Wax qayb ama episode dhexda ka maqan lama helin.');
  const header = `${title}\n━━━━━━━━━━━━━━━━━━\n\n`;
  let chunk = header;
  let sent = 0;
  for (const item of items) {
    const line = formatter(item) + '\n\n';
    if (chunk.length + line.length > 3700) {
      await ctx.reply(chunk);
      sent++;
      chunk = '';
    }
    chunk += line;
  }
  if (chunk) await ctx.reply(chunk);
  return sent;
}

function adminOnly(ctx) {
  return Number(ctx.from?.id) === ADMIN_ID;
}

bot.command('incomplete', async ctx => {
  if (!adminOnly(ctx)) return ctx.reply('❌ Admin keliya.');
  const parts = getIncompleteParts();
  const episodes = getIncompleteEpisodes();
  if (!parts.length && !episodes.length) {
    return ctx.reply('✅ Dhammaan qaybaha iyo episodes-ka la hayo waa isku xiran yihiin.');
  }
  await ctx.reply(`🔎 HUBINTA FILIMADA / MUSALSALLADA\n\n🎞️ Filimo qaybo ka maqan: ${parts.length}\n📺 Musalsallo episodes ka maqan: ${episodes.length}`);
  if (parts.length) {
    await sendIncompleteReport(ctx, '🎞️ PARTS-KA MAQAN', parts, item =>
      `🎬 ${item.title}\n📦 La hayo: ${formatNumberList(item.available)}\n❌ Maqan: ${formatNumberList(item.missing)}`
    );
  }
  if (episodes.length) {
    await sendIncompleteReport(ctx, '📺 EPISODES-KA MAQAN', episodes, item =>
      `🎬 ${item.title} — Season ${item.season}\n📺 La hayo: ${formatNumberList(item.available)}\n❌ Maqan: Episode ${formatNumberList(item.missing)}`
    );
  }
  return;
});

bot.command('incompleteparts', async ctx => {
  if (!adminOnly(ctx)) return ctx.reply('❌ Admin keliya.');
  return sendIncompleteReport(ctx, '🎞️ FILIMADA PARTS-KA KA MAQAN', getIncompleteParts(), item =>
    `🎬 ${item.title}\n📦 La hayo: ${formatNumberList(item.available)}\n❌ Maqan: Part ${formatNumberList(item.missing)}`
  );
});

bot.command('incompleteepisodes', async ctx => {
  if (!adminOnly(ctx)) return ctx.reply('❌ Admin keliya.');
  return sendIncompleteReport(ctx, '📺 MUSALSALLADA EPISODES-KA KA MAQAN', getIncompleteEpisodes(), item =>
    `🎬 ${item.title} — Season ${item.season}\n📺 La hayo: ${formatNumberList(item.available)}\n❌ Maqan: Episode ${formatNumberList(item.missing)}`
  );
});

function findMovies(query) {
  const parsed = parseCaption(query);
  const q = correctQuery(parsed.key || query);
  if (!q) return [];

  let groups = buildGroups()
    .map(group => ({ ...group, score: similarity(q, group.key) }))
    .filter(group => group.score >= 0.48);

  if (parsed.episode !== null) {
    const matching = groups.filter(g => g.episodes.some(record => {
      const i = getMovieInfo(record);
      return Number(i.episode) === parsed.episode &&
        (parsed.season === null || Number(i.season) === parsed.season);
    }));
    if (matching.length) groups = matching;
  }

  if (parsed.part !== null) {
    const matching = groups.filter(g =>
      g.parts.some(record => Number(getMovieInfo(record).part) === parsed.part)
    );
    if (matching.length) groups = matching;
  }

  return groups.sort((a, b) => b.score - a.score).slice(0, 8);
}

// =====================================================
// 8. MISSING FILMS TRACKER + ADMIN ALERT
// =====================================================

function recordMissingSearch(query, ctx) {
  const title = cleanTitle(query);
  const key = normalize(title);

  // Ignore very short searches, commands, and empty strings.
  if (!key || key.length < 2 || title.startsWith('/')) return;

  let item = missingMovies.find(entry => entry.key === key);
  const now = new Date().toISOString();
  const isNewMissingTitle = !item;

  if (!item) {
    item = {
      id: Date.now(),
      title,
      key,
      count: 0,
      firstSearchedAt: now,
      lastSearchedAt: now,
      users: []
    };
    missingMovies.push(item);
  }

  item.count = (Number(item.count) || 0) + 1;
  item.lastSearchedAt = now;
  if (title.length > item.title.length && title.length < 100) item.title = title;

  const from = ctx.from || {};
  const userId = Number(from.id);
  let userEntry = item.users.find(u => Number(u.id) === userId);

  if (!userEntry) {
    userEntry = {
      id: userId,
      username: from.username || '',
      firstName: from.first_name || '',
      searches: 0,
      firstSearchedAt: now,
      lastSearchedAt: now
    };
    item.users.push(userEntry);
  }

  userEntry.username = from.username || userEntry.username || '';
  userEntry.firstName = from.first_name || userEntry.firstName || '';
  userEntry.searches = (Number(userEntry.searches) || 0) + 1;
  userEntry.lastSearchedAt = now;

  saveMissing();

  // Notify the admin only the first time a new missing title is recorded.
  // Repeated searches increase the counter but do not spam the admin.
  if (isNewMissingTitle) {
    const username = from.username ? '@' + from.username : 'Ma laha username';
    const firstName = from.first_name || 'Magac lama hayo';
    const alert =
      '🔔 FILIM CUSUB OO MAQAN!\n\n' +
      '🎬 Magaca: ' + title + '\n' +
      '👤 Qofka raadiyey: ' + firstName + '\n' +
      '🔗 Username: ' + username + '\n' +
      '🆔 User ID: ' + userId + '\n' +
      '📅 Waqtiga: ' + now + '\n\n' +
      '📊 Faahfaahin: /missing';

    ctx.telegram.sendMessage(ADMIN_ID, alert).catch(error => {
      console.error('Admin missing-film notification failed:', error.message);
    });
  }
}

function getMissingTop(limit = 20) {
  return [...missingMovies]
    .sort((a, b) => Number(b.count) - Number(a.count))
    .slice(0, limit);
}

function formatMissingUser(user) {
  const name = user.firstName || 'Magac ma jiro';
  const username = user.username ? ' (@' + user.username + ')' : ' (username ma jiro)';
  return `${name}${username} — ID: ${user.id} — ${user.searches} jeer`;
}

bot.command('missing', async ctx => {
  if (Number(ctx.from.id) !== ADMIN_ID) return ctx.reply('❌ Admin keliya.');
  if (!missingMovies.length) return ctx.reply('✅ Weli lama diiwaangelin filim maqan.');

  const list = [...missingMovies]
    .sort((a, b) => new Date(b.lastSearchedAt) - new Date(a.lastSearchedAt))
    .slice(0, 15);

  let text = '🔎 FILIMADA LA RAADIYAY EE AAN BOT-KA KU JIRIN\n━━━━━━━━━━━━━━━━━━\n\n';
  for (const item of list) {
    text += `🎬 ${item.title}\n🔢 Raadis: ${item.count}\n👥 Dad kala duwan: ${item.users.length}\n🕒 Ugu dambayn: ${new Date(item.lastSearchedAt).toLocaleString('en-GB', { timeZone: 'Africa/Mogadishu' })}\n\n`;
  }
  text += 'Faahfaahin qof-qof ah: /missingusers';
  return ctx.reply(text);
});

bot.command('missingtop', async ctx => {
  if (Number(ctx.from.id) !== ADMIN_ID) return ctx.reply('❌ Admin keliya.');
  const top = getMissingTop(20);
  if (!top.length) return ctx.reply('Weli ma jiraan raadisyo maqan.');
  let text = '🏆 TOP 20 MISSING FILMS\n━━━━━━━━━━━━━━━━━━\n\n';
  top.forEach((item, index) => {
    text += `${index + 1}. ${item.title}\n🔎 ${item.count} raadis | 👥 ${item.users.length} qof\n\n`;
  });
  return ctx.reply(text);
});

bot.command('missingstats', async ctx => {
  if (Number(ctx.from.id) !== ADMIN_ID) return ctx.reply('❌ Admin keliya.');
  const searches = missingMovies.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
  const people = new Set(missingMovies.flatMap(item => (item.users || []).map(u => Number(u.id)))).size;
  const top = getMissingTop(1)[0];
  return ctx.reply(
    '📊 MISSING FILMS STATISTICS\n━━━━━━━━━━━━━━━━━━\n\n' +
    `🎬 Filimo kala duwan: ${missingMovies.length}\n` +
    `🔎 Raadis guud: ${searches}\n` +
    `👥 Dad kala duwan: ${people}\n` +
    `🏆 Kan ugu badan: ${top ? top.title + ' (' + top.count + ')' : 'Weli ma jiro'}`
  );
});

bot.command('missingusers', async ctx => {
  if (Number(ctx.from.id) !== ADMIN_ID) return ctx.reply('❌ Admin keliya.');
  const top = getMissingTop(10);
  if (!top.length) return ctx.reply('Weli xog ma jirto.');

  for (const item of top) {
    let text = `🎬 ${item.title}\n🔎 Raadis guud: ${item.count}\n\n`;
    for (const user of (item.users || []).slice(0, 15)) {
      text += '• ' + formatMissingUser(user) + '\n';
    }
    await ctx.reply(text.slice(0, 3900));
  }
});

bot.command('missingclear', async ctx => {
  if (Number(ctx.from.id) !== ADMIN_ID) return ctx.reply('❌ Admin keliya.');
  return ctx.reply(
    '⚠️ Ma hubtaa inaad tirtirayso dhammaan xogta Missing Films?',
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Haa, tirtir', 'missingclear:yes')],
      [Markup.button.callback('❌ Maya', 'missingclear:no')]
    ])
  );
});

bot.action('missingclear:yes', async ctx => {
  if (Number(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Admin keliya.', { show_alert: true });
  missingMovies = [];
  saveMissing();
  await ctx.answerCbQuery('Xogta waa la nadiifiyay.');
  return ctx.editMessageText('✅ Xogta Missing Films waa la nadiifiyay.');
});

bot.action('missingclear:no', async ctx => {
  if (Number(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Admin keliya.', { show_alert: true });
  await ctx.answerCbQuery('Waa la joojiyay.');
  return ctx.editMessageText('❌ Nadiifinta waa la joojiyay.');
});

// =====================================================
// 9. TMDB - POSTERS AND MOVIE DETAILS
// =====================================================

const GENRES = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy',
  80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family',
  14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
  9648: 'Mystery', 10749: 'Romance', 878: 'Science Fiction',
  10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western'
};

function getCachedTMDB(key) {
  const cached = tmdbCache.get(key);
  if (!cached) return undefined;
  if (Date.now() - cached.time >= TMDB_CACHE_TIME) {
    tmdbCache.delete(key);
    return undefined;
  }
  return cached.value;
}

function setCachedTMDB(key, value) {
  tmdbCache.set(key, { value, time: Date.now() });
  if (tmdbCache.size > 2000) {
    for (const [cacheKey, entry] of tmdbCache) {
      if (Date.now() - entry.time >= TMDB_CACHE_TIME) tmdbCache.delete(cacheKey);
    }
  }
}

async function fetchTMDB(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TMDB_TIMEOUT);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error('TMDB HTTP ' + response.status);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function getTMDBInfo(title, kind) {
  if (!TMDB_API_KEY) return null;
  const category = kind === 'series' ? 'tv' : 'movie';
  const cacheKey = category + ':' + normalize(title);
  const cached = getCachedTMDB(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const url = `https://api.themoviedb.org/3/search/${category}` +
      `?api_key=${encodeURIComponent(TMDB_API_KEY)}` +
      `&query=${encodeURIComponent(title)}&include_adult=false`;
    const data = await fetchTMDB(url);
    const firstFive = (data.results || []).slice(0, 5);
    const scored = firstFive.map(item => ({
      item,
      score: similarity(normalize(title), normalize(item.title || item.name || ''))
    })).sort((a, b) => b.score - a.score);

    const best = scored[0];
    const result = best && best.score >= 0.45 ? {
      title: best.item.title || best.item.name,
      overview: best.item.overview || '',
      date: best.item.release_date || best.item.first_air_date || '',
      poster: best.item.poster_path
        ? 'https://image.tmdb.org/t/p/w500' + best.item.poster_path : null,
      genres: (best.item.genre_ids || []).map(id => GENRES[id]).filter(Boolean)
    } : null;

    setCachedTMDB(cacheKey, result);
    return result;
  } catch (error) {
    console.error('TMDB ERROR:', error.message);
    return null;
  }
}

function formatMovieCaption(title, info, extra = '') {
  let text = '🎬 ' + title;
  if (info?.date) text += '\n📅 Year: ' + info.date.slice(0, 4);
  if (info?.genres?.length) text += '\n🎭 Genre: ' + info.genres.join(', ');
  if (info?.overview) text += '\n\n📝 ' + info.overview.slice(0, 450);
  if (extra) text += '\n\n' + extra;
  return text.slice(0, 1020);
}

async function sendPosterMenu(ctx, title, kind, keyboard, extra = '') {
  const info = await getTMDBInfo(title, kind);
  const caption = formatMovieCaption(title, info, extra);

  if (info?.poster) {
    try {
      return await ctx.replyWithPhoto(info.poster, {
        caption,
        reply_markup: keyboard.reply_markup
      });
    } catch (error) {
      console.error('POSTER SEND ERROR:', error.message);
    }
  }
  return ctx.reply(caption, keyboard);
}

// =====================================================
// 10. FAVORITES + VIDEO DELIVERY
// =====================================================

function isFavorite(userId, key) {
  return getOrCreateUser(userId).favorites.includes(key);
}

function toggleFavorite(userId, key) {
  const user = getOrCreateUser(userId);
  if (user.favorites.includes(key)) {
    user.favorites = user.favorites.filter(item => item !== key);
    saveUsers();
    return false;
  }
  user.favorites.push(key);
  saveUsers();
  return true;
}

function favoriteButton(userId, key) {
  return Markup.button.callback(
    isFavorite(userId, key) ? '❤️ Ka saar Favorites' : '⭐ Ku dar Favorites',
    'favorite:toggle'
  );
}

async function sendVideo(ctx, record, groupTitle, groupKey) {
  try {
    await ctx.sendChatAction('upload_video');
    const info = getMovieInfo(record);
    let caption = '🎬 ' + (groupTitle || info.title || 'Filim');

    if (info.season !== null && info.episode !== null) {
      caption += ` - Season ${info.season} Episode ${info.episode}`;
    } else if (info.part !== null) {
      caption += ` - Part ${info.part}`;
    }

    const options = { caption, parse_mode: undefined };
    if (groupKey) {
      options.reply_markup = Markup.inlineKeyboard([
        [favoriteButton(ctx.from.id, groupKey)]
      ]).reply_markup;
    }

    await ctx.telegram.copyMessage(
      ctx.chat.id, record.chatId, record.messageId, options
    );
  } catch (error) {
    console.error('VIDEO SEND ERROR:', error.message);
    await ctx.reply(
      '⚠️ Video-ga lama soo diri karin. Hubi in bot-ku leeyahay rukhsadda channel-ka.'
    );
  }
}

// =====================================================
// 11. START + USER COMMANDS (NO JOIN GATE)
// =====================================================

bot.start(async ctx => {
  const user = getOrCreateUser(ctx.from.id);
  processNewReferral(user, getStartPayload(ctx));

  return ctx.reply(
    '🎬 Ku soo dhowow SOMALI BOT!\n\n' +
    'Qor magaca filimka ama musalsalka aad rabto.\n\n' +
    '⭐ /favorites - Filimada aad kaydsatay\n' +
    'ℹ️ /help - Caawimaad'
  );
});

bot.command('invite', async ctx => {
  const user = getOrCreateUser(ctx.from.id);
  const link = getReferralLink(ctx.from.id);
  return ctx.reply(
    '🔗 YOUR REFERRAL LINK\n\n' +
    '👤 Link-gaaga gaarka ah:\n' + link + '\n\n' +
    '👥 Dadka aad keentay: ' + (Number(user.referralCount) || 0) +
    '\n\n📢 La wadaag saaxiibbadaa si ay bot-ka ugu soo biiraan.',
    Markup.inlineKeyboard([[
      Markup.button.url(
        '📤 Share Bot',
        'https://t.me/share/url?url=' + encodeURIComponent(link) +
        '&text=' + encodeURIComponent('Ku soo biir SOMALI BOT 🎬')
      )
    ]])
  );
});

bot.command('top', async ctx => {
  const top = getTopReferrers(10);
  if (!top.length) return ctx.reply('🏆 Weli ma jiraan referrals la diiwaangeliyay.');
  let message = '🏆 TOP REFERRERS\n\n';
  top.forEach((user, index) => {
    message += `${index + 1}. ${user.firstName || user.username || `User ${user.id}`}\n👥 Referrals: ${user.referralCount}\n\n`;
  });
  return ctx.reply(message);
});

bot.command('promolinks', async ctx => {
  if (Number(ctx.from.id) !== ADMIN_ID) return ctx.reply('❌ Admin keliya.');
  let message = '🌍 TRAFFIC TRACKING LINKS\n\n';
  for (const source of ['tiktok', 'facebook', 'telegram', 'instagram', 'youtube', 'other']) {
    message += source.toUpperCase() + ':\n' + getSourceLink(source) + '\n\n';
  }
  return ctx.reply(message);
});

// =====================================================
// 12. OPEN MOVIE / SERIES / PARTS
// =====================================================

async function openGroup(ctx, group, requested = {}) {
  if (requested.episode !== null && requested.episode !== undefined) {
    const chosen = group.episodes.find(record => {
      const i = getMovieInfo(record);
      return Number(i.episode) === Number(requested.episode) &&
        (requested.season == null || Number(i.season) === Number(requested.season));
    });
    if (chosen) {
      sessions.set(ctx.from.id, { type: 'selected', group });
      return sendVideo(ctx, chosen, group.title, group.key);
    }
  }

  if (requested.part !== null && requested.part !== undefined) {
    const chosen = group.parts.find(record =>
      Number(getMovieInfo(record).part) === Number(requested.part)
    );
    if (chosen) {
      sessions.set(ctx.from.id, { type: 'selected', group });
      return sendVideo(ctx, chosen, group.title, group.key);
    }
  }

  if (group.kind === 'series') {
    const seasons = [...new Set(group.episodes.map(record =>
      Number(getMovieInfo(record).season)
    ))].filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b);

    sessions.set(ctx.from.id, {
      type: 'series', group, selectedSeason: null
    });

    const keyboard = Markup.inlineKeyboard([
      ...seasons.map(season => [Markup.button.callback('📺 Season ' + season, 'season:' + season)]),
      [favoriteButton(ctx.from.id, group.key)]
    ]);

    return sendPosterMenu(ctx, group.title, 'series', keyboard, '📺 Musalsalka\n\nDooro Season-ka:');
  }

  if (group.kind === 'parts') {
    sessions.set(ctx.from.id, { type: 'parts', group });
    const keyboard = Markup.inlineKeyboard([
      ...group.parts.map(record => [
        Markup.button.callback('▶️ Part ' + getMovieInfo(record).part, 'part:' + record.id)
      ]),
      [favoriteButton(ctx.from.id, group.key)]
    ]);
    return sendPosterMenu(ctx, group.title, 'movie', keyboard, '🎬 Filim qaybo leh\n\nDooro Part-ka:');
  }

  // Single movie: poster stays unchanged. The Watch button sends the actual video.
  const record = group.records.reduce((best, current) => newestRecord(best, current));
  sessions.set(ctx.from.id, { type: 'single', group, record });

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('▶️ DAawo FILIMKA', 'movie:watch')],
    [favoriteButton(ctx.from.id, group.key)]
  ]);

  return sendPosterMenu(ctx, group.title, 'movie', keyboard, '🎬 Filim buuxa\n\nRiix ▶️ Daawo Filimka si muuqaalka loo soo diro.');
}

bot.command('favorites', async ctx => {
  const user = getOrCreateUser(ctx.from.id);
  if (!user.favorites.length) return ctx.reply('⭐ Weli wax filim ah kuma kaydsan Favorites.');

  const groups = buildGroups().filter(group => user.favorites.includes(group.key));
  if (!groups.length) return ctx.reply('Filimadii aad kaydsatay hadda lama helin.');

  sessions.set(ctx.from.id, { type: 'favorites', groups });
  const rows = [];
  for (let i = 0; i < Math.min(groups.length, 50); i += 2) {
    const row = [Markup.button.callback('🎬 ' + groups[i].title.slice(0, 28), 'favorite:open:' + i)];
    if (groups[i + 1]) row.push(Markup.button.callback('🎬 ' + groups[i + 1].title.slice(0, 28), 'favorite:open:' + (i + 1)));
    rows.push(row);
  }
  return ctx.reply('❤️ FILIMADA AAD JECESHAHAY\n\nDooro filimka:', Markup.inlineKeyboard(rows));
});

bot.action('movie:watch', async ctx => {
  const session = sessions.get(ctx.from.id);
  if (!session || session.type !== 'single' || !session.record) {
    return ctx.answerCbQuery('Fadlan mar kale raadi filimka.', { show_alert: true });
  }
  await ctx.answerCbQuery('⏳ Filimka ayaa la soo dirayaa...');
  return sendVideo(ctx, session.record, session.group.title, session.group.key);
});

bot.action('favorite:toggle', async ctx => {
  const session = sessions.get(ctx.from.id);
  if (!session?.group) {
    return ctx.answerCbQuery('Fadlan mar kale raadi filimka.', { show_alert: true });
  }
  const saved = toggleFavorite(ctx.from.id, session.group.key);
  return ctx.answerCbQuery(
    saved ? '❤️ Favorites ayaa lagu daray.' : '🗑️ Favorites waa laga saaray.'
  );
});

bot.action(/^favorite:open:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  const session = sessions.get(ctx.from.id);
  if (!session || session.type !== 'favorites') return ctx.reply('Fadlan mar kale fur Favorites.');
  const group = session.groups[Number(ctx.match[1])];
  if (!group) return ctx.reply('Filimka lama helin.');
  return openGroup(ctx, group);
});

bot.action(/^title:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  const session = sessions.get(ctx.from.id);
  if (!session || session.type !== 'titles') return ctx.reply('Fadlan mar kale raadi filimka.');
  const group = session.groups[Number(ctx.match[1])];
  if (!group) return ctx.reply('Filimka lama helin.');
  return openGroup(ctx, group, session.requested || {});
});

bot.action(/^season:(\d+)$/, async ctx => {
  const session = sessions.get(ctx.from.id);
  if (!session || session.type !== 'series') {
    return ctx.answerCbQuery('Fadlan mar kale raadi musalsalka.', { show_alert: true });
  }
  const season = Number(ctx.match[1]);
  const episodes = session.group.episodes.filter(record =>
    Number(getMovieInfo(record).season) === season
  );
  if (!episodes.length) return ctx.answerCbQuery('Season-kan lama helin.', { show_alert: true });

  session.selectedSeason = season;
  const rows = [];
  for (let i = 0; i < episodes.length; i += 2) {
    const row = [Markup.button.callback(
      '▶️ Ep ' + getMovieInfo(episodes[i]).episode,
      'episode:' + episodes[i].id
    )];
    if (episodes[i + 1]) row.push(Markup.button.callback(
      '▶️ Ep ' + getMovieInfo(episodes[i + 1]).episode,
      'episode:' + episodes[i + 1].id
    ));
    rows.push(row);
  }
  rows.push([Markup.button.callback('⬅️ Seasons', 'seasons_back')]);
  rows.push([favoriteButton(ctx.from.id, session.group.key)]);
  await ctx.answerCbQuery();
  const text = '📺 ' + session.group.title + '\nSeason ' + season + '\n\nDooro Episode-ka:';
  try {
    if (ctx.callbackQuery.message?.photo) return await ctx.editMessageCaption(text, Markup.inlineKeyboard(rows));
    return await ctx.editMessageText(text, Markup.inlineKeyboard(rows));
  } catch (error) {
    if (!String(error.message).includes('message is not modified')) console.error('SEASON EDIT:', error.message);
  }
});

bot.action('seasons_back', async ctx => {
  const session = sessions.get(ctx.from.id);
  if (!session || session.type !== 'series') return ctx.answerCbQuery();
  const seasons = [...new Set(session.group.episodes.map(record =>
    Number(getMovieInfo(record).season)
  ))].filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  session.selectedSeason = null;
  const keyboard = Markup.inlineKeyboard([
    ...seasons.map(season => [Markup.button.callback('📺 Season ' + season, 'season:' + season)]),
    [favoriteButton(ctx.from.id, session.group.key)]
  ]);
  await ctx.answerCbQuery();
  const text = '🎬 ' + session.group.title + '\n\n📺 Musalsalka\n\nDooro Season-ka:';
  try {
    if (ctx.callbackQuery.message?.photo) return await ctx.editMessageCaption(text, keyboard);
    return await ctx.editMessageText(text, keyboard);
  } catch (error) {
    if (!String(error.message).includes('message is not modified')) console.error('SEASONS BACK:', error.message);
  }
});

bot.action(/^episode:(\d+)$/, async ctx => {
  const session = sessions.get(ctx.from.id);
  if (!session || session.type !== 'series') {
    return ctx.answerCbQuery('Fadlan mar kale raadi musalsalka.', { show_alert: true });
  }
  const record = session.group.episodes.find(item =>
    Number(item.id) === Number(ctx.match[1]) &&
    Number(getMovieInfo(item).season) === Number(session.selectedSeason)
  );
  if (!record) return ctx.answerCbQuery('Episode-kan lama helin.', { show_alert: true });
  await ctx.answerCbQuery('⏳ Episode-ka ayaa la soo dirayaa...');
  return sendVideo(ctx, record, session.group.title, session.group.key);
});

bot.action(/^part:(\d+)$/, async ctx => {
  const session = sessions.get(ctx.from.id);
  if (!session || session.type !== 'parts') {
    return ctx.answerCbQuery('Fadlan mar kale raadi filimka.', { show_alert: true });
  }
  const record = session.group.parts.find(item => Number(item.id) === Number(ctx.match[1]));
  if (!record) return ctx.answerCbQuery('Qaybtan lama helin.', { show_alert: true });
  await ctx.answerCbQuery('⏳ Qaybta ayaa la soo dirayaa...');
  return sendVideo(ctx, record, session.group.title, session.group.key);
});

// =====================================================
// 13. TEXT SEARCH + MISSING TRACKING
// =====================================================

bot.on('text', async (ctx, next) => {
  const query = ctx.message.text.trim();
  if (query.startsWith('/')) return next();
  if (!query) return;

  const parsed = parseCaption(query);
  const results = findMovies(query);

  if (!results.length) {
    // Store the search and the Telegram user identity.
    recordMissingSearch(query, ctx);

    // Show TMDB-based suggestions only as suggestions, never as playable files.
    const tmdbInfo = await getTMDBInfo(cleanTitle(query), 'movie');
    let message = '❌ Filimkan si sax ah loogama helin bot-ka.\n\n' +
      '🔎 Waan diiwaangelinnay codsigaaga. Admin-ku wuu arki karaa filimada la raadiyay.\n\n' +
      'Hubi higgaadda magaca ama isku day magac kale.';
    if (tmdbInfo?.title) {
      message += '\n\n🎬 TMDB wuxuu helay cinwaan u dhow: ' + tmdbInfo.title +
        '\nℹ️ Laakiin muuqaalka filimkan kuma jiro bot-ka hadda.';
    }
    return ctx.reply(message);
  }

  const best = results[0];
  const second = results[1];
  const corrected = correctQuery(parsed.key || query);
  const exactMatch = corrected === best.key;
  const strongMatch = best.score >= 0.70 && (!second || best.score - second.score >= 0.08);

  if (exactMatch || strongMatch) return openGroup(ctx, best, parsed);

  sessions.set(ctx.from.id, { type: 'titles', groups: results, requested: parsed });
  const rows = [];
  for (let i = 0; i < results.length; i += 2) {
    const row = [Markup.button.callback('🎬 ' + results[i].title.slice(0, 28), 'title:' + i)];
    if (results[i + 1]) row.push(Markup.button.callback(
      '🎬 ' + results[i + 1].title.slice(0, 28), 'title:' + (i + 1)
    ));
    rows.push(row);
  }

  return ctx.reply(
    '🎬 Magacyo dhow ayaa la helay.\n\nMa kuwan baad ka wadday? Dooro filimka:',
    Markup.inlineKeyboard(rows)
  );
});

// =====================================================
// 14. HELP + BROADCAST
// =====================================================

bot.command('help', async ctx => ctx.reply(
  'ℹ️ Caawimaadda SOMALI BOT\n\n' +
  'Haddii aad cabasho, su\'aal ama dhibaato qabto, fadlan nagala soo xiriir:\n\n' +
  '📩 Telegram: @Fare252\n\n' +
  '📱 WhatsApp: +2520906949873\n\n' +
  'Mahadsanid inaad isticmaasho SOMALI BOT ❤️'
));

async function broadcastMessage(ctx, messageId) {
  let sent = 0, failed = 0;
  await ctx.reply('⏳ Broadcast ayaa bilaabanaya. Users: ' + users.length);
  for (const user of users) {
    try {
      await ctx.telegram.copyMessage(user.id, ctx.chat.id, messageId);
      sent++;
      await new Promise(resolve => setTimeout(resolve, 45));
    } catch (error) {
      failed++;
      console.log('BROADCAST ERROR:', user.id, error.message);
    }
  }
  return ctx.reply(`✅ Broadcast dhammaaday!\n\n👥 Users: ${users.length}\n✅ La diray: ${sent}\n❌ Fashilmay: ${failed}`);
}

bot.command('broadcast', async ctx => {
  if (Number(ctx.from.id) !== ADMIN_ID) return ctx.reply('❌ Admin keliya.');
  const replied = ctx.message.reply_to_message;
  const message = ctx.message.text.replace(/^\/broadcast(@\w+)?\s*/i, '').trim();
  if (replied) return broadcastMessage(ctx, replied.message_id);
  if (!message) return ctx.reply(
    'Qor: /broadcast Fariintaada\nAma reply saar fariin kadib qor /broadcast.'
  );

  let sent = 0, failed = 0;
  await ctx.reply('⏳ Broadcast qoraal ayaa bilaabanaya.');
  for (const user of users) {
    try {
      await ctx.telegram.sendMessage(user.id, message);
      sent++;
      await new Promise(resolve => setTimeout(resolve, 45));
    } catch (error) { failed++; }
  }
  return ctx.reply(`✅ Broadcast dhammaaday!\n👥 Users: ${users.length}\n✅ La diray: ${sent}\n❌ Fashilmay: ${failed}`);
});

async function prepareMediaBroadcast(ctx) {
  if (Number(ctx.from.id) !== ADMIN_ID) return;
  pendingBroadcasts.set(ADMIN_ID, { chatId: ctx.chat.id, messageId: ctx.message.message_id });
  return ctx.reply(
    '📢 Fariintan ma u dirnaa dhammaan users-ka?',
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Haa, dir', 'broadcast_yes')],
      [Markup.button.callback('❌ Jooji', 'broadcast_no')]
    ])
  );
}

bot.on('voice', prepareMediaBroadcast);
bot.on('audio', prepareMediaBroadcast);
bot.on('video_note', prepareMediaBroadcast);
bot.on('photo', prepareMediaBroadcast);
bot.on('video', prepareMediaBroadcast);
bot.on('document', prepareMediaBroadcast);

bot.action('broadcast_yes', async ctx => {
  if (Number(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Admin keliya.');
  const pending = pendingBroadcasts.get(ADMIN_ID);
  if (!pending) return ctx.answerCbQuery('Fariinta lama helin.', { show_alert: true });
  pendingBroadcasts.delete(ADMIN_ID);
  await ctx.answerCbQuery();
  return broadcastMessage(ctx, pending.messageId);
});

bot.action('broadcast_no', async ctx => {
  if (Number(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Admin keliya.');
  pendingBroadcasts.delete(ADMIN_ID);
  await ctx.answerCbQuery();
  return ctx.reply('❌ Waa la joojiyay.');
});

// =====================================================
// 15. ADMIN DASHBOARD
// =====================================================

bot.command('stats', async ctx => {
  if (Number(ctx.from.id) !== ADMIN_ID) return ctx.reply('❌ Admin keliya.');

  const groups = buildGroups();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const countSince = (field, start) => users.filter(user => {
    if (!user[field]) return false;
    const date = new Date(user[field]);
    return Number.isFinite(date.getTime()) && date >= start;
  }).length;

  const monthlyActive = countSince('lastActiveAt', monthStart);
  const activeToday = countSince('lastActiveAt', todayStart);
  const joinedToday = countSince('firstSeen', todayStart);
  const joinedThisMonth = countSince('firstSeen', monthStart);
  const totalFavorites = users.reduce((sum, user) => sum + (user.favorites || []).length, 0);
  const sourceStats = getSourceStatistics();
  const top = getTopReferrers(5);

  let topText = top.length
    ? top.map((user, i) => `${i + 1}. ${user.firstName || user.username || user.id} — ${user.referralCount}`).join('\n')
    : 'Weli referrals ma jiraan.';

  const missingSearches = missingMovies.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
  const topMissing = getMissingTop(1)[0];

  const message =
    '📊 SOMALI BOT STATISTICS\n━━━━━━━━━━━━━━━━━━\n\n' +
    '👥 ALL TIME USERS: ' + users.length + '\n' +
    '📅 MONTHLY ACTIVE USERS: ' + monthlyActive + '\n' +
    '🆕 USERS JOINED THIS MONTH: ' + joinedThisMonth + '\n' +
    '☀️ ACTIVE TODAY: ' + activeToday + '\n' +
    '🆕 JOINED TODAY: ' + joinedToday + '\n\n' +
    '🔗 REFERRAL STATISTICS\n👥 TOTAL REFERRALS: ' + getTotalReferrals() + '\n\n' +
    '🌍 TRAFFIC SOURCES\n' +
    '🎵 TikTok: ' + sourceStats.tiktok + '\n' +
    '📘 Facebook: ' + sourceStats.facebook + '\n' +
    '✈️ Telegram: ' + sourceStats.telegram + '\n' +
    '📸 Instagram: ' + sourceStats.instagram + '\n' +
    '▶️ YouTube: ' + sourceStats.youtube + '\n' +
    '🔗 Referral links: ' + sourceStats.referral + '\n' +
    '❔ Other: ' + sourceStats.other + '\n' +
    '❔ Unknown / Older users: ' + sourceStats.unknown + '\n\n' +
    '🏆 TOP REFERRERS\n' + topText + '\n\n' +
    '🎬 MOVIE STATISTICS\n' +
    '🎞️ VIDEO RECORDS: ' + movies.length + '\n' +
    '📚 FILM / SERIES GROUPS: ' + groups.length + '\n' +
    '📺 SERIES: ' + groups.filter(g => g.kind === 'series').length + '\n' +
    '🎞️ FILMS WITH PARTS: ' + groups.filter(g => g.kind === 'parts').length + '\n' +
    '🎬 SINGLE MOVIES: ' + groups.filter(g => g.kind === 'movie').length + '\n\n' +
    '❤️ FAVORITES SAVED: ' + totalFavorites + '\n\n' +
    '🔎 MISSING FILMS\n' +
    '🎬 Filimo kala duwan: ' + missingMovies.length + '\n' +
    '🔍 Raadis guud: ' + missingSearches + '\n' +
    '🏆 Ugu badan: ' + (topMissing ? topMissing.title + ' (' + topMissing.count + ')' : 'Weli ma jiro') + '\n\n' +
    '🖼️ TMDB: ' + (TMDB_API_KEY ? 'Enabled' : 'API key missing');

  return ctx.reply(message);
});

// =====================================================
// 16. TELEGRAM COMMAND MENU
// =====================================================

async function setupTelegramMenu() {
  try {
    await bot.telegram.setMyCommands([
      { command: 'help', description: 'Caawimaad iyo Support' },
      { command: 'favorites', description: 'Filimada aad kaydsatay' },
      { command: 'invite', description: 'Hel referral link-gaaga' },
      { command: 'top', description: 'Top referrers' }
    ], { scope: { type: 'default' } });

    await bot.telegram.setMyCommands([
      { command: 'stats', description: 'View bot statistics' },
      { command: 'broadcast', description: 'Send a broadcast' },
      { command: 'promolinks', description: 'Get traffic promotion links' },
      { command: 'missing', description: 'Liiska filimada la waayay' },
      { command: 'missingtop', description: 'Top 20 filim ee la raadiyay' },
      { command: 'missingstats', description: 'Tirakoobka missing films' },
      { command: 'missingusers', description: 'Dadka raadiyay filimada maqan' },
      { command: 'missingclear', description: 'Nadiifi missing films data' },
      { command: 'incomplete', description: 'Hubi parts iyo episodes maqan' },
      { command: 'incompleteparts', description: 'Hubi filimada parts-ka ka maqan' },
      { command: 'incompleteepisodes', description: 'Hubi episodes-ka maqan' }
    ], { scope: { type: 'chat', chat_id: ADMIN_ID } });

    console.log('Telegram Menu configured.');
  } catch (error) {
    console.error('MENU SETUP ERROR:', error.message);
  }
}

// =====================================================
// 17. ERROR HANDLING / STARTUP
// =====================================================

bot.catch(error => console.error('BOT ERROR:', error));

bot.launch({
  allowedUpdates: ['message', 'callback_query', 'channel_post']
})
  .then(async () => {
    console.log('SOMALI BOT is running!');
    console.log('Channel membership gate/buttons: REMOVED');
    console.log('Source channel video ingestion: Enabled');
    console.log('Single movie: Poster -> Watch button -> video');
    console.log('Missing films tracking: Enabled');
    console.log('Missing parts/episodes checker: Enabled');
    console.log('Missing database: missing_movies.json');
    console.log('Old movies.json and users.json preserved.');
    await setupTelegramMenu();
  })
  .catch(error => {
    console.error('BOT LAUNCH ERROR:', error);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
