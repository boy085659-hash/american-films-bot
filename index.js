
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

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN missing");
}

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
    path.basename(file) +
    ". Original file has not been overwritten."
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

// Preserve old users and their existing fields.
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

// Preserve all old movie records.
let nextMovieId = movies.reduce(
  (max, movie) => Math.max(max, Number(movie.id) || 0),
  0
) + 1;

const sessions = new Map();

function saveMovies() {
  safeSave(MOVIES_DB, movies);
}

function saveUsers() {
  safeSave(USERS_DB, users);
}

saveUsers();

// ========================================
// 3. NORMALIZE AND CLEAN MOVIE TITLES
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

  // Detect Season and Episode.
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

  // Detect movie parts.
  if (season === null) {
    const partMatch = title.match(
      /\b(?:part|pt|qayb|cd|disc|disk)\s*0*(\d+)\b/i
    );

    if (partMatch) {
      part = Number(partMatch[1]);
      title = title.replace(partMatch[0], " ");
    }
  }

  // Remove video file extensions.
  title = title.replace(
    /\.(mp4|mkv|avi|mov|webm)$/i,
    " "
  );

  // Remove promotional words and channel branding.
  title = title.replace(
    /\b(?:filim|film|movie|cusub|new|official|astaan)\b/gi,
    " "
  );

  // Remove video quality labels.
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

  // Remove punctuation and decorative symbols.
  title = title.replace(/[^\p{L}\p{N}\s]/gu, " ");

  title = title
    .replace(/\s+/g, " ")
    .trim();

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

// Re-read old records using their original captions.
// New cleaned title takes priority over old promotional title.
function getMovieInfo(movie) {
  const source = movie.caption || movie.title || "";
  const parsed = parseCaption(source);

  const oldSeason = movie.season !== undefined &&
    movie.season !== null
      ? Number(movie.season)
      : null;

  const oldEpisode = movie.episode !== undefined &&
    movie.episode !== null
      ? Number(movie.episode)
      : null;

  const oldPart = movie.part !== undefined &&
    movie.part !== null
      ? Number(movie.part)
      : null;

  const season = parsed.season ?? oldSeason;
  const episode = parsed.episode ?? oldEpisode;
  const part = parsed.part ?? oldPart;

  return {
    title: parsed.title || parseCaption(movie.title).title || movie.title,
    key: parsed.key || normalize(movie.title) || normalize(movie.key),
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

// Add missing IDs and metadata without removing old fields.
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

if (migrationChanged) {
  saveMovies();
}

// ========================================
// 4. REGISTER USERS
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

      console.log("New user registered:", userId);
    }
  }

  return next();
});

// ========================================
// 5. RECEIVE VIDEOS FROM BOTH CHANNELS
// ========================================

bot.on("channel_post", ctx => {
  const post = ctx.channelPost;

  const channelUsername = ctx.chat.username
    ? "@" + ctx.chat.username.toLowerCase()
    : "";

  const allowedChannel = CHANNELS.some(
    channel =>
      channel.username.toLowerCase() === channelUsername
  );

  if (!allowedChannel) return;

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
    console.log("Video has no caption:", post.message_id);
    return;
  }

  const parsed = parseCaption(caption);

  if (!parsed.key) {
    console.log("Could not detect movie title:", caption);
    return;
  }

  // Avoid saving the same channel post twice.
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

  // Keep original caption and save cleaned movie title.
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
    "New movie saved:",
    parsed.title,
    "from",
    channelUsername
  );
});

// ========================================
// 6. SUBSCRIBE CHECK
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
      console.error(
        "JOIN CHECK ERROR:",
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
    "🎬 Si aad u isticmaasho bot-ka, fadlan join garee labada channel:\n\n" +
    "1️⃣ " + CHANNELS[0].link + "\n" +
    "2️⃣ " + CHANNELS[1].link,
    Markup.inlineKeyboard([
      [
        Markup.button.url(
          "📢 Somali Film",
          CHANNELS[1].link
        )
      ],
      [
        Markup.button.url(
          "🎬 VEXORA MOVIES",
          CHANNELS[0].link
        )
      ],
      [
        Markup.button.callback(
          "✅ Waan join gareeyay",
          "check_join"
        )
      ]
    ])
  );
}

// ========================================
// 7. START
// ========================================

bot.start(async ctx => {
  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  return ctx.reply(
    "🎬 Ku soo dhowow American Films!\n\n" +
    "Qor magaca filimka aad rabto."
  );
});

bot.action("check_join", async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  return ctx.reply(
    "✅ Waa lagu xaqiijiyay!\n\n" +
    "Hadda qor magaca filimka."
  );
});

// ========================================
// 8. SMART SEARCH
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

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const whole =
    1 - distance(a, b) / Math.max(a.length, b.length);

  const aw = a.split(" ");
  const bw = b.split(" ");

  let matched = 0;

  for (const word of aw) {
    let best = 0;

    for (const other of bw) {
      best = Math.max(
        best,
        1 - distance(word, other) /
        Math.max(word.length, other.length)
      );
    }

    if (best >= 0.55) matched++;
  }

  return Math.max(
    whole,
    matched / Math.max(aw.length, bw.length)
  );
}

function findMovies(query) {
  const q = parseCaption(query).key || normalize(query);

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

  return [...groups.values()]
    .map(group => ({
      ...group,
      score: similarity(q, group.key)
    }))
    .filter(group => group.score >= 0.48)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

// ========================================
// 9. SEND VIDEO DIRECTLY
// ========================================

async function sendVideo(ctx, movie) {
  try {
    await ctx.sendChatAction("upload_video");

    // Sends the original video directly.
    // It does not create a folder or playlist.
    await ctx.telegram.copyMessage(
      ctx.chat.id,
      movie.chatId,
      movie.messageId
    );

  } catch (error) {
    console.error("VIDEO ERROR:", error.message);

    await ctx.reply(
      "⚠️ Video-ga lama soo diri karin.\n" +
      "Fadlan mar kale isku day."
    );
  }
}

// ========================================
// 10. OPEN MOVIE / SERIES / PARTS
// ========================================

async function openMovie(ctx, group) {
  const records = group.records;

  const episodes = records.filter(movie =>
    movie.season !== null &&
    movie.episode !== null
  );

  const parts = records.filter(movie =>
    movie.part !== null
  );

  // TV SERIES: show Seasons.
  if (episodes.length) {
    const seasons = [
      ...new Set(episodes.map(movie => movie.season))
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

  // MOVIE PARTS: show Parts.
  if (parts.length) {
    sessions.set(ctx.from.id, {
      type: "parts",
      records: parts
    });

    return ctx.reply(
      "🎬 " + group.title + "\n\nDooro qaybta:",
      Markup.inlineKeyboard(
        parts
          .sort((a, b) => a.part - b.part)
          .map(movie => [
            Markup.button.callback(
              "Part " + movie.part,
              "part:" + movie.id
            )
          ])
      )
    );
  }

  // ONE MOVIE OR DUPLICATE COPIES:
  // Always send a video directly.
  // Never show a folder or copies menu.
  const selectedMovie = records[records.length - 1];

  return sendVideo(ctx, selectedMovie);
}

// ========================================
// 11. ADMIN BROADCAST
// ========================================

bot.command("broadcast", async ctx => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply(
      "❌ Admin keliya ayaa isticmaali kara."
    );
  }

  const replied = ctx.message.reply_to_message;

  const message = ctx.message.text
    .replace(/^\/broadcast(@\w+)?\s*/i, "")
    .trim();

  if (!replied && !message) {
    return ctx.reply(
      "📢 Qoraal:\n" +
      "/broadcast Fariintaada\n\n" +
      "Sawir ama video:\n" +
      "Reply saar fariinta kadib qor /broadcast."
    );
  }

  await ctx.reply(
    "⏳ Broadcast ayaa bilaabanaya.\n" +
    "Users: " + users.length
  );

  let sent = 0;
  let failed = 0;

  for (const user of users) {
    try {
      if (replied) {
        await ctx.telegram.copyMessage(
          user.id,
          ctx.chat.id,
          replied.message_id
        );
      } else {
        await ctx.telegram.sendMessage(
          user.id,
          message
        );
      }

      sent++;

      await new Promise(resolve =>
        setTimeout(resolve, 40)
      );

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
    "👥 Users: " + users.length + "\n" +
    "✅ La diray: " + sent + "\n" +
    "❌ Fashilmay: " + failed
  );
});

// ========================================
// 12. ADMIN STATISTICS
// ========================================

bot.command("stats", async ctx => {
  if (ctx.from.id !== ADMIN_ID) {
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

  // Users registered last month.
  const lastMonthUsers = users.filter(user => {
    if (!user.firstSeen) return false;

    const date = new Date(user.firstSeen);

    return (
      !Number.isNaN(date.getTime()) &&
      date >= startLastMonth &&
      date < startThisMonth
    );
  }).length;

  // Movies saved last month.
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
// 13. SEARCH HANDLER
// ========================================

bot.on("text", async ctx => {
  const query = ctx.message.text.trim();

  if (!query || query.startsWith("/")) return;

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const results = findMovies(query);

  if (!results.length) {
    return ctx.reply(
      "❌ Filimkan lama helin.\n\n" +
      "Isku day magac kale."
    );
  }

  if (results.length === 1) {
    return openMovie(ctx, results[0]);
  }

  sessions.set(ctx.from.id, {
    type: "titles",
    groups: results
  });

  return ctx.reply(
    "🎬 Filimadan ayaa la helay. Mid dooro:",
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
// 14. SELECT MOVIE TITLE
// ========================================

bot.action(/^title:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const session = sessions.get(ctx.from.id);

  if (!session || session.type !== "titles") {
    return ctx.reply(
      "Fadlan mar kale raadi filimka."
    );
  }

  const group = session.groups[Number(ctx.match[1])];

  if (!group) {
    return ctx.reply("Filimka lama helin.");
  }

  return openMovie(ctx, group);
});

// ========================================
// 15. SELECT SEASON
// ========================================

bot.action(/^season:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const session = sessions.get(ctx.from.id);

  if (!session || session.type !== "series") {
    return ctx.reply(
      "Fadlan mar kale raadi series-ka."
    );
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
// 16. SELECT EPISODE
// ========================================

bot.action(/^episode:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const session = sessions.get(ctx.from.id);

  if (!session || session.type !== "series") {
    return ctx.reply(
      "Fadlan mar kale raadi series-ka."
    );
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
// 17. SELECT PART
// ========================================

bot.action(/^part:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) {
    return showJoin(ctx);
  }

  const session = sessions.get(ctx.from.id);

  if (!session || session.type !== "parts") {
    return ctx.reply(
      "Fadlan mar kale raadi filimka."
    );
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
// 18. ERROR HANDLING
// ========================================

bot.catch(error => {
  console.error("BOT ERROR:", error);
});

// ========================================
// 19. START BOT
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

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
