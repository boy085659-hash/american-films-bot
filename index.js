
const { Telegraf, Markup } = require("telegraf");
const fs = require("fs");
const path = require("path");

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
  { username: "@VEXORAMOVIES", link: "https://t.me/VEXORAMOVIES" },
  { username: "@somalifilm0", link: "https://t.me/somalifilm0" }
];

if (!BOT_TOKEN) {
  throw new Error("BOT TOKEN IS MISSING.");
}

const bot = new Telegraf(BOT_TOKEN);

const MOVIES_DB = path.join(__dirname, "movies.json");
const USERS_DB = path.join(__dirname, "users.json");

const sessions = new Map();
const pendingBroadcasts = new Map();

// =====================================================
// 2. DATABASE - PRESERVE OLD DATA
// =====================================================

function loadArray(file, property) {
  if (!fs.existsSync(file)) return [];

  const data = JSON.parse(fs.readFileSync(file, "utf8"));

  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data[property])) return data[property];

  throw new Error("Database format error: " + path.basename(file));
}

function safeSave(file, data) {
  const temp = file + ".tmp";
  const backup = file + ".bak";

  if (fs.existsSync(file)) {
    fs.copyFileSync(file, backup);
  }

  fs.writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(temp, file);
}

let movies = loadArray(MOVIES_DB, "movies");
let users = loadArray(USERS_DB, "users");

users = users.map(user => {
  if (typeof user === "number" || typeof user === "string") {
    return { id: Number(user), firstSeen: null };
  }

  return {
    ...user,
    id: Number(user.id),
    firstSeen: user.firstSeen || null
  };
}).filter(user => Number.isFinite(user.id));

let nextMovieId = movies.reduce(
  (max, movie) => Math.max(max, Number(movie.id) || 0),
  0
) + 1;

function saveMovies() {
  safeSave(MOVIES_DB, movies);
}

function saveUsers() {
  safeSave(USERS_DB, users);
}

saveUsers();

// =====================================================
// 3. NORMALIZATION
// =====================================================

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function canonicalTitle(value) {
  return normalize(
    String(value || "")
      .replace(/\b(?:part|pt|qeyb(?:ta|teda|teeda)?|qayb(?:ta|teda|teeda)?|cd|disc|disk)\s*[:#-]?\s*\d+\b/gi, " ")
      .replace(/\b(?:season|episode|ep|s)\s*0*\d+\b/gi, " ")
      .replace(/\b\d{1,2}x\d{1,3}\b/gi, " ")
  );
}

// =====================================================
// 4. CAPTION PARSER
// =====================================================

function parseCaption(caption) {
  const raw = String(caption || "").trim();
  const lines = raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean);

  let season = null;
  let episode = null;
  let part = null;

  let match = raw.match(/\bS\s*0*(\d+)\s*(?:E|EP)\s*0*(\d+)\b/i);

  if (!match) {
    match = raw.match(
      /\bSeason\s*0*(\d+)\s*(?:Episode|Ep)\s*0*(\d+)\b/i
    );
  }

  if (!match) {
    match = raw.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  }

  if (match) {
    season = Number(match[1]);
    episode = Number(match[2]);
  } else {
    const epMatch = raw.match(/\b(?:E|EP|Episode)\s*0*(\d+)\b/i);
    const seasonMatch = raw.match(/\bSeason\s*0*(\d+)\b/i);

    if (epMatch) episode = Number(epMatch[1]);
    if (seasonMatch) season = Number(seasonMatch[1]);

    // Episode without a season is treated as Season 1.
    if (episode !== null && season === null) season = 1;
  }

  const partRegex =
    /\b(?:part|pt|qeyb(?:ta|teda|teeda)?|qayb(?:ta|teda|teeda)?|cd|disc|disk)\s*[:#-]?\s*0*(\d+)\s*(?:aad|naad)?\b/i;

  const partMatch = raw.match(partRegex);
  if (partMatch) part = Number(partMatch[1]);

  let title = "";

  for (const line of lines) {
    let cleaned = line;

    cleaned = cleaned.replace(
      /\bS\s*0*\d+\s*(?:E|EP)\s*0*\d+\b.*$/i, " "
    );

    cleaned = cleaned.replace(
      /\bSeason\s*0*\d+\s*(?:Episode|Ep)\s*0*\d+\b.*$/i, " "
    );

    cleaned = cleaned.replace(
      /\b(?:E|EP|Episode)\s*0*\d+\b.*$/i, " "
    );

    cleaned = cleaned.replace(/\b\d{1,2}x\d{1,3}\b.*$/i, " ");
    cleaned = cleaned.replace(/\bSeason\s*0*\d+\b/gi, " ");
    cleaned = cleaned.replace(partRegex, " ");

    cleaned = cleaned
      .replace(/#[\w]+/g, " ")
      .replace(/\.(mp4|mkv|avi|mov|webm)$/i, " ")
      .replace(/\b(?:filim|film|movie|cusub|new|official)\b/gi, " ")
      .replace(/\b(?:480p|720p|1080p|1440p|2160p|4k|8k|hd|full\s*hd|uhd|hdr|web-dl|bluray|brrip|webrip)\b/gi, " ")
      .replace(/\b(?:19|20)\d{2}\b/g, " ")
      .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}]/gu, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (
      cleaned &&
      !/^(part|pt|episode|ep|season|s|e)\s*\d*$/i.test(cleaned)
    ) {
      title = cleaned;
      break;
    }
  }

  return {
    title,
    key: canonicalTitle(title),
    season,
    episode,
    part,
    type: season !== null || episode !== null
      ? "series"
      : part !== null
        ? "part"
        : "movie"
  };
}

// =====================================================
// 5. READ OLD MOVIE RECORDS
// =====================================================

function getMovieInfo(movie) {
  const parsed = parseCaption(movie.caption || movie.title || "");

  const season = parsed.season ??
    (movie.season != null ? Number(movie.season) : null);

  const episode = parsed.episode ??
    (movie.episode != null ? Number(movie.episode) : null);

  const part = parsed.part ??
    (movie.part != null ? Number(movie.part) : null);

  const title = parsed.title || movie.title || "";

  return {
    title,
    key: canonicalTitle(title),
    season,
    episode,
    part,
    type: season !== null || episode !== null
      ? "series"
      : part !== null
        ? "part"
        : movie.type === "series"
          ? "series"
          : "movie"
  };
}

// =====================================================
// 6. REGISTER USERS
// =====================================================

bot.use(async (ctx, next) => {
  if (ctx.chat?.type === "private" && ctx.from) {
    const userId = Number(ctx.from.id);

    if (!users.some(user => user.id === userId)) {
      users.push({
        id: userId,
        firstSeen: new Date().toISOString()
      });

      saveUsers();
    }
  }

  return next();
});

// =====================================================
// 7. RECEIVE VIDEOS FROM CHANNELS
// =====================================================

bot.on("channel_post", ctx => {
  const post = ctx.channelPost;

  const channelUsername = ctx.chat.username
    ? "@" + ctx.chat.username.toLowerCase()
    : "";

  const allowed = CHANNELS.some(
    channel => channel.username.toLowerCase() === channelUsername
  );

  if (!allowed) return;

  const hasVideo =
    Boolean(post.video) ||
    Boolean(
      post.document &&
      (
        post.document.mime_type?.startsWith("video/") ||
        /\.(mp4|mkv|avi|mov|webm)$/i.test(post.document.file_name || "")
      )
    );

  if (!hasVideo || !post.caption) return;

  const parsed = parseCaption(post.caption);

  if (!parsed.key) {
    console.log("Title not detected:", post.caption);
    return;
  }

  let movie = movies.find(item =>
    String(item.chatId) === String(ctx.chat.id) &&
    Number(item.messageId) === Number(post.message_id)
  );

  if (!movie) {
    movie = {
      id: nextMovieId++,
      chatId: ctx.chat.id,
      messageId: post.message_id
    };
    movies.push(movie);
  }

  Object.assign(movie, {
    caption: post.caption,
    title: parsed.title,
    key: parsed.key,
    season: parsed.season,
    episode: parsed.episode,
    part: parsed.part,
    type: parsed.type,
    sourceChannel: channelUsername,
    savedAt: new Date().toISOString()
  });

  saveMovies();

  console.log(
    "Saved:",
    parsed.title,
    parsed.season ? "Season " + parsed.season : "",
    parsed.episode ? "Episode " + parsed.episode : "",
    parsed.part ? "Part " + parsed.part : ""
  );
});

// =====================================================
// 8. SUBSCRIPTION CHECK
// =====================================================

async function isJoined(userId) {
  for (const channel of CHANNELS) {
    try {
      const member = await bot.telegram.getChatMember(
        channel.username,
        userId
      );

      const joined =
        ["creator", "administrator", "member"].includes(member.status) ||
        (member.status === "restricted" && member.is_member);

      if (!joined) return false;
    } catch (error) {
      console.error("JOIN CHECK:", channel.username, error.message);
      return false;
    }
  }

  return true;
}

async function showJoin(ctx) {
  return ctx.reply(
    "🎬 Si aad u isticmaasho bot-ka, fadlan join garee labada channel:\n\n" +
    "1️⃣ " + CHANNELS[0].link + "\n" +
    "2️⃣ " + CHANNELS[1].link,
    Markup.inlineKeyboard([
      [Markup.button.url("📢 Somali Film", CHANNELS[1].link)],
      [Markup.button.url("🎬 VEXORA MOVIES", CHANNELS[0].link)],
      [Markup.button.callback("✅ Waan join gareeyay", "check_join")]
    ])
  );
}

bot.start(async ctx => {
  if (!(await isJoined(ctx.from.id))) return showJoin(ctx);

  return ctx.reply(
    "🎬 Ku soo dhowow American Somali Films!\n\n" +
    "Qor magaca filimka ama musalsalka aad rabto."
  );
});

bot.action("check_join", async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) return showJoin(ctx);

  return ctx.reply("✅ Waa lagu xaqiijiyay!\n\nHadda qor magaca filimka.");
});

// =====================================================
// 9. FUZZY SEARCH
// =====================================================

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const old = row[j];

      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1)
      );

      previous = old;
    }
  }

  return row[b.length];
}

function wordSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - distance(a, b) / Math.max(a.length, b.length);
}

function similarity(query, title) {
  if (!query || !title) return 0;
  if (query === title) return 1;
  if (title.includes(query)) return 0.97;
  if (query.includes(title)) return 0.94;

  const queryWords = query.split(" ");
  const titleWords = title.split(" ");

  const matched = queryWords.map(word => {
    let best = 0;
    for (const other of titleWords) {
      best = Math.max(best, wordSimilarity(word, other));
    }
    return best;
  });

  const average =
    matched.reduce((sum, value) => sum + value, 0) / matched.length;

  if (matched.every(value => value >= 0.72)) {
    return Math.min(0.92, average);
  }

  return average * 0.85;
}

function newestRecord(a, b) {
  const dateA = new Date(a.savedAt || 0).getTime() || 0;
  const dateB = new Date(b.savedAt || 0).getTime() || 0;

  if (dateA !== dateB) return dateA > dateB ? a : b;

  return Number(a.id) >= Number(b.id) ? a : b;
}

// =====================================================
// 10. REMOVE DUPLICATE EPISODES AND PARTS
// =====================================================

function uniqueEpisodes(records) {
  const unique = new Map();

  for (const movie of records) {
    const info = getMovieInfo(movie);
    const season = Number(info.season);
    const episode = Number(info.episode);

    if (
      !Number.isFinite(season) ||
      !Number.isFinite(episode) ||
      season <= 0 ||
      episode <= 0
    ) continue;

    const key = `${season}:${episode}`;
    const previous = unique.get(key);

    unique.set(key, previous ? newestRecord(previous, movie) : movie);
  }

  return [...unique.values()].sort((a, b) => {
    const A = getMovieInfo(a);
    const B = getMovieInfo(b);

    return (
      Number(A.season) - Number(B.season) ||
      Number(A.episode) - Number(B.episode)
    );
  });
}

function uniqueParts(records) {
  const unique = new Map();

  for (const movie of records) {
    const part = Number(getMovieInfo(movie).part);

    if (!Number.isFinite(part) || part <= 0) continue;

    const previous = unique.get(part);
    unique.set(part, previous ? newestRecord(previous, movie) : movie);
  }

  return [...unique.values()].sort((a, b) =>
    Number(getMovieInfo(a).part) - Number(getMovieInfo(b).part)
  );
}

// =====================================================
// 11. GROUP MOVIES
// =====================================================

function findMovies(query) {
  const parsedQuery = parseCaption(query);
  const q = parsedQuery.key || canonicalTitle(query);

  const groups = new Map();

  for (const movie of movies) {
    if (!movie.chatId || !movie.messageId) continue;

    const info = getMovieInfo(movie);
    if (!info.key) continue;

    if (!groups.has(info.key)) {
      groups.set(info.key, {
        title: info.title,
        key: info.key,
        records: []
      });
    }

    groups.get(info.key).records.push({
      ...movie,
      ...info
    });
  }

  let results = [...groups.values()]
    .map(group => ({
      ...group,
      score: similarity(q, group.key)
    }))
    .filter(group =>
      group.score >= (q.split(" ").length === 1 ? 0.72 : 0.68)
    );

  if (parsedQuery.part !== null) {
    const matching = results.filter(group =>
      uniqueParts(group.records).some(movie =>
        Number(getMovieInfo(movie).part) === parsedQuery.part
      )
    );
    if (matching.length) results = matching;
  }

  if (parsedQuery.episode !== null) {
    const matching = results.filter(group =>
      group.records.some(movie => {
        const info = getMovieInfo(movie);
        return (
          Number(info.episode) === parsedQuery.episode &&
          (
            parsedQuery.season === null ||
            Number(info.season) === parsedQuery.season
          )
        );
      })
    );
    if (matching.length) results = matching;
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 8);
}

// =====================================================
// 12. TMDB POSTER SEARCH
// =====================================================

async function getPoster(title, type) {
  if (!TMDB_API_KEY) {
    console.log("TMDB_API_KEY is missing.");
    return null;
  }

  try {
    const category = type === "series" ? "tv" : "movie";
    const url =
      `https://api.themoviedb.org/3/search/${category}` +
      `?api_key=${encodeURIComponent(TMDB_API_KEY)}` +
      `&query=${encodeURIComponent(title)}` +
      "&include_adult=false";

    const response = await fetch(url);

    if (!response.ok) {
      console.error("TMDB ERROR:", response.status);
      return null;
    }

    const data = await response.json();
    const result = data.results?.find(item => item.poster_path);

    if (!result) return null;

    return "https://image.tmdb.org/t/p/w500" + result.poster_path;
  } catch (error) {
    console.error("TMDB SEARCH ERROR:", error.message);
    return null;
  }
}

// =====================================================
// 13. SEND VIDEO
// =====================================================

async function sendVideo(ctx, movie) {
  try {
    await ctx.sendChatAction("upload_video");

    await ctx.telegram.copyMessage(
      ctx.chat.id,
      movie.chatId,
      movie.messageId
    );
  } catch (error) {
    console.error("VIDEO ERROR:", error.message);

    await ctx.reply(
      "⚠️ Video-ga lama soo diri karin.\nFadlan mar kale isku day."
    );
  }
}

// =====================================================
// 14. SHOW POSTER AND SELECTION BUTTONS
// =====================================================

async function sendPosterMenu(ctx, title, type, keyboard, fallbackText) {
  const poster = await getPoster(title, type);

  if (poster) {
    try {
      return await ctx.replyWithPhoto(poster, {
        caption: "🎬 " + title + "\n\n" + fallbackText,
        reply_markup: keyboard.reply_markup
      });
    } catch (error) {
      console.error("POSTER SEND ERROR:", error.message);
    }
  }

  return ctx.reply(
    "🎬 " + title + "\n\n" + fallbackText,
    keyboard
  );
}

// =====================================================
// 15. OPEN MOVIE / SERIES / PARTS
// =====================================================

async function openMovie(ctx, group, requested = {}) {
  const records = group.records;

  if (requested.part !== null && requested.part !== undefined) {
    const selected = uniqueParts(records).find(movie =>
      Number(getMovieInfo(movie).part) === Number(requested.part)
    );

    if (selected) return sendVideo(ctx, selected);
  }

  if (requested.episode !== null && requested.episode !== undefined) {
    const selected = uniqueEpisodes(records).find(movie => {
      const info = getMovieInfo(movie);

      return (
        Number(info.episode) === Number(requested.episode) &&
        (
          requested.season == null ||
          Number(info.season) === Number(requested.season)
        )
      );
    });

    if (selected) return sendVideo(ctx, selected);
  }

  const episodes = uniqueEpisodes(records);

  if (episodes.length) {
    const seasons = [
      ...new Set(episodes.map(movie =>
        Number(getMovieInfo(movie).season)
      ))
    ].sort((a, b) => a - b);

    sessions.set(ctx.from.id, {
      type: "series",
      group,
      episodes
    });

    const keyboard = Markup.inlineKeyboard(
      seasons.map(season => [
        Markup.button.callback("Season " + season, "season:" + season)
      ])
    );

    return sendPosterMenu(
      ctx,
      group.title,
      "series",
      keyboard,
      "Dooro Season:"
    );
  }

  const parts = uniqueParts(records);

  if (parts.length) {
    sessions.set(ctx.from.id, {
      type: "parts",
      records: parts
    });

    const keyboard = Markup.inlineKeyboard(
      parts.map(movie => [
        Markup.button.callback(
          "Part " + getMovieInfo(movie).part,
          "part:" + movie.id
        )
      ])
    );

    return sendPosterMenu(
      ctx,
      group.title,
      "movie",
      keyboard,
      "Dooro qaybta:"
    );
  }

  // Single movie: send video directly. No poster or selection buttons.
  return sendVideo(ctx, records[records.length - 1]);
}

// =====================================================
// 16. SEARCH HANDLER
// =====================================================

bot.on("text", async ctx => {
  const query = ctx.message.text.trim();

  if (!query || query.startsWith("/")) return;

  if (!(await isJoined(ctx.from.id))) return showJoin(ctx);

  const parsedQuery = parseCaption(query);
  const results = findMovies(query);

  if (!results.length) {
    return ctx.reply("❌ Filimkan lama helin.\n\nIsku day magac kale.");
  }

  if (results.length === 1) {
    return openMovie(ctx, results[0], parsedQuery);
  }

  if (
    results[0].score >= 0.93 &&
    results[0].score - results[1].score >= 0.12
  ) {
    return openMovie(ctx, results[0], parsedQuery);
  }

  sessions.set(ctx.from.id, {
    type: "titles",
    groups: results,
    requested: parsedQuery
  });

  return ctx.reply(
    "🎬 Filimadan ayaa ugu dhow magaca aad qortay. Mid dooro:",
    Markup.inlineKeyboard(
      results.map((group, index) => [
        Markup.button.callback(group.title, "title:" + index)
      ])
    )
  );
});

// =====================================================
// 17. SELECT TITLE
// =====================================================

bot.action(/^title:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) return showJoin(ctx);

  const session = sessions.get(ctx.from.id);

  if (!session || session.type !== "titles") {
    return ctx.reply("Fadlan mar kale raadi filimka.");
  }

  const group = session.groups[Number(ctx.match[1])];

  if (!group) return ctx.reply("Filimka lama helin.");

  return openMovie(ctx, group, session.requested || {});
});

// =====================================================
// 18. SELECT SEASON
// =====================================================

bot.action(/^season:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) return showJoin(ctx);

  const session = sessions.get(ctx.from.id);

  if (!session || session.type !== "series") {
    return ctx.reply("Fadlan mar kale raadi series-ka.");
  }

  const season = Number(ctx.match[1]);

  const episodes = uniqueEpisodes(session.episodes).filter(movie =>
    Number(getMovieInfo(movie).season) === season
  );

  if (!episodes.length) return ctx.reply("Season-kan lama helin.");

  session.selectedEpisodes = episodes;

  return ctx.reply(
    "📺 Season " + season + "\n\nDooro Episode:",
    Markup.inlineKeyboard(
      episodes.map(movie => [
        Markup.button.callback(
          "EP " + getMovieInfo(movie).episode,
          "episode:" + movie.id
        )
      ])
    )
  );
});

// =====================================================
// 19. SELECT EPISODE
// =====================================================

bot.action(/^episode:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) return showJoin(ctx);

  const session = sessions.get(ctx.from.id);

  if (!session || session.type !== "series") {
    return ctx.reply("Fadlan mar kale raadi series-ka.");
  }

  const movie = (session.selectedEpisodes || []).find(item =>
    Number(item.id) === Number(ctx.match[1])
  );

  if (!movie) return ctx.reply("Episode-kan lama helin.");

  return sendVideo(ctx, movie);
});

// =====================================================
// 20. SELECT PART
// =====================================================

bot.action(/^part:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) return showJoin(ctx);

  const session = sessions.get(ctx.from.id);

  if (!session || session.type !== "parts") {
    return ctx.reply("Fadlan mar kale raadi filimka.");
  }

  const movie = session.records.find(item =>
    Number(item.id) === Number(ctx.match[1])
  );

  if (!movie) return ctx.reply("Qaybtan lama helin.");

  return sendVideo(ctx, movie);
});

// =====================================================
// 21. ADMIN BROADCAST
// =====================================================

async function broadcastMessage(ctx, messageId) {
  let sent = 0;
  let failed = 0;

  await ctx.reply("⏳ Broadcast ayaa bilaabanaya.\nUsers: " + users.length);

  for (const user of users) {
    try {
      await ctx.telegram.copyMessage(user.id, ctx.chat.id, messageId);
      sent++;
      await new Promise(resolve => setTimeout(resolve, 40));
    } catch (error) {
      failed++;
      console.log("BROADCAST ERROR:", user.id, error.message);
    }
  }

  return ctx.reply(
    "✅ Broadcast dhammaaday!\n\n" +
    "👥 Users: " + users.length + "\n" +
    "✅ La diray: " + sent + "\n" +
    "❌ Fashilmay: " + failed
  );
}

bot.command("broadcast", async ctx => {
  if (Number(ctx.from.id) !== ADMIN_ID) {
    return ctx.reply("❌ Admin keliya.");
  }

  const replied = ctx.message.reply_to_message;
  const message = ctx.message.text
    .replace(/^\/broadcast(@\w+)?\s*/i, "")
    .trim();

  if (replied) {
    return broadcastMessage(ctx, replied.message_id);
  }

  if (!message) {
    return ctx.reply(
      "📢 Qoraal:\n/broadcast Fariintaada\n\n" +
      "Sawir, Voice ama Video: reply saar fariinta kadib qor /broadcast."
    );
  }

  let sent = 0;
  let failed = 0;

  await ctx.reply("⏳ Broadcast qoraal ayaa bilaabanaya.");

  for (const user of users) {
    try {
      await ctx.telegram.sendMessage(user.id, message);
      sent++;
      await new Promise(resolve => setTimeout(resolve, 40));
    } catch (error) {
      failed++;
    }
  }

  return ctx.reply(
    "✅ Broadcast dhammaaday!\n\n" +
    "👥 Users: " + users.length + "\n" +
    "✅ La diray: " + sent + "\n" +
    "❌ Fashilmay: " + failed
  );
});

// =====================================================
// 22. VOICE / AUDIO / VIDEO NOTE BROADCAST
// =====================================================

async function prepareVoiceBroadcast(ctx) {
  if (Number(ctx.from.id) !== ADMIN_ID) return;

  pendingBroadcasts.set(ADMIN_ID, {
    chatId: ctx.chat.id,
    messageId: ctx.message.message_id
  });

  return ctx.reply(
    "🎙️ VOICE BROADCAST\n\n" +
    "Codkaaga waxaa loo diri doonaa dhammaan users-ka bot-ka.\n\n" +
    "👥 Users: " + users.length + "\n\nMa rabtaa inaad dirto?",
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Haa, dhammaan u dir", "voice_broadcast_yes")],
      [Markup.button.callback("❌ Jooji", "voice_broadcast_no")]
    ])
  );
}

bot.on("voice", prepareVoiceBroadcast);
bot.on("audio", prepareVoiceBroadcast);
bot.on("video_note", prepareVoiceBroadcast);

bot.action("voice_broadcast_yes", async ctx => {
  await ctx.answerCbQuery();

  if (Number(ctx.from.id) !== ADMIN_ID) {
    return ctx.reply("❌ Admin keliya.");
  }

  const pending = pendingBroadcasts.get(ADMIN_ID);

  if (!pending) return ctx.reply("⚠️ Codka lama helin.");

  pendingBroadcasts.delete(ADMIN_ID);

  let sent = 0;
  let failed = 0;

  await ctx.reply("⏳ Voice Broadcast ayaa bilaabanaya...");

  for (const user of users) {
    try {
      await ctx.telegram.copyMessage(
        user.id,
        pending.chatId,
        pending.messageId
      );
      sent++;
      await new Promise(resolve => setTimeout(resolve, 40));
    } catch (error) {
      failed++;
    }
  }

  return ctx.reply(
    "✅ VOICE BROADCAST DHAMMAADAY!\n\n" +
    "👥 Users: " + users.length + "\n" +
    "🎙️ La diray: " + sent + "\n" +
    "❌ Fashilmay: " + failed
  );
});

bot.action("voice_broadcast_no", async ctx => {
  await ctx.answerCbQuery();

  if (Number(ctx.from.id) !== ADMIN_ID) return;

  pendingBroadcasts.delete(ADMIN_ID);
  return ctx.reply("❌ Voice Broadcast waa la joojiyay.");
});

// =====================================================
// 23. ADMIN STATISTICS
// =====================================================

bot.command("stats", async ctx => {
  if (Number(ctx.from.id) !== ADMIN_ID) {
    return ctx.reply("❌ Admin keliya.");
  }

  const seriesCount = movies.filter(movie => {
    const info = getMovieInfo(movie);
    return info.episode !== null;
  }).length;

  const partsCount = movies.filter(movie =>
    getMovieInfo(movie).part !== null
  ).length;

  return ctx.reply(
    "📊 AMERICAN SOMALI FILMS\n\n" +
    "👥 Users: " + users.length + "\n" +
    "🎬 Videos: " + movies.length + "\n" +
    "📺 Episode records: " + seriesCount + "\n" +
    "🎞️ Part records: " + partsCount + "\n" +
    "🖼️ TMDB: " + (TMDB_API_KEY ? "Enabled" : "Missing")
  );
});

// =====================================================
// 24. ERROR HANDLING AND START
// =====================================================

bot.catch(error => {
  console.error("BOT ERROR:", error);
});

bot.launch({
  allowedUpdates: ["message", "callback_query", "channel_post"]
}).then(() => {
  console.log("American Somali Films Bot is running!");
  console.log("Listening to both movie channels.");
  console.log("TMDB poster search:", TMDB_API_KEY ? "Enabled" : "Missing API key");
  console.log("Series Season and Episode system enabled.");
  console.log("Part selection enabled.");
}).catch(error => {
  console.error("BOT LAUNCH ERROR:", error);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
