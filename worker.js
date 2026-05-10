export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/stats' || url.pathname === '/stats/') {
      return Response.redirect(url.origin + '/log/stats/', 301);
    }

    if (url.pathname === '/api/pota-activations') {
      try {
        const resp = await fetch('https://api.pota.app/activation/N6CBL', {
          headers: { 'User-Agent': 'N6CBL.radio/1.0' },
        });
        if (!resp.ok) {
          return new Response(JSON.stringify({ error: 'upstream HTTP ' + resp.status }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const body = await resp.text();
        return new Response(body, {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300',
          },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    return env.ASSETS.fetch(request);
  },
};
