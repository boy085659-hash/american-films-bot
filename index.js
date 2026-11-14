
const { Telegraf } = require("telegraf");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL = "@VEXORAMOVIES";

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is missing");
}

const bot = new Telegraf(BOT_TOKEN);

// Local movie database
const DB_FILE = path.join(__dirname, "movies.json");

let movies = [];

try {
  if (fs.existsSync(DB_FILE)) {
    movies = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  }
} catch (error) {
  console.error("Database error:", error.message);
}

function saveMovies() {
  fs.writeFileSync(DB_FILE, JSON.stringify(movies, null, 2));
}

// Welcome
bot.start((ctx) => {
  return ctx.reply(
    "🎬 Ku soo dhowow American Films!\n\n" +
    "Ii soo qor magaca filimka aad rabto.\n\n" +
    "Waxaan kuu soo dirayaa filimada ku jira channel-keena."
  );
});

// Receive new channel videos and index them
bot.on("channel_post", async (ctx) => {
  try {
    const post = ctx.channelPost;

    // Only index actual video files
    if (!post.video) return;

    const title = post.caption?.trim();

    if (!title) {
      console.log("Video has no caption. Add its movie title.");
      return;
    }

    const film = {
      title,
      chatId: ctx.chat.id,
      messageId: post.message_id
    };

    // Avoid duplicate message entries
    movies = movies.filter(
      (m) =>
        !(m.chatId === film.chatId &&
          m.messageId === film.messageId)
    );

    movies.push(film);
    saveMovies();

    console.log("Movie indexed:", title);

  } catch (error) {
    console.error("INDEX ERROR:", error.message);
  }
});

// Search channel movies
bot.on("text", async (ctx) => {
  const query = ctx.message.text.trim();

  if (!query || query.startsWith("/")) return;

  try {
    await ctx.sendChatAction("typing");

    const found = movies
      .filter((movie) =>
        movie.title.toLowerCase().includes(query.toLowerCase())
      )
      .slice(0, 10);

    if (found.length === 0) {
      return ctx.reply(
        "❌ Filimkan channel-keena kuma jiro.\n\n" +
        "Fadlan isku day magac kale."
      );
    }

    const buttons = found.map((movie, index) => [{
      text: `🎬 ${movie.title}`,
      callback_data: `film:${index}`
    }]);

    return ctx.reply(
      "🎥 Filimada channel-ka laga helay. Mid dooro:",
      {
        reply_markup: {
          inline_keyboard: buttons
        }
      }
    );

  } catch (error) {
    console.error("SEARCH ERROR:", error.message);
    return ctx.reply("⚠️ Raadinta ayaa fashilantay.");
  }
});

// Send the actual channel video
bot.action(/^film:(\d+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();

    const index = Number(ctx.match[1]);
    const film = movies[index];

    if (!film) {
      return ctx.reply("❌ Filimkan lama helin.");
    }

    await ctx.sendChatAction("upload_video");

    await ctx.telegram.copyMessage(
      ctx.chat.id,
      film.chatId,
      film.messageId
    );

  } catch (error) {
    console.error("SEND VIDEO ERROR:", error.message);

    await ctx.reply(
      "⚠️ Video-ga lama soo diri karin. Fadlan mar kale isku day."
    );
  }
});

// Errors
bot.catch((error) => {
  console.error("BOT ERROR:", error);
});

// Launch
bot.launch()
  .then(() => {
    console.log("🎬 American Films Bot is running!");
    console.log("Indexed movies:", movies.length);
  })
  .catch((error) => {
    console.error("BOT START ERROR:", error);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
