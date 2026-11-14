
const { Telegraf } = require("telegraf");
const axios = require("axios");
const fs = require("fs");

const bot = new Telegraf(process.env.BOT_TOKEN);
const TMDB_KEY = process.env.TMDB_API_KEY;

const CACHE_FILE = "./cache.json";
let cache = {};

if (fs.existsSync(CACHE_FILE)) {
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    cache = {};
  }
}

function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function clean(text) {
  return text.trim().toLowerCase();
}

bot.start((ctx) => {
  ctx.reply(
    "🎬 Ku soo dhowow American Films!\n\n" +
    "Ii soo qor magaca filimka aad rabto inaan kuu raadiyo."
  );
});

bot.on("text", async (ctx) => {
  const query = ctx.message.text.trim();

  if (query.startsWith("/")) return;

  const key = clean(query);

  try {
    let movies = cache["search_" + key];

    if (!movies) {
      const response = await axios.get(
        "https://api.themoviedb.org/3/search/movie",
        {
          params: {
            api_key: TMDB_KEY,
            query: query,
            language: "en-US"
          }
        }
      );

      movies = response.data.results.slice(0, 5);

      cache["search_" + key] = movies;
      movies.forEach(movie => {
        cache["movie_" + movie.id] = movie;
      });

      saveCache();
    }

    if (!movies || movies.length === 0) {
      return ctx.reply("❌ Filimkan lama helin. Isku day magac kale.");
    }

    const buttons = movies.map(movie => {
      const year = movie.release_date
        ? movie.release_date.slice(0, 4)
        : "Unknown";

      return [{
        text: `${movie.title} (${year})`,
        callback_data: `movie:${movie.id}`
      }];
    });

    await ctx.reply(
      "🎥 Filimada la helay. Mid dooro:",
      {
        reply_markup: {
          inline_keyboard: buttons
        }
      }
    );

  } catch (error) {
    console.error(error.response?.data || error.message);
    ctx.reply("⚠️ Cilad ayaa dhacday. Mar kale isku day.");
  }
});

bot.action(/^movie:(\d+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();

    const id = ctx.match[1];
    let movie = cache["movie_" + id];

    if (!movie) {
      const response = await axios.get(
        `https://api.themoviedb.org/3/movie/${id}`,
        {
          params: {
            api_key: TMDB_KEY,
            language: "en-US"
          }
        }
      );

      movie = response.data;
      cache["movie_" + id] = movie;
      saveCache();
    }

    const year = movie.release_date
      ? movie.release_date.slice(0, 4)
      : "Unknown";

    const rating = movie.vote_average
      ? movie.vote_average.toFixed(1) + "/10"
      : "Not available";

    const overview = movie.overview || "Faahfaahin lama hayo.";
    const caption =
      `🎬 ${movie.title}\n` +
      `📅 Sanadka: ${year}\n` +
      `⭐ Qiimeynta: ${rating}\n\n` +
      `${overview.slice(0, 750)}\n\n` +
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
    console.error(error.response?.data || error.message);
    ctx.reply("⚠️ Faahfaahinta filimka lama soo heli karin.");
  }
});

bot.catch((error) => {
  console.error("Bot error:", error);
});

bot.launch();
console.log("🎬 American Films Bot is running!");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
