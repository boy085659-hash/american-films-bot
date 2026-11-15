
const { Telegraf, Markup } = require("telegraf");
const fs = require("fs");
const path = require("path");

// ========================================
// 1. SETTINGS
// ========================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = 7199419196;

const CHANNELS = [
  {
    username: "@VEXORAMOVIES",
    link: "https://t.me/VEXORAMOVIES"
  },
  {
    username: "@somalifilm0",
    link: "https://t.me/somalifilm0"
  }
];

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");

const bot = new Telegraf(BOT_TOKEN);

const MOVIES_DB = path.join(__dirname, "movies.json");
const USERS_DB = path.join(__dirname, "users.json");

// ========================================
// 2. SAFE DATABASE
// ========================================

function loadArray(file, property) {
  if (!fs.existsSync(file)) return [];

  const data = JSON.parse(fs.readFileSync(file, "utf8"));

  if (Array.isArray(data)) return data;

  if (data && Array.isArray(data[property])) {
    return data[property];
  }

  throw new Error(
    "Database format is not recognized: " +
    path.basename(file)
  );
}

function safeSave(file, data) {
  const temp = file + ".tmp";

  fs.writeFileSync(
    temp,
    JSON.stringify(data, null, 2),
    "utf8"
  );

  fs.renameSync(temp, file);
}

let movies = loadArray(MOVIES_DB, "movies");
let users = loadArray(USERS_DB, "users");

users = users.map(user => {
  if (typeof user === "number" || typeof user === "string") {
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
}).filter(user => Number.isFinite(user.id));

let nextMovieId = movies.reduce(
  (max, movie) => Math.max(max, Number(movie.id) || 0),
  0
) + 1;

const sessions = new Map();
const pendingBroadcasts = new Map();

function saveMovies() {
  safeSave(MOVIES_DB, movies);
}

function saveUsers() {
  safeSave(USERS_DB, users);
}

saveUsers();

// ========================================
// 3. SMART TITLE CLEANER
// ========================================

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function parseCaption(caption) {
  let title = String(caption || "").trim();

  let season = null;
  let episode = null;
  let part = null;

  // Season 1 Episode 5 / S1E5
  let match = title.match(
    /\b(?:season|s)\s*0*(\d+)\s*(?:episode|ep|e)\s*0*(\d+)\b/i
  );

  if (!match) {
    match = title.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  }

  if (match) {
    season = Number(match[1]);
    episode = Number(match[2]);
    title = title.replace(match[0], " ");
  }

  // Episode 5
  if (season === null) {
    const epMatch = title.match(
      /\b(?:episode|ep)\s*0*(\d+)\b/i
    );

    if (epMatch) {
      episode = Number(epMatch[1]);
      title = title.replace(epMatch[0], " ");
    }
  }

  // Part 5, Qeybta 5, Qeybta 5AAD
  if (season === null) {
    const partMatch = title.match(
      /\b(?:part|pt|qeybta|qaybta|qeyb|qayb|cd|disc|disk)\s*0*(\d+)\s*(?:aad|naad)?\b/i
    );

    if (partMatch) {
      part = Number(partMatch[1]);
      title = title.replace(partMatch[0], " ");
    }
  }

  // Remove hashtags.
  title = title.replace(/#[\w]+/g, " ");

  // Remove video extensions.
  title = title.replace(
    /\.(mp4|mkv|avi|mov|webm)$/i,
    " "
  );

  // Remove promotional words.
  title = title.replace(
    /\b(?:filim|film|movie|cusub|new|official|astaan)\b/gi,
    " "
  );

  // Remove video quality.
  title = title.replace(
    /\b(?:480p|720p|1080p|1440p|2160p|4k|8k|hd|full\s*hd|uhd|hdr|web-dl|bluray|brrip|webrip)\b/gi,
    " "
  );

  // Remove years.
  title = title.replace(/\b(?:19|20)\d{2}\b/g, " ");

  // Remove emojis and flags.
  title = title.replace(
    /[\p{Extended_Pictographic}\p{Regional_Indicator}]/gu,
    " "
  );

  // Remove decorative punctuation.
  title = title.replace(/[^\p{L}\p{N}\s]/gu, " ");

  title = title.replace(/\s+/g, " ").trim();

  return {
    title,
    key: normalize(title),
    season,
    episode,
    part,
    type: season !== null
      ? "series"
      : part !== null
        ? "part"
        : "movie"
  };
}

// ========================================
// 4. OLD MOVIE RECORD COMPATIBILITY
// ========================================

function getMovieInfo(movie) {
  const source = movie.caption || movie.title || "";
  const parsed = parseCaption(source);

  const oldSeason = movie.season != null
    ? Number(movie.season)
    : null;

  const oldEpisode = movie.episode != null
    ? Number(movie.episode)
    : null;

  const oldPart = movie.part != null
    ? Number(movie.part)
    : null;

  const season = parsed.season ?? oldSeason;
  const episode = parsed.episode ?? oldEpisode;
  const part = parsed.part ?? oldPart;

  return {
    title: parsed.title ||
      parseCaption(movie.title).title ||
      movie.title,

    key: parsed.key ||
      normalize(movie.title) ||
      normalize(movie.key),

    season,
    episode,
    part,

    type: season !== null
      ? "series"
      : part !== null
        ? "part"
        : (movie.type === "series" ? "series" : "movie")
  };
}

let migrationChanged = false;

for (const movie of movies) {
  if (!movie.id) {
    movie.id = nextMovieId++;
    migrationChanged = true;
  }

  const info = getMovieInfo(movie);

  for (const [key, value] of Object.entries(info)) {
    if (
      value !== undefined &&
      value !== null &&
      movie[key] !== value
    ) {
      movie[key] = value;
      migrationChanged = true;
    }
  }
}

if (migrationChanged) saveMovies();

// ========================================
// 5. REGISTER USERS
// ========================================

bot.use(async (ctx, next) => {
  if (ctx.chat?.type === "private" && ctx.from) {
    const userId = Number(ctx.from.id);

    const existing = users.find(
      user => user.id === userId
    );

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

// ========================================
// 6. RECEIVE VIDEOS FROM CHANNELS
// ========================================

bot.on("channel_post", ctx => {
  const post = ctx.channelPost;

  const channelUsername = ctx.chat.username
    ? "@" + ctx.chat.username.toLowerCase()
    : "";

  const allowed = CHANNELS.some(
    channel =>
      channel.username.toLowerCase() === channelUsername
  );

  if (!allowed) return;

  const hasVideo =
    Boolean(post.video) ||
    Boolean(
      post.document &&
      (
        post.document.mime_type?.startsWith("video/") ||
        /\.(mp4|mkv|avi|mov|webm)$/i.test(
          post.document.file_name || ""
        )
      )
    );

  if (!hasVideo) return;

  const caption = post.caption?.trim();

  if (!caption) {
    console.log("Video without caption:", post.message_id);
    return;
  }

  const parsed = parseCaption(caption);

  if (!parsed.key) {
    console.log("No movie title:", caption);
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
    savedAt: movie.savedAt || new Date().toISOString()
  });

  saveMovies();

  console.log(
    "Movie saved:",
    parsed.title,
    parsed.part ? "Part " + parsed.part : "",
    channelUsername
  );
});

// ========================================
// 7. SUBSCRIBE CHECK
// ========================================

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
      console.error("JOIN CHECK:", error.message);
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
      [
        Markup.button.url("📢 Somali Film", CHANNELS[1].link)
      ],
      [
        Markup.button.url("🎬 VEXORA MOVIES", CHANNELS[0].link)
      ],
      [
        Markup.button.callback("✅ Waan join gareeyay", "check_join")
      ]
    ])
  );
}

// ========================================
// 8. START
// ========================================

bot.start(async ctx => {
  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  return ctx.reply(
    "🎬 Ku soo dhowow American Films!\n\n" +
    "Qor magaca filimka aad rabto.\n\n" +
    "Tusaale: Sweet Home"
  );
});

bot.action("check_join", async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  return ctx.reply(
    "✅ Waa lagu xaqiijiyay!\n\nQor magaca filimka."
  );
});

// ========================================
// 9. SMART FUZZY SEARCH
// ========================================

function distance(a, b) {
  const row = Array.from(
    { length: b.length + 1 },
    (_, i) => i
  );

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

  return 1 - (
    distance(a, b) / Math.max(a.length, b.length)
  );
}

function similarity(query, title) {
  if (!query || !title) return 0;
  if (query === title) return 1;

  // Exact phrase inside title.
  if (title.includes(query)) return 0.96;
  if (query.includes(title)) return 0.93;

  const queryWords = query.split(" ");
  const titleWords = title.split(" ");

  const matched = queryWords.map(word => {
    let best = 0;

    for (const other of titleWords) {
      best = Math.max(
        best,
        wordSimilarity(word, other)
      );
    }

    return best;
  });

  const average =
    matched.reduce((sum, score) => sum + score, 0) /
    matched.length;

  const allWordsMatch = matched.every(score => score >= 0.72);

  if (allWordsMatch) {
    return Math.min(0.92, average);
  }

  return average * 0.85;
}

function findMovies(query) {
  const parsedQuery = parseCaption(query);
  const q = parsedQuery.key || normalize(query);

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
    .filter(group => group.score >= (
      q.split(" ").length === 1 ? 0.72 : 0.68
    ));

  // If a specific part was requested,
  // prefer titles that contain that part.
  if (parsedQuery.part !== null) {
    const matching = results.filter(group =>
      group.records.some(
        movie => Number(movie.part) === parsedQuery.part
      )
    );

    if (matching.length) results = matching;
  }

  if (
    parsedQuery.season !== null ||
    parsedQuery.episode !== null
  ) {
    const matching = results.filter(group =>
      group.records.some(movie =>
        (parsedQuery.season === null ||
          Number(movie.season) === parsedQuery.season) &&
        (parsedQuery.episode === null ||
          Number(movie.episode) === parsedQuery.episode)
      )
    );

    if (matching.length) results = matching;
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

// ========================================
// 10. SEND VIDEO
// ========================================

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

// ========================================
// 11. OPEN MOVIE / SERIES / PARTS
// ========================================

async function openMovie(ctx, group, requested = {}) {
  const records = group.records;

  // Directly send requested part.
  if (requested.part !== null && requested.part !== undefined) {
    const selected = records.find(movie =>
      Number(movie.part) === Number(requested.part)
    );

    if (selected) return sendVideo(ctx, selected);
  }

  // Directly send requested episode.
  if (requested.episode !== null &&
      requested.episode !== undefined) {

    const selected = records.find(movie =>
      Number(movie.episode) === Number(requested.episode) &&
      (
        requested.season == null ||
        Number(movie.season) === Number(requested.season)
      )
    );

    if (selected) return sendVideo(ctx, selected);
  }

  const episodes = records.filter(movie =>
    movie.season !== null &&
    movie.episode !== null
  );

  const parts = records.filter(movie =>
    movie.part !== null
  );

  // SERIES
  if (episodes.length) {
    const seasons = [
      ...new Set(episodes.map(movie => Number(movie.season)))
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
          Markup.button.callback(
            "Season " + season,
            "season:" + season
          )
        ])
      )
    );
  }

  // PARTS
  if (parts.length) {
    const sorted = [...parts].sort(
      (a, b) => Number(a.part) - Number(b.part)
    );

    sessions.set(ctx.from.id, {
      type: "parts",
      records: sorted
    });

    return ctx.reply(
      "🎬 " + group.title + "\n\nDooro qaybta:",
      Markup.inlineKeyboard(
        sorted.map(movie => [
          Markup.button.callback(
            "Qeybta " + movie.part,
            "part:" + movie.id
          )
        ])
      )
    );
  }

  return sendVideo(ctx, records[records.length - 1]);
}

// ========================================
// 12. ADMIN BROADCAST ENGINE
// ========================================

async function broadcastMessage(ctx, messageId) {
  let sent = 0;
  let failed = 0;

  const total = users.length;

  await ctx.reply(
    "⏳ Broadcast ayaa bilaabanaya.\n" +
    "👥 Users: " + total
  );

  for (const user of users) {
    try {
      await ctx.telegram.copyMessage(
        user.id,
        ctx.chat.id,
        messageId
      );

      sent++;

      // Telegram rate protection.
      await new Promise(resolve => setTimeout(resolve, 40));

    } catch (error) {
      failed++;

      console.log(
        "BROADCAST ERROR:",
        user.id,
        error.message
      );
    }
  }

  return ctx.reply(
    "✅ Broadcast dhammaaday!\n\n" +
    "👥 Users: " + total + "\n" +
    "✅ La diray: " + sent + "\n" +
    "❌ Fashilmay: " + failed
  );
}

// ========================================
// 13. TEXT BROADCAST
// ========================================

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
      "📢 Qoraal:\n" +
      "/broadcast Fariintaada\n\n" +
      "Voice, sawir ama video:\n" +
      "Reply saar fariinta kadib qor /broadcast.\n\n" +
      "Ama si toos ah bot-ka ugu soo dir voice."
    );
  }

  let sent = 0;
  let failed = 0;

  await ctx.reply(
    "⏳ Broadcast qoraal ayaa bilaabanaya.\n" +
    "Users: " + users.length
  );

  for (const user of users) {
    try {
      await ctx.telegram.sendMessage(user.id, message);
      sent++;

      await new Promise(resolve => setTimeout(resolve, 40));

    } catch (error) {
      failed++;
      console.log("TEXT BROADCAST ERROR:", error.message);
    }
  }

  return ctx.reply(
    "✅ Broadcast dhammaaday!\n\n" +
    "👥 Users: " + users.length + "\n" +
    "✅ La diray: " + sent + "\n" +
    "❌ Fashilmay: " + failed
  );
});

// ========================================
// 14. VOICE / AUDIO BROADCAST
// ========================================

// Admin sends a voice directly to the bot.
// Bot asks for confirmation before sending to everyone.

async function prepareVoiceBroadcast(ctx) {
  if (Number(ctx.from.id) !== ADMIN_ID) {
    return;
  }

  pendingBroadcasts.set(ADMIN_ID, {
    chatId: ctx.chat.id,
    messageId: ctx.message.message_id
  });

  return ctx.reply(
    "🎙️ VOICE BROADCAST\n\n" +
    "Codkaaga wuxuu gaari doonaa users-ka bot-ka.\n\n" +
    "👥 Users: " + users.length + "\n\n" +
    "Ma rabtaa inaad dhammaan u dirto?",
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "✅ Haa, dhammaan u dir",
          "voice_broadcast_yes"
        )
      ],
      [
        Markup.button.callback(
          "❌ Jooji",
          "voice_broadcast_no"
        )
      ]
    ])
  );
}

bot.on("voice", prepareVoiceBroadcast);
bot.on("audio", prepareVoiceBroadcast);

// Support round video messages too.
bot.on("video_note", prepareVoiceBroadcast);

// Confirm voice broadcast.
bot.action("voice_broadcast_yes", async ctx => {
  await ctx.answerCbQuery();

  if (Number(ctx.from.id) !== ADMIN_ID) {
    return ctx.reply("❌ Admin keliya.");
  }

  const pending = pendingBroadcasts.get(ADMIN_ID);

  if (!pending) {
    return ctx.reply("⚠️ Cod la dirayo lama helin.");
  }

  pendingBroadcasts.delete(ADMIN_ID);

  let sent = 0;
  let failed = 0;

  await ctx.reply(
    "⏳ Codka ayaa loo dirayaa users-ka..."
  );

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

      console.log(
        "VOICE BROADCAST ERROR:",
        user.id,
        error.message
      );
    }
  }

  return ctx.reply(
    "✅ VOICE BROADCAST DHAMMAADAY!\n\n" +
    "👥 Users: " + users.length + "\n" +
    "🎙️ La gaarsiiyay: " + sent + "\n" +
    "❌ Fashilmay: " + failed
  );
});

// Cancel voice broadcast.
bot.action("voice_broadcast_no", async ctx => {
  await ctx.answerCbQuery();

  if (Number(ctx.from.id) !== ADMIN_ID) {
    return;
  }

  pendingBroadcasts.delete(ADMIN_ID);

  return ctx.reply(
    "❌ Voice Broadcast waa la joojiyay."
  );
});

// ========================================
// 15. ADMIN STATISTICS
// ========================================

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

  const lastMonthUsers = users.filter(user => {
    if (!user.firstSeen) return false;

    const date = new Date(user.firstSeen);

    return (
      !Number.isNaN(date.getTime()) &&
      date >= startLastMonth &&
      date < startThisMonth
    );
  }).length;

  const lastMonthMovies = movies.filter(movie => {
    const savedDate = movie.savedAt || movie.createdAt;

    if (!savedDate) return false;

    const date = new Date(savedDate);

    return (
      !Number.isNaN(date.getTime()) &&
      date >= startLastMonth &&
      date < startThisMonth
    );
  }).length;

  const monthName = startLastMonth.toLocaleString(
    "en-US",
    {
      month: "long",
      year: "numeric",
      timeZone: "UTC"
    }
  );

  const oldUsersWithoutDate = users.filter(
    user => !user.firstSeen
  ).length;

  const channelOneMovies = movies.filter(
    movie => movie.sourceChannel === "@vexoramovies"
  ).length;

  const channelTwoMovies = movies.filter(
    movie => movie.sourceChannel === "@somalifilm0"
  ).length;

  return ctx.reply(
    "📊 AMERICAN FILMS STATISTICS\n\n" +

    "👥 ALL TIME USERS: " + users.length + "\n" +
    "📅 LAST MONTH USERS (" + monthName + "): " +
    lastMonthUsers + "\n" +

    "❓ Old users without date: " +
    oldUsersWithoutDate + "\n\n" +

    "🎬 ALL TIME MOVIES: " + movies.length + "\n" +
    "📅 LAST MONTH MOVIES: " + lastMonthMovies + "\n\n" +

    "📢 VEXORA MOVIES: " + channelOneMovies + "\n" +
    "📢 SOMALI FILM: " + channelTwoMovies
  );
});

// ========================================
// 16. SEARCH HANDLER
// ========================================

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
      "❌ Filimkan lama helin.\n\n" +
      "Hubi magaca ama isku day magac kale."
    );
  }

  if (results.length === 1) {
    return openMovie(ctx, results[0], parsedQuery);
  }

  // If top result is clearly better, open it directly.
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
        Markup.button.callback(
          group.title,
          "title:" + index
        )
      ])
    )
  );
});

// ========================================
// 17. SELECT MOVIE TITLE
// ========================================

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

// ========================================
// 18. SELECT SEASON
// ========================================

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

  const episodes = session.episodes
    .filter(movie => Number(movie.season) === season)
    .sort((a, b) => a.episode - b.episode);

  if (!episodes.length) {
    return ctx.reply("Season-kan lama helin.");
  }

  session.selectedEpisodes = episodes;

  return ctx.reply(
    "📺 Season " + season + "\n\nDooro Episode:",
    Markup.inlineKeyboard(
      episodes.map(movie => [
        Markup.button.callback(
          "EP " + movie.episode,
          "episode:" + movie.id
        )
      ])
    )
  );
});

// ========================================
// 19. SELECT EPISODE
// ========================================

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

// ========================================
// 20. SELECT PART
// ========================================

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

// ========================================
// 21. ERROR HANDLING
// ========================================

bot.catch(error => {
  console.error("BOT ERROR:", error);
});

// ========================================
// 22. START BOT
// ========================================

bot.launch({
  allowedUpdates: [
    "message",
    "callback_query",
    "channel_post"
  ]
});

console.log("🎬 American Films Bot is running!");
console.log("📢 Listening to both movie channels.");
console.log("🔎 Smart Movie Search enabled.");
console.log("🎙️ Voice Broadcast enabled.");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
