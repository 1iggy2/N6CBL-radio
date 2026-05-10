# N6CBL.radio

Personal website of N6CBL. Live at [N6CBL.radio](https://N6CBL.radio).

Tools, blog posts, 3D prints, amateur radio resources, and whatever else.

## Hosting

Cloudflare Pages — deploys automatically from the `main` branch of this repo.

## Design

Follows the US Graphics Company design philosophy: dense, explicit, performant,
timeless. See [CLAUDE.md](./CLAUDE.md) for the full doctrine.

## Structure

| Path | Content |
|---|---|
| `/` | Home / current splash |
| `/log/` | QSO log |
| `/log/stats/` | QSO log statistics and analysis |
| `/blog/` | Posts |
| `/tools/` | Browser utilities |
| `/prints/` | 3D print catalog |
| `/radio/` | Ham radio resources |

## Development

No build step required for static pages. Just edit HTML/CSS and push.

```sh
git clone https://github.com/1iggy2/n6cbl-radio
cd n6cbl-radio
# open index.html in a browser
```

## License

Content: All rights reserved, N6CBL.  
Code/templates: MIT unless otherwise noted in the file.
