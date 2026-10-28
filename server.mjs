import "dotenv/config";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import Database from "better-sqlite3";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(ROOT, "uploads"));
const VIDEO_DIR = path.join(UPLOAD_DIR, "videos");
const IMAGE_DIR = path.join(UPLOAD_DIR, "images");
const SUBTITLE_DIR = path.join(UPLOAD_DIR, "subtitles");
const PORT = Number(process.env.PORT || 3000);
const MAX_VIDEO_SIZE_MB = Number(process.env.MAX_VIDEO_SIZE_MB || 2048);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "";
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".ogg"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const SUBTITLE_EXTENSIONS = new Set([".srt", ".vtt"]);
const LANGUAGE_NAMES = {
  en: "English",
  sw: "Swahili",
  fr: "French",
  ar: "Arabic",
  pt: "Portuguese",
  es: "Spanish",
  other: "Other",
};
const r2Values = [R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME];
if (r2Values.some(Boolean) && r2Values.some((value) => !value)) {
  throw new Error("Set all R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME values.");
}
const r2Client = R2_ACCOUNT_ID
  ? new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    })
  : null;

for (const directory of [DATA_DIR, VIDEO_DIR, IMAGE_DIR, SUBTITLE_DIR]) {
  fs.mkdirSync(directory, { recursive: true });
}

if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) {
  throw new Error("Set ADMIN_PASSWORD in .env to a unique password of at least 12 characters.");
}
if (process.env.ADMIN_PASSWORD === "change-this-to-a-unique-password-of-at-least-12-characters") {
  throw new Error("Replace the example ADMIN_PASSWORD in .env before starting the server.");
}
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  throw new Error("Set SESSION_SECRET in .env to a random secret of at least 32 characters.");
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}
if (!Number.isInteger(MAX_VIDEO_SIZE_MB) || MAX_VIDEO_SIZE_MB < 1) {
  throw new Error("MAX_VIDEO_SIZE_MB must be a positive whole number.");
}
if (process.env.NODE_ENV === "production" && !FRONTEND_ORIGIN) {
  throw new Error("Set FRONTEND_ORIGIN to the public Netlify site URL.");
}
if (process.env.NODE_ENV === "production" && !r2Client) {
  throw new Error("Configure Cloudflare R2 before deploying the production media server.");
}

const sessionSecret = Buffer.from(process.env.SESSION_SECRET);
const expectedPassword = crypto.scryptSync(process.env.ADMIN_PASSWORD, sessionSecret, 64);
const database = new Database(path.join(DATA_DIR, "tazama.sqlite"));
database.pragma("journal_mode = WAL");
database.pragma("foreign_keys = ON");
database.exec(`
  CREATE TABLE IF NOT EXISTS movies (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    translated_title TEXT NOT NULL DEFAULT '',
    translated_language TEXT NOT NULL DEFAULT 'sw',
    synopsis TEXT NOT NULL DEFAULT '',
    translated_synopsis TEXT NOT NULL DEFAULT '',
    original_language TEXT NOT NULL DEFAULT 'other',
    release_year INTEGER,
    genres TEXT NOT NULL DEFAULT '',
    poster_file TEXT NOT NULL,
    video_file TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS subtitles (
    id TEXT PRIMARY KEY,
    movie_id TEXT NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
    language_code TEXT NOT NULL,
    language_name TEXT NOT NULL,
    subtitle_file TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS subtitles_movie_id ON subtitles(movie_id);
  CREATE TABLE IF NOT EXISTS revoked_sessions (
    nonce TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
`);
const movieColumns = new Set(database.prepare("PRAGMA table_info(movies)").all().map(({ name }) => name));
if (!movieColumns.has("content_type")) {
  database.exec("ALTER TABLE movies ADD COLUMN content_type TEXT NOT NULL DEFAULT 'movie'");
}
if (!movieColumns.has("vj_name")) {
  database.exec("ALTER TABLE movies ADD COLUMN vj_name TEXT NOT NULL DEFAULT ''");
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : false);
app.use((req, res, next) => {
  const origin = req.get("Origin");
  if (origin && origin === FRONTEND_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token, Range");
    res.setHeader("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range, ETag");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") return res.sendStatus(origin === FRONTEND_ORIGIN ? 204 : 403);
  next();
});
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'", ...(FRONTEND_ORIGIN ? [new URL(FRONTEND_ORIGIN).origin] : [])],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:", "https://images.unsplash.com", ...(FRONTEND_ORIGIN ? [new URL(FRONTEND_ORIGIN).origin] : [])],
        mediaSrc: ["'self'", "blob:", ...(FRONTEND_ORIGIN ? [new URL(FRONTEND_ORIGIN).origin] : [])],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "https://fonts.googleapis.com"],
        upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null,
      },
    },
  }),
);
app.use(express.json({ limit: "64kb" }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Try again in 15 minutes." },
});

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

function createToken() {
  const issuedAt = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(24).toString("base64url");
  const csrf = crypto.randomBytes(24).toString("base64url");
  const payload = `${issuedAt}.${nonce}.${csrf}`;
  return { token: `${payload}.${sign(payload)}`, csrf };
}

function getSession(req) {
  const cookie = req.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("tazama_admin="));
  if (!cookie) return null;

  let token;
  try {
    token = decodeURIComponent(cookie.slice("tazama_admin=".length));
  } catch {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [issuedAt, nonce, csrf, signature] = parts;
  const timestamp = Number(issuedAt);
  if (
    !Number.isInteger(timestamp) ||
    timestamp > Math.floor(Date.now() / 1000) ||
    Math.floor(Date.now() / 1000) - timestamp > SESSION_TTL_SECONDS
  ) {
    return null;
  }

  const payload = `${issuedAt}.${nonce}.${csrf}`;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  if (database.prepare("SELECT 1 FROM revoked_sessions WHERE nonce = ? AND expires_at > ?").get(nonce, Math.floor(Date.now() / 1000))) {
    return null;
  }
  return { csrf, nonce };
}

function setAuthCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const sameSite = FRONTEND_ORIGIN ? "None" : "Strict";
  res.setHeader(
    "Set-Cookie",
    `tazama_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${SESSION_TTL_SECONDS}${secure}`,
  );
}

function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Admin sign-in required." });
  const csrf = req.get("X-CSRF-Token") || "";
  const expected = Buffer.from(session.csrf);
  const actual = Buffer.from(csrf);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return res.status(403).json({ error: "Your session expired. Sign in again." });
  }
  req.adminSession = session;
  next();
}

function cleanFile(fileName) {
  return path.basename(fileName);
}

function languageName(code) {
  return LANGUAGE_NAMES[code] || LANGUAGE_NAMES.other;
}

function getMovie(id) {
  const movie = database.prepare("SELECT * FROM movies WHERE id = ?").get(id);
  if (!movie) return null;
  const subtitleTracks = database
    .prepare("SELECT language_code AS languageCode, language_name AS languageName, subtitle_file AS file FROM subtitles WHERE movie_id = ? ORDER BY rowid")
    .all(id)
    .map((track) => ({
      languageCode: track.languageCode,
      languageName: track.languageName,
      src: `/media/${encodeURIComponent(track.file)}`,
    }));

  return {
    id: movie.id,
    title: movie.title,
    translatedTitle: movie.translated_title,
    translatedLanguage: movie.translated_language,
    videoLanguage: movie.translated_language,
    videoLanguageName: languageName(movie.translated_language),
    synopsis: movie.synopsis,
    translatedSynopsis: movie.translated_synopsis,
    originalLanguage: movie.original_language,
    releaseYear: movie.release_year,
    genres: movie.genres.split(",").filter(Boolean),
    contentType: movie.content_type || "movie",
    vjName: movie.vj_name || "",
    poster: movie.poster_file ? `/media/${encodeURIComponent(movie.poster_file)}` : "",
    video: `/media/${encodeURIComponent(movie.video_file)}`,
    subtitleTracks,
    createdAt: movie.created_at,
  };
}

function getMovies() {
  return database
    .prepare("SELECT id FROM movies ORDER BY created_at DESC, rowid DESC")
    .all()
    .map(({ id }) => getMovie(id));
}

const storage = multer.diskStorage({
  destination(req, file, callback) {
    if (file.fieldname === "video") return callback(null, VIDEO_DIR);
    if (file.fieldname === "poster") return callback(null, IMAGE_DIR);
    if (file.fieldname === "subtitles") return callback(null, SUBTITLE_DIR);
    return callback(new Error("Unexpected upload field."));
  },
  filename(req, file, callback) {
    callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_VIDEO_SIZE_MB * 1024 * 1024,
    files: 10,
    fields: 20,
  },
  fileFilter(req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();
    const permitted =
      (file.fieldname === "video" && VIDEO_EXTENSIONS.has(extension)) ||
      (file.fieldname === "poster" && IMAGE_EXTENSIONS.has(extension)) ||
      (file.fieldname === "subtitles" && SUBTITLE_EXTENSIONS.has(extension));
    if (!permitted) return callback(new Error(`Unsupported file type for ${file.fieldname}.`));
    callback(null, true);
  },
});

function removeUploadedFiles(files = []) {
  for (const file of files) fs.rmSync(file.path, { force: true });
}

async function storeUploadedFiles(files) {
  if (!r2Client) return;
  const uploaded = [];
  try {
    for (const file of files) {
      await new Upload({
        client: r2Client,
        params: {
          Bucket: R2_BUCKET_NAME,
          Key: cleanFile(file.filename),
          Body: fs.createReadStream(file.path),
          ContentType: file.mimetype,
        },
      }).done();
      uploaded.push(cleanFile(file.filename));
    }
  } catch (error) {
    const cleanup = await Promise.allSettled(uploaded.map((key) => r2Client.send(
      new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }),
    )));
    for (const result of cleanup) {
      if (result.status === "rejected") console.error("Could not clean up an incomplete R2 upload.", result.reason);
    }
    throw error;
  }
}

async function deleteStoredFiles(files) {
  const names = files.filter(Boolean).map(cleanFile);
  if (r2Client) {
    await Promise.all(names.map((Key) => r2Client.send(new DeleteObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key,
    }))));
    return;
  }
  for (const name of names) {
    const directory = VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase())
      ? VIDEO_DIR
      : IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())
        ? IMAGE_DIR
        : SUBTITLE_DIR;
    fs.rmSync(path.join(directory, name), { force: true });
  }
}

function hasExpectedSignature(file, allowedSignatures) {
  const descriptor = fs.openSync(file.path, "r");
  const header = Buffer.alloc(16);
  try {
    const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
    return allowedSignatures.some((matches) => matches(header.subarray(0, bytesRead)));
  } finally {
    fs.closeSync(descriptor);
  }
}

function isValidVideo(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  const signatures = {
    ".mp4": (header) => header.toString("ascii", 4, 8) === "ftyp",
    ".webm": (header) => header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
    ".ogg": (header) => header.toString("ascii", 0, 4) === "OggS",
  };
  return hasExpectedSignature(file, [signatures[extension]]);
}

function isValidPoster(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  const signatures = {
    ".jpg": (header) => header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff,
    ".jpeg": (header) => header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff,
    ".png": (header) => header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ".webp": (header) => header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP",
  };
  return hasExpectedSignature(file, [signatures[extension]]);
}

function normalizeSubtitles(file, languageCode) {
  let contents = fs.readFileSync(file.path, "utf8").replace(/^\uFEFF/, "");
  if (path.extname(file.originalname).toLowerCase() === ".srt") {
    contents = `WEBVTT\n\n${contents.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")}`;
    const convertedFileName = `${path.parse(file.filename).name}.vtt`;
    const convertedPath = path.join(SUBTITLE_DIR, convertedFileName);
    fs.writeFileSync(convertedPath, contents, "utf8");
    fs.rmSync(file.path, { force: true });
    file.path = convertedPath;
    file.filename = convertedFileName;
  } else if (!contents.startsWith("WEBVTT")) {
    throw new Error(`${file.originalname} is not a valid WebVTT subtitle file.`);
  }
  file.mimetype = "text/vtt";
  return {
    id: crypto.randomUUID(),
    file: cleanFile(file.filename),
    code: languageCode,
    name: languageName(languageCode),
  };
}

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", mediaStorage: r2Client ? "r2" : "local" });
});

app.get("/api/movies", (req, res) => {
  const allMovies = getMovies();
  const search = String(req.query.search || "").trim().toLocaleLowerCase();
  const genre = String(req.query.genre || "").trim().toLocaleLowerCase();
  const type = String(req.query.type || "").trim().toLocaleLowerCase();
  const vj = String(req.query.vj || "").trim().toLocaleLowerCase();
  const movies = allMovies.filter((movie) => {
    const matchesSearch =
      !search ||
      [movie.title, movie.synopsis, ...movie.genres]
        .concat(movie.vjName || "")
        .join(" ")
        .toLocaleLowerCase()
        .includes(search);
    const matchesGenre = !genre || movie.genres.some((item) => item.toLocaleLowerCase() === genre);
    return matchesSearch && matchesGenre && (!type || movie.contentType === type) &&
      (!vj || movie.vjName.toLocaleLowerCase() === vj);
  });
  res.json({
    movies,
    genres: [...new Set(allMovies.flatMap((movie) => movie.genres))].sort(),
    vjs: [...new Set(allMovies.map((movie) => movie.vjName).filter(Boolean))].sort(),
  });
});

app.get("/api/movies/:id", (req, res) => {
  const movie = getMovie(req.params.id);
  if (!movie) return res.status(404).json({ error: "Movie not found." });
  res.json({ movie });
});

app.get("/api/auth", (req, res) => {
  const session = getSession(req);
  res.json({ authenticated: Boolean(session), csrf: session?.csrf || null });
});

app.get("/api/admin/storage", requireAdmin, async (req, res, next) => {
  if (!r2Client) {
    return res.status(409).json({ connected: false, error: "Cloudflare R2 is not configured." });
  }
  try {
    await r2Client.send(new HeadBucketCommand({ Bucket: R2_BUCKET_NAME }));
    res.json({ connected: true, bucket: R2_BUCKET_NAME });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/login", loginLimiter, (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const supplied = crypto.scryptSync(password, sessionSecret, 64);
  if (password.length === 0 || !crypto.timingSafeEqual(expectedPassword, supplied)) {
    return res.status(401).json({ error: "That password doesn’t match." });
  }
  database.prepare("DELETE FROM revoked_sessions WHERE expires_at <= ?").run(Math.floor(Date.now() / 1000));
  const { token, csrf } = createToken();
  setAuthCookie(res, token);
  res.json({ authenticated: true, csrf });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  database.prepare("INSERT OR REPLACE INTO revoked_sessions (nonce, expires_at) VALUES (?, ?)").run(
    req.adminSession.nonce,
    Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  );
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const sameSite = FRONTEND_ORIGIN ? "None" : "Strict";
  res.setHeader("Set-Cookie", `tazama_admin=; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=0${secure}`);
  res.json({ authenticated: false });
});

app.post(
  "/api/admin/movies",
  requireAdmin,
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "poster", maxCount: 1 },
    { name: "subtitles", maxCount: 8 },
  ]),
  async (req, res) => {
    const files = Object.values(req.files || {}).flat();
    let remoteFilesStored = false;
    try {
      const video = req.files?.video?.[0];
      const poster = req.files?.poster?.[0];
      if (!video) {
        removeUploadedFiles(files);
        return res.status(400).json({ error: "A translated movie video is required." });
      }
      if (poster && poster.size > 5 * 1024 * 1024) {
        removeUploadedFiles(files);
        return res.status(400).json({ error: "Poster images must be 5 MB or smaller." });
      }
      const subtitleFiles = req.files?.subtitles || [];
      if (subtitleFiles.some((file) => file.size > 2 * 1024 * 1024)) {
        removeUploadedFiles(files);
        return res.status(400).json({ error: "Subtitle files must be 2 MB or smaller." });
      }
      if (poster && !isValidPoster(poster)) {
        removeUploadedFiles(files);
        return res.status(400).json({ error: "The poster contents do not match a supported image format." });
      }
      if (!isValidVideo(video)) {
        removeUploadedFiles(files);
        return res.status(400).json({ error: "The video contents do not match a supported video format." });
      }

      const title = String(req.body.title || "").trim();
      const synopsis = String(req.body.synopsis || "").trim();
      const videoLanguage = String(req.body.videoLanguage || req.body.translatedLanguage || "other");
      const contentType = String(req.body.contentType || "movie");
      const vjName = String(req.body.vjName || "").trim();
      const releaseYear = req.body.releaseYear ? Number(req.body.releaseYear) : null;
      const genres = String(req.body.genres || "")
        .split(",")
        .map((genre) => genre.trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 8);

      if (!title || title.length > 120 || synopsis.length > 2000) {
        removeUploadedFiles(files);
        return res.status(400).json({ error: "Add a film title (up to 120 characters) and keep its description under 2,000 characters." });
      }
      if (!LANGUAGE_NAMES[videoLanguage]) {
        removeUploadedFiles(files);
        return res.status(400).json({ error: "Choose the language spoken in your uploaded video." });
      }
      if (!["movie", "series", "tv"].includes(contentType)) {
        removeUploadedFiles(files);
        return res.status(400).json({ error: "Choose Movie, Series, or TV Show as the content type." });
      }
      if (vjName.length > 60) {
        removeUploadedFiles(files);
        return res.status(400).json({ error: "VJ names must be 60 characters or fewer." });
      }
      if (releaseYear !== null && (!Number.isInteger(releaseYear) || releaseYear < 1888 || releaseYear > new Date().getFullYear() + 2)) {
        removeUploadedFiles(files);
        return res.status(400).json({ error: "Enter a valid release year." });
      }

      const rawLanguages = req.body.subtitleLanguages;
      const subtitleLanguages = Array.isArray(rawLanguages) ? rawLanguages : rawLanguages ? [rawLanguages] : [];
      if (subtitleFiles.length !== subtitleLanguages.length || subtitleLanguages.some((code) => !LANGUAGE_NAMES[code])) {
        removeUploadedFiles(files);
        return res.status(400).json({ error: "Choose a language for every subtitle file." });
      }

      const subtitles = subtitleFiles.map((file, index) => normalizeSubtitles(file, subtitleLanguages[index]));
      await storeUploadedFiles(files);
      remoteFilesStored = Boolean(r2Client);
      const id = crypto.randomUUID();
      const insertMovie = database.prepare(`
        INSERT INTO movies (id, title, translated_title, translated_language, synopsis, translated_synopsis, original_language, release_year, genres, poster_file, video_file, content_type, vj_name)
        VALUES (@id, @title, @translatedTitle, @translatedLanguage, @synopsis, @translatedSynopsis, @originalLanguage, @releaseYear, @genres, @posterFile, @videoFile, @contentType, @vjName)
      `);
      const insertSubtitle = database.prepare(`
        INSERT INTO subtitles (id, movie_id, language_code, language_name, subtitle_file)
        VALUES (@id, @movieId, @code, @name, @file)
      `);
      database.transaction(() => {
        insertMovie.run({
          id,
          title: title.slice(0, 120),
          translatedTitle: title.slice(0, 120),
          translatedLanguage: videoLanguage,
          synopsis,
          translatedSynopsis: synopsis,
          originalLanguage: videoLanguage,
          releaseYear,
          genres: genres.join(","),
          posterFile: poster ? cleanFile(poster.filename) : "",
          videoFile: cleanFile(video.filename),
          contentType,
          vjName,
        });
        for (const subtitle of subtitles) insertSubtitle.run({ ...subtitle, movieId: id });
      })();
      if (r2Client) removeUploadedFiles(files);
      res.status(201).json({ movie: getMovie(id) });
    } catch (error) {
      removeUploadedFiles(files);
      if (remoteFilesStored) {
        try {
          await deleteStoredFiles(files.map((file) => file.filename));
        } catch (cleanupError) {
          console.error("Could not clean up R2 objects after a failed movie upload.", cleanupError);
        }
      }
      throw error;
    }
  },
);

app.patch("/api/admin/movies/:id", requireAdmin, (req, res) => {
  const movie = database.prepare("SELECT id FROM movies WHERE id = ?").get(req.params.id);
  if (!movie) return res.status(404).json({ error: "Movie not found." });

  const contentType = String(req.body.contentType || "");
  const vjName = String(req.body.vjName || "").trim();
  if (!["movie", "series", "tv"].includes(contentType)) {
    return res.status(400).json({ error: "Choose Movie, Series, or TV Show as the content type." });
  }
  if (vjName.length > 60) {
    return res.status(400).json({ error: "VJ names must be 60 characters or fewer." });
  }

  database.prepare("UPDATE movies SET content_type = ?, vj_name = ? WHERE id = ?")
    .run(contentType, vjName, movie.id);
  res.json({ movie: getMovie(movie.id) });
});

app.delete("/api/admin/movies/:id", requireAdmin, async (req, res, next) => {
  const movie = database.prepare("SELECT * FROM movies WHERE id = ?").get(req.params.id);
  if (!movie) return res.status(404).json({ error: "Movie not found." });
  const subtitleFiles = database.prepare("SELECT subtitle_file FROM subtitles WHERE movie_id = ?").all(movie.id);
  try {
    await deleteStoredFiles([movie.video_file, movie.poster_file, ...subtitleFiles.map((row) => row.subtitle_file)]);
    database.prepare("DELETE FROM movies WHERE id = ?").run(movie.id);
    res.json({ deleted: true });
  } catch (error) {
    next(error);
  }
});

app.get("/media/:file", async (req, res, next) => {
  const file = req.params.file;
  const extension = path.extname(file).toLowerCase();
  const allowed = new Set([...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS, ".vtt"]);
  if (path.basename(file) !== file || !/^[0-9a-f-]{36}\.[a-z0-9]+$/i.test(file) || !allowed.has(extension)) {
    return res.status(404).end();
  }
  if (r2Client) {
    try {
      const range = /^bytes=\d*-\d*$/.test(req.get("Range") || "") ? req.get("Range") : undefined;
      const object = await r2Client.send(new GetObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: file,
        Range: range,
      }));
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", object.ContentType || "application/octet-stream");
      res.setHeader("Cache-Control", "public, max-age=3600");
      if (object.ContentLength !== undefined) res.setHeader("Content-Length", object.ContentLength);
      if (object.ContentRange) res.setHeader("Content-Range", object.ContentRange);
      if (object.ETag) res.setHeader("ETag", object.ETag);
      res.status(object.ContentRange ? 206 : 200);
      object.Body.pipe(res);
      object.Body.on("error", next);
    } catch (error) {
      if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404) return res.status(404).end();
      next(error);
    }
    return;
  }
  const directory = VIDEO_EXTENSIONS.has(extension)
    ? VIDEO_DIR
    : IMAGE_EXTENSIONS.has(extension)
      ? IMAGE_DIR
      : SUBTITLE_DIR;
  res.sendFile(file, { root: directory, dotfiles: "deny" }, (error) => {
    if (error && !res.headersSent) next(error);
  });
});

app.use(express.static(PUBLIC_DIR, {
  extensions: ["html"],
  setHeaders(res, filePath) {
    if ([".html", ".css", ".js"].includes(path.extname(filePath))) {
      res.setHeader("Cache-Control", "no-store");
    }
  },
}));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE"
      ? `That file is too large. The upload limit is ${MAX_VIDEO_SIZE_MB} MB per file.`
      : "The upload could not be completed. Check the number and size of your files.";
    return res.status(400).json({ error: message });
  }
  if (error.message?.startsWith("Unsupported file type") || error.message?.includes("valid WebVTT")) {
    return res.status(400).json({ error: error.message });
  }
  console.error(error);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

app.listen(PORT, () => {
  console.log(`Tazama is ready at http://localhost:${PORT}`);
});
