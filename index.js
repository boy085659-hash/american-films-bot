
const { Telegraf } = require("telegraf");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL = "@VEXORAMOVIES";
const ADMIN_ID = 7199419196;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");

const bot = new Telegraf(BOT_TOKEN);
const DB = path.join(__dirname, "movies.json");

let movies = [];
const complaints = new Set();

if (fs.existsSync(DB)) {
  try {
    movies = JSON.parse(fs.readFileSync(DB, "utf8"));
  } catch {
    movies = [];
  }
}

function save() {
  fs.writeFileSync(DB, JSON.stringify(movies, null, 2));
}

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
  "Ama dooro:",
  {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🎬 Raadi Filim", callback_data: "search_info" }],
        [{ text: "📩 Cabasho / Nala soo xiriir", callback_data: "contact_admin" }],
        [{ text: "ℹ️ Caawimaad", callback_data: "help" }]
      ]
    }
  }
));

// Help
bot.action("help", async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply(
    "ℹ️ Sida loo isticmaalo:\n\n" +
    "1. Qor magaca filimka.\n" +
    "2. Dooro filimka aad rabto.\n" +
    "3. Cabasho haddii aad qabto, nala soo xiriir.\n\n" +
    "Qor /cancel si aad u joojiso cabashada."
  );
});

// Search information
bot.action("search_info", async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply("🎬 Qor magaca filimka aad rabto.");
});

// Complaint button
bot.action("contact_admin", async ctx => {
  await ctx.answerCbQuery();
  complaints.add(ctx.from.id);

  await ctx.reply(
    "📩 Fadlan halkan ku qor cabashadaada.\n\n" +
    "Cabashadaada waxaa si gaar ah loogu dirayaa maamulka.\n\n" +
    "Qor /cancel si aad u joojiso."
  );
});

// Cancel complaint
bot.command("cancel", ctx => {
  complaints.delete(ctx.from.id);
  return ctx.reply("❌ Cabashada waa la joojiyey.");
});

// Search and complaint messages
bot.on("text", async ctx => {
  const query = ctx.message.text.trim();
  const userId = ctx.from.id;

  if (!query || query.startsWith("/")) return;

  // Complaint system
  if (complaints.has(userId)) {
    complaints.delete(userId);

    const username = ctx.from.username
      ? "@" + ctx.from.username
      : "Username ma jiro";

    const complaint =
      "📩 CABASHO CUSUB\n\n" +
      "👤 Magac: " + (ctx.from.first_name || "Unknown") + "\n" +
      "🔗 Username: " + username + "\n" +
      "🆔 User ID: " + userId + "\n\n" +
      "💬 Cabasho:\n" + query.slice(0, 3500);

    try {
      await bot.telegram.sendMessage(ADMIN_ID, complaint);

      return ctx.reply(
        "✅ Cabashadaada waa la helay.\n" +
        "Mahadsanid inaad nala soo xiriirtay."
      );
    } catch (error) {
      console.error("ADMIN MESSAGE ERROR:", error.message);
      return ctx.reply(
        "⚠️ Cabashada lama diri karin. Fadlan mar kale isku day."
      );
    }
  }

  // Search channel database only
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
    callback_data: "film:" + movie.chatId + ":" + movie.messageId
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
bot.action(/^film:(-?\d+):(\d+)$/, async ctx => {
  await ctx.answerCbQuery();

  const chatId = Number(ctx.match[1]);
  const messageId = Number(ctx.match[2]);

  const movie = movies.find(m =>
    m.chatId === chatId &&
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
