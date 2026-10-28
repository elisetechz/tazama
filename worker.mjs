const SESSION_TTL_SECONDS = 12 * 60 * 60;
const UPLOAD_TTL_SECONDS = 24 * 60 * 60;
const PART_SIZE = 8 * 1024 * 1024;
const MAX_VIDEO_SIZE = 2 * 1024 * 1024 * 1024;
const LANGUAGES = {
  en: "English",
  sw: "Swahili",
  fr: "French",
  ar: "Arabic",
  pt: "Portuguese",
  es: "Spanish",
  other: "Other",
};
const EXTENSIONS = {
  video: new Set([".mp4", ".webm", ".ogg"]),
  poster: new Set([".jpg", ".jpeg", ".png", ".webp"]),
  subtitles: new Set([".srt", ".vtt"]),
};
const MIME_TYPES = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "video/ogg",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".srt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== env.FRONTEND_ORIGIN) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-CSRF-Token, Range",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, ETag",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function cookieOptions(env, maxAge = SESSION_TTL_SECONDS) {
  const sameSite = env.FRONTEND_ORIGIN ? "None" : "Strict";
  return `HttpOnly; Secure; SameSite=${sameSite}; Path=/; Max-Age=${maxAge}`;
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const value = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!value) return "";
  try {
    return decodeURIComponent(value.slice(name.length + 1));
  } catch {
    return "";
  }
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

async function createSession(env) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const csrf = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const payload = `${issuedAt}.${nonce}.${csrf}`;
  return { token: `${payload}.${await hmac(payload, env.SESSION_SECRET)}`, csrf };
}

function equalStrings(left, right) {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    mismatch |= (a[index] || 0) ^ (b[index] || 0);
  }
  return mismatch === 0;
}

async function getSession(request, env) {
  const token = getCookie(request, "tazama_admin");
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [issuedAt, nonce, csrf, signature] = parts;
  const now = Math.floor(Date.now() / 1000);
  const timestamp = Number(issuedAt);
  if (!Number.isInteger(timestamp) || timestamp > now || now - timestamp > SESSION_TTL_SECONDS) return null;
  if (!equalStrings(signature, await hmac(`${issuedAt}.${nonce}.${csrf}`, env.SESSION_SECRET))) return null;
  const revoked = await env.DB.prepare(
    "SELECT 1 FROM revoked_sessions WHERE nonce = ? AND expires_at > ?",
  ).bind(nonce, now).first();
  return revoked ? null : { csrf, nonce };
}

async function requireAdmin(request, env, needsCsrf = true) {
  const session = await getSession(request, env);
  if (!session) return { response: json({ error: "Admin sign-in required." }, 401) };
  if (needsCsrf && !equalStrings(request.headers.get("X-CSRF-Token") || "", session.csrf)) {
    return { response: json({ error: "Your session expired. Sign in again." }, 403) };
  }
  return { session };
}

async function readJson(request, maxBytes = 64 * 1024) {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > maxBytes) throw new Error("Request is too large.");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("Request is too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON request.");
  }
}

async function readLimitedBody(request, maxBytes) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("An upload part is required.");
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Upload parts must be 8 MB or smaller.");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function getFileExtension(name) {
  const cleanName = String(name || "").split(/[\\/]/).pop() || "";
  const index = cleanName.lastIndexOf(".");
  return index < 0 ? "" : cleanName.slice(index).toLowerCase();
}

function getMimeType(extension) {
  return MIME_TYPES[extension] || "application/octet-stream";
}

function normalizeMovie(row, subtitles) {
  const tracks = subtitles.get(row.id) || [];
  return {
    id: row.id,
    title: row.title,
    translatedTitle: row.translated_title,
    translatedLanguage: row.translated_language,
    videoLanguage: row.translated_language,
    videoLanguageName: LANGUAGES[row.translated_language] || LANGUAGES.other,
    synopsis: row.synopsis,
    translatedSynopsis: row.translated_synopsis,
    originalLanguage: row.original_language,
    releaseYear: row.release_year,
    genres: row.genres.split(",").filter(Boolean),
    contentType: row.content_type || "movie",
    vjName: row.vj_name || "",
    poster: row.poster_file ? `/media/${encodeURIComponent(row.poster_file)}` : "",
    video: `/media/${encodeURIComponent(row.video_file)}`,
    subtitleTracks: tracks.map((track) => ({
      languageCode: track.language_code,
      languageName: track.language_name,
      src: `/media/${encodeURIComponent(track.subtitle_file)}`,
    })),
    createdAt: row.created_at,
  };
}

async function listMovies(env) {
  const { results = [] } = await env.DB.prepare(
    "SELECT * FROM movies ORDER BY created_at DESC, id DESC",
  ).all();
  if (!results.length) return [];
  const { results: subtitleRows = [] } = await env.DB.prepare(
    "SELECT * FROM subtitles ORDER BY movie_id, id",
  ).all();
  const subtitles = new Map();
  for (const track of subtitleRows) {
    if (!subtitles.has(track.movie_id)) subtitles.set(track.movie_id, []);
    subtitles.get(track.movie_id).push(track);
  }
  return results.map((row) => normalizeMovie(row, subtitles));
}

function validateMetadata(metadata, files) {
  if (!metadata || typeof metadata !== "object" || !Array.isArray(files)) {
    throw new Error("Movie details and files are required.");
  }
  const title = String(metadata.title || "").trim();
  const synopsis = String(metadata.synopsis || "").trim();
  const videoLanguage = String(metadata.videoLanguage || "");
  const contentType = String(metadata.contentType || "movie");
  const vjName = String(metadata.vjName || "").trim();
  const releaseYear = metadata.releaseYear ? Number(metadata.releaseYear) : null;
  const genres = String(metadata.genres || "").split(",").map((item) => item.trim().slice(0, 40)).filter(Boolean).slice(0, 8);
  if (!title || title.length > 120 || synopsis.length > 2000) {
    throw new Error("Add a film title (up to 120 characters) and keep its description under 2,000 characters.");
  }
  if (!LANGUAGES[videoLanguage]) throw new Error("Choose the language spoken in your uploaded video.");
  if (!["movie", "series", "tv"].includes(contentType)) throw new Error("Choose Movie, Series, or TV Show as the content type.");
  if (vjName.length > 60) throw new Error("VJ names must be 60 characters or fewer.");
  if (releaseYear !== null && (!Number.isInteger(releaseYear) || releaseYear < 1888 || releaseYear > new Date().getFullYear() + 2)) {
    throw new Error("Enter a valid release year.");
  }
  if (files.length < 1 || files.length > 10 || files.filter((file) => file.field === "video").length !== 1) {
    throw new Error("Choose one video and no more than nine optional files.");
  }
  if (files.filter((file) => file.field === "poster").length > 1 || files.filter((file) => file.field === "subtitles").length > 8) {
    throw new Error("Choose at most one poster and eight subtitle files.");
  }
  const normalizedFiles = files.map((file) => {
    const extension = getFileExtension(file.name);
    if (!file || !["video", "poster", "subtitles"].includes(file.field) || !EXTENSIONS[file.field].has(extension)) {
      throw new Error("A file has an unsupported type.");
    }
    if (!Number.isSafeInteger(file.size) || file.size < 1) throw new Error("A selected file is empty or invalid.");
    if (file.field === "video" && file.size > MAX_VIDEO_SIZE) throw new Error("Videos must be 2 GB or smaller.");
    if (file.field === "poster" && file.size > 5 * 1024 * 1024) throw new Error("Poster images must be 5 MB or smaller.");
    if (file.field === "subtitles" && (file.size > 2 * 1024 * 1024 || !LANGUAGES[file.languageCode])) {
      throw new Error("Subtitle files must be 2 MB or smaller and have a selected language.");
    }
    return {
      id: String(file.id || ""),
      field: file.field,
      name: String(file.name).split(/[\\/]/).pop().slice(0, 180),
      size: file.size,
      extension,
      languageCode: file.field === "subtitles" ? file.languageCode : "",
      key: `${crypto.randomUUID()}${extension}`,
    };
  });
  if (normalizedFiles.some((file) => !/^[\w-]{1,80}$/.test(file.id)) ||
      new Set(normalizedFiles.map((file) => file.id)).size !== normalizedFiles.length) {
    throw new Error("Invalid file upload identifiers.");
  }
  return {
    metadata: {
      title,
      synopsis,
      videoLanguage,
      contentType,
      vjName,
      releaseYear,
      genres,
    },
    files: normalizedFiles,
  };
}

async function getUploadSession(env, uploadId, nonce) {
  const row = await env.DB.prepare(
    "SELECT * FROM upload_sessions WHERE id = ? AND admin_nonce = ? AND expires_at > ?",
  ).bind(uploadId, nonce, Math.floor(Date.now() / 1000)).first();
  if (!row) return null;
  return { ...row, files: JSON.parse(row.files_json), metadata: JSON.parse(row.metadata_json) };
}

async function cleanupUpload(env, upload) {
  for (const file of upload.files) {
    if (file.multipart_id) {
      try {
        await env.MEDIA_BUCKET.resumeMultipartUpload(file.key, file.multipart_id).abort();
      } catch (error) {
        console.error("Could not abort incomplete R2 upload.", error);
      }
    }
    await env.MEDIA_BUCKET.delete(file.key);
  }
  await env.DB.prepare("DELETE FROM upload_sessions WHERE id = ?").bind(upload.id).run();
}

function isValidSignature(extension, bytes) {
  if (extension === ".mp4") return bytes.length >= 8 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp";
  if (extension === ".webm") return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  if (extension === ".ogg") return String.fromCharCode(...bytes.slice(0, 4)) === "OggS";
  if (extension === ".jpg" || extension === ".jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (extension === ".png") return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  if (extension === ".webp") return String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  return true;
}

async function validateStoredFile(bucket, file) {
  const object = await bucket.get(file.key, { range: { offset: 0, length: 16 } });
  if (!object) throw new Error("An uploaded file could not be found in R2.");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (!isValidSignature(file.extension, bytes)) {
    throw new Error(file.field === "video"
      ? "The video contents do not match a supported video format."
      : "The poster contents do not match a supported image format.");
  }
}

async function readSubtitle(bucket, file) {
  const object = await bucket.get(file.key);
  if (!object) throw new Error("An uploaded subtitle could not be found in R2.");
  let text = (await object.text()).replace(/^\uFEFF/, "");
  if (file.extension === ".srt") {
    text = `WEBVTT\n\n${text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")}`;
    const newKey = `${crypto.randomUUID()}.vtt`;
    await bucket.put(newKey, text, { httpMetadata: { contentType: "text/vtt; charset=utf-8" } });
    await bucket.delete(file.key);
    return newKey;
  }
  if (!text.startsWith("WEBVTT")) throw new Error(`${file.name} is not a valid WebVTT subtitle file.`);
  await bucket.put(file.key, text, { httpMetadata: { contentType: "text/vtt; charset=utf-8" } });
  return file.key;
}

function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value || "");
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!suffix) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

async function serveMedia(request, env, key) {
  if (!key || key.includes("/") || key.includes("\\")) return new Response("Not found", { status: 404 });
  const rangeHeader = request.headers.get("Range");
  if (!rangeHeader) {
    const object = await env.MEDIA_BUCKET.get(key);
    if (!object) return new Response("Not found", { status: 404 });
    return new Response(object.body, {
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Type": object.httpMetadata?.contentType || getMimeType(getFileExtension(key)),
        "Content-Length": String(object.size),
        "Cache-Control": "public, max-age=3600",
        ETag: object.httpEtag,
      },
    });
  }
  const metadata = await env.MEDIA_BUCKET.head(key);
  if (!metadata) return new Response("Not found", { status: 404 });
  const range = parseRange(rangeHeader, metadata.size);
  if (!range) return new Response(null, {
    status: 416,
    headers: { "Content-Range": `bytes */${metadata.size}`, "Accept-Ranges": "bytes" },
  });
  const object = await env.MEDIA_BUCKET.get(key, {
    range: { offset: range.start, length: range.end - range.start + 1 },
  });
  if (!object) return new Response("Not found", { status: 404 });
  return new Response(object.body, {
    status: 206,
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Type": metadata.httpMetadata?.contentType || getMimeType(getFileExtension(key)),
      "Content-Length": String(range.end - range.start + 1),
      "Content-Range": `bytes ${range.start}-${range.end}/${metadata.size}`,
      "Cache-Control": "public, max-age=3600",
      ETag: metadata.httpEtag,
    },
  });
}

async function handleApi(request, env) {
  if (!env.DB || !env.MEDIA_BUCKET || !env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
    return json({ error: "Cloudflare Worker bindings and secrets are not fully configured." }, 503);
  }
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/health") {
    return json({ status: "ok", mediaStorage: "r2", runtime: "cloudflare-workers" });
  }
  if (request.method === "GET" && path === "/api/movies") {
    const allMovies = await listMovies(env);
    const search = (url.searchParams.get("search") || "").trim().toLocaleLowerCase();
    const genre = (url.searchParams.get("genre") || "").trim().toLocaleLowerCase();
    const type = (url.searchParams.get("type") || "").trim().toLocaleLowerCase();
    const vj = (url.searchParams.get("vj") || "").trim().toLocaleLowerCase();
    const movies = allMovies.filter((movie) => {
      const matchesSearch = !search || [movie.title, movie.synopsis, ...movie.genres, movie.vjName]
        .join(" ").toLocaleLowerCase().includes(search);
      const matchesGenre = !genre || movie.genres.some((item) => item.toLocaleLowerCase() === genre);
      return matchesSearch && matchesGenre && (!type || movie.contentType === type) &&
        (!vj || movie.vjName.toLocaleLowerCase() === vj);
    });
    return json({
      movies,
      genres: [...new Set(allMovies.flatMap((movie) => movie.genres))].sort(),
      vjs: [...new Set(allMovies.map((movie) => movie.vjName).filter(Boolean))].sort(),
    });
  }
  const movieMatch = /^\/api\/movies\/([^/]+)$/.exec(path);
  if (request.method === "GET" && movieMatch) {
    const movie = (await listMovies(env)).find((item) => item.id === decodeURIComponent(movieMatch[1]));
    return movie ? json({ movie }) : json({ error: "Movie not found." }, 404);
  }
  if (request.method === "GET" && path === "/api/auth") {
    const session = await getSession(request, env);
    return json({ authenticated: Boolean(session), csrf: session?.csrf || null });
  }
  if (request.method === "POST" && path === "/api/admin/login") {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const cutoff = Math.floor(Date.now() / 1000) - 15 * 60;
    const attempts = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM login_attempts WHERE ip = ? AND created_at > ?",
    ).bind(ip, cutoff).first();
    if ((attempts?.count || 0) >= 10) return json({ error: "Too many sign-in attempts. Try again in 15 minutes." }, 429);
    await env.DB.prepare("INSERT INTO login_attempts (ip, created_at) VALUES (?, ?)").bind(ip, Math.floor(Date.now() / 1000)).run();
    let body;
    try {
      body = await readJson(request, 4 * 1024);
    } catch (error) {
      return json({ error: error.message }, 400);
    }
    const supplied = typeof body.password === "string" ? body.password : "";
    const actualDigest = toBase64Url(new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${env.SESSION_SECRET}:${supplied}`),
    )));
    const expectedDigest = toBase64Url(new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${env.SESSION_SECRET}:${env.ADMIN_PASSWORD}`),
    )));
    if (!supplied || !equalStrings(actualDigest, expectedDigest)) return json({ error: "That password doesn’t match." }, 401);
    const { token, csrf } = await createSession(env);
    return json({ authenticated: true, csrf }, 200, { "Set-Cookie": `tazama_admin=${encodeURIComponent(token)}; ${cookieOptions(env)}` });
  }
  if (request.method === "POST" && path === "/api/admin/logout") {
    const auth = await requireAdmin(request, env);
    if (auth.response) return auth.response;
    await env.DB.prepare("INSERT OR REPLACE INTO revoked_sessions (nonce, expires_at) VALUES (?, ?)")
      .bind(auth.session.nonce, Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS).run();
    return json({ authenticated: false }, 200, { "Set-Cookie": `tazama_admin=; ${cookieOptions(env, 0)}` });
  }
  if (request.method === "GET" && path === "/api/admin/storage") {
    const auth = await requireAdmin(request, env, false);
    if (auth.response) return auth.response;
    return json({ connected: true, bucket: env.MEDIA_BUCKET_NAME || "configured R2 bucket" });
  }
  if (request.method === "POST" && path === "/api/admin/uploads") {
    const auth = await requireAdmin(request, env);
    if (auth.response) return auth.response;
    let body;
    let validated;
    try {
      body = await readJson(request);
      validated = validateMetadata(body.metadata, body.files);
    } catch (error) {
      return json({ error: error.message }, 400);
    }
    const uploadId = crypto.randomUUID();
    const files = [];
    try {
      for (const file of validated.files) {
        const multipart = await env.MEDIA_BUCKET.createMultipartUpload(file.key, {
          httpMetadata: { contentType: getMimeType(file.extension) },
        });
        files.push({ ...file, multipart_id: multipart.uploadId });
      }
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        "INSERT INTO upload_sessions (id, admin_nonce, metadata_json, files_json, expires_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(uploadId, auth.session.nonce, JSON.stringify(validated.metadata), JSON.stringify(files), now + UPLOAD_TTL_SECONDS).run();
      return json({ uploadId, partSize: PART_SIZE, files: files.map(({ id }) => ({ id })) }, 201);
    } catch (error) {
      await Promise.all(files.map((file) => env.MEDIA_BUCKET.resumeMultipartUpload(file.key, file.multipart_id).abort()));
      console.error("Could not initialize R2 multipart upload.", error);
      return json({ error: "Could not start the R2 upload." }, 502);
    }
  }
  const partMatch = /^\/api\/admin\/uploads\/([0-9a-f-]+)\/files\/([\w-]+)\/parts\/(\d+)$/.exec(path);
  if (request.method === "POST" && partMatch) {
    const auth = await requireAdmin(request, env);
    if (auth.response) return auth.response;
    const [, uploadId, fileId, partText] = partMatch;
    const upload = await getUploadSession(env, uploadId, auth.session.nonce);
    if (!upload) return json({ error: "This upload expired. Please start again." }, 404);
    const file = upload.files.find((item) => item.id === fileId);
    const partNumber = Number(partText);
    if (!file || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000 ||
        !request.body) {
      return json({ error: "Invalid upload part." }, 400);
    }
    if (partNumber > Math.ceil(file.size / PART_SIZE)) return json({ error: "Upload part is outside the file size." }, 400);
    try {
      const data = await readLimitedBody(request, PART_SIZE);
      const expectedSize = Math.min(PART_SIZE, file.size - (partNumber - 1) * PART_SIZE);
      if (data.byteLength !== expectedSize) return json({ error: "Upload part size mismatch." }, 400);
      const multipart = env.MEDIA_BUCKET.resumeMultipartUpload(file.key, file.multipart_id);
      const part = await multipart.uploadPart(partNumber, data);
      await env.DB.prepare(
        "INSERT OR REPLACE INTO upload_parts (upload_id, file_id, part_number, etag) VALUES (?, ?, ?, ?)",
      ).bind(uploadId, fileId, partNumber, part.etag).run();
      return json({ accepted: true, partNumber });
    } catch (error) {
      console.error("R2 upload part failed.", error);
      return json({ error: "R2 could not store this upload part. Please retry it." }, 502);
    }
  }
  const completeMatch = /^\/api\/admin\/uploads\/([0-9a-f-]+)\/complete$/.exec(path);
  if (request.method === "POST" && completeMatch) {
    const auth = await requireAdmin(request, env);
    if (auth.response) return auth.response;
    const upload = await getUploadSession(env, completeMatch[1], auth.session.nonce);
    if (!upload) return json({ error: "This upload expired. Please start again." }, 404);
    try {
      await readJson(request, 4 * 1024);
      for (const file of upload.files) {
        const expectedParts = Math.ceil(file.size / PART_SIZE);
        const { results = [] } = await env.DB.prepare(
          "SELECT part_number, etag FROM upload_parts WHERE upload_id = ? AND file_id = ? ORDER BY part_number",
        ).bind(upload.id, file.id).all();
        if (results.length !== expectedParts || results.some((part, index) => part.part_number !== index + 1)) {
          throw new Error("An upload is incomplete. Please retry the missing file parts.");
        }
        await env.MEDIA_BUCKET.resumeMultipartUpload(file.key, file.multipart_id).complete(
          results.map((part) => ({ partNumber: part.part_number, etag: part.etag })),
        );
      }
      const video = upload.files.find((file) => file.field === "video");
      const poster = upload.files.find((file) => file.field === "poster");
      await validateStoredFile(env.MEDIA_BUCKET, video);
      if (poster) await validateStoredFile(env.MEDIA_BUCKET, poster);
      const subtitleFiles = upload.files.filter((file) => file.field === "subtitles");
      const subtitleKeys = [];
      for (const file of subtitleFiles) subtitleKeys.push({ file, key: await readSubtitle(env.MEDIA_BUCKET, file) });
      const movieId = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO movies
          (id, title, translated_title, translated_language, synopsis, translated_synopsis, original_language, release_year, genres, poster_file, video_file, content_type, vj_name, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(movieId, upload.metadata.title, upload.metadata.title, upload.metadata.videoLanguage, upload.metadata.synopsis,
            upload.metadata.synopsis, upload.metadata.videoLanguage, upload.metadata.releaseYear, upload.metadata.genres.join(","),
            poster?.key || "", video.key, upload.metadata.contentType, upload.metadata.vjName, now),
        ...subtitleKeys.map(({ file, key }) => env.DB.prepare(
          "INSERT INTO subtitles (id, movie_id, language_code, language_name, subtitle_file) VALUES (?, ?, ?, ?, ?)",
        ).bind(crypto.randomUUID(), movieId, file.languageCode, LANGUAGES[file.languageCode], key)),
      ]);
      await env.DB.prepare("DELETE FROM upload_parts WHERE upload_id = ?").bind(upload.id).run();
      await env.DB.prepare("DELETE FROM upload_sessions WHERE id = ?").bind(upload.id).run();
      const movie = (await listMovies(env)).find((item) => item.id === movieId);
      return json({ movie }, 201);
    } catch (error) {
      console.error("Could not complete the R2 upload.", error);
      await cleanupUpload(env, upload);
      return json({ error: error.message || "Could not finish saving the movie." }, 400);
    }
  }
  const abortMatch = /^\/api\/admin\/uploads\/([0-9a-f-]+)\/abort$/.exec(path);
  if (request.method === "POST" && abortMatch) {
    const auth = await requireAdmin(request, env);
    if (auth.response) return auth.response;
    const upload = await getUploadSession(env, abortMatch[1], auth.session.nonce);
    if (upload) await cleanupUpload(env, upload);
    return json({ aborted: true });
  }
  const classificationMatch = /^\/api\/admin\/movies\/([^/]+)$/.exec(path);
  if (request.method === "PATCH" && classificationMatch) {
    const auth = await requireAdmin(request, env);
    if (auth.response) return auth.response;
    let body;
    try {
      body = await readJson(request, 8 * 1024);
    } catch (error) {
      return json({ error: error.message }, 400);
    }
    const contentType = String(body.contentType || "");
    const vjName = String(body.vjName || "").trim();
    if (!["movie", "series", "tv"].includes(contentType) || vjName.length > 60) {
      return json({ error: "Choose a valid content type and keep the VJ name under 60 characters." }, 400);
    }
    const result = await env.DB.prepare("UPDATE movies SET content_type = ?, vj_name = ? WHERE id = ?")
      .bind(contentType, vjName, decodeURIComponent(classificationMatch[1])).run();
    if (!result.meta.changes) return json({ error: "Movie not found." }, 404);
    const movie = (await listMovies(env)).find((item) => item.id === decodeURIComponent(classificationMatch[1]));
    return json({ movie });
  }
  if (request.method === "DELETE" && classificationMatch) {
    const auth = await requireAdmin(request, env);
    if (auth.response) return auth.response;
    const movie = await env.DB.prepare("SELECT * FROM movies WHERE id = ?")
      .bind(decodeURIComponent(classificationMatch[1])).first();
    if (!movie) return json({ error: "Movie not found." }, 404);
    const { results: tracks = [] } = await env.DB.prepare("SELECT subtitle_file FROM subtitles WHERE movie_id = ?")
      .bind(movie.id).all();
    await Promise.all([movie.video_file, movie.poster_file, ...tracks.map((track) => track.subtitle_file)]
      .filter(Boolean).map((key) => env.MEDIA_BUCKET.delete(key)));
    await env.DB.prepare("DELETE FROM movies WHERE id = ?").bind(movie.id).run();
    return json({ deleted: true });
  }
  return json({ error: "Not found." }, 404);
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    const origin = request.headers.get("Origin");
    if (request.method === "OPTIONS") {
      return origin === env.FRONTEND_ORIGIN
        ? new Response(null, { status: 204, headers: cors })
        : new Response(null, { status: 403 });
    }
    if (origin && origin !== env.FRONTEND_ORIGIN) return json({ error: "Origin is not allowed." }, 403);
    const url = new URL(request.url);
    try {
      const mediaMatch = /^\/media\/([^/]+)$/.exec(url.pathname);
      const response = mediaMatch
        ? await serveMedia(request, env, decodeURIComponent(mediaMatch[1]))
        : await handleApi(request, env);
      for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
      response.headers.set("X-Content-Type-Options", "nosniff");
      response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
      response.headers.set("X-Frame-Options", "DENY");
      return response;
    } catch (error) {
      console.error("Worker request failed.", error);
      const message = error instanceof Error ? error.message : "Unexpected server error.";
      return json({ error: message }, 500, cors);
    }
  },
};
