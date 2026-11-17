
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

const CHANNELS = [
  {
    username: '@VEXORAMOVIES',
    link: 'https://t.me/VEXORAMOVIES'
  },
  {
    username: '@somalifilm0',
    link: 'https://t.me/somalifilm0'
  }
];

const SOURCES = [
  'tiktok',
  'facebook',
  'telegram',
  'instagram',
  'youtube',
  'other',
  'referral'
];

if (!BOT_TOKEN) {
  throw new Error('BOT TOKEN IS MISSING');
}

const bot = new Telegraf(BOT_TOKEN);

const MOVIES_DB = path.join(__dirname, 'movies.json');
const USERS_DB = path.join(__dirname, 'users.json');

const sessions = new Map();
const pendingBroadcasts = new Map();
const tmdbCache = new Map();


// =====================================================
// 2. DATABASE - PRESERVE OLD DATA
// =====================================================

function loadArray(file, property) {
  if (!fs.existsSync(file)) return [];

  const parsed = JSON.parse(
    fs.readFileSync(file, 'utf8')
  );

  if (Array.isArray(parsed)) return parsed;

  if (parsed && Array.isArray(parsed[property])) {
    return parsed[property];
  }

  throw new Error(
    'Database format error: ' + path.basename(file)
  );
}

function safeSave(file, data) {
  const temp = file + '.tmp';
  const backup = file + '.bak';

  if (fs.existsSync(file)) {
    fs.copyFileSync(file, backup);
  }

  fs.writeFileSync(
    temp,
    JSON.stringify(data, null, 2),
    'utf8'
  );

  fs.renameSync(temp, file);
}

let movies = loadArray(MOVIES_DB, 'movies');

let users = loadArray(USERS_DB, 'users')
  .map(user => {
    if (typeof user === 'number' || typeof user === 'string') {
      return {
        id: Number(user),
        firstSeen: null,
        favorites: []
      };
    }

    return {
      ...user,
      id: Number(user.id),
      firstSeen: user.firstSeen || null,
      favorites: Array.isArray(user.favorites)
        ? user.favorites
        : [],
      referralCount: Number(user.referralCount) || 0
    };
  })
  .filter(user => Number.isFinite(user.id));

let nextMovieId =
  movies.reduce((max, movie) => {
    return Math.max(max, Number(movie.id) || 0);
  }, 0) + 1;

function saveMovies() {
  safeSave(MOVIES_DB, movies);
}

function saveUsers() {
  safeSave(USERS_DB, users);
}

function getUser(userId) {
  return users.find(user => user.id === Number(userId));
}

function getOrCreateUser(userId) {
  let user = getUser(userId);

  if (!user) {
    user = {
      id: Number(userId),
      firstSeen: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
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
  return SOURCES.includes(source)
    ? source
    : 'other';
}

function processNewReferral(user, payload) {
  if (!payload || user.referredBy || user.firstSource) {
    return;
  }

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

    if (inviterId === Number(user.id)) {
      inviterId = null;
    }

    const inviter = inviterId
      ? getUser(inviterId)
      : null;

    if (!inviter) {
      inviterId = null;
    }
  } else if (sourceMatch) {
    source = validSource(
      sourceMatch[1].toLowerCase()
    );
  }

  user.firstSource = source;

  if (inviterId) {
    user.referredBy = inviterId;

    const inviter = getUser(inviterId);

    if (inviter) {
      inviter.referralCount =
        (Number(inviter.referralCount) || 0) + 1;
    }
  }

  saveUsers();
}

function getTotalReferrals() {
  return users.reduce(
    (sum, user) =>
      sum + (Number(user.referralCount) || 0),
    0
  );
}

function getSourceStatistics() {
  const stats = {};

  for (const source of SOURCES) {
    stats[source] = 0;
  }

  stats.unknown = 0;

  for (const user of users) {
    const source = user.firstSource || 'unknown';

    if (stats[source] === undefined) {
      stats.unknown++;
    } else {
      stats[source]++;
    }
  }

  return stats;
}

function getTopReferrers(limit = 10) {
  return users
    .filter(user =>
      Number(user.referralCount) > 0
    )
    .sort((a, b) =>
      Number(b.referralCount) -
      Number(a.referralCount)
    )
    .slice(0, limit);
}


// =====================================================
// 4. USER ACTIVITY TRACKING
// =====================================================

bot.use(async (ctx, next) => {
  if (ctx.chat?.type === 'private' && ctx.from) {
    const existing = getUser(ctx.from.id);

    ctx.state.isNewUser = !existing;

    const user = getOrCreateUser(ctx.from.id);

    const now = new Date();
    const last = user.lastActiveAt
      ? new Date(user.lastActiveAt)
      : null;

    // Save activity at most once per hour.
    if (
      !last ||
      !Number.isFinite(last.getTime()) ||
      now.getTime() - last.getTime() >= 60 * 60 * 1000
    ) {
      user.lastActiveAt = now.toISOString();
      saveUsers();
    }
  }

  return next();
});


// =====================================================
// 5. TITLE NORMALIZATION
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


// =====================================================
// 6. CAPTION PARSING
// =====================================================

function parseCaption(caption) {
  const raw = String(caption || '')
    .replace(/\r/g, '')
    .trim();

  const lines = raw.split('\n')
    .map(x => x.trim())
    .filter(Boolean);

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
    const ep = raw.match(
      /\b(?:Episode|EP|E)\s*0*(\d+)\b/i
    );

    if (ep) {
      episode = Number(ep[1]);
      marker = ep.index;

      const sm =
        raw.match(/\bSeason\s*0*(\d+)\b/i) ||
        raw.match(/\bS\s*0*(\d+)\b/i);

      season = sm ? Number(sm[1]) : 1;
    }
  }

  const partRe =
    /\b(?:part|pt|qeyb(?:ta|teda|teeda)?|qayb(?:ta|teda|teeda)?|cd|disc|disk)\s*[:#-]?\s*0*(\d+)\b/i;

  const pm = raw.match(partRe);

  if (pm) {
    part = Number(pm[1]);

    if (marker === null || pm.index < marker) {
      marker = pm.index;
    }
  }

  let titleLine = lines.find(line =>
    !/^https?:\/\//i.test(line) &&
    !/^[@#]/.test(line)
  ) || '';

  if (marker !== null) {
    const before = raw.slice(0, marker);
    const beforeLines = before.split('\n')
      .map(x => x.trim())
      .filter(Boolean);

    if (beforeLines.length) {
      titleLine = beforeLines[beforeLines.length - 1];
    }
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
    type: episode !== null
      ? 'series'
      : part !== null
        ? 'part'
        : 'movie'
  };
}

function getMovieInfo(movie) {
  const captionInfo = parseCaption(movie.caption || '');

  const hasCaptionEpisode =
    captionInfo.episode !== null;

  const hasCaptionPart =
    captionInfo.part !== null;

  const season = hasCaptionEpisode
    ? captionInfo.season
    : movie.season != null
      ? Number(movie.season)
      : captionInfo.season;

  const episode = hasCaptionEpisode
    ? captionInfo.episode
    : movie.episode != null
      ? Number(movie.episode)
      : null;

  const part = hasCaptionPart
    ? captionInfo.part
    : movie.part != null
      ? Number(movie.part)
      : null;

  let title;

  if (
    (hasCaptionEpisode || hasCaptionPart) &&
    captionInfo.title
  ) {
    title = captionInfo.title;
  } else {
    title = cleanTitle(
      movie.title || captionInfo.title || ''
    );
  }

  if (!title) {
    title = cleanTitle(
      captionInfo.title || movie.title || ''
    );
  }

  return {
    title,
    key: normalize(title),
    season,
    episode,
    part,
    type: episode !== null || movie.type === 'series'
      ? 'series'
      : part !== null
        ? 'parts'
        : 'movie'
  };
}


// =====================================================
// 7. RECEIVE CHANNEL VIDEOS
// =====================================================

bot.on('channel_post', ctx => {
  const post = ctx.channelPost;

  const username = ctx.chat.username
    ? '@' + ctx.chat.username.toLowerCase()
    : '';

  if (!CHANNELS.some(ch =>
    ch.username.toLowerCase() === username
  )) {
    return;
  }

  const hasVideo =
    Boolean(post.video) ||
    Boolean(post.document && (
      post.document.mime_type?.startsWith('video/') ||
      /\.(mp4|mkv|avi|mov|webm)$/i.test(
        post.document.file_name || ''
      )
    ));

  if (!hasVideo || !post.caption) return;

  const info = parseCaption(post.caption);

  if (!info.key) return;

  let record = movies.find(m =>
    String(m.chatId) === String(ctx.chat.id) &&
    Number(m.messageId) === Number(post.message_id)
  );

  if (!record) {
    record = {
      id: nextMovieId++,
      chatId: ctx.chat.id,
      messageId: post.message_id
    };

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
// 8. SUBSCRIBE CHECK
// =====================================================

async function isJoined(userId) {
  for (const channel of CHANNELS) {
    try {
      const member = await bot.telegram.getChatMember(
        channel.username,
        userId
      );

      const joined =
        ['creator', 'administrator', 'member'].includes(member.status) ||
        (member.status === 'restricted' && member.is_member);

      if (!joined) return false;

    } catch (error) {
      console.error('JOIN CHECK:', error.message);
      return false;
    }
  }

  return true;
}

async function showJoin(ctx) {
  return ctx.reply(
    '🎬 Si aad u isticmaasho bot-ka, fadlan join garee labada channel:\n\n' +
    '1️⃣ ' + CHANNELS[0].link + '\n' +
    '2️⃣ ' + CHANNELS[1].link,

    Markup.inlineKeyboard([
      [
        Markup.button.url('📢 Somali Film', CHANNELS[1].link)
      ],
      [
        Markup.button.url('🎬 VEXORA MOVIES', CHANNELS[0].link)
      ],
      [
        Markup.button.callback('✅ Waan join gareeyay', 'check_join')
      ]
    ])
  );
}


// =====================================================
// 9. START
// =====================================================

bot.start(async ctx => {
  const user = getOrCreateUser(ctx.from.id);

  // Only process referral/source for genuinely new users.
  if (ctx.state.isNewUser) {
    const payload = getStartPayload(ctx);
    processNewReferral(user, payload);
  }

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  return ctx.reply(
    '🎬 Ku soo dhowow American Somali Films!\n\n' +
    'Qor magaca filimka ama musalsalka aad rabto.\n\n' +
    '⭐ /favorites - Filimada aad kaydsatay\n' +
    'ℹ️ /help - Caawimaad'
  );
});

bot.action('check_join', async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  return ctx.reply(
    '✅ Waa lagu xaqiijiyay!\n\nHadda qor magaca filimka.'
  );
});


// =====================================================
// 10. REFERRAL COMMAND
// =====================================================

bot.command('invite', async ctx => {
  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const user = getOrCreateUser(ctx.from.id);
  const link = getReferralLink(ctx.from.id);

  const count = Number(user.referralCount) || 0;

  return ctx.reply(
    '🔗 YOUR REFERRAL LINK\n\n' +
    '👤 Link-gaaga gaarka ah:\n' +
    link + '\n\n' +
    '👥 Dadka aad keentay: ' + count + '\n\n' +
    '📢 La wadaag saaxiibbadaa si ay bot-ka ugu soo biiraan.\n' +
    '🎁 Dhibco iyo abaalmarin ma jiraan; tirinta keliya ayaa la sameeyaa.',
    Markup.inlineKeyboard([
      [
        Markup.button.url(
          '📤 Share Bot',
          'https://t.me/share/url?url=' +
          encodeURIComponent(link) +
          '&text=' +
          encodeURIComponent('Ku soo biir American Somali Films 🎬')
        )
      ]
    ])
  );
});


// =====================================================
// 11. TOP REFERRERS
// =====================================================

bot.command('top', async ctx => {
  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const top = getTopReferrers(10);

  if (!top.length) {
    return ctx.reply(
      '🏆 Weli ma jiraan referrals la diiwaangeliyay.'
    );
  }

  let message = '🏆 TOP REFERRERS\n\n';

  top.forEach((user, index) => {
    const name = user.firstName ||
      user.username ||
      `User ${user.id}`;

    message +=
      `${index + 1}. ${name}\n` +
      `👥 Referrals: ${user.referralCount}\n\n`;
  });

  return ctx.reply(message);
});


// =====================================================
// 12. ADMIN PROMOTION LINKS
// =====================================================

bot.command('promolinks', async ctx => {
  if (Number(ctx.from.id) !== ADMIN_ID) {
    return ctx.reply('❌ Admin keliya.');
  }

  let message = '🌍 TRAFFIC TRACKING LINKS\n\n';

  for (const source of [
    'tiktok',
    'facebook',
    'telegram',
    'instagram',
    'youtube',
    'other'
  ]) {
    message +=
      source.toUpperCase() + ':\n' +
      getSourceLink(source) + '\n\n';
  }

  message +=
    'Isticmaal link-ga platform-ka aad xayeysiinta ku daabacayso.';

  return ctx.reply(message);
});


// =====================================================
// 13. SMART SEARCH ENGINE
// =====================================================

function levenshtein(a, b) {
  const row = Array.from(
    { length: b.length + 1 },
    (_, i) => i
  );

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

  const distance = levenshtein(a, b);

  return 1 - distance / Math.max(a.length, b.length);
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;

  if (b.includes(a) || a.includes(b)) {
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);

    return 0.85 + (shorter / longer) * 0.15;
  }

  const aw = a.split(' ').filter(Boolean);
  const bw = b.split(' ').filter(Boolean);

  if (!aw.length || !bw.length) return 0;

  let total = 0;
  let matched = 0;

  for (const word of aw) {
    let best = 0;

    for (const other of bw) {
      const score = wordSimilarity(word, other);

      if (score > best) best = score;
    }

    total += best;

    if (best >= 0.65) matched++;
  }

  const average = total / aw.length;
  const coverage = matched / aw.length;

  const lengthPenalty =
    Math.min(aw.length, bw.length) /
    Math.max(aw.length, bw.length);

  return average * 0.65 +
    coverage * 0.25 +
    lengthPenalty * 0.10;
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

    if (
      !Number.isFinite(s) ||
      !Number.isFinite(e) ||
      s < 1 ||
      e < 1
    ) continue;

    const key = `${s}:${e}`;

    map.set(
      key,
      map.has(key)
        ? newestRecord(map.get(key), record)
        : record
    );
  }

  return [...map.values()].sort((a, b) => {
    const A = getMovieInfo(a);
    const B = getMovieInfo(b);

    return (
      Number(A.season) - Number(B.season) ||
      Number(A.episode) - Number(B.episode)
    );
  });
}

function uniqueParts(records) {
  const map = new Map();

  for (const record of records) {
    const p = Number(getMovieInfo(record).part);

    if (!Number.isFinite(p) || p < 1) continue;

    map.set(
      p,
      map.has(p)
        ? newestRecord(map.get(p), record)
        : record
    );
  }

  return [...map.values()].sort((a, b) =>
    Number(getMovieInfo(a).part) -
    Number(getMovieInfo(b).part)
  );
}

function buildGroups() {
  const map = new Map();

  for (const record of movies) {
    if (!record.chatId || !record.messageId) continue;

    const info = getMovieInfo(record);

    if (!info.key) continue;

    if (!map.has(info.key)) {
      map.set(info.key, {
        title: info.title,
        key: info.key,
        records: []
      });
    }

    const group = map.get(info.key);

    if (
      info.title.length > group.title.length &&
      info.title.length < 80
    ) {
      group.title = info.title;
    }

    group.records.push(record);
  }

  return [...map.values()].map(group => {
    group.episodes = uniqueEpisodes(group.records);
    group.parts = uniqueParts(group.records);

    group.kind = group.episodes.length
      ? 'series'
      : group.parts.length
        ? 'parts'
        : 'movie';

    return group;
  });
}

function findMovies(query) {
  const parsed = parseCaption(query);
  const q = correctQuery(parsed.key || query);

  if (!q) return [];

  let groups = buildGroups()
    .map(group => ({
      ...group,
      score: similarity(q, group.key)
    }))
    .filter(group => group.score >= 0.48);

  if (parsed.episode !== null) {
    const matching = groups.filter(g =>
      g.episodes.some(record => {
        const i = getMovieInfo(record);

        return (
          Number(i.episode) === parsed.episode &&
          (
            parsed.season === null ||
            Number(i.season) === parsed.season
          )
        );
      })
    );

    if (matching.length) groups = matching;
  }

  if (parsed.part !== null) {
    const matching = groups.filter(g =>
      g.parts.some(record =>
        Number(getMovieInfo(record).part) === parsed.part
      )
    );

    if (matching.length) groups = matching;
  }

  return groups
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}


// =====================================================
// 14. TMDB POSTER AND INFORMATION
// =====================================================

const GENRES = {
  28: 'Action',
  12: 'Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  14: 'Fantasy',
  36: 'History',
  27: 'Horror',
  10402: 'Music',
  9648: 'Mystery',
  10749: 'Romance',
  878: 'Science Fiction',
  10770: 'TV Movie',
  53: 'Thriller',
  10752: 'War',
  37: 'Western'
};

async function getTMDBInfo(title, kind) {
  if (!TMDB_API_KEY) return null;

  const category = kind === 'series' ? 'tv' : 'movie';
  const cacheKey = category + ':' + normalize(title);

  if (tmdbCache.has(cacheKey)) {
    return tmdbCache.get(cacheKey);
  }

  try {
    const url =
      `https://api.themoviedb.org/3/search/${category}` +
      `?api_key=${encodeURIComponent(TMDB_API_KEY)}` +
      `&query=${encodeURIComponent(title)}` +
      '&include_adult=false';

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error('TMDB HTTP ' + response.status);
    }

    const data = await response.json();

    const results = (data.results || [])
      .map(item => {
        const name = item.title || item.name || '';

        return {
          item,
          score: similarity(
            normalize(title),
            normalize(name)
          )
        };
      })
      .sort((a, b) => b.score - a.score);

    const best = results[0];

    const result =
      best && best.score >= 0.45
        ? {
            title: best.item.title || best.item.name,
            overview: best.item.overview || '',
            date: best.item.release_date ||
              best.item.first_air_date || '',
            poster: best.item.poster_path
              ? 'https://image.tmdb.org/t/p/w500' +
                best.item.poster_path
              : null,
            genres: (best.item.genre_ids || [])
              .map(id => GENRES[id])
              .filter(Boolean)
          }
        : null;

    tmdbCache.set(cacheKey, result);

    return result;

  } catch (error) {
    console.error('TMDB ERROR:', error.message);
    return null;
  }
}

function formatMovieCaption(title, info, extra = '') {
  let text = '🎬 ' + title;

  if (info?.date) {
    text += '\n📅 Year: ' + info.date.slice(0, 4);
  }

  if (info?.genres?.length) {
    text += '\n🎭 Genre: ' + info.genres.join(', ');
  }

  if (info?.overview) {
    text += '\n\n📝 ' + info.overview.slice(0, 450);
  }

  if (extra) {
    text += '\n\n' + extra;
  }

  return text.slice(0, 1020);
}

async function sendPosterMenu(
  ctx,
  title,
  kind,
  keyboard,
  extra = ''
) {
  const info = await getTMDBInfo(title, kind);

  const caption = formatMovieCaption(
    title,
    info,
    extra
  );

  if (info?.poster) {
    try {
      return await ctx.replyWithPhoto(
        info.poster,
        {
          caption,
          reply_markup: keyboard.reply_markup
        }
      );

    } catch (error) {
      console.error('POSTER SEND ERROR:', error.message);
    }
  }

  return ctx.reply(
    caption +
    '\n\n🖼️ Poster lama helin. Isticmaal badhanka hoose.',
    keyboard
  );
}


// =====================================================
// 15. SEND VIDEO
// =====================================================

async function sendVideo(ctx, record, groupTitle) {
  try {
    await ctx.sendChatAction('upload_video');

    const info = getMovieInfo(record);

    let caption =
      '🎬 ' + (groupTitle || info.title || 'Filim');

    if (
      info.season !== null &&
      info.episode !== null
    ) {
      caption +=
        ` - Season ${info.season} Episode ${info.episode}`;

    } else if (info.part !== null) {
      caption += ` - Part ${info.part}`;
    }

    await ctx.telegram.copyMessage(
      ctx.chat.id,
      record.chatId,
      record.messageId,
      {
        caption,
        parse_mode: undefined
      }
    );

  } catch (error) {
    console.error('VIDEO SEND ERROR:', error.message);

    await ctx.reply(
      '⚠️ Video-ga lama soo diri karin. Hubi in bot-ku leeyahay rukhsadda channel-ka.'
    );
  }
}


// =====================================================
// 16. FAVORITES
// =====================================================

function isFavorite(userId, key) {
  const user = getOrCreateUser(userId);
  return user.favorites.includes(key);
}

function toggleFavorite(userId, key) {
  const user = getOrCreateUser(userId);

  if (user.favorites.includes(key)) {
    user.favorites = user.favorites.filter(
      item => item !== key
    );

    saveUsers();
    return false;
  }

  user.favorites.push(key);
  saveUsers();

  return true;
}

function favoriteButton(userId, key) {
  const saved = isFavorite(userId, key);

  return Markup.button.callback(
    saved ? '❤️ Ka saar Favorites' : '⭐ Ku dar Favorites',
    'favorite:toggle'
  );
}

bot.command('favorites', async ctx => {
  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const user = getOrCreateUser(ctx.from.id);

  if (!user.favorites.length) {
    return ctx.reply(
      '⭐ Weli wax filim ah kuma kaydsan Favorites.'
    );
  }

  const groups = buildGroups().filter(group =>
    user.favorites.includes(group.key)
  );

  if (!groups.length) {
    return ctx.reply(
      'Filimadii aad kaydsatay hadda lama helin.'
    );
  }

  sessions.set(ctx.from.id, {
    type: 'favorites',
    groups
  });

  return ctx.reply(
    '❤️ FILIMADA AAD JECESHAHAY\n\nDooro filimka:',
    Markup.inlineKeyboard(
      groups.map((group, index) => [
        Markup.button.callback(
          '🎬 ' + group.title,
          'favorite:open:' + index
        )
      ])
    )
  );
});

bot.action('favorite:toggle', async ctx => {
  await ctx.answerCbQuery();

  const session = sessions.get(ctx.from.id);

  if (!session?.group) {
    return ctx.reply('Fadlan mar kale raadi filimka.');
  }

  const saved = toggleFavorite(
    ctx.from.id,
    session.group.key
  );

  return ctx.reply(
    saved
      ? '❤️ Filimka Favorites ayaa lagu daray.'
      : '🗑️ Filimka Favorites waa laga saaray.'
  );
});

bot.action(/^favorite:open:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const session = sessions.get(ctx.from.id);

  if (!session || session.type !== 'favorites') {
    return ctx.reply('Fadlan mar kale fur Favorites.');
  }

  const group = session.groups[Number(ctx.match[1])];

  if (!group) return ctx.reply('Filimka lama helin.');

  return openGroup(ctx, group);
});


// =====================================================
// 17. OPEN TITLE / SEASON / EPISODE
// =====================================================

async function openGroup(ctx, group, requested = {}) {
  if (
    requested.episode !== null &&
    requested.episode !== undefined
  ) {
    const chosen = group.episodes.find(record => {
      const i = getMovieInfo(record);

      return (
        Number(i.episode) === Number(requested.episode) &&
        (
          requested.season == null ||
          Number(i.season) === Number(requested.season)
        )
      );
    });

    if (chosen) {
      return sendVideo(ctx, chosen, group.title);
    }
  }

  if (
    requested.part !== null &&
    requested.part !== undefined
  ) {
    const chosen = group.parts.find(record =>
      Number(getMovieInfo(record).part) ===
      Number(requested.part)
    );

    if (chosen) {
      return sendVideo(ctx, chosen, group.title);
    }
  }

  if (group.kind === 'series') {
    const seasons = [
      ...new Set(
        group.episodes.map(record =>
          Number(getMovieInfo(record).season)
        )
      )
    ]
      .filter(n => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);

    sessions.set(ctx.from.id, {
      type: 'series',
      group,
      selectedSeason: null
    });

    const keyboard = Markup.inlineKeyboard([
      ...seasons.map(season => [
        Markup.button.callback(
          '📺 Season ' + season,
          'season:' + season
        )
      ]),
      [favoriteButton(ctx.from.id, group.key)]
    ]);

    return sendPosterMenu(
      ctx,
      group.title,
      'series',
      keyboard,
      '📺 Musalsalka\n\nDooro Season-ka:'
    );
  }

  if (group.kind === 'parts') {
    sessions.set(ctx.from.id, {
      type: 'parts',
      group
    });

    const keyboard = Markup.inlineKeyboard([
      ...group.parts.map(record => [
        Markup.button.callback(
          '▶️ Part ' + getMovieInfo(record).part,
          'part:' + record.id
        )
      ]),
      [favoriteButton(ctx.from.id, group.key)]
    ]);

    return sendPosterMenu(
      ctx,
      group.title,
      'movie',
      keyboard,
      '🎬 Filim qaybo leh\n\nDooro Part-ka:'
    );
  }

  const record = group.records.reduce(
    (best, current) => newestRecord(best, current)
  );

  sessions.set(ctx.from.id, {
    type: 'single',
    group,
    record
  });

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        '▶️ Daawo Filimka',
        'movie:' + record.id
      )
    ],
    [favoriteButton(ctx.from.id, group.key)]
  ]);

  return sendPosterMenu(
    ctx,
    group.title,
    'movie',
    keyboard,
    '🎬 Taabo badhanka si aad u daawato.'
  );
}


// =====================================================
// 18. TEXT SEARCH
// =====================================================

bot.on('text', async ctx => {
  const query = ctx.message.text.trim();

  if (!query || query.startsWith('/')) return;

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const parsed = parseCaption(query);
  const results = findMovies(query);

  if (!results.length) {
    return ctx.reply(
      '❌ Filimkan lama helin.\n\n' +
      'Hubi magaca ama isku day qoraal kale.'
    );
  }

  const best = results[0];
  const second = results[1];

  const corrected = correctQuery(
    parsed.key || query
  );

  const exactMatch =
    corrected === best.key;

  const strongMatch =
    best.score >= 0.70 &&
    (
      !second ||
      best.score - second.score >= 0.08
    );

  if (exactMatch || strongMatch) {
    return openGroup(ctx, best, parsed);
  }

  sessions.set(ctx.from.id, {
    type: 'titles',
    groups: results,
    requested: parsed
  });

  await ctx.reply(
    '🎬 Waxaan helay filimo dhow.\n' +
    'Dooro midka aad raadineyso:'
  );

  for (let i = 0; i < results.length; i++) {
    const group = results[i];

    const info = await getTMDBInfo(
      group.title,
      group.kind === 'series' ? 'series' : 'movie'
    );

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '✅ Dooro ' + group.title.slice(0, 35),
          'title:' + i
        )
      ]
    ]);

    if (info?.poster) {
      try {
        await ctx.replyWithPhoto(
          info.poster,
          {
            caption: formatMovieCaption(
              group.title,
              info
            ),
            reply_markup: keyboard.reply_markup
          }
        );

        continue;

      } catch (error) {
        console.error('SEARCH POSTER:', error.message);
      }
    }

    await ctx.reply(
      '🎬 ' + group.title,
      keyboard
    );
  }
});


// =====================================================
// 19. TITLE BUTTON
// =====================================================

bot.action(/^title:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const session = sessions.get(ctx.from.id);

  if (!session || session.type !== 'titles') {
    return ctx.reply('Fadlan mar kale raadi filimka.');
  }

  const group = session.groups[Number(ctx.match[1])];

  if (!group) return ctx.reply('Filimka lama helin.');

  return openGroup(
    ctx,
    group,
    session.requested || {}
  );
});


// =====================================================
// 20. MOVIE BUTTON
// =====================================================

bot.action(/^movie:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const movieId = Number(ctx.match[1]);
  const session = sessions.get(ctx.from.id);

  let record = null;
  let title = '';

  if (
    session &&
    session.type === 'single' &&
    Number(session.record.id) === movieId
  ) {
    record = session.record;
    title = session.group.title;
  } else {
    record = movies.find(movie =>
      Number(movie.id) === movieId
    );

    if (record) {
      title = getMovieInfo(record).title;
    }
  }

  if (!record) {
    return ctx.reply('Filimkan hadda lama helin.');
  }

  return sendVideo(ctx, record, title);
});


// =====================================================
// 21. SEASON BUTTON
// =====================================================

bot.action(/^season:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const session = sessions.get(ctx.from.id);

  if (!session || session.type !== 'series') {
    return ctx.reply('Fadlan mar kale raadi musalsalka.');
  }

  const season = Number(ctx.match[1]);

  const episodes = session.group.episodes.filter(
    record =>
      Number(getMovieInfo(record).season) === season
  );

  if (!episodes.length) {
    return ctx.reply('Season-kan xogtiisa lama helin.');
  }

  session.selectedSeason = season;

  const keyboard = Markup.inlineKeyboard([
    ...episodes.map(record => [
      Markup.button.callback(
        '▶️ Episode ' + getMovieInfo(record).episode,
        'episode:' + record.id
      )
    ]),
    [
      Markup.button.callback(
        '⭐ Favorites',
        'favorite:toggle'
      )
    ]
  ]);

  return sendPosterMenu(
    ctx,
    session.group.title,
    'series',
    keyboard,
    '📺 ' + session.group.title +
    '\nSeason ' + season +
    '\n\nDooro Episode-ka:'
  );
});


// =====================================================
// 22. EPISODE BUTTON
// =====================================================

bot.action(/^episode:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const session = sessions.get(ctx.from.id);

  if (!session || session.type !== 'series') {
    return ctx.reply('Fadlan mar kale raadi musalsalka.');
  }

  const record = session.group.episodes.find(item =>
    Number(item.id) === Number(ctx.match[1]) &&
    Number(getMovieInfo(item).season) ===
      Number(session.selectedSeason)
  );

  if (!record) {
    return ctx.reply('Episode-kan lama helin.');
  }

  return sendVideo(ctx, record, session.group.title);
});


// =====================================================
// 23. PART BUTTON
// =====================================================

bot.action(/^part:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const session = sessions.get(ctx.from.id);

  if (!session || session.type !== 'parts') {
    return ctx.reply('Fadlan mar kale raadi filimka.');
  }

  const record = session.group.parts.find(item =>
    Number(item.id) === Number(ctx.match[1])
  );

  if (!record) return ctx.reply('Qaybtan lama helin.');

  return sendVideo(ctx, record, session.group.title);
});


// =====================================================
// 24. HELP
// =====================================================

bot.command('help', async ctx => {
  return ctx.reply(
    '🎬 AMERICAN SOMALI FILMS\n\n' +
    '🔎 Qor magaca filimka si aad u raadiso.\n' +
    '⭐ /favorites - Filimada aad kaydsatay.\n' +
    '🔗 /invite - Referral link-gaaga.\n' +
    '🏆 /top - Dadka referrals-ka ugu badan keenay.\n' +
    'ℹ️ /help - Caawimaad.\n\n' +
    'Haddii aad qalad ku qorto magaca, bot-ku wuxuu isku dayayaa inuu fahmo.'
  );
});


// =====================================================
// 25. ADMIN BROADCAST
// =====================================================

async function broadcastMessage(ctx, messageId) {
  let sent = 0;
  let failed = 0;

  await ctx.reply(
    '⏳ Broadcast ayaa bilaabanaya. Users: ' + users.length
  );

  for (const user of users) {
    try {
      await ctx.telegram.copyMessage(
        user.id,
        ctx.chat.id,
        messageId
      );

      sent++;

      await new Promise(resolve =>
        setTimeout(resolve, 45)
      );

    } catch (error) {
      failed++;
      console.log('BROADCAST ERROR:', user.id, error.message);
    }
  }

  return ctx.reply(
    `✅ Broadcast dhammaaday!\n\n` +
    `👥 Users: ${users.length}\n` +
    `✅ La diray: ${sent}\n` +
    `❌ Fashilmay: ${failed}`
  );
}

bot.command('broadcast', async ctx => {
  if (Number(ctx.from.id) !== ADMIN_ID) {
    return ctx.reply('❌ Admin keliya.');
  }

  const replied = ctx.message.reply_to_message;

  const message = ctx.message.text
    .replace(/^\/broadcast(@\w+)?\s*/i, '')
    .trim();

  if (replied) {
    return broadcastMessage(ctx, replied.message_id);
  }

  if (!message) {
    return ctx.reply(
      'Qor: /broadcast Fariintaada\n' +
      'Ama reply saar fariin kadib qor /broadcast.'
    );
  }

  let sent = 0;
  let failed = 0;

  await ctx.reply('⏳ Broadcast qoraal ayaa bilaabanaya.');

  for (const user of users) {
    try {
      await ctx.telegram.sendMessage(user.id, message);
      sent++;

      await new Promise(resolve =>
        setTimeout(resolve, 45)
      );

    } catch (error) {
      failed++;
    }
  }

  return ctx.reply(
    `✅ Broadcast dhammaaday!\n` +
    `👥 Users: ${users.length}\n` +
    `✅ La diray: ${sent}\n` +
    `❌ Fashilmay: ${failed}`
  );
});

async function prepareMediaBroadcast(ctx) {
  if (Number(ctx.from.id) !== ADMIN_ID) return;

  pendingBroadcasts.set(ADMIN_ID, {
    chatId: ctx.chat.id,
    messageId: ctx.message.message_id
  });

  return ctx.reply(
    '📢 Fariintan ma u dirnaa dhammaan users-ka?',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Haa, dir', 'broadcast_yes')
      ],
      [
        Markup.button.callback('❌ Jooji', 'broadcast_no')
      ]
    ])
  );
}

bot.on('voice', prepareMediaBroadcast);
bot.on('audio', prepareMediaBroadcast);
bot.on('video_note', prepareMediaBroadcast);
bot.on('photo', prepareMediaBroadcast);

bot.action('broadcast_yes', async ctx => {
  await ctx.answerCbQuery();

  if (Number(ctx.from.id) !== ADMIN_ID) return;

  const pending = pendingBroadcasts.get(ADMIN_ID);

  if (!pending) return ctx.reply('Fariinta lama helin.');

  pendingBroadcasts.delete(ADMIN_ID);

  return broadcastMessage(ctx, pending.messageId);
});

bot.action('broadcast_no', async ctx => {
  await ctx.answerCbQuery();

  if (Number(ctx.from.id) !== ADMIN_ID) return;

  pendingBroadcasts.delete(ADMIN_ID);

  return ctx.reply('❌ Waa la joojiyay.');
});


// =====================================================
// 26. ADMIN STATISTICS
// =====================================================

bot.command('stats', async ctx => {
  if (Number(ctx.from.id) !== ADMIN_ID) {
    return ctx.reply('❌ Admin keliya.');
  }

  const groups = buildGroups();
  const now = new Date();

  const monthStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    1
  );

  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );

  // Monthly active users: lastActiveAt in this month.
  const monthlyActive = users.filter(user => {
    if (!user.lastActiveAt) return false;

    const date = new Date(user.lastActiveAt);

    return (
      Number.isFinite(date.getTime()) &&
      date >= monthStart
    );
  }).length;

  const activeToday = users.filter(user => {
    if (!user.lastActiveAt) return false;

    const date = new Date(user.lastActiveAt);

    return (
      Number.isFinite(date.getTime()) &&
      date >= todayStart
    );
  }).length;

  const joinedToday = users.filter(user => {
    if (!user.firstSeen) return false;

    const date = new Date(user.firstSeen);

    return (
      Number.isFinite(date.getTime()) &&
      date >= todayStart
    );
  }).length;

  const joinedThisMonth = users.filter(user => {
    if (!user.firstSeen) return false;

    const date = new Date(user.firstSeen);

    return (
      Number.isFinite(date.getTime()) &&
      date >= monthStart
    );
  }).length;

  const totalFavorites = users.reduce(
    (sum, user) =>
      sum + (user.favorites || []).length,
    0
  );

  const sourceStats = getSourceStatistics();

  const totalReferrals = getTotalReferrals();

  const top = getTopReferrers(5);

  let topText = '';

  if (top.length) {
    top.forEach((user, index) => {
      topText +=
        `${index + 1}. ${user.firstName || user.username || user.id}` +
        ` — ${user.referralCount}\n`;
    });
  } else {
    topText = 'Weli referrals ma jiraan.\n';
  }

  const message =
    '📊 AMERICAN SOMALI FILMS\n' +
    '━━━━━━━━━━━━━━━━━━\n\n' +

    '👥 ALL TIME USERS: ' + users.length + '\n' +
    '📅 MONTHLY ACTIVE USERS: ' + monthlyActive + '\n' +
    '🆕 USERS JOINED THIS MONTH: ' + joinedThisMonth + '\n' +
    '☀️ ACTIVE TODAY: ' + activeToday + '\n' +
    '🆕 JOINED TODAY: ' + joinedToday + '\n\n' +

    '🔗 REFERRAL STATISTICS\n' +
    '👥 TOTAL REFERRALS: ' + totalReferrals + '\n\n' +

    '🌍 TRAFFIC SOURCES\n' +
    '🎵 TikTok: ' + sourceStats.tiktok + '\n' +
    '📘 Facebook: ' + sourceStats.facebook + '\n' +
    '✈️ Telegram: ' + sourceStats.telegram + '\n' +
    '📸 Instagram: ' + sourceStats.instagram + '\n' +
    '▶️ YouTube: ' + sourceStats.youtube + '\n' +
    '🔗 Referral links: ' + sourceStats.referral + '\n' +
    '❔ Other / Unknown: ' + sourceStats.other + '\n' +
    '❔ Older users without source: ' + sourceStats.unknown + '\n\n' +

    '🏆 TOP REFERRERS\n' + topText + '\n' +

    '🎬 MOVIE STATISTICS\n' +
    '🎞️ VIDEO RECORDS: ' + movies.length + '\n' +
    '📚 FILM / SERIES GROUPS: ' + groups.length + '\n' +
    '📺 SERIES: ' +
    groups.filter(g => g.kind === 'series').length + '\n' +
    '🎞️ FILMS WITH PARTS: ' +
    groups.filter(g => g.kind === 'parts').length + '\n' +
    '🎬 SINGLE MOVIES: ' +
    groups.filter(g => g.kind === 'movie').length + '\n\n' +

    '❤️ FAVORITES SAVED: ' + totalFavorites + '\n' +

    '🖼️ TMDB: ' +
    (TMDB_API_KEY ? 'Enabled' : 'API key missing');

  return ctx.reply(message);
});


// =====================================================
// 27. TELEGRAM MENU - ADMIN ONLY
// =====================================================

async function setupTelegramMenu() {
  try {
    // Remove default command menu for ordinary users.
    await bot.telegram.setMyCommands([], {
      scope: {
        type: 'default'
      }
    });

    // Only the admin gets these commands in the menu.
    await bot.telegram.setMyCommands(
      [
        {
          command: 'stats',
          description: 'View bot statistics'
        },
        {
          command: 'broadcast',
          description: 'Send a broadcast'
        }
      ],
      {
        scope: {
          type: 'chat',
          chat_id: ADMIN_ID
        }
      }
    );

    console.log('Telegram Menu configured: Admin only.');

  } catch (error) {
    console.error('MENU SETUP ERROR:', error.message);
  }
}


// =====================================================
// 28. ERROR HANDLING / STARTUP
// =====================================================

bot.catch(error => {
  console.error('BOT ERROR:', error);
});

bot.launch({
  allowedUpdates: [
    'message',
    'callback_query',
    'channel_post'
  ]
})
  .then(async () => {
    console.log('American Somali Films Bot is running!');
    console.log('Smart Search: Enabled');
    console.log('TMDB Posters:', TMDB_API_KEY ? 'Enabled' : 'Missing');
    console.log('Series: Poster -> Seasons -> Episodes -> Video');
    console.log('Favorites: Enabled');
    console.log('Referral Tracking: Enabled');
    console.log('Traffic Tracking: Enabled');
    console.log('Monthly Active Users: Enabled');
    console.log('Admin Stats: Enabled');
    console.log('Admin Menu: Enabled');
    console.log('Old movies.json and users.json preserved.');

    await setupTelegramMenu();
  })
  .catch(error => {
    console.error('BOT LAUNCH ERROR:', error);
    process.exit(1);
  });

process.once('SIGINT', () => {
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
});
