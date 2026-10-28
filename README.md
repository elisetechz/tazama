# Tazama

A self-hosted video library for content you own or are authorized to distribute. Tazama includes an English/Swahili storefront, a private upload studio, browser playback, and optional subtitles.

## What is included

- Responsive storefront with Home, Movies, Series, and TV Shows navigation, category and VJ filters, search, a saved list, and recently watched progress.
- English and Swahili interface copy and movie-language labels.
- Admin studio for uploading finished videos, classifying each as a movie, series, or TV show, and recording its category and Ugandan VJ.
- WebVTT subtitles and SRT-to-WebVTT conversion for browser playback.
- SQLite catalog, local file storage, HTTP video range requests, and persistent content across restarts.
- Rate-limited administrator sign-in, signed HTTP-only cookies, CSRF checks, upload validation, and browser security headers.

Upload the final translated video itself: this app does not translate audio, transcode, or moderate films. Choose the spoken language of the uploaded file. A poster and subtitle tracks are optional. Movies are streamed from the server that hosts this app; streaming large libraries publicly requires appropriate storage, bandwidth, and a production deployment.

## Requirements

- Node.js 20.19+ or 22.12+ (required by the SQLite dependency)
- npm

## Run locally

1. Install Node.js if it is not already installed.
2. Copy `.env.example` to `.env`.
3. Set `ADMIN_PASSWORD` to a unique password (at least 12 characters).
4. Set `SESSION_SECRET` to a randomly generated secret with at least 32 characters. For example, generate one with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"` and paste the output into `.env`.
5. Install dependencies and start the app:

   ```sh
   npm install
   npm start
   ```

6. Open [http://localhost:3000](http://localhost:3000) and select the profile icon or **Open your studio** to sign in and add a film.

`npm run dev` restarts the server when backend files change. Set `PORT` to change the listening port. Set `MAX_VIDEO_SIZE_MB` to adjust the maximum size for each uploaded file (default: 2048 MB).
Run `npm test` to exercise sign-in, authorization, uploads, subtitles, media range requests, and deletion.

## Uploads

- Finished, translated movie video: MP4, WebM, or Ogg.
- Title and spoken language are required. Content type, release year, genres, Ugandan VJ, a short description, and a poster are optional.
- Poster: JPG, PNG, or WebP (up to 5 MB) when supplied.
- Subtitles: SRT or WebVTT (up to 2 MB per track); SRT timestamps are converted when uploaded.
- Up to eight optional subtitle files can be attached to a film.
- The title, uploaded video's spoken language, optional description, year, categories, content type, and VJ name are recorded in the catalog. VJ suggestions include VJ Junior, VJ Jingo, VJ Mark, VJ Ice P, VJ Emmy, VJ Kevo, VJ Ulio, VJ Ivo, VJ Uncle T, VJ Soul, VJ Heavy Q, VJ Shaolin Khan, VJ Omutaputa, and VJ Bombash; any other VJ name can be entered and will become a browse filter.
- Existing uploads can be reclassified or assigned a VJ from the Studio without uploading the video again.
- Each upload represents one playable video title. Series and TV Shows are catalog categories; season and episode management is not included.
- Uploaded files and the SQLite database are stored under `uploads/` and `data/`. Back up both directories.

## Deploy Netlify + Cloudflare Workers + D1 + R2

Netlify hosts the storefront. A Cloudflare Worker runs the API, D1 stores the catalog, and the existing private R2 bucket stores the video, poster, and subtitle files. The Worker accepts 8 MiB upload parts, so a large video is uploaded in small requests rather than exceeding the Workers request-body limit. Secrets belong in Cloudflare's secret manager, never in source control or chat.

### Cloudflare Worker setup

1. Install Node.js 22 and npm, then clone the `elisetechz/tazama` GitHub repository and run `npm install`.
2. Sign in to Cloudflare CLI: `npx wrangler login`.
3. Create the free D1 database: `npx wrangler d1 create tazama-catalog`. Copy its database ID into `wrangler.jsonc`, replacing `CREATE_D1_DATABASE_AND_REPLACE_WITH_ID`.
4. Confirm the R2 bucket named `elise` exists in the same Cloudflare account. The R2 bucket is attached to the Worker through the `MEDIA_BUCKET` binding in `wrangler.jsonc`; do not put R2 API keys in the Worker.
5. In `wrangler.jsonc`, set `FRONTEND_ORIGIN` to the exact Netlify site origin (no trailing slash), for example `https://your-site.netlify.app`.
6. Create the D1 tables: `npm run migrate:worker`.
7. Set the private Worker secrets from the terminal prompts: `npx wrangler secret put ADMIN_PASSWORD` and `npx wrangler secret put SESSION_SECRET`. Use an administrator password with at least 12 characters and a unique random session secret of at least 32 characters. Do not put either value in `wrangler.jsonc`.
8. Deploy the API: `npm run deploy:worker`. Check `https://<worker-name>.<account-subdomain>.workers.dev/api/health`; the response should include `"mediaStorage":"r2"`.

### Netlify storefront setup

1. Import the same GitHub repository into Netlify. The build command is `node scripts/build-netlify.mjs`; the publish directory is `dist`. Deploy once and note the site origin.
2. Set `FRONTEND_ORIGIN` in `wrangler.jsonc` to that exact Netlify origin, redeploy the Worker, and set Netlify's `TAZAMA_API_BASE` environment variable to the Worker HTTPS origin (no path or trailing slash).
3. Redeploy Netlify. Open the site, sign in to the Studio, run **Check R2 connection**, and upload a small test movie before uploading your library.

The default Netlify and `workers.dev` hostnames are different sites, and some browsers block cross-site sign-in cookies. If Studio login is blocked, use a custom domain with the site and API on subdomains of the same registered domain. The public catalog and media are intentionally readable without sign-in; administrative actions require a signed session and CSRF token.

The Workers Free plan has daily request and CPU limits; D1 Free has a 500 MB database limit and a 50-query-per-invocation limit; R2 Standard has 10 GB-month free storage, with internet egress free. R2 storage and operation use beyond its free allowance can cost money. A 507 MB movie fits the stated R2 storage allowance on its own, but the limit is shared by all files in the bucket. Large uploads use 8 MiB parts and video files are limited to 2 GB. See current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), and [R2 pricing](https://developers.cloudflare.com/r2/pricing/) before publishing.

The local database and uploaded files are not automatically copied to the cloud. After deployment, upload each movie again through the deployed Studio. Keep `.env`, `data/`, `uploads/`, and generated build output out of source control, and upload only content you have permission to distribute.

## Local development

Run `npm install`, configure `.env` as described above, then use `npm start`. Leave the R2 values empty to keep media on local disk. Run `npm test` to exercise sign-in, authorization, uploads, subtitles, media range requests, classification, and deletion.

Upload only movies and artwork you have permission to store and distribute. You are responsible for the rights and privacy obligations that apply to the content and audience in your jurisdiction.
