import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../worker.mjs";

function createEnvironment() {
  const revoked = new Set();
  const statements = [];
  const database = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes("COUNT(*) AS count")) return { count: 0 };
              if (sql.includes("FROM revoked_sessions")) return revoked.has(values[0]) ? { revoked: 1 } : null;
              return null;
            },
            async run() {
              statements.push({ sql, values });
              if (sql.includes("INSERT OR REPLACE INTO revoked_sessions")) revoked.add(values[0]);
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const bucket = {
    async head() {
      return { size: bytes.length, httpMetadata: { contentType: "video/mp4" }, httpEtag: '"test-etag"' };
    },
    async get(_key, options = {}) {
      const selected = options.range
        ? bytes.slice(options.range.offset, options.range.offset + options.range.length)
        : bytes;
      return {
        body: new Blob([selected]).stream(),
        size: selected.length,
        httpMetadata: { contentType: "video/mp4" },
        httpEtag: '"test-etag"',
      };
    },
  };
  return {
    env: {
      DB: database,
      MEDIA_BUCKET: bucket,
      MEDIA_BUCKET_NAME: "elise",
      FRONTEND_ORIGIN: "https://tazama-test.netlify.app",
      ADMIN_PASSWORD: "integration-test-password",
      SESSION_SECRET: "worker-test-session-secret-with-more-than-32-characters",
    },
    statements,
  };
}

test("Worker health, CORS, cookie sessions, and byte-range streaming", async () => {
  const { env } = createEnvironment();
  const origin = env.FRONTEND_ORIGIN;

  const health = await worker.fetch(new Request("https://tazama-api.test/api/health", {
    headers: { Origin: origin },
  }), env);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: "ok",
    mediaStorage: "r2",
    runtime: "cloudflare-workers",
  });
  assert.equal(health.headers.get("Access-Control-Allow-Origin"), origin);

  const deniedPreflight = await worker.fetch(new Request("https://tazama-api.test/api/admin/login", {
    method: "OPTIONS",
    headers: { Origin: "https://untrusted.example" },
  }), env);
  assert.equal(deniedPreflight.status, 403);

  const login = await worker.fetch(new Request("https://tazama-api.test/api/admin/login", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
  }), env);
  assert.equal(login.status, 200);
  const { csrf } = await login.json();
  const cookie = login.headers.get("Set-Cookie").split(";")[0];

  const auth = await worker.fetch(new Request("https://tazama-api.test/api/auth", {
    headers: { Origin: origin, Cookie: cookie },
  }), env);
  assert.deepEqual(await auth.json(), { authenticated: true, csrf });

  const media = await worker.fetch(new Request("https://tazama-api.test/media/test.mp4", {
    headers: { Origin: origin, Range: "bytes=3-6" },
  }), env);
  assert.equal(media.status, 206);
  assert.equal(media.headers.get("Content-Range"), "bytes 3-6/10");
  assert.deepEqual([...new Uint8Array(await media.arrayBuffer())], [3, 4, 5, 6]);
});
