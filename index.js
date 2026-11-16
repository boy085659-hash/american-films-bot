
const { Telegraf, Markup } = require("telegraf");
const fs = require("fs");
const path = require("path");

// =====================================================
// 1. SETTINGS
// =====================================================

const BOT_TOKEN =
  process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;

const ADMIN_ID = 7199419196;

const CHANNELS = [
  { username: "@VEXORAMOVIES", link: "https://t.me/VEXORAMOVIES" },
  { username: "@somalifilm0", link: "https://t.me/somalifilm0" }
];

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN or TELEGRAM_BOT_TOKEN is missing");
}

const bot = new Telegraf(BOT_TOKEN);

const MOVIES_DB = path.join(__dirname, "movies.json");
const USERS_DB = path.join(__dirname, "users.json");

// =====================================================
// 2. DATABASE
// =====================================================

function loadArray(file, property) {
  if (!fs.existsSync(file)) return [];

  const data = JSON.parse(fs.readFileSync(file, "utf8"));

  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data[property])) return data[property];

  throw new Error(
    "Database format is not recognized: " + path.basename(file)
  );
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

let nextMovieId =
  movies.reduce((max, movie) => Math.max(max, Number(movie.id) || 0), 0) + 1;

const sessions = new Map();
const pendingBroadcasts = new Map();

function saveMovies() {
  safeSave(MOVIES_DB, movies);
}

function saveUsers() {
  safeSave(USERS_DB, users);
}

saveUsers();

// =====================================================
// 3. TEXT NORMALIZATION
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

// Remove Part / Season / Episode information from title key.
// This helps captions with slightly different formatting
// belong to the same movie group.
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

  let match = raw.match(
    /\b(?:season|s)\s*0*(\d+)\s*(?:episode|ep|e)\s*0*(\d+)\b/i
  );

  if (!match) {
    match = raw.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  }

  if (match) {
    season = Number(match[1]);
    episode = Number(match[2]);
  }

  const partRegex =
    /\b(?:part|pt|qeyb(?:ta|teda|teeda)?|qayb(?:ta|teda|teeda)?|cd|disc|disk)\s*[:#-]?\s*0*(\d+)\s*(?:aad|naad)?\b/i;

  const partMatch = raw.match(partRegex);

  if (partMatch) {
    part = Number(partMatch[1]);
  }

  // Look for the first line that appears to contain a title.
  let title = "";

  for (const line of lines) {
    const cleaned = line
      .replace(partRegex, " ")
      .replace(/\b(?:season|episode|ep|s)\s*0*\d+\b/gi, " ")
      .replace(/\b\d{1,2}x\d{1,3}\b/gi, " ")
      .replace(/#[\w]+/g, " ")
      .replace(/\.(mp4|mkv|avi|mov|webm)$/i, " ")
      .replace(/\b(?:filim|film|movie|cusub|new|official|astaan)\b/gi, " ")
      .replace(/\b(?:480p|720p|1080p|1440p|2160p|4k|8k|hd|full\s*hd|uhd|hdr|web-dl|bluray|brrip|webrip)\b/gi, " ")
      .replace(/\b(?:19|20)\d{2}\b/g, " ")
      .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}]/gu, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (cleaned && !/^(part|pt|episode|ep|season|s)\s*\d*$/i.test(cleaned)) {
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
    type: season !== null ? "series" : part !== null ? "part" : "movie"
  };
}

// =====================================================
// 5. READ OLD RECORDS
// =====================================================

function getMovieInfo(movie) {
  const parsed = parseCaption(movie.caption || movie.title || "");

  const oldSeason = movie.season != null ? Number(movie.season) : null;
  const oldEpisode = movie.episode != null ? Number(movie.episode) : null;
  const oldPart = movie.part != null ? Number(movie.part) : null;

  const season = parsed.season ?? oldSeason;
  const episode = parsed.episode ?? oldEpisode;
  const part = parsed.part ?? oldPart;

  const title = parsed.title || movie.title || "";

  return {
    title,
    key: canonicalTitle(title),
    season,
    episode,
    part,
    type: season !== null
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
    const existing = users.find(user => user.id === userId);

    if (!existing) {
      users.push({
        id: userId,
        firstSeen: new Date().toISOString()
      });

      saveUsers();
      console.log("New user:", userId);
    }
  }

  return next();
});

// =====================================================
// 7. RECEIVE VIDEOS FROM BOTH CHANNELS
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

  if (!hasVideo) return;

  const caption = (post.caption || "").trim();

  if (!caption) {
    console.log("Video without caption:", post.message_id);
    return;
  }

  const parsed = parseCaption(caption);

  if (!parsed.key) {
    console.log("Video title not detected:", caption);
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
    caption,
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
    "Movie saved:",
    parsed.title,
    parsed.part ? "Part " + parsed.part : "",
    channelUsername
  );
});

// =====================================================
// 8. SUBSCRIPTION CHECK
// =====================================================

async function isJoined(userId) {
  for (const channel of CHANNELS) {
    try {
      const member = await bot.telegram.getChatMember(channel.username, userId);

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

// =====================================================
// 9. START
// =====================================================

bot.start(async ctx => {
  if (!(await isJoined(ctx.from.id))) return showJoin(ctx);

  return ctx.reply(
    "🎬 Ku soo dhowow American Films!\n\nQor magaca filimka aad rabto."
  );
});

bot.action("check_join", async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) return showJoin(ctx);

  return ctx.reply("✅ Waa lagu xaqiijiyay!\n\nHadda qor magaca filimka.");
});

// =====================================================
// 10. FUZZY SEARCH
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

  const allMatch = matched.every(value => value >= 0.72);

  if (allMatch) return Math.min(0.92, average);

  return average * 0.85;
}

// =====================================================
// 11. DUPLICATE FILTERING
// One Part number = one video.
// One Season + Episode = one video.
// Old database records are not deleted.
// =====================================================

function newestRecord(a, b) {
  const dateA = new Date(a.savedAt || 0).getTime() || 0;
  const dateB = new Date(b.savedAt || 0).getTime() || 0;

  if (dateA !== dateB) {
    return dateA > dateB ? a : b;
  }

  return Number(a.id) >= Number(b.id) ? a : b;
}

function uniqueEpisodes(records) {
  const unique = new Map();

  for (const movie of records) {
    const info = getMovieInfo(movie);

    const season = Number(info.season);
    const episode = Number(info.episode);

    if (!Number.isFinite(season) || !Number.isFinite(episode)) continue;

    const key = `${season}:${episode}`;
    const previous = unique.get(key);

    unique.set(key, previous ? newestRecord(previous, movie) : movie);
  }

  return [...unique.values()]
    .sort((a, b) =>
      Number(getMovieInfo(a).season) - Number(getMovieInfo(b).season) ||
      Number(getMovieInfo(a).episode) - Number(getMovieInfo(b).episode)
    );
}

function uniqueParts(records) {
  const unique = new Map();

  for (const movie of records) {
    const info = getMovieInfo(movie);
    const part = Number(info.part);

    if (!Number.isFinite(part) || part <= 0) continue;

    const previous = unique.get(part);

    // Keep only one best/newest video for each Part number.
    unique.set(part, previous ? newestRecord(previous, movie) : movie);
  }

  return [...unique.values()].sort((a, b) =>
    Number(getMovieInfo(a).part) - Number(getMovieInfo(b).part)
  );
}

// =====================================================
// 12. FIND MOVIES
// Both channels are grouped using the same cleaned title.
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
      uniqueParts(group.records).some(
        movie => Number(getMovieInfo(movie).part) === parsedQuery.part
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

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

// =====================================================
// 13. SEND ONE VIDEO
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
// 14. OPEN MOVIE / SERIES / PARTS
// =====================================================

async function openMovie(ctx, group, requested = {}) {
  const records = group.records;

  // If user searched for a specific Part, send only that Part.
  if (requested.part !== null && requested.part !== undefined) {
    const selected = uniqueParts(records).find(
      movie => Number(getMovieInfo(movie).part) === Number(requested.part)
    );

    if (selected) return sendVideo(ctx, selected);
  }

  // If user searched for a specific Episode, send only that Episode.
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

  const episodes = uniqueEpisodes(records.filter(movie => {
    const info = getMovieInfo(movie);

    return info.season !== null && info.episode !== null;
  }));

  if (episodes.length) {
    const seasons = [
      ...new Set(episodes.map(movie => Number(getMovieInfo(movie).season)))
    ].sort((a, b) => a - b);

    sessions.set(ctx.from.id, {
      type: "series",
      group,
      episodes
    });

    return ctx.reply(
      "📺 " + group.title + "\n\nDooro Season:",
      Markup.inlineKeyboard(
        seasons.map(season => [
          Markup.button.callback("Season " + season, "season:" + season)
        ])
      )
    );
  }

  // Deduplicate parts before creating buttons.
  const parts = uniqueParts(records);

  if (parts.length) {
    sessions.set(ctx.from.id, {
      type: "parts",
      records: parts
    });

    return ctx.reply(
      "🎬 " + group.title + "\n\nDooro qaybta:",
      Markup.inlineKeyboard(
        parts.map(movie => [
          Markup.button.callback(
            "Qeybta " + getMovieInfo(movie).part,
            "part:" + movie.id
          )
        ])
      )
    );
  }

  return sendVideo(ctx, records[records.length - 1]);
}

// =====================================================
// 15. ADMIN BROADCAST
// =====================================================

async function broadcastMessage(ctx, messageId) {
  let sent = 0;
  let failed = 0;
  const total = users.length;

  await ctx.reply("⏳ Broadcast ayaa bilaabanaya.\nUsers: " + total);

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
    "👥 Users: " + total + "\n" +
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
      "Voice, sawir ama video: reply saar fariinta kadib qor /broadcast."
    );
  }

  let sent = 0;
  let failed = 0;

  await ctx.reply(
    "⏳ Broadcast qoraal ayaa bilaabanaya.\nUsers: " + users.length
  );

  for (const user of users) {
    try {
      await ctx.telegram.sendMessage(user.id, message);
      sent++;

      await new Promise(resolve => setTimeout(resolve, 40));
    } catch (error) {
      failed++;
      console.log("TEXT BROADCAST ERROR:", user.id, error.message);
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
// 16. VOICE / AUDIO / VIDEO NOTE BROADCAST
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

  if (!pending) {
    return ctx.reply("⚠️ Codka lama helin. Mar kale soo dir.");
  }

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
      console.log("VOICE ERROR:", user.id, error.message);
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
// 17. ADMIN STATISTICS
// =====================================================

bot.command("stats", async ctx => {
  if (Number(ctx.from.id) !== ADMIN_ID) {
    return ctx.reply("❌ Admin keliya.");
  }

  const now = new Date();

  const startLastMonth = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() - 1,
    1
  ));

  const startThisMonth = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    1
  ));

  const inLastMonth = value => {
    if (!value) return false;

    const date = new Date(value);

    return (
      !Number.isNaN(date.getTime()) &&
      date >= startLastMonth &&
      date < startThisMonth
    );
  };

  const lastMonthUsers =
    users.filter(user => inLastMonth(user.firstSeen)).length;

  const lastMonthMovies =
    movies.filter(movie => inLastMonth(movie.savedAt || movie.createdAt)).length;

  const monthName = startLastMonth.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  });

  const oldUsersWithoutDate =
    users.filter(user => !user.firstSeen).length;

  const channelOneMovies =
    movies.filter(movie => movie.sourceChannel === "@vexoramovies").length;

  const channelTwoMovies =
    movies.filter(movie => movie.sourceChannel === "@somalifilm0").length;

  return ctx.reply(
    "📊 AMERICAN FILMS STATISTICS\n\n" +
    "👥 ALL TIME USERS: " + users.length + "\n" +
    "📅 LAST MONTH USERS (" + monthName + "): " + lastMonthUsers + "\n" +
    "❓ Old users without date: " + oldUsersWithoutDate + "\n\n" +
    "🎬 ALL TIME MOVIES: " + movies.length + "\n" +
    "📅 LAST MONTH MOVIES: " + lastMonthMovies + "\n\n" +
    "📢 VEXORA MOVIES: " + channelOneMovies + "\n" +
    "📢 SOMALI FILM: " + channelTwoMovies
  );
});

// =====================================================
// 18. SEARCH HANDLER
// =====================================================

bot.on("text", async ctx => {
  const query = ctx.message.text.trim();

  if (!query || query.startsWith("/")) return;

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const parsedQuery = parseCaption(query);
  const results = findMovies(query);

  if (!results.length) {
    return ctx.reply(
      "❌ Filimkan lama helin.\n\nIsku day magac kale."
    );
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
// 19. SELECT TITLE
// =====================================================

bot.action(/^title:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const session = sessions.get(ctx.from.id);

  if (!session || session.type !== "titles") {
    return ctx.reply("Fadlan mar kale raadi filimka.");
  }

  const group = session.groups[Number(ctx.match[1])];

  if (!group) {
    return ctx.reply("Filimka lama helin.");
  }

  return openMovie(ctx, group, session.requested || {});
});

// =====================================================
// 20. SELECT SEASON
// =====================================================

bot.action(/^season:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const session = sessions.get(ctx.from.id);

  if (!session || session.type !== "series") {
    return ctx.reply("Fadlan mar kale raadi series-ka.");
  }

  const season = Number(ctx.match[1]);

  const episodes = uniqueEpisodes(session.episodes)
    .filter(movie => Number(getMovieInfo(movie).season) === season);

  if (!episodes.length) {
    return ctx.reply("Season-kan lama helin.");
  }

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
// 21. SELECT EPISODE
// Sends ONE video only.
// =====================================================

bot.action(/^episode:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const session = sessions.get(ctx.from.id);

  if (!session || session.type !== "series") {
    return ctx.reply("Fadlan mar kale raadi series-ka.");
  }

  const movie = (session.selectedEpisodes || []).find(
    item => Number(item.id) === Number(ctx.match[1])
  );

  if (!movie) {
    return ctx.reply("Episode-kan lama helin.");
  }

  return sendVideo(ctx, movie);
});

// =====================================================
// 22. SELECT PART
// Sends ONE video only.
// =====================================================

bot.action(/^part:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const session = sessions.get(ctx.from.id);

  if (!session || session.type !== "parts") {
    return ctx.reply("Fadlan mar kale raadi filimka.");
  }

  const movie = session.records.find(
    item => Number(item.id) === Number(ctx.match[1])
  );

  if (!movie) {
    return ctx.reply("Qaybtan lama helin.");
  }

  return sendVideo(ctx, movie);
});

// =====================================================
// 23. ERROR HANDLING
// =====================================================

bot.catch(error => {
  console.error("BOT ERROR:", error);
});

// =====================================================
// 24. START BOT
// =====================================================

bot.launch({
  allowedUpdates: ["message", "callback_query", "channel_post"]
});

console.log("🎬 American Films Bot is running!");
console.log("📢 Listening to both movie channels.");
console.log("🔎 Smart Movie Search enabled.");
console.log("🎞️ Duplicate Part filtering enabled.");
console.log("🎙️ Voice Broadcast enabled.");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
