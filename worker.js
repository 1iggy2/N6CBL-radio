const MAX_POST_BYTES = 32 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/stats' || url.pathname === '/stats/') {
      return Response.redirect(url.origin + '/log/stats/', 301);
    }

    if (url.pathname === '/api/blog/publish') {
      if (request.method !== 'POST') {
        return json({ error: 'method not allowed' }, 405, { Allow: 'POST' });
      }
      return publishBlogPost(request, env);
    }

    if (url.pathname === '/api/pota-activations') {
      try {
        const resp = await fetch('https://api.pota.app/activation/N6CBL', {
          headers: { 'User-Agent': 'N6CBL.radio/1.0' },
        });
        if (!resp.ok) {
          return json({ error: 'upstream HTTP ' + resp.status }, 502);
        }
        const body = await resp.text();
        return new Response(body, {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300',
          },
        });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    return env.ASSETS.fetch(request);
  },
};

async function publishBlogPost(request, env) {
  const authProblem = authorizePublisher(request, env);
  if (authProblem) return json({ error: authProblem }, 403);

  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return json({ error: 'GITHUB_TOKEN and GITHUB_REPO are required' }, 500);
  }

  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_POST_BYTES) return json({ error: 'payload too large' }, 413);

  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    return json({ error: 'invalid JSON payload' }, 400);
  }

  const post = normalizePost(payload);
  const problems = validatePost(post);
  if (problems.length) return json({ error: problems.join('; ') }, 400);

  const branch = env.GITHUB_BRANCH || 'main';
  const filePath = `content/blog/${post.date}-${post.slug}.json`;
  const content = JSON.stringify(post, null, 2) + '\n';
  const apiPath = encodeURIComponent(filePath).replace(/%2F/g, '/');
  const endpoint = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${apiPath}`;
  const message = `Add ${post.title} blog post`;

  const exists = await githubFetch(endpoint + `?ref=${encodeURIComponent(branch)}`, env);
  if (exists.status === 200) {
    return json({ error: `${filePath} already exists` }, 409);
  }
  if (exists.status !== 404) {
    return json({ error: `GitHub lookup failed with HTTP ${exists.status}` }, 502);
  }

  const response = await githubFetch(endpoint, env, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: toBase64(content),
      branch,
      committer: env.GITHUB_COMMITTER_NAME && env.GITHUB_COMMITTER_EMAIL ? {
        name: env.GITHUB_COMMITTER_NAME,
        email: env.GITHUB_COMMITTER_EMAIL,
      } : undefined,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    return json({ error: result.message || `GitHub commit failed with HTTP ${response.status}` }, 502);
  }

  return json({
    status: 'committed',
    filePath,
    commitSha: result.commit && result.commit.sha,
    commitUrl: result.commit && result.commit.html_url,
    postUrl: `/blog/#post-${post.date}-${post.slug}`,
  }, 201);
}

function normalizePost(payload) {
  return {
    date: stringValue(payload.date),
    title: stringValue(payload.title),
    slug: slugify(stringValue(payload.slug || payload.title)),
    type: stringValue(payload.type || 'FIELD REPORT').toUpperCase(),
    tags: Array.isArray(payload.tags) ? payload.tags.map(stringValue).filter(Boolean) : [],
    context: stringValue(payload.context),
    body: Array.isArray(payload.body) ? payload.body.map(stringValue).filter(Boolean) : [],
    photos: [],
  };
}

function validatePost(post) {
  const problems = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(post.date)) problems.push('date must be YYYY-MM-DD');
  if (!post.title) problems.push('title is required');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(post.slug)) problems.push('slug must be lowercase hyphenated text');
  if (!post.context) problems.push('context is required');
  if (!post.body.length) problems.push('body is required');
  if (JSON.stringify(post).length > MAX_POST_BYTES) problems.push('post is too large');
  return problems;
}

function authorizePublisher(request, env) {
  const identity = getAccessEmail(request);
  if (!identity) return 'Cloudflare Access identity is required';

  const allowedEmails = emailList(env.ALLOWED_EMAILS || env.ALLOWED_EMAIL);
  if (allowedEmails.length && !allowedEmails.includes(identity.toLowerCase())) {
    return 'Cloudflare Access identity is not authorized';
  }

  return '';
}

function getAccessEmail(request) {
  return request.headers.get('Cf-Access-Authenticated-User-Email')
    || request.headers.get('cf-access-authenticated-user-email')
    || '';
}

function emailList(value) {
  return String(value || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function githubFetch(url, env, init = {}) {
  return fetch(url, {
    ...init,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'N6CBL.radio publisher',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}

function stringValue(value) {
  return String(value || '').trim();
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untitled';
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
