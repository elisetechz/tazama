import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import crypto from "node:crypto";

async function findPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(child, baseUrl) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error("App server exited before becoming ready.");
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("App server did not become ready.");
}

test("admin sessions, uploads, subtitles, media ranges, and deletes work end to end", async () => {
  const port = await findPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const password = "integration-test-password";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ADMIN_PASSWORD: password,
      SESSION_SECRET: crypto.randomBytes(48).toString("base64url"),
      FRONTEND_ORIGIN: "https://tazama-test.netlify.app",
      PORT: String(port),
      NODE_ENV: "test",
    },
    stdio: "ignore",
  });
  let cookie = "";
  let movieId = "";
  let videoFile = "";
  let posterFile = "";
  const subtitleFiles = [];

  try {
    await waitForServer(child, baseUrl);

    const health = await fetch(`${baseUrl}/api/health`);
    assert.deepEqual(await health.json(), { status: "ok", mediaStorage: "local" });
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");

    const preflight = await fetch(`${baseUrl}/api/admin/login`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://tazama-test.netlify.app",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://tazama-test.netlify.app");
    assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");

    const unauthenticated = await fetch(`${baseUrl}/api/admin/movies`, { method: "POST" });
    assert.equal(unauthenticated.status, 401);

    const badLogin = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "incorrect" }),
    });
    assert.equal(badLogin.status, 401);

    const login = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://tazama-test.netlify.app" },
      body: JSON.stringify({ password }),
    });
    assert.equal(login.status, 200);
    const loginResult = await login.json();
    assert.ok(loginResult.csrf);
    const authCookie = login.headers.getSetCookie()[0];
    assert.match(authCookie, /SameSite=None/i);
    assert.equal(login.headers.get("access-control-allow-origin"), "https://tazama-test.netlify.app");
    cookie = authCookie.split(";")[0];

    const auth = await fetch(`${baseUrl}/api/auth`, { headers: { Cookie: cookie } });
    assert.deepEqual(await auth.json(), { authenticated: true, csrf: loginResult.csrf });

    const storageCheck = await fetch(`${baseUrl}/api/admin/storage`, {
      headers: { Cookie: cookie, "X-CSRF-Token": loginResult.csrf },
    });
    assert.equal(storageCheck.status, 409);
    assert.deepEqual(await storageCheck.json(), {
      connected: false,
      error: "Cloudflare R2 is not configured.",
    });

    const missingCsrf = await fetch(`${baseUrl}/api/admin/movies`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    assert.equal(missingCsrf.status, 403);

    const form = new FormData();
    const video = Buffer.alloc(24);
    video.writeUInt32BE(video.length, 0);
    video.write("ftyp", 4);
    video.write("isom", 8);
    video.writeUInt32BE(0, 12);
    video.write("isom", 16);
    const poster = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const subtitles = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n";
    const invalidForm = new FormData();
    invalidForm.set("title", "Invalid upload");
    invalidForm.set("videoLanguage", "sw");
    invalidForm.set("video", new Blob(["not a video"], { type: "video/mp4" }), "invalid.mp4");
    invalidForm.set("poster", new Blob([poster], { type: "image/png" }), "poster.png");
    const invalidUpload = await fetch(`${baseUrl}/api/admin/movies`, {
      method: "POST",
      headers: { Cookie: cookie, "X-CSRF-Token": loginResult.csrf },
      body: invalidForm,
    });
    assert.equal(invalidUpload.status, 400);
    assert.match((await invalidUpload.json()).error, /video contents/);

    form.set("title", `Test Film ${crypto.randomUUID()}`);
    form.set("contentType", "series");
    form.set("vjName", "VJ Ice P");
    form.set("videoLanguage", "sw");
    form.set("releaseYear", "2024");
    form.set("genres", "Drama, Mystery");
    form.set("synopsis", "A test story.");
    form.set("video", new Blob([video], { type: "video/mp4" }), "test.mp4");
    form.append("subtitles", new Blob([subtitles], { type: "text/vtt" }), "captions.vtt");
    form.append("subtitleLanguages", "sw");
    form.append("subtitles", new Blob(["1\n00:00:01,000 --> 00:00:02,000\nHello\n"], { type: "application/x-subrip" }), "english.srt");
    form.append("subtitleLanguages", "en");

    const upload = await fetch(`${baseUrl}/api/admin/movies`, {
      method: "POST",
      headers: { Cookie: cookie, "X-CSRF-Token": loginResult.csrf },
      body: form,
    });
    const uploadResult = await upload.json();
    assert.equal(upload.status, 201, uploadResult.error);
    const uploaded = uploadResult;
    movieId = uploaded.movie.id;
    videoFile = uploaded.movie.video.split("/").pop();
    subtitleFiles.push(...uploaded.movie.subtitleTracks.map((track) => track.src.split("/").pop()));
    assert.equal(uploaded.movie.poster, "");
    assert.equal(uploaded.movie.videoLanguage, "sw");
    assert.equal(uploaded.movie.videoLanguageName, "Swahili");
    assert.equal(uploaded.movie.contentType, "series");
    assert.equal(uploaded.movie.vjName, "VJ Ice P");
    assert.equal(uploaded.movie.subtitleTracks.length, 2);
    assert.equal(uploaded.movie.subtitleTracks[0].languageCode, "sw");
    assert.equal(uploaded.movie.subtitleTracks[1].languageCode, "en");
    assert.match(uploaded.movie.subtitleTracks[1].src, /\.vtt$/);

    const classificationResponse = await fetch(`${baseUrl}/api/admin/movies/${movieId}`, {
      method: "PATCH",
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": loginResult.csrf,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ contentType: "tv", vjName: "VJ Jingo" }),
    });
    const classification = await classificationResponse.json();
    assert.equal(classificationResponse.status, 200);
    assert.equal(classification.movie.contentType, "tv");
    assert.equal(classification.movie.vjName, "VJ Jingo");

    const convertedSubtitle = await fetch(`${baseUrl}${uploaded.movie.subtitleTracks[1].src}`);
    assert.equal(convertedSubtitle.status, 200);
    assert.match(await convertedSubtitle.text(), /00:00:01\.000 --> 00:00:02\.000/);

    const collection = await fetch(`${baseUrl}/api/movies?search=test%20film`);
    assert.equal((await collection.json()).movies[0].id, movieId);
    const tvByVj = await fetch(`${baseUrl}/api/movies?type=tv&vj=VJ%20Jingo&genre=drama`);
    const tvCatalog = await tvByVj.json();
    assert.equal(tvCatalog.movies[0].id, movieId);
    assert.deepEqual(tvCatalog.vjs, ["VJ Jingo"]);

    const range = await fetch(`${baseUrl}${uploaded.movie.video}`, { headers: { Range: "bytes=0-5" } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), "bytes 0-5/24");
    assert.equal((await range.arrayBuffer()).byteLength, 6);

    const logout = await fetch(`${baseUrl}/api/admin/logout`, {
      method: "POST",
      headers: { Cookie: cookie, "X-CSRF-Token": loginResult.csrf },
    });
    assert.equal(logout.status, 200);
    const revokedSession = await fetch(`${baseUrl}/api/admin/movies`, {
      method: "POST",
      headers: { Cookie: cookie, "X-CSRF-Token": loginResult.csrf },
    });
    assert.equal(revokedSession.status, 401);

    const relogin = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const secondCookie = relogin.headers.getSetCookie()[0].split(";")[0];
    const remove = await fetch(`${baseUrl}/api/admin/movies/${movieId}`, {
      method: "DELETE",
      headers: { Cookie: secondCookie, "X-CSRF-Token": (await relogin.json()).csrf },
    });
    assert.equal(remove.status, 200);
    movieId = "";

    const removed = await fetch(`${baseUrl}/api/movies/${uploaded.movie.id}`);
    assert.equal(removed.status, 404);
  } finally {
    if (movieId && cookie) {
      try {
        const auth = await fetch(`${baseUrl}/api/auth`, { headers: { Cookie: cookie } });
        const session = await auth.json();
        if (session.csrf) {
          await fetch(`${baseUrl}/api/admin/movies/${movieId}`, {
            method: "DELETE",
            headers: { Cookie: cookie, "X-CSRF-Token": session.csrf },
          });
        }
      } catch {
        // The app may have exited after an assertion failed.
      }
    }
    child.kill();
    if (child.exitCode === null) await once(child, "exit");
    for (const file of [videoFile, posterFile, ...subtitleFiles]) {
      if (!file) continue;
      const response = await fetch(`${baseUrl}/media/${file}`).catch(() => null);
      if (response?.ok) throw new Error(`Test cleanup left an uploaded file: ${file}`);
    }
  }
});
