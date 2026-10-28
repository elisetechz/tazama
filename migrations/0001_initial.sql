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
  poster_file TEXT NOT NULL DEFAULT '',
  video_file TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'movie',
  vj_name TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS login_attempts_ip_time ON login_attempts(ip, created_at);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  admin_nonce TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  files_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS upload_parts (
  upload_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  PRIMARY KEY (upload_id, file_id, part_number)
);
