
const { Telegraf, Markup } = require("telegraf");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;

const ADMIN_ID = 7199419196;

const CHANNELS = [
  {
    username: "@somalifilm0",
    link: "https://t.me/somalifilm0"
  },
  {
    username: "@VEXORAMOVIES",
    link: "https://t.me/VEXORAMOVIES"
  }
];

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");

const bot = new Telegraf(BOT_TOKEN);
const DB = path.join(__dirname, "movies.json");

let movies = [];

if (fs.existsSync(DB)) {
  try {
    const data = JSON.parse(fs.readFileSync(DB, "utf8"));
    if (Array.isArray(data)) movies = data;
  } catch (err) {
    console.error("Database error:", err.message);
  }
}

let nextId =
  movies.reduce((max, m) => Math.max(max, Number(m.id) || 0), 0) + 1;

const sessions = new Map();

function save() {
  fs.writeFileSync(DB, JSON.stringify(movies, null, 2));
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Read movie title, season, episode and part.
function parseCaption(caption) {
  let title = String(caption || "").trim();

  let season = null;
  let episode = null;
  let part = null;

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

  if (season === null) {
    const partMatch = title.match(
      /\b(?:part|pt|qayb|cd|disc|disk)\s*0*(\d+)\b/i
    );

    if (partMatch) {
      part = Number(partMatch[1]);
      title = title.replace(partMatch[0], " ");
    }
  }

  title = title
    .replace(/\.(mp4|mkv|avi|mov|webm)$/i, " ")
    .replace(/\b(480p|720p|1080p|2160p|4k|hd)\b/gi, " ")
    .replace(/[\[\](){}]/g, " ")
    .replace(/[|_]+/g, " ")
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

// Save channel videos.
bot.on("channel_post", ctx => {
  const post = ctx.channelPost;

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

  const caption = post.caption?.trim();
  if (!caption) return;

  const parsed = parseCaption(caption);
  if (!parsed.key) return;

  let movie = movies.find(m =>
    String(m.chatId) === String(ctx.chat.id) &&
    Number(m.messageId) === Number(post.message_id)
  );

  if (!movie) {
    movie = {
      id: nextId++,
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
    type: parsed.type
  });

  save();
  console.log("Saved movie:", parsed.title);
});

// Preserve and prepare old records.
for (const movie of movies) {
  if (!movie.id) movie.id = nextId++;

  if (!movie.key || !movie.type) {
    const parsed = parseCaption(movie.caption || movie.title || "");
    Object.assign(movie, parsed);
  }
}
save();

// Check membership in both channels.
async function isJoined(userId) {
  for (const channel of CHANNELS) {
    try {
      const member = await bot.telegram.getChatMember(
        channel.username,
        userId
      );

      if (!["creator", "administrator", "member"].includes(member.status)) {
        return false;
      }
    } catch (err) {
      console.error("JOIN CHECK:", err.message);
      return false;
    }
  }
  return true;
}

async function showJoin(ctx) {
  return ctx.reply(
    "Fadlan join dheh channelada aad leftiga ka qaadatey 👇\n\n" +
    "❌ " + CHANNELS[0].link + "\n" +
    "❌ " + CHANNELS[1].link,
    Markup.inlineKeyboard([
      [Markup.button.url("📢 Somali Film", CHANNELS[0].link)],
      [Markup.button.url("🎬 VEXORA MOVIES", CHANNELS[1].link)],
      [Markup.button.callback("✅ Waan join gareeyay", "check_join")]
    ])
  );
}

bot.start(async ctx => {
  if (!(await isJoined(ctx.from.id))) return showJoin(ctx);

  return ctx.reply(
    "🎬 Ku soo dhowow American Films!\n\nQor magaca filimka aad rabto."
  );
});

bot.action("check_join", async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) return showJoin(ctx);

  return ctx.reply("✅ Waa lagu xaqiijiyay!\n\nQor magaca filimka.");
});

// Smart search.
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

function score(a, b) {
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
        1 - distance(word, other) / Math.max(word.length, other.length)
      );
    }

    if (best >= 0.55) matched++;
  }

  return Math.max(whole, matched / Math.max(aw.length, bw.length));
}

function findMovies(query) {
  const groups = new Map();
  const q = normalize(query);

  for (const movie of movies) {
    if (!movie.chatId || !movie.messageId || !movie.key) continue;

    if (!groups.has(movie.key)) {
      groups.set(movie.key, {
        title: movie.title,
        key: movie.key,
        records: []
      });
    }

    groups.get(movie.key).records.push(movie);
  }

  return [...groups.values()]
    .map(group => ({
      ...group,
      score: score(q, group.key)
    }))
    .filter(group => group.score >= 0.48)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

// Send exactly one selected video.
async function sendVideo(ctx, movie) {
  try {
    await ctx.sendChatAction("upload_video");

    await ctx.telegram.copyMessage(
      ctx.chat.id,
      movie.chatId,
      movie.messageId
    );
  } catch (err) {
    console.error("VIDEO ERROR:", err.message);
    await ctx.reply("⚠️ Video-ga lama soo diri karin.");
  }
}

// Show series, parts or ordinary movie.
async function openMovie(ctx, group) {
  const records = group.records;

  const episodes = records.filter(m =>
    m.type === "series" &&
    m.season !== null &&
    m.episode !== null
  );

  const parts = records.filter(m =>
    m.type === "part" && m.part !== null
  );

  if (episodes.length) {
    const seasons = [...new Set(episodes.map(m => m.season))]
      .sort((a, b) => a - b);

    sessions.set(ctx.from.id, {
      type: "series",
      group,
      episodes
    });

    return ctx.reply(
      "🎬 " + group.title + "\n\nDooro Season:",
      Markup.inlineKeyboard(
        seasons.map(s => [
          Markup.button.callback("Season " + s, "season:" + s)
        ])
      )
    );
  }

  if (parts.length) {
    sessions.set(ctx.from.id, {
      type: "parts",
      records: parts
    });

    return ctx.reply(
      "🎬 " + group.title + "\n\nDooro qaybta:",
      Markup.inlineKeyboard(
        parts.sort((a, b) => a.part - b.part).map(m => [
          Markup.button.callback("Part " + m.part, "part:" + m.id)
        ])
      )
    );
  }

  if (records.length === 1) {
    return sendVideo(ctx, records[0]);
  }

  sessions.set(ctx.from.id, {
    type: "copies",
    records
  });

  return ctx.reply(
    "Filimkan nuqullo kala duwan ayaa jira. Mid dooro:",
    Markup.inlineKeyboard(
      records.slice(0, 10).map((m, i) => [
        Markup.button.callback("Nuqul " + (i + 1), "copy:" + m.id)
      ])
    )
  );
}

// Search movies.
bot.on("text", async ctx => {
  const query = ctx.message.text.trim();

  if (!query || query.startsWith("/")) return;

  if (!(await isJoined(ctx.from.id))) return showJoin(ctx);

  const results = findMovies(query);

  if (!results.length) {
    return ctx.reply("❌ Filimkan lama helin. Isku day magac kale.");
  }

  if (results.length === 1) {
    return openMovie(ctx, results[0]);
  }

  sessions.set(ctx.from.id, {
    type: "titles",
    groups: results
  });

  return ctx.reply(
    "Filimadan ayaa isku dhow. Mid dooro:",
    Markup.inlineKeyboard(
      results.map((g, i) => [
        Markup.button.callback(g.title, "title:" + i)
      ])
    )
  );
});

// Choose a matching title.
bot.action(/^title:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) return showJoin(ctx);

  const session = sessions.get(ctx.from.id);
  if (!session || session.type !== "titles") return;

  const group = session.groups[Number(ctx.match[1])];
  if (!group) return ctx.reply("Filimka lama helin.");

  return openMovie(ctx, group);
});

// Choose a season.
bot.action(/^season:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) return showJoin(ctx);

  const session = sessions.get(ctx.from.id);
  if (!session || session.type !== "series") return;

  const season = Number(ctx.match[1]);

  const episodes = session.episodes
    .filter(m => m.season === season)
    .sort((a, b) => a.episode - b.episode);

  if (!episodes.length) return ctx.reply("Season-kan lama helin.");

  session.selectedSeason = season;
  session.selectedEpisodes = episodes;

  return ctx.reply(
    "📺 Season " + season + "\nDooro Episode:",
    Markup.inlineKeyboard(
      episodes.map(m => [
        Markup.button.callback("EP " + m.episode, "episode:" + m.id)
      ])
    )
  );
});

// Choose an episode.
bot.action(/^episode:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) return showJoin(ctx);

  const session = sessions.get(ctx.from.id);
  if (!session || session.type !== "series") return;

  const movie = session.selectedEpisodes?.find(
    m => Number(m.id) === Number(ctx.match[1])
  );

  if (!movie) return ctx.reply("Episode-kan lama helin.");

  return sendVideo(ctx, movie);
});

// Choose a movie part.
bot.action(/^part:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) return showJoin(ctx);

  const session = sessions.get(ctx.from.id);
  if (!session || session.type !== "parts") return;

  const movie = session.records.find(
    m => Number(m.id) === Number(ctx.match[1])
  );

  if (!movie) return ctx.reply("Qaybtan lama helin.");

  return sendVideo(ctx, movie);
});

// Choose a duplicate ordinary movie.
bot.action(/^copy:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  if (!(await isJoined(ctx.from.id))) return showJoin(ctx);

  const session = sessions.get(ctx.from.id);
  if (!session || session.type !== "copies") return;

  const movie = session.records.find(
    m => Number(m.id) === Number(ctx.match[1])
  );

  if (!movie) return ctx.reply("Filimka lama helin.");

  return sendVideo(ctx, movie);
});

// Admin broadcast.
bot.command("broadcast", async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;

  const message = ctx.message.text.replace(/^\/broadcast\s*/i, "").trim();

  if (!message) {
    return ctx.reply("Isticmaal: /broadcast Fariintaada");
  }

  const userFile = path.join(__dirname, "users.json");
  let users = [];

  if (fs.existsSync(userFile)) {
    try {
      users = JSON.parse(fs.readFileSync(userFile, "utf8"));
    } catch {}
  }

  let sent = 0;

  for (const id of users) {
    try {
      await bot.telegram.sendMessage(id, message);
      sent++;
    } catch (err) {
      console.error("Broadcast error:", id, err.message);
    }
  }

  return ctx.reply("Broadcast waa dhammaaday. La diray: " + sent);
});

// Save private users for admin broadcast.
bot.use(async (ctx, next) => {
  if (ctx.chat?.type === "private" && ctx.from) {
    const userFile = path.join(__dirname, "users.json");
    let users = [];

    if (fs.existsSync(userFile)) {
      try {
        users = JSON.parse(fs.readFileSync(userFile, "utf8"));
      } catch {}
    }

    if (!users.includes(ctx.from.id)) {
      users.push(ctx.from.id);
      fs.writeFileSync(userFile, JSON.stringify(users, null, 2));
    }
  }

  return next();
});

bot.catch(err => console.error("BOT ERROR:", err));

bot.launch({
  allowedUpdates: ["message", "callback_query", "channel_post"]
});

console.log("🎬 American Films Bot is running!");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
