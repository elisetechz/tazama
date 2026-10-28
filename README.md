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

## Deploy Netlify + Render + Cloudflare R2

The Netlify site serves the public interface; Render runs the Express API and SQLite catalog; Cloudflare R2 stores movie, poster, and subtitle files. The Render blueprint in `render.yaml` configures a persistent disk for the SQLite database. Set secrets in provider dashboards only; never commit them or paste them into chat.

1. Install Git if needed and publish this project to a private GitHub repository. The `.gitignore` excludes `.env`, the database, uploaded files, and generated Netlify output; confirm that secrets and personal movie files are not included in the repository.
2. In Cloudflare, confirm the `elise` R2 bucket exists. Create an R2 S3 API token scoped to that bucket with object read/write access. Do not create a general Cloudflare account API token. The account ID and bucket name from your supplied endpoint are already filled in `render.yaml`; the access key and secret are private and must only be entered in Render's environment setup.
3. Import the GitHub repository into Netlify and choose a permanent `*.netlify.app` site name. The first deploy can run without `TAZAMA_API_BASE`; this publishes the static interface so you can get its exact site origin.
4. In Render, create a new Blueprint from the same repository. Set `FRONTEND_ORIGIN` to the exact Netlify origin, for example `https://your-site.netlify.app` (no trailing slash). Set a unique `ADMIN_PASSWORD` of at least 12 characters and enter the R2 access key and secret when prompted. The blueprint generates `SESSION_SECRET`; it configures the supplied R2 account/bucket and stores the SQLite database on a persistent disk.
5. After Render deploys, open its service and check `/api/health`. It should report `"mediaStorage":"r2"`. Copy the Render public HTTPS origin (for example `https://tazama-api.onrender.com`) into Netlify's `TAZAMA_API_BASE` environment variable, then trigger a new Netlify deploy.
6. Open the public Netlify URL and sign in to the Studio. Use **Check R2 connection** before uploading, then upload a test video and play it. Public visitors can browse and stream the catalog. Only upload movies and artwork you have permission to share.

The two origins must match exactly: Netlify `TAZAMA_API_BASE` is the Render HTTPS origin; Render `FRONTEND_ORIGIN` is the Netlify HTTPS origin. For reliable Studio sign-in across browsers, use a custom domain and put the API on a subdomain of the same domain (for example `watch.example.com` and `api.example.com`); browsers may block third-party cookies between the default Netlify and Render domains. The public movie catalog and media routes are intentionally viewable without sign-in; the Studio remains protected.

This deployment stores new uploads in R2. The database and uploads on your current computer are not automatically copied to the public deployment; upload those videos again through the deployed Studio after launch. Render's persistent disk is required for SQLite; do not remove it or redeploy to a service without persistent storage. The R2 bucket can remain private: media is streamed through the authenticated app server's R2 credentials, so no public R2 bucket URL or R2 CORS rule is required.

For a custom domain, configure it in Netlify and update Render's `FRONTEND_ORIGIN` to the final domain. Set a strong private administrator password, keep `.env`, `data/`, and `uploads/` out of source control, and set `TRUST_PROXY=true` behind the trusted Render proxy.

## Local development

Run `npm install`, configure `.env` as described above, then use `npm start`. Leave the R2 values empty to keep media on local disk. Run `npm test` to exercise sign-in, authorization, uploads, subtitles, media range requests, classification, and deletion.

Upload only movies and artwork you have permission to store and distribute. You are responsible for the rights and privacy obligations that apply to the content and audience in your jurisdiction.
