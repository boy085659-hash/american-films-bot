
const { Telegraf } = require("telegraf");
const axios = require("axios");

// Check environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const TMDB_KEY = process.env.TMDB_API_KEY;

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is missing in Environment Variables");
}

if (!TMDB_KEY) {
  throw new Error("TMDB_API_KEY is missing in Environment Variables");
}

const bot = new Telegraf(BOT_TOKEN);

// TMDB API request
const tmdb = axios.create({
  baseURL: "https://api.themoviedb.org/3",
  timeout: 15000,
  params: {
    api_key: TMDB_KEY
  }
});

// Welcome message
bot.start((ctx) => {
  return ctx.reply(
    "🎬 Ku soo dhowow American Films!\n\n" +
    "Ii soo qor magaca filimka aad rabto inaan kuu raadiyo."
  );
});

// Search movies
bot.on("text", async (ctx) => {
  const query = ctx.message.text.trim();

  if (!query || query.startsWith("/")) return;

  try {
    await ctx.sendChatAction("typing");

    const response = await tmdb.get("/search/movie", {
      params: {
        query,
        language: "en-US"
      }
    });

    const movies = (response.data.results || []).slice(0, 5);

    if (movies.length === 0) {
      return ctx.reply(
        "❌ Filimkan lama helin. Isku day magac kale."
      );
    }

    const buttons = movies.map((movie) => {
      const year = movie.release_date
        ? movie.release_date.slice(0, 4)
        : "Unknown";

      return [{
        text: `${movie.title} (${year})`,
        callback_data: `movie:${movie.id}`
      }];
    });

    return ctx.reply(
      "🎥 Filimada la helay. Mid dooro:",
      {
        reply_markup: {
          inline_keyboard: buttons
        }
      }
    );

  } catch (error) {
    console.error(
      "TMDB SEARCH ERROR:",
      error.response?.data || error.message
    );

    return ctx.reply(
      "⚠️ Raadinta filimka way fashilantay. Fadlan mar kale isku day."
    );
  }
});

// Movie details
bot.action(/^movie:(\d+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.sendChatAction("typing");

    const id = ctx.match[1];

    const response = await tmdb.get(`/movie/${id}`, {
      params: {
        language: "en-US"
      }
    });

    const movie = response.data;

    const year = movie.release_date
      ? movie.release_date.slice(0, 4)
      : "Unknown";

    const rating = movie.vote_average
      ? movie.vote_average.toFixed(1) + "/10"
      : "Not available";

    const overview =
      movie.overview || "Faahfaahin lama hayo.";

    const caption =
      `🎬 ${movie.title}\n` +
      `📅 Sanadka: ${year}\n` +
      `⭐ Qiimeynta: ${rating}\n\n` +
      `${overview.slice(0, 700)}\n\n` +
      `📚 Xogta: TMDB`;

    if (movie.poster_path) {
      await ctx.replyWithPhoto(
        `https://image.tmdb.org/t/p/w500${movie.poster_path}`,
        { caption }
      );
    } else {
      await ctx.reply(caption);
    }

  } catch (error) {
    console.error(
      "MOVIE DETAILS ERROR:",
      error.response?.data || error.message
    );

    return ctx.reply(
      "⚠️ Faahfaahinta filimka lama soo heli karin."
    );
  }
});

// Error handling
bot.catch((error) => {
  console.error("BOT ERROR:", error);
});

// Start bot
bot.launch()
  .then(() => {
    console.log("🎬 American Films Bot is running!");
  })
  .catch((error) => {
    console.error("BOT START ERROR:", error);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
