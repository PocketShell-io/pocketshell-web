#!/usr/bin/env node
// Render content/blog/*.md into static pages under dist/ and dist/sitemap.xml.
// URLs are extensionless ("pretty"), but posts are written as
// dist/blog/<slug>/index.html — a real directory index — so /blog/<slug>
// renders on every static server (python -m http.server, Live Server, nginx)
// instead of downloading: bare extensionless files get
// application/octet-stream from servers that infer content type from the file
// suffix. deploy.sh uploads the same bytes to the flat blog/<slug> and
// blog/<slug>/ S3 keys, which S3 REST needs because it never maps directory
// URIs to index documents itself.
//
//   node scripts/build-blog.mjs --list   # only emit src/generated/blog-posts.ts
//                                        # (imported by the landing page; runs
//                                        # before vue-tsc in `npm run build`)
//   node scripts/build-blog.mjs          # emit pages + sitemap (after vite build)
//
// Output: dist/blog/<slug> (posts), dist/blog/index.html (also copied to the
// bare "blog" key by deploy.sh), dist/sitemap.xml.
//
// Files without frontmatter (e.g. keyword-research.md) are planning notes and
// are skipped.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = path.join(ROOT, 'content', 'blog');
const DIST = path.join(ROOT, 'dist');
const SITE = 'https://pocketshell.io';

const esc = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function parseFrontmatter(md) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  if (!meta.slug || !meta.title || !meta.date) return null;
  return { meta, body: md.slice(m[0].length) };
}

// Landing teaser order: featured posts first, then newest.
const rank = (p) => (p.featured === 'true' ? 0 : 1);

const fmtDate = (iso) =>
  new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(iso));

const OG_IMAGE = `${SITE}/images/og-cover.png`;

function page({ title, description, canonical, type = 'website', published, cover, content }) {
  const image = cover ? `${SITE}${cover}` : OG_IMAGE;
  const jsonld = {
    '@context': 'https://schema.org',
    ...(type === 'article'
      ? {
          '@type': 'BlogPosting',
          headline: title,
          description,
          datePublished: published,
          author: { '@type': 'Person', name: 'Alexey Grigorev', url: 'https://github.com/alexeygrigorev' },
        }
      : { '@type': 'Blog', name: 'PocketShell Blog', description }),
    url: canonical,
  };
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <link rel="canonical" href="${esc(canonical)}" />
  <meta name="robots" content="index, follow" />
  <meta name="theme-color" content="#0d1117" />
  <meta property="og:type" content="${type}" />
  <meta property="og:site_name" content="PocketShell" />
  <meta property="og:locale" content="en_US" />
  <meta property="og:url" content="${esc(canonical)}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:image" content="${esc(image)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="${esc(title)}" />${published ? `\n  <meta property="article:published_time" content="${published}" />\n  <meta property="article:author" content="Alexey Grigorev" />` : ''}
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(description)}" />
  <meta name="twitter:image" content="${esc(image)}" />
  <link rel="alternate" type="application/rss+xml" title="PocketShell blog" href="/feed.xml" />
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230d1117' stroke='%2330363d' stroke-width='2'/%3E%3Ctext x='12' y='45' font-family='ui-monospace,monospace' font-size='30' font-weight='bold' fill='%233fb950'%3E%3E_%3C/text%3E%3C/svg%3E" />
  <link rel="stylesheet" href="/blog.css" />
  <script type="application/ld+json">${JSON.stringify(jsonld)}</script>
</head>
<body>
  <header class="topbar landing-topbar">
    <div class="topbar-rail">
      <a class="brand" href="/"><span class="brand-mark">&gt;_</span> PocketShell</a>
      <nav class="site-nav">
        <a class="nav-link" href="/#features">Features</a>
        <a class="nav-link" href="/#how">How it works</a>
        <a class="nav-link" href="/#security">Security</a>
        <a class="nav-link" href="/#faq">FAQ</a>
        <a class="nav-link" href="/blog">Blog</a>
      </nav>
      <span class="spacer"></span>
      <a class="button" data-auth href="/login">Sign in</a>
    </div>
  </header>
  <main>
${content}
  </main>
  <footer class="landing-footer">
    <div class="footer-row">
      <span class="foot-brand"><span class="brand-mark">&gt;_</span> PocketShell</span>
      <span class="foot-dim">Built by Alexey Grigorev — a developer who wanted his servers from an iPad.</span>
      <nav class="footer-nav">
        <a href="/#features">Features</a>
        <a href="/#how">How it works</a>
        <a href="/#security">Security</a>
        <a href="/#faq">FAQ</a>
        <a href="/blog">Blog</a>
        <a href="https://github.com/alexeygrigorev">GitHub</a>
        <a data-auth href="/login">Sign in</a>
      </nav>
    </div>
  </footer>
  <script>
    // Static pages have no auth state; default CTAs to /login and swap to
    // /app for signed-in visitors (same sessionStorage key the SPA uses).
    try {
      if (sessionStorage.getItem('ps.idToken')) {
        document.querySelectorAll('a[data-auth]').forEach((a) => {
          a.href = '/app';
          a.textContent = 'Open app';
        });
      }
    } catch (e) {}
  </script>
</body>
</html>
`;
}

function postPage(post, others) {
  const more = others
    .slice(0, 2)
    .map(
      (p) =>
        `\n        <a class="card card-link" href="/blog/${p.slug}">${cardCover(p)}<h3>${esc(p.title)}</h3><p>${esc(
          p.description,
        )}</p></a>`,
    )
    .join('');
  return page({
    title: `${post.title} — PocketShell`,
    description: post.description,
    canonical: `${SITE}/blog/${post.slug}`,
    type: 'article',
    published: post.date,
    cover: post.cover,
    content: `    <div class="container">
      <article class="post">
        <h1>${esc(post.title)}</h1>
        <p class="post-meta"><time datetime="${post.date}">${fmtDate(post.date)}</time> · ${post.readingMinutes} min read</p>
        ${post.cover ? `<img class="post-cover" src="${esc(post.cover)}" alt="" width="1200" height="630" />` : ''}
        <div class="prose">
${post.html}
        </div>
        <aside class="post-cta">
          <div>
            <strong>PocketShell</strong>
            <p>Your saved SSH hosts, a real terminal in a browser tab.</p>
          </div>
          <a class="button primary" data-auth href="/login">Sign in</a>
        </aside>
        <nav class="keep-reading band">
          <h2>Keep reading</h2>
          <div class="cards blog-cards">${more}
          </div>
        </nav>
      </article>
    </div>`,
  });
}

// Card covers, shared by the blog index, keep-reading, and any post with a
// `cover` in frontmatter. Fixed 2:1-ish box so mixed crops stay uniform.
const cardCover = (p) =>
  p.cover
    ? `\n          <img class="card-cover" src="${esc(p.cover)}" alt="" width="1200" height="630" loading="lazy" />`
    : '';

function indexPage(posts) {
  const cards = posts
    .map(
      (p) => `\n        <a class="card card-link" href="/blog/${p.slug}">${cardCover(p)}
          <h3>${esc(p.title)}</h3>
          <p>${esc(p.description)}</p>
          <span class="card-meta">${fmtDate(p.date)} · ${p.readingMinutes} min read</span>
        </a>`,
    )
    .join('');
  return page({
    title: 'SSH and terminal guides — PocketShell blog',
    description:
      'Practical notes on SSH, terminals, and running things on remote machines — from building PocketShell, an SSH client in a browser tab.',
    canonical: `${SITE}/blog`,
    content: `    <div class="container blog-index">
      <h1>Blog</h1>
      <p class="band-sub">SSH, terminals, and running things on remote machines.</p>
    </div>
    <section class="band">
      <div class="container">
        <div class="cards blog-cards">${cards}
        </div>
      </div>
    </section>`,
  });
}

function sitemapXml(posts) {
  const urls = [
    ['/', null],
    ['/blog', null],
    ...posts.map((p) => [`/blog/${p.slug}`, p.date]),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map(
      ([p, lastmod]) =>
        `  <url><loc>${SITE}${p}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`,
    )
    .join('\n')}\n</urlset>\n`;
}

function feedXml(posts) {
  const items = posts
    .map(
      (p) =>
        `  <item>
    <title>${esc(p.title)}</title>
    <link>${SITE}/blog/${p.slug}</link>
    <guid isPermaLink="true">${SITE}/blog/${p.slug}</guid>
    <pubDate>${new Date(p.date).toUTCString()}</pubDate>
    <description>${esc(p.description)}</description>
  </item>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>PocketShell blog</title>
    <link>${SITE}/blog</link>
    <description>Practical notes on SSH, terminals, and running things on remote machines.</description>
    <language>en</language>
${items}
  </channel>
</rss>
`;
}

const postsMeta = () =>
  `[${posts
    .map(
      (p) =>
        `\n  { slug: '${p.slug}', title: ${JSON.stringify(p.title)}, description: ${JSON.stringify(
          p.description,
        )}, date: '${p.date}', readingMinutes: ${p.readingMinutes}, featured: ${p.featured === 'true'}, cover: ${JSON.stringify(
          p.cover || '',
        )} },`,
    )
    .join('')}\n]`;

const [flag] = process.argv.slice(2);
const listOnly = flag === '--list';

const files = (await readdir(CONTENT)).filter((f) => f.endsWith('.md'));
const posts = [];
for (const file of files) {
  const parsed = parseFrontmatter(await readFile(path.join(CONTENT, file), 'utf8'));
  if (!parsed) continue;
  const html = await marked.parse(parsed.body);
  posts.push({
    ...parsed.meta,
    html,
    readingMinutes: Math.max(1, Math.round(parsed.body.split(/\s+/).length / 220)),
  });
}
posts.sort((a, b) => rank(a) - rank(b) || (a.date < b.date ? 1 : -1));

await mkdir(path.join(ROOT, 'src', 'generated'), { recursive: true });
await writeFile(
  path.join(ROOT, 'src', 'generated', 'blog-posts.ts'),
  `// Generated by scripts/build-blog.mjs from content/blog/*.md — do not edit.\n` +
    `export interface BlogPostMeta {\n  slug: string;\n  title: string;\n  description: string;\n  date: string;\n  readingMinutes: number;\n  featured: boolean;\n  cover: string;\n}\n\n` +
    `export const blogPosts: BlogPostMeta[] = ${postsMeta()};\n`,
);

if (listOnly) {
  console.log(`blog: indexed ${posts.length} post(s)`);
  process.exit(0);
}

await mkdir(path.join(DIST, 'blog'), { recursive: true });
for (const post of posts) {
  const dir = path.join(DIST, 'blog', post.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'index.html'),
    postPage(post, posts.filter((p) => p.slug !== post.slug)),
  );
}
// The index goes to blog/index.html; deploy.sh additionally copies it to the
// bare "blog" key so https://pocketshell.io/blog resolves (S3 REST origins do
// not map directory URIs to index documents themselves).
await writeFile(path.join(DIST, 'blog', 'index.html'), indexPage(posts));
await writeFile(path.join(DIST, 'sitemap.xml'), sitemapXml(posts));
await writeFile(path.join(DIST, 'feed.xml'), feedXml(posts));
console.log(`blog: wrote ${posts.length} post(s), index, sitemap, feed`);
