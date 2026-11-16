
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

if (!BOT_TOKEN) {
  throw new Error('BOT TOKEN IS MISSING. Set BOT_TOKEN in Environment Variables.');
}

const bot = new Telegraf(BOT_TOKEN);

const MOVIES_DB = path.join(__dirname, 'movies.json');
const USERS_DB = path.join(__dirname, 'users.json');

const sessions = new Map();
const pendingBroadcasts = new Map();
const posterCache = new Map();


// =====================================================
// 2. DATABASE - PRESERVE OLD DATA
// =====================================================

function loadArray(file, property) {
  if (!fs.existsSync(file)) return [];

  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (Array.isArray(parsed)) return parsed;

  if (parsed && Array.isArray(parsed[property])) {
    return parsed[property];
  }

  throw new Error('Database format error: ' + path.basename(file));
}

function safeSave(file, data) {
  const temp = file + '.tmp';
  const backup = file + '.bak';

  // Backup old database before changing it.
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, backup);
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
        firstSeen: null
      };
    }

    return {
      ...user,
      id: Number(user.id),
      firstSeen: user.firstSeen || null
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

// Save normalized users without removing their existing fields.
saveUsers();


// =====================================================
// 3. TITLE / CAPTION PARSING
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
    const ep = raw.match(/\b(?:Episode|EP|E)\s*0*(\d+)\b/i);

    if (ep) {
      episode = Number(ep[1]);
      marker = ep.index;

      const sm =
        raw.match(/\bSeason\s*0*(\d+)\b/i) ||
        raw.match(/\bS\s*0*(\d+)\b/i);

      season = sm ? Number(sm[1]) : 1;
    }
  }

  // Supports Part, Qeybta, Qaybta and common spelling variations.
  const partRe =
    /\b(?:part|pt|qeyb(?:ta|teda|teeda)?|qayb(?:ta|teda|teeda)?|qeyt(?:a|eda)?|cd|disc|disk)\s*[:#-]?\s*0*(\d+)\b/i;

  const pm = raw.match(partRe);

  if (pm) {
    part = Number(pm[1]);

    if (marker === null || pm.index < marker) {
      marker = pm.index;
    }
  }

  let titleLine = lines[0] || '';

  if (marker !== null) {
    const before = raw
      .slice(0, marker)
      .split('\n')
      .filter(x => x.trim())
      .pop();

    if (before) titleLine = before;
  } else {
    const useful = lines.find(line =>
      !/^https?:\/\//i.test(line) &&
      !/^[@#]/.test(line)
    );

    if (useful) titleLine = useful;
  }

  let title = titleLine
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/@[\w]+/g, ' ')
    .replace(/#[\w]+/g, ' ')
    .replace(/[🎬🎥📺🍿⭐🔥❤️✅]/gu, ' ')
    .replace(/\b(?:480p|720p|1080p|1440p|2160p|4k|8k|hd|full\s*hd|uhd|hdr|web\s*dl|bluray|brrip|webrip)\b/gi, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/[|:–—]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  title = title
    .replace(/^(?:movie|film|filim)\s+/i, '')
    .trim();

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
  const parsed = parseCaption(movie.caption || movie.title || '');

  const season =
    parsed.season ??
    (movie.season != null ? Number(movie.season) : null);

  const episode =
    parsed.episode ??
    (movie.episode != null ? Number(movie.episode) : null);

  const part =
    parsed.part ??
    (movie.part != null ? Number(movie.part) : null);

  // Prefer the already saved clean title when available.
  const title = movie.title || parsed.title || '';

  return {
    title,
    key: normalize(title),
    season,
    episode,
    part,
    type: episode !== null || movie.type === 'series'
      ? 'series'
      : part !== null
        ? 'part'
        : 'movie'
  };
}


// =====================================================
// 4. REGISTER USERS
// =====================================================

bot.use(async (ctx, next) => {
  if (ctx.chat?.type === 'private' && ctx.from) {
    const id = Number(ctx.from.id);

    if (!users.some(user => user.id === id)) {
      users.push({
        id,
        firstSeen: new Date().toISOString()
      });

      saveUsers();
    }
  }

  return next();
});


// =====================================================
// 5. RECEIVE CHANNEL VIDEOS
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

  if (!info.key) {
    console.log(
      'Skipped: no title detected:',
      post.caption.slice(0, 120)
    );
    return;
  }

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

  // Update the matching record without removing old fields.
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

  console.log(
    'Saved:',
    info.title,
    info.season ? `S${info.season}` : '',
    info.episode ? `E${info.episode}` : '',
    info.part ? `Part ${info.part}` : ''
  );
});


// =====================================================
// 6. JOIN CHECK
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
      console.error(
        'JOIN CHECK:',
        channel.username,
        error.message
      );

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
        Markup.button.url(
          '📢 Somali Film',
          CHANNELS[1].link
        )
      ],
      [
        Markup.button.url(
          '🎬 VEXORA MOVIES',
          CHANNELS[0].link
        )
      ],
      [
        Markup.button.callback(
          '✅ Waan join gareeyay',
          'check_join'
        )
      ]
    ])
  );
}

bot.start(async ctx => {
  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  return ctx.reply(
    '🎬 Ku soo dhowow American Somali Films!\n\n' +
    'Qor magaca filimka ama musalsalka aad rabto.'
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
// 7. SEARCH / GROUP RECORDS
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

function similarity(a, b) {
  if (!a || !b) return 0;

  if (a === b) return 1;
  if (b.includes(a)) return 0.97;
  if (a.includes(b)) return 0.94;

  const aw = a.split(' ');
  const bw = b.split(' ');

  const scores = aw.map(word =>
    Math.max(
      ...bw.map(other =>
        1 - levenshtein(word, other) /
        Math.max(word.length, other.length)
      )
    )
  );

  return scores.reduce((x, y) => x + y, 0) /
    scores.length * 0.9;
}

function newestRecord(a, b) {
  const da = new Date(a.savedAt || 0).getTime() || 0;
  const db = new Date(b.savedAt || 0).getTime() || 0;

  if (da !== db) {
    return da > db ? a : b;
  }

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
    ) {
      continue;
    }

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
    const episodes = uniqueEpisodes(group.records);
    const parts = uniqueParts(group.records);

    group.episodes = episodes;
    group.parts = parts;

    group.kind = episodes.length
      ? 'series'
      : parts.length
        ? 'parts'
        : 'movie';

    return group;
  });
}

function findMovies(query) {
  const parsed = parseCaption(query);
  const q = parsed.key || normalize(query);

  let groups = buildGroups()
    .map(group => ({
      ...group,
      score: similarity(q, group.key)
    }))
    .filter(group =>
      group.score >= (
        q.split(' ').length === 1 ? 0.70 : 0.66
      )
    );

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
// 8. TMDB POSTERS
// =====================================================

async function getPoster(title, kind) {
  if (!TMDB_API_KEY) {
    console.error(
      'TMDB_API_KEY is missing. Add it in Environment Variables.'
    );

    return null;
  }

  const category = kind === 'series' ? 'tv' : 'movie';

  const cacheKey =
    category + ':' + normalize(title);

  if (posterCache.has(cacheKey)) {
    return posterCache.get(cacheKey);
  }

  try {
    const url =
      `https://api.themoviedb.org/3/search/${category}` +
      `?api_key=${encodeURIComponent(TMDB_API_KEY)}` +
      `&query=${encodeURIComponent(title)}` +
      '&include_adult=false';

    const response = await fetch(url, {
      headers: {
        accept: 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error('TMDB HTTP ' + response.status);
    }

    const data = await response.json();

    const results = data.results || [];

    const queryKey = normalize(title);

    // Prefer the closest matching title with a poster.
    const candidates = results
      .filter(item => item.poster_path)
      .map(item => {
        const resultTitle =
          normalize(item.title || item.name || '');

        return {
          item,
          score: similarity(queryKey, resultTitle)
        };
      })
      .sort((a, b) => b.score - a.score);

    const result = candidates.length
      ? candidates[0].item
      : null;

    const poster = result
      ? 'https://image.tmdb.org/t/p/w500' +
        result.poster_path
      : null;

    posterCache.set(cacheKey, poster);

    return poster;

  } catch (error) {
    console.error(
      'TMDB POSTER ERROR:',
      error.message
    );

    return null;
  }
}

async function sendPosterMenu(
  ctx,
  title,
  kind,
  keyboard,
  caption
) {
  const poster = await getPoster(title, kind);

  const text = caption || ('🎬 ' + title);

  if (poster) {
    try {
      return await ctx.replyWithPhoto(poster, {
        caption: text,
        reply_markup: keyboard.reply_markup
      });

    } catch (error) {
      console.error(
        'POSTER SEND ERROR:',
        error.message
      );
    }
  }

  return ctx.reply(
    text + '\n\n🖼️ Poster-ka hadda lama helin. Doorashada hoose isticmaal.',
    keyboard
  );
}


// =====================================================
// 9. SEND VIDEO
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
    console.error(
      'VIDEO SEND ERROR:',
      error.message
    );

    await ctx.reply(
      '⚠️ Video-ga lama soo diri karin. Fadlan mar kale isku day.'
    );
  }
}


// =====================================================
// 10. OPEN TITLE
// =====================================================

async function openGroup(ctx, group, requested = {}) {

  // Direct episode request.
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

  // Direct part request.
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

  // SERIES: Poster -> Seasons -> Poster -> Episodes.
  if (group.kind === 'series') {
    const seasons = [
      ...new Set(
        group.episodes.map(record =>
          Number(getMovieInfo(record).season)
        )
      )
    ]
      .filter(n => n > 0)
      .sort((a, b) => a - b);

    sessions.set(ctx.from.id, {
      type: 'series',
      group,
      selectedSeason: null
    });

    const keyboard = Markup.inlineKeyboard(
      seasons.map(season => [
        Markup.button.callback(
          'Season ' + season,
          'season:' + season
        )
      ])
    );

    return sendPosterMenu(
      ctx,
      group.title,
      'series',
      keyboard,
      '📺 Musalsalka: ' + group.title +
      '\n\nDooro xilliga (Season):'
    );
  }

  // MULTIPART MOVIE: Poster -> Parts.
  if (group.kind === 'parts') {
    sessions.set(ctx.from.id, {
      type: 'parts',
      group
    });

    const keyboard = Markup.inlineKeyboard(
      group.parts.map(record => [
        Markup.button.callback(
          'Part ' + getMovieInfo(record).part,
          'part:' + record.id
        )
      ])
    );

    return sendPosterMenu(
      ctx,
      group.title,
      'movie',
      keyboard,
      '🎬 ' + group.title +
      '\n\nDooro qaybta (Part):'
    );
  }

  // SINGLE MOVIE: Poster -> Watch button.
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
        '🎬 Daawo Filimka',
        'movie:' + record.id
      )
    ]
  ]);

  return sendPosterMenu(
    ctx,
    group.title,
    'movie',
    keyboard,
    '🎬 ' + group.title +
    '\n\nTaabo badhanka hoose si aad u daawato filimka.'
  );
}


// =====================================================
// 11. TEXT SEARCH
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
      '❌ Filimkan lama helin.\n\nIsku day magac kale.'
    );
  }

  if (
    results.length === 1 ||
    (
      results[0].score >= 0.93 &&
      (
        !results[1] ||
        results[0].score - results[1].score >= 0.12
      )
    )
  ) {
    return openGroup(
      ctx,
      results[0],
      parsed
    );
  }

  sessions.set(ctx.from.id, {
    type: 'titles',
    groups: results,
    requested: parsed
  });

  return ctx.reply(
    '🎬 Filimadan ayaa ugu dhow magaca aad qortay. Mid dooro:',

    Markup.inlineKeyboard(
      results.map((group, index) => [
        Markup.button.callback(
          group.title,
          'title:' + index
        )
      ])
    )
  );
});


// =====================================================
// 12. TITLE BUTTON
// =====================================================

bot.action(/^title:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const session = sessions.get(ctx.from.id);

  if (!session || session.type !== 'titles') {
    return ctx.reply(
      'Fadlan mar kale raadi filimka.'
    );
  }

  const group = session.groups[Number(ctx.match[1])];

  if (!group) {
    return ctx.reply('Filimka lama helin.');
  }

  return openGroup(
    ctx,
    group,
    session.requested || {}
  );
});


// =====================================================
// 13. SINGLE MOVIE BUTTON
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
    // Recover the movie if the user's session was reset.
    record = movies.find(movie =>
      Number(movie.id) === movieId
    );

    if (record) {
      title = getMovieInfo(record).title;
    }
  }

  if (!record) {
    return ctx.reply(
      'Filimkan hadda lama helin. Fadlan mar kale raadi.'
    );
  }

  return sendVideo(ctx, record, title);
});


// =====================================================
// 14. SEASON BUTTON
// =====================================================

bot.action(/^season:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const session = sessions.get(ctx.from.id);

  if (!session || session.type !== 'series') {
    return ctx.reply(
      'Fadlan mar kale raadi musalsalka.'
    );
  }

  const season = Number(ctx.match[1]);

  const episodes = session.group.episodes.filter(
    record =>
      Number(getMovieInfo(record).season) === season
  );

  if (!episodes.length) {
    return ctx.reply(
      'Season-kan xogtiisa lama helin.'
    );
  }

  session.selectedSeason = season;

  const keyboard = Markup.inlineKeyboard(
    episodes.map(record => [
      Markup.button.callback(
        'EP ' + getMovieInfo(record).episode,
        'episode:' + record.id
      )
    ])
  );

  return sendPosterMenu(
    ctx,
    session.group.title,
    'series',
    keyboard,
    '📺 ' + session.group.title +
    '\nSeason ' + season +
    '\n\nDooro Episode:'
  );
});


// =====================================================
// 15. EPISODE BUTTON
// =====================================================

bot.action(/^episode:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const session = sessions.get(ctx.from.id);

  if (!session || session.type !== 'series') {
    return ctx.reply(
      'Fadlan mar kale raadi musalsalka.'
    );
  }

  const record = session.group.episodes.find(item =>
    Number(item.id) === Number(ctx.match[1]) &&
    Number(getMovieInfo(item).season) ===
      Number(session.selectedSeason)
  );

  if (!record) {
    return ctx.reply(
      'Episode-kan lama helin.'
    );
  }

  return sendVideo(
    ctx,
    record,
    session.group.title
  );
});


// =====================================================
// 16. PART BUTTON
// =====================================================

bot.action(/^part:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const session = sessions.get(ctx.from.id);

  if (!session || session.type !== 'parts') {
    return ctx.reply(
      'Fadlan mar kale raadi filimka.'
    );
  }

  const record = session.group.parts.find(item =>
    Number(item.id) === Number(ctx.match[1])
  );

  if (!record) {
    return ctx.reply(
      'Qaybtan lama helin.'
    );
  }

  return sendVideo(
    ctx,
    record,
    session.group.title
  );
});


// =====================================================
// 17. ADMIN BROADCAST
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

      console.log(
        'BROADCAST ERROR:',
        user.id,
        error.message
      );
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
    return broadcastMessage(
      ctx,
      replied.message_id
    );
  }

  if (!message) {
    return ctx.reply(
      'Qor: /broadcast Fariintaada\n' +
      'Ama reply saar sawir/video/cod kadib qor /broadcast.'
    );
  }

  let sent = 0;
  let failed = 0;

  await ctx.reply(
    '⏳ Broadcast qoraal ayaa bilaabanaya.'
  );

  for (const user of users) {
    try {
      await ctx.telegram.sendMessage(
        user.id,
        message
      );

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
        Markup.button.callback(
          '✅ Haa, dir',
          'broadcast_yes'
        )
      ],
      [
        Markup.button.callback(
          '❌ Jooji',
          'broadcast_no'
        )
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

  if (!pending) {
    return ctx.reply('Fariinta lama helin.');
  }

  pendingBroadcasts.delete(ADMIN_ID);

  return broadcastMessage(
    ctx,
    pending.messageId
  );
});

bot.action('broadcast_no', async ctx => {
  await ctx.answerCbQuery();

  if (Number(ctx.from.id) !== ADMIN_ID) return;

  pendingBroadcasts.delete(ADMIN_ID);

  return ctx.reply('❌ Waa la joojiyay.');
});


// =====================================================
// 18. ADMIN STATS
// =====================================================

bot.command('stats', async ctx => {
  if (Number(ctx.from.id) !== ADMIN_ID) {
    return ctx.reply('❌ Admin keliya.');
  }

  const groups = buildGroups();

  return ctx.reply(
    '📊 AMERICAN SOMALI FILMS\n\n' +

    '👥 Users: ' + users.length + '\n' +

    '🎬 Video records: ' + movies.length + '\n' +

    '📚 Film / Series groups: ' + groups.length + '\n' +

    '📺 Series: ' +
    groups.filter(g => g.kind === 'series').length + '\n' +

    '🎞️ Films with parts: ' +
    groups.filter(g => g.kind === 'parts').length + '\n' +

    '🎬 Single movies: ' +
    groups.filter(g => g.kind === 'movie').length + '\n' +

    '🖼️ TMDB: ' +
    (TMDB_API_KEY ? 'API key detected' : 'API key missing')
  );
});


// =====================================================
// 19. ERROR HANDLING / STARTUP
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
  .then(() => {
    console.log(
      'American Somali Films Bot is running!'
    );

    console.log(
      'Listening to both movie channels.'
    );

    console.log(
      'TMDB poster search:',
      TMDB_API_KEY ? 'Enabled' : 'Missing API key'
    );

    console.log(
      'Single movies: poster -> watch button -> video.'
    );

    console.log(
      'Series: poster -> seasons -> poster -> episodes.'
    );

    console.log(
      'Multipart movies: poster -> parts.'
    );

    console.log(
      'Existing movies.json and users.json preserved.'
    );
  })
  .catch(error => {
    console.error(
      'BOT LAUNCH ERROR:',
      error
    );

    process.exit(1);
  });

process.once('SIGINT', () => {
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
});
