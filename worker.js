const MAX_POST_BYTES = 32 * 1024;
const MAX_PUBLISH_BYTES = 75 * 1024 * 1024;
const MAX_REQUEST_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);
const IMAGE_FILE_PATTERN = /^[a-z0-9][a-z0-9._-]*\.(?:jpe?g|png|webp|gif|heic|heif)$/i;
const LOG_FILE_PATTERN = /^[^\\/\x00-\x1f]+\.(?:adi|adif|log|txt)$/i;

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

    if (url.pathname === '/api/log/publish') {
      if (request.method !== 'POST') {
        return json({ error: 'method not allowed' }, 405, { Allow: 'POST' });
      }
      return publishActivationLog(request, env);
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
  if (length > MAX_REQUEST_BYTES) return json({ error: 'payload too large' }, 413);

  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    return json({ error: 'invalid JSON payload' }, 400);
  }

  const photoUploads = normalizePhotoUploads(payload);
  const post = normalizePost(payload, photoUploads, new Date());
  const problems = validatePost(post, photoUploads);
  if (problems.length) return json({ error: problems.join('; ') }, 400);

  const branch = env.GITHUB_BRANCH || 'main';
  const postPath = `content/blog/${post.date}-${post.slug}.json`;
  const postContent = JSON.stringify(post, null, 2) + '\n';

  const exists = await githubFetch(contentsEndpoint(env, postPath) + `?ref=${encodeURIComponent(branch)}`, env);
  if (exists.status === 200) {
    return json({ error: `${postPath} already exists` }, 409);
  }
  if (exists.status !== 404) {
    return json({ error: `GitHub lookup failed with HTTP ${exists.status}` }, 502);
  }

  const imagePaths = photoUploads.map((photo) => `images/blog/${post.date}-${post.slug}/${photo.fileName}`);
  const duplicatePath = firstDuplicate(imagePaths);
  if (duplicatePath) return json({ error: `duplicate image path ${duplicatePath}` }, 400);

  for (const imagePath of imagePaths) {
    const imageExists = await githubFetch(contentsEndpoint(env, imagePath) + `?ref=${encodeURIComponent(branch)}`, env);
    if (imageExists.status === 200) return json({ error: `${imagePath} already exists` }, 409);
    if (imageExists.status !== 404) {
      return json({ error: `GitHub lookup failed for ${imagePath} with HTTP ${imageExists.status}` }, 502);
    }
  }

  const commitResult = await commitFiles(env, branch, `Add ${post.title} blog post`, [
    { path: postPath, content: toBase64(postContent), encoding: 'base64' },
    ...photoUploads.map((photo) => ({
      path: `images/blog/${post.date}-${post.slug}/${photo.fileName}`,
      content: photo.contentBase64,
      encoding: 'base64',
    })),
  ]);

  if (commitResult.error) return json({ error: commitResult.error }, commitResult.status || 502);

  return json({
    status: 'committed',
    filePath: postPath,
    imagePaths,
    commitSha: commitResult.sha,
    commitUrl: commitResult.htmlUrl,
    postUrl: `/blog/#post-${post.date}-${post.slug}`,
  }, 201);
}

async function publishActivationLog(request, env) {
  const authProblem = authorizePublisher(request, env);
  if (authProblem) return json({ error: authProblem }, 403);

  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return json({ error: 'GITHUB_TOKEN and GITHUB_REPO are required' }, 500);
  }

  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_REQUEST_BYTES) return json({ error: 'payload too large' }, 413);

  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    return json({ error: 'invalid JSON payload' }, 400);
  }

  const logUpload = normalizeLogUpload(payload.log || payload.file || {});
  const problems = validateLogUpload(logUpload);
  if (problems.length) return json({ error: problems.join('; ') }, 400);

  const branch = env.GITHUB_BRANCH || 'main';
  const logPath = `logs/${logUpload.fileName}`;

  const exists = await githubFetch(contentsEndpoint(env, logPath) + `?ref=${encodeURIComponent(branch)}`, env);
  if (exists.status === 200) return json({ error: `${logPath} already exists` }, 409);
  if (exists.status !== 404) {
    return json({ error: `GitHub lookup failed for ${logPath} with HTTP ${exists.status}` }, 502);
  }

  const commitResult = await commitFiles(env, branch, `Add ${logUpload.fileName}`, [
    { path: logPath, content: logUpload.contentBase64, encoding: 'base64' },
  ]);

  if (commitResult.error) return json({ error: commitResult.error }, commitResult.status || 502);

  return json({
    status: 'committed',
    logPath,
    commitSha: commitResult.sha,
    commitUrl: commitResult.htmlUrl,
    logUrl: `/log/#sid-${fileStem(logUpload.fileName)}`,
  }, 201);
}

function normalizeLogUpload(log) {
  return {
    fileName: logFileNameValue(log.fileName || log.name),
    mimeType: stringValue(log.mimeType || log.type).toLowerCase(),
    size: Number(log.size || 0),
    contentBase64: compactBase64(log.contentBase64 || log.data || ''),
  };
}

function validateLogUpload(logUpload) {
  const problems = [];
  if (!logUpload.fileName) problems.push('log file name is required');
  if (!LOG_FILE_PATTERN.test(logUpload.fileName) || hasParentDirectorySegment(logUpload.fileName)) {
    problems.push('log file must be ADIF, ADI, LOG, or TXT with a safe filename');
  }
  if (!logUpload.contentBase64 || !isBase64(logUpload.contentBase64)) problems.push('log file has invalid data');
  const actualBytes = logUpload.size || base64Bytes(logUpload.contentBase64);
  if (actualBytes > MAX_LOG_BYTES) problems.push('log file exceeds 5 MB');
  return problems;
}

function normalizePost(payload, photoUploads, publishedAtDate) {
  const date = stringValue(payload.date);
  const slug = slugify(stringValue(payload.slug || payload.title));
  return {
    date,
    publishedAt: publishedAtDate.toISOString(),
    title: stringValue(payload.title),
    slug,
    type: stringValue(payload.type || 'FIELD REPORT').toUpperCase(),
    tags: Array.isArray(payload.tags) ? payload.tags.map(stringValue).filter(Boolean) : [],
    context: stringValue(payload.context),
    body: Array.isArray(payload.body) ? payload.body.map(stringValue).filter(Boolean) : [],
    photos: photoUploads.map((photo) => ({
      src: `/images/blog/${date}-${slug}/${photo.fileName}`,
      alt: photo.alt,
      caption: photo.caption,
      width: photo.width,
      height: photo.height,
    })),
  };
}

function normalizePhotoUploads(payload) {
  if (!Array.isArray(payload.photos)) return [];
  return payload.photos.map((photo) => ({
    fileName: fileNameValue(photo.fileName || photo.name),
    mimeType: stringValue(photo.mimeType || photo.type).toLowerCase(),
    size: Number(photo.size || 0),
    width: Number(photo.width || 0) || undefined,
    height: Number(photo.height || 0) || undefined,
    alt: stringValue(photo.alt || photo.caption || photo.fileName || photo.name),
    caption: stringValue(photo.caption || photo.alt || photo.fileName || photo.name),
    contentBase64: compactBase64(photo.contentBase64 || photo.data || ''),
  })).filter((photo) => photo.fileName || photo.contentBase64 || photo.caption);
}

function validatePost(post, photoUploads) {
  const problems = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(post.date)) problems.push('date must be YYYY-MM-DD');
  if (!post.title) problems.push('title is required');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(post.slug)) problems.push('slug must be lowercase hyphenated text');
  if (!post.context) problems.push('context is required');
  if (!post.body.length) problems.push('body is required');
  if (JSON.stringify(post).length > MAX_POST_BYTES) problems.push('post metadata is too large');

  let imageBytes = 0;
  photoUploads.forEach((photo, index) => {
    const label = `photo ${index + 1}`;
    if (!photo.fileName) problems.push(`${label} file name is required`);
    if (!IMAGE_FILE_PATTERN.test(photo.fileName)) problems.push(`${label} needs a safe image filename`);
    if (!isAllowedImage(photo)) problems.push(`${label} must be JPEG, PNG, WebP, GIF, HEIC, or HEIF`);
    if (!photo.contentBase64 || !isBase64(photo.contentBase64)) problems.push(`${label} has invalid image data`);
    if (!photo.caption) problems.push(`${label} caption is required`);
    if (!photo.alt) problems.push(`${label} alt text is required`);
    const actualBytes = photo.size || base64Bytes(photo.contentBase64);
    if (actualBytes > MAX_IMAGE_BYTES) problems.push(`${label} exceeds 25 MB`);
    imageBytes += actualBytes;
  });
  if (imageBytes > MAX_PUBLISH_BYTES - MAX_POST_BYTES) problems.push('combined image payload exceeds 75 MB');
  return problems;
}

async function commitFiles(env, branch, message, files) {
  const encodedBranch = encodeURIComponent(branch);
  const readRefEndpoint = `https://api.github.com/repos/${env.GITHUB_REPO}/git/ref/heads/${encodedBranch}`;
  const updateRefEndpoint = `https://api.github.com/repos/${env.GITHUB_REPO}/git/refs/heads/${encodedBranch}`;
  const refResponse = await githubFetch(readRefEndpoint, env);
  const ref = await refResponse.json().catch(() => ({}));
  if (!refResponse.ok) {
    return githubFailure('GitHub branch lookup failed', refResponse, ref, { branch });
  }

  const commitResponse = await githubFetch(ref.object.url, env);
  const parentCommit = await commitResponse.json().catch(() => ({}));
  if (!commitResponse.ok) {
    return githubFailure('GitHub parent commit lookup failed', commitResponse, parentCommit, { branch });
  }

  const tree = [];
  for (const file of files) {
    const blobResponse = await githubFetch(`https://api.github.com/repos/${env.GITHUB_REPO}/git/blobs`, env, {
      method: 'POST',
      body: JSON.stringify({ content: file.content, encoding: file.encoding || 'base64' }),
    });
    const blob = await blobResponse.json().catch(() => ({}));
    if (!blobResponse.ok) {
      return githubFailure('GitHub blob create failed', blobResponse, blob, { path: file.path });
    }
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const treeResponse = await githubFetch(`https://api.github.com/repos/${env.GITHUB_REPO}/git/trees`, env, {
    method: 'POST',
    body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree }),
  });
  const newTree = await treeResponse.json().catch(() => ({}));
  if (!treeResponse.ok) {
    return githubFailure('GitHub tree create failed', treeResponse, newTree, { fileCount: files.length });
  }

  const newCommitResponse = await githubFetch(`https://api.github.com/repos/${env.GITHUB_REPO}/git/commits`, env, {
    method: 'POST',
    body: JSON.stringify({
      message,
      tree: newTree.sha,
      parents: [ref.object.sha],
      committer: env.GITHUB_COMMITTER_NAME && env.GITHUB_COMMITTER_EMAIL ? {
        name: env.GITHUB_COMMITTER_NAME,
        email: env.GITHUB_COMMITTER_EMAIL,
      } : undefined,
    }),
  });
  const newCommit = await newCommitResponse.json().catch(() => ({}));
  if (!newCommitResponse.ok) {
    return githubFailure('GitHub commit create failed', newCommitResponse, newCommit, { fileCount: files.length });
  }

  const updateResponse = await githubFetch(updateRefEndpoint, env, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommit.sha }),
  });
  const update = await updateResponse.json().catch(() => ({}));
  if (!updateResponse.ok) {
    return githubFailure('GitHub branch update failed', updateResponse, update, { branch });
  }

  return { sha: newCommit.sha, htmlUrl: newCommit.html_url };
}

function githubFailure(action, response, body, context = {}) {
  const message = stringValue(body.message) || response.statusText || 'GitHub request failed';
  const contextText = Object.entries(context)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
  const hint = response.status === 404
    ? '; confirm GITHUB_REPO points at the repository and GITHUB_TOKEN can access it with contents write permission'
    : '';
  return {
    error: `${action}${contextText ? ` (${contextText})` : ''}: ${message} (HTTP ${response.status})${hint}`,
    status: 502,
  };
}

function isAllowedImage(photo) {
  return IMAGE_MIME_TYPES.has(photo.mimeType) || IMAGE_FILE_PATTERN.test(photo.fileName);
}

function contentsEndpoint(env, filePath) {
  const apiPath = encodeURIComponent(filePath).replace(/%2F/g, '/');
  return `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${apiPath}`;
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

function fileNameValue(value) {
  return stringValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/^\.+/, '');
}

function logFileNameValue(value) {
  return stringValue(value).replace(/^.*[\\/]/, '');
}

function fileStem(value) {
  return stringValue(value).replace(/\.[^.]+$/, '');
}

function hasParentDirectorySegment(value) {
  return /(^|[\s.])\.\.([\s.]|$)/.test(stringValue(value));
}

function compactBase64(value) {
  return stringValue(value).replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
}

function isBase64(value) {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0;
}

function base64Bytes(value) {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor(value.length * 3 / 4) - padding;
}

function firstDuplicate(values) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return '';
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
