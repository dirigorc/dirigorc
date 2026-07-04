/**
 * Cloudflare Worker endpoint for Dirigo race report emails.
 *
 * Supports two entry points:
 * - Email Routing Worker: attach this Worker to an address such as updates@dirigorc.com.
 * - HTTP POST webhook: send JSON or plain text to the Worker URL.
 *
 * Required Worker secrets/vars:
 * - GITHUB_TOKEN: Fine-grained GitHub token with Contents: write on dirigorc/dirigorc.
 * - GITHUB_REPO: "dirigorc/dirigorc"
 * - INGEST_TOKEN: Shared bearer token for HTTP POSTs.
 *
 * Optional vars:
 * - ALLOWED_FROM: Comma-separated sender allowlist for Email Routing.
 */

const DISPATCH_EVENT_TYPE = "race-report-email";

function allowedSender(sender, env) {
  if (!env.ALLOWED_FROM) return true;
  const allowed = env.ALLOWED_FROM.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  return allowed.some((value) => sender.toLowerCase().includes(value));
}

function headerValue(headers, name) {
  return headers.get(name) || headers.get(name.toLowerCase()) || "";
}

async function dispatchToGitHub(env, email) {
  const repo = env.GITHUB_REPO || "dirigorc/dirigorc";
  const ingest = await createIngestPayload(env, email);
  const response = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "dirigorc-race-report-worker",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      event_type: DISPATCH_EVENT_TYPE,
      client_payload: { ingest },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub dispatch failed: ${response.status} ${detail}`);
  }
}

async function githubRequest(env, path, options = {}) {
  const repo = env.GITHUB_REPO || "dirigorc/dirigorc";
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "dirigorc-race-report-worker",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub API failed: ${response.status} ${detail}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

function textToBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function safeId(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "race-report";
}

async function createIngestPayload(env, email) {
  const baseBranch = env.GITHUB_REF || "main";
  const id = `${Date.now()}-${safeId(email.subject || "race-report")}`;
  const branch = `automation/email-ingest-${id}`;
  const path = `tmp/email-ingest/${id}/payload.json`;

  const baseRef = await githubRequest(env, `/git/ref/heads/${baseBranch}`);
  await githubRequest(env, "/git/refs", {
    method: "POST",
    body: JSON.stringify({
      ref: `refs/heads/${branch}`,
      sha: baseRef.object.sha,
    }),
  });

  await githubRequest(env, `/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `Stage race report email payload: ${email.subject || "Race report"}`,
      branch,
      content: textToBase64(JSON.stringify({ email }, null, 2)),
    }),
  });

  return {
    branch,
    path,
    subject: email.subject || "Race report digest",
    from: email.from || "Unknown sender",
  };
}

async function emailPayloadFromRequest(request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = await request.json();
    return {
      from: body.from || body.sender || "HTTP webhook",
      subject: body.subject || "Race report digest",
      text: body.text || body.body || body.plain || "",
      raw: body.raw || "",
      attachments: body.attachments || [],
    };
  }

  const text = await request.text();
  return {
    from: request.headers.get("x-email-from") || "HTTP webhook",
    subject: request.headers.get("x-email-subject") || "Race report digest",
    text,
    raw: text,
  };
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Send POST requests to submit a race report digest.\n", { status: 405 });
    }

    const expected = `Bearer ${env.INGEST_TOKEN}`;
    if (!env.INGEST_TOKEN || request.headers.get("authorization") !== expected) {
      return new Response("Unauthorized\n", { status: 401 });
    }

    const email = await emailPayloadFromRequest(request);
    if (!email.text && !email.raw) {
      return new Response("Missing email text/body\n", { status: 400 });
    }

    await dispatchToGitHub(env, email);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  },

  async email(message, env, ctx) {
    const from = message.from || headerValue(message.headers, "from");
    if (!allowedSender(from, env)) {
      message.setReject("Sender is not allowed to create Dirigo race report drafts.");
      return;
    }

    const raw = await new Response(message.raw).text();
    const email = {
      from,
      subject: headerValue(message.headers, "subject") || "Race report digest",
      text: raw,
      raw,
    };

    ctx.waitUntil(dispatchToGitHub(env, email));
  },
};
