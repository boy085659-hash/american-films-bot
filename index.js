
const { Telegraf } = require("telegraf");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL = "@VEXORAMOVIES";
const ADMIN_ID = 7199419196;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");

const bot = new Telegraf(BOT_TOKEN);

const DB = path.join(__dirname, "movies.json");
const USERS_DB = path.join(__dirname, "users.json");

let movies = [];
let users = [];

// Load movie database
if (fs.existsSync(DB)) {
  try {
    movies = JSON.parse(fs.readFileSync(DB, "utf8"));
  } catch {
    movies = [];
  }
}

// Load users database
if (fs.existsSync(USERS_DB)) {
  try {
    users = JSON.parse(fs.readFileSync(USERS_DB, "utf8"));
  } catch {
    users = [];
  }
}

function save() {
  fs.writeFileSync(DB, JSON.stringify(movies, null, 2));
}

function saveUsers() {
  fs.writeFileSync(
    USERS_DB,
    JSON.stringify(users, null, 2)
  );
}

// Register private bot users
bot.use(async (ctx, next) => {
  if (ctx.from && ctx.chat?.type === "private") {
    if (!users.includes(ctx.from.id)) {
      users.push(ctx.from.id);
      saveUsers();
      console.log("New user:", ctx.from.id);
    }
  }

  return next();
});

// ADMIN BROADCAST
bot.command("broadcast", async ctx => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("❌ Admin kaliya ayaa isticmaali kara.");
  }

  const message = ctx.message.text
    .replace(/^\/broadcast(?:@\w+)?\s*/i, "")
    .trim();

  if (!message) {
    return ctx.reply(
      "📢 Isticmaal:\n\n/broadcast Fariintaada"
    );
  }

  await ctx.reply("⏳ Fariinta waa la dirayaa...");

  let sent = 0;
  let failed = 0;
  const activeUsers = [];

  for (const userId of users) {
    try {
      await bot.telegram.sendMessage(userId, message);
      sent++;
      activeUsers.push(userId);
    } catch (error) {
      failed++;
      console.log(
        "Broadcast failed:",
        userId,
        error.message
      );

      // Keep users who may temporarily have delivery errors
      activeUsers.push(userId);
    }
  }

  users = activeUsers;
  saveUsers();

  return ctx.reply(
    "✅ BROADCAST DHAMMAAD\n\n" +
    "📨 La diray: " + sent + "\n" +
    "⚠️ Fashilmay: " + failed + "\n" +
    "👥 Wadarta: " + users.length
  );
});

// ADMIN STATS
bot.command("stats", ctx => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("❌ Admin kaliya.");
  }

  return ctx.reply(
    "📊 AMERICAN FILMS STATISTICS\n\n" +
    "🎬 Filimada kaydsan: " + movies.length + "\n" +
    "👥 Dadka bot-ka isticmaalay: " + users.length
  );
});

// Save new channel videos
bot.on("channel_post", (ctx) => {
  const post = ctx.channelPost;

  if (!post.video) return;

  const title = post.caption?.trim();

  if (!title) {
    console.log("Video has no movie title");
    return;
  }

  const movie = {
    title,
    chatId: ctx.chat.id,
    messageId: post.message_id
  };

  movies = movies.filter(
    m => !(m.chatId === movie.chatId &&
           m.messageId === movie.messageId)
  );

  movies.push(movie);
  save();

  console.log("Saved movie:", title);
});

// Welcome
bot.start(ctx => ctx.reply(
  "🎬 Ku soo dhowow American Films!\n\n" +
  "Qor magaca filimka aad rabto.\n\n" +
  "📩 Cabasho ama caawimaad: nala soo xiriir."
));

// Search channel database only
bot.on("text", async ctx => {
  const query = ctx.message.text.trim();

  if (!query || query.startsWith("/")) return;

  const results = movies.filter(m =>
    m.title.toLowerCase().includes(query.toLowerCase())
  ).slice(0, 10);

  if (!results.length) {
    return ctx.reply(
      "❌ Filimkan channel-keena kuma jiro."
    );
  }

  const keyboard = results.map(movie => [{
    text: "🎬 " + movie.title,
    callback_data: "film:" + movie.messageId
  }]);

  return ctx.reply(
    "Filimada channel-ka laga helay. Mid dooro:",
    {
      reply_markup: {
        inline_keyboard: keyboard
      }
    }
  );
});

// Send actual video from channel
bot.action(/^film:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  const messageId = Number(ctx.match[1]);

  const movie = movies.find(m =>
    m.messageId === messageId
  );

  if (!movie) {
    return ctx.reply("❌ Filimka lama helin.");
  }

  try {
    await ctx.sendChatAction("upload_video");

    await ctx.telegram.copyMessage(
      ctx.chat.id,
      movie.chatId,
      movie.messageId
    );

  } catch (error) {
    console.error("VIDEO ERROR:", error.message);
    await ctx.reply("⚠️ Video-ga lama soo diri karin.");
  }
});

bot.catch(err => console.error("BOT ERROR:", err));

bot.launch({
  allowedUpdates: [
    "message",
    "callback_query",
    "channel_post"
  ]
});

console.log("🎬 American Films Bot is running!");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
