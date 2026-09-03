// Outrank -> LoveCheck blog auto-publisher (Vercel serverless function)
//
// Outrank sends a POST with `Authorization: Bearer <token>` and a JSON body:
//   { event_type, timestamp, data: { articles: [ { title, content_html,
//     content_markdown, meta_description, slug, tags, image_url, created_at } ] } }
//
// This function verifies the token, wraps each article in the LoveCheck blog
// template, and commits it to blog/<slug>.html in the GitHub repo (which makes
// Vercel redeploy). It also appends the new URL to sitemap.xml.
//
// Required environment variables (set in the Vercel project settings):
//   OUTRANK_ACCESS_TOKEN  - shared secret, must match the token entered in Outrank
//   GITHUB_TOKEN          - fine-grained GitHub token with Contents: read & write on this repo

const OWNER = "guichstudio";
const REPO = "lovechecklanding";
const BRANCH = "main";
const SITE = "https://www.lovecheckapp.com";
// Kill switch de publication. Pause par defaut : la publication automatique
// est suspendue tant que OUTRANK_PUBLISHING_ENABLED n'est pas exactement "true".
// Motif : 16 articles en 16 jours sur un domaine de 3 semaines, tous en position
// 85-95 avec 0 clic. Pour reprendre : definir la variable dans Vercel.
const PUBLISHING_ENABLED = process.env.OUTRANK_PUBLISHING_ENABLED === "true";

const GH_HEADERS = (token) => ({
  Authorization: `Bearer ${token}`,
  "User-Agent": "lovecheck-outrank-webhook",
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json",
});

module.exports = async (req, res) => {
  // Health/config check (no secrets leaked, just booleans) — GET the endpoint to verify env vars are applied.
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      endpoint: "outrank-webhook",
      configured: {
        OUTRANK_ACCESS_TOKEN: Boolean(process.env.OUTRANK_ACCESS_TOKEN),
        GITHUB_TOKEN: Boolean(process.env.GITHUB_TOKEN),
      },
      publishing_enabled: PUBLISHING_ENABLED,
    });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 1. Authenticate the request
  const token = process.env.OUTRANK_ACCESS_TOKEN;
  const auth = req.headers["authorization"] || "";
  if (!token || auth !== `Bearer ${token}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Publication en pause : on accuse reception sans rien ecrire.
  // 200 (et non 4xx/5xx) pour qu'Outrank ne rejoue pas la livraison en boucle.
  if (!PUBLISHING_ENABLED) {
    return res.status(200).json({
      ok: true,
      paused: true,
      message: "Publishing is paused. Set OUTRANK_PUBLISHING_ENABLED=true to resume.",
    });
  }

  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) {
    return res.status(500).json({ error: "Server not configured: GITHUB_TOKEN missing" });
  }

  // 2. Parse the payload (Vercel usually parses JSON automatically)
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }

  // Robustly locate the article list across payload shapes.
  let articles =
    body?.data?.articles ||
    (body?.data?.article ? [body.data.article] : null) ||
    (Array.isArray(body?.articles) ? body.articles : null) ||
    (body?.article ? [body.article] : null);
  if (!Array.isArray(articles) || articles.length === 0) {
    return res.status(200).json({ ok: true, message: "No articles in payload", event: body?.event_type });
  }

  // 3. Build ALL changes in memory, then write them in ONE atomic commit.
  //    A single commit = a single Vercel deploy = reliable CDN cache purge.
  //    (Three separate commits per article confused Vercel's deploy/purge and
  //    left /blog served stale from the edge cache.)
  try {
    const sitemapFile = await ghGetFile(ghToken, "sitemap.xml");
    const indexFile = await ghGetFile(ghToken, "blog/index.html");
    let sitemapXml = sitemapFile ? Buffer.from(sitemapFile.content, "base64").toString("utf8") : null;
    let indexHtml = indexFile ? Buffer.from(indexFile.content, "base64").toString("utf8") : null;
    const existing = indexHtml ? parseCards(indexHtml) : []; // for internal linking

    const files = [];
    const results = [];
    for (const a of articles) {
      try {
        const slug = slugify(a.slug || a.title || "");
        if (!slug) throw new Error("Missing slug/title");
        files.push({ path: `blog/${slug}.html`, content: renderArticle(a, slug, existing) });
        if (sitemapXml) sitemapXml = addLocToSitemap(sitemapXml, `${SITE}/blog/${slug}`);
        if (indexHtml) indexHtml = addCardToIndex(indexHtml, a, slug);
        existing.unshift({ href: `/blog/${slug}`, title: decodeEntities(String(a.title || "")).trim() });
        results.push({ slug, status: "published" });
      } catch (e) {
        results.push({ title: a?.title, status: "error", error: String(e && e.message ? e.message : e) });
      }
    }

    if (sitemapFile && sitemapXml) files.push({ path: "sitemap.xml", content: sitemapXml });
    if (indexFile && indexHtml) files.push({ path: "blog/index.html", content: indexHtml });

    const published = results.filter((r) => r.status === "published").map((r) => r.slug);
    if (files.length) {
      await commitFilesAtomic(ghToken, files, `Outrank: publish ${published.join(", ") || "articles"}`);
    }

    // Extra safety net: fire a Vercel deploy hook if configured (forces a fresh deploy).
    if (process.env.VERCEL_DEPLOY_HOOK && published.length) {
      try { await fetch(process.env.VERCEL_DEPLOY_HOOK, { method: "POST" }); } catch (_) { /* non-fatal */ }
    }

    const anyError = results.some((r) => r.status === "error");
    return res.status(anyError ? 207 : 200).json({ ok: !anyError, results });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};

/* ---------------- helpers ---------------- */

function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripTags(s) {
  return String(s || "").replace(/<[^>]*>/g, " ");
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&rsquo;|&#8217;/g, "’").replace(/&mdash;|&#8212;/g, "—");
}

// Build FAQPage structured data from question-style headings in the article body.
// Only questions/answers that are actually visible on the page are used (Google-compliant).
function buildFaqSchema(html) {
  const headingRe = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi;
  const heads = [];
  let m;
  while ((m = headingRe.exec(html)) !== null) {
    heads.push({ text: decodeEntities(stripTags(m[1])).replace(/\s+/g, " ").trim(), start: m.index, end: headingRe.lastIndex });
  }
  const faqs = [];
  for (let i = 0; i < heads.length; i++) {
    const q = heads[i].text;
    if (!q.endsWith("?") || q.length < 8) continue;
    const chunk = html.slice(heads[i].end, i + 1 < heads.length ? heads[i + 1].start : html.length);
    const a = decodeEntities(stripTags(chunk)).replace(/\s+/g, " ").trim();
    if (a.length < 40) continue;
    faqs.push({ q, a: a.slice(0, 900) });
    if (faqs.length >= 6) break;
  }
  if (faqs.length < 2) return null;
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  });
}

// Parse the blog index HTML into a list of {href, title} for internal linking.
function parseCards(html) {
  const re = /<a class="post-card" href="(\/blog\/[^"]+)">[\s\S]*?<h2>([\s\S]*?)<\/h2>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ href: m[1], title: decodeEntities(stripTags(m[2])).replace(/\s+/g, " ").trim() });
  }
  return out;
}

// Pure transform: add a <url> entry to the sitemap XML (idempotent).
function addLocToSitemap(xml, loc) {
  if (xml.includes(`<loc>${loc}</loc>`)) return xml;
  const today = new Date().toISOString().slice(0, 10);
  const entry =
    `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${today}</lastmod>\n` +
    `    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>\n`;
  return xml.replace("</urlset>", entry + "</urlset>");
}

// Pure transform: add a post card to the blog index at the marker (idempotent, newest first).
function addCardToIndex(html, a, slug) {
  const href = `/blog/${slug}`;
  const marker = "<!-- POSTS_START -->";
  if (html.includes(`href="${href}"`) || !html.includes(marker)) return html;
  const tag = esc((Array.isArray(a.tags) && a.tags[0]) || "Relationship tips");
  const title = esc(a.title || "");
  const thumb = a.image_url
    ? `<div class="post-thumb"><img src="${esc(a.image_url)}" alt="${title}" loading="lazy"></div>`
    : `<div class="post-thumb post-thumb--ph"><img src="/icon.png" alt="LoveCheck"></div>`;
  const card =
    `\n            <a class="post-card" href="${href}">\n` +
    `                ${thumb}\n` +
    `                <div class="post-card-body">\n` +
    `                    <span class="post-tag">${tag}</span>\n` +
    `                    <h2>${title}</h2>\n` +
    `                    <p>${esc(a.meta_description || "")}</p>\n` +
    `                </div>\n` +
    `            </a>`;
  return html.replace(marker, marker + card);
}

async function ghGetFile(token, path) {
  const r = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${BRANCH}`,
    { headers: GH_HEADERS(token) }
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

// Generic GitHub API JSON call.
async function ghJson(token, url, method, body) {
  const r = await fetch(url, {
    method: method || "GET",
    headers: GH_HEADERS(token),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`GitHub ${method || "GET"} ${url.replace(/^https:\/\/api\.github\.com/, "")}: ${r.status} ${await r.text()}`);
  return r.json();
}

// Commit multiple files in ONE commit via the Git Data API.
// One commit -> one Vercel deploy -> reliable CDN cache purge.
async function commitFilesAtomic(token, files, message) {
  const base = `https://api.github.com/repos/${OWNER}/${REPO}`;
  const ref = await ghJson(token, `${base}/git/ref/heads/${BRANCH}`);
  const baseSha = ref.object.sha;
  const baseCommit = await ghJson(token, `${base}/git/commits/${baseSha}`);
  const tree = [];
  for (const f of files) {
    const blob = await ghJson(token, `${base}/git/blobs`, "POST", {
      content: Buffer.from(f.content, "utf8").toString("base64"),
      encoding: "base64",
    });
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const newTree = await ghJson(token, `${base}/git/trees`, "POST", { base_tree: baseCommit.tree.sha, tree });
  const commit = await ghJson(token, `${base}/git/commits`, "POST", { message, tree: newTree.sha, parents: [baseSha] });
  await ghJson(token, `${base}/git/refs/heads/${BRANCH}`, "PATCH", { sha: commit.sha });
}

function renderArticle(a, slug, related) {
  const url = `${SITE}/blog/${slug}`;
  const title = esc(a.title || "LoveCheck");
  const desc = esc(a.meta_description || "");
  const tag = esc((Array.isArray(a.tags) && a.tags[0]) || "Relationship tips");
  const ogImage = a.image_url ? esc(a.image_url) : `${SITE}/icon.png`;
  const date = (a.created_at ? String(a.created_at) : new Date().toISOString()).slice(0, 10);
  const dateLabel = new Date(date + "T00:00:00Z").toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  });

  // Normalize the incoming body: keep a single <h1> (our title), so demote any
  // h1 inside the content to h2.
  let bodyHtml = String(a.content_html || "");
  bodyHtml = bodyHtml.replace(/<(\/?)h1(\b[^>]*)>/gi, "<$1h2$2>");

  // Featured/hero image at the top of the article (skip if already in the body to avoid duplicates).
  const heroUrl = a.image_url ? esc(a.image_url) : "";
  const hero = heroUrl && !bodyHtml.includes(a.image_url)
    ? `<img class="article-hero" src="${heroUrl}" alt="${title}">`
    : "";

  const ld1 = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: a.title || "",
    description: a.meta_description || "",
    image: ogImage,
    author: { "@type": "Organization", name: "LoveCheck" },
    publisher: { "@type": "Organization", name: "LoveCheck", logo: { "@type": "ImageObject", url: `${SITE}/icon-192.png` } },
    datePublished: date,
    dateModified: date,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
  });
  const ld2 = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE}/blog` },
      { "@type": "ListItem", position: 3, name: a.title || "", item: url },
    ],
  });
  const ldFaq = buildFaqSchema(bodyHtml);

  // Internal linking: link to up to 3 other existing articles.
  const relItems = (related || []).filter((r) => r.href !== `/blog/${slug}`).slice(0, 3);
  const relatedSection = relItems.length
    ? `\n    <section class="related">\n        <div class="container">\n            <h3>Keep reading</h3>\n` +
      relItems.map((r) => `            <a href="${r.href}">${esc(r.title)} &rarr;</a>`).join("\n") +
      `\n        </div>\n    </section>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <meta name="description" content="${desc}">

    <link rel="icon" href="/favicon.ico" sizes="any">
    <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
    <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png">

    <link rel="canonical" href="${url}">

    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${desc}">
    <meta property="og:image" content="${ogImage}">
    <meta property="og:url" content="${url}">
    <meta property="og:type" content="article">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${desc}">
    <meta name="twitter:image" content="${ogImage}">

    <meta name="theme-color" content="#FDF8F4">

    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">

    <script type="application/ld+json">${ld1}</script>
    <script type="application/ld+json">${ld2}</script>${ldFaq ? `\n    <script type="application/ld+json">${ldFaq}</script>` : ""}

    <style>
        @font-face { font-family: 'Advercase'; src: url('/fonts/Advercase.otf') format('opentype'); font-weight: normal; font-style: normal; font-display: swap; }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html { scroll-behavior: smooth; }
        body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background-color: #FDF8F4; color: #2D2D2D; line-height: 1.75; letter-spacing: -0.04em; }
        h1, h2, h3 { letter-spacing: -0.05em; }
        .container { max-width: 720px; margin: 0 auto; padding: 0 24px; }
        .header { padding: 16px 24px; text-align: center; border-bottom: 1px solid rgba(0,0,0,0.05); }
        .header-logo { display: inline-flex; align-items: center; gap: 6px; font-size: 1rem; font-weight: 600; color: #2D2D2D; text-decoration: none; letter-spacing: -0.06em; }
        .header-icon { width: 36px; height: 36px; border-radius: 10px; }
        .breadcrumb { max-width: 720px; margin: 24px auto 0; padding: 0 24px; font-size: 0.78rem; color: #999; }
        .breadcrumb a { color: #999; text-decoration: none; }
        .breadcrumb a:hover { color: #C41E3A; }
        article { padding: 20px 24px 48px; }
        .article-tag { display: inline-block; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; color: #C41E3A; background: #FCE9EC; padding: 4px 10px; border-radius: 999px; margin-bottom: 16px; }
        .article-title { font-family: 'Advercase', Georgia, serif; font-size: 2.1rem; color: #C41E3A; line-height: 1.15; margin-bottom: 12px; }
        .article-meta { font-size: 0.82rem; color: #999; margin-bottom: 24px; }
        .article-hero { display: block; width: 100%; max-height: 440px; object-fit: cover; border-radius: 20px; margin-bottom: 28px; border: 1px solid rgba(0,0,0,0.04); }
        .article-body { background: #fff; border-radius: 20px; padding: 40px; border: 1px solid rgba(0,0,0,0.04); }
        .article-body p { margin-bottom: 18px; font-size: 0.98rem; color: #333; }
        .article-body h2 { font-size: 1.35rem; font-weight: 700; color: #2D2D2D; margin: 34px 0 12px; }
        .article-body h3 { font-size: 1.05rem; font-weight: 700; color: #C41E3A; margin: 24px 0 8px; }
        .article-body ul, .article-body ol { margin: 0 0 18px 22px; }
        .article-body li { margin-bottom: 8px; font-size: 0.98rem; color: #333; }
        .article-body a { color: #C41E3A; text-decoration: none; font-weight: 600; }
        .article-body a:hover { text-decoration: underline; }
        .article-body img { max-width: 100%; height: auto; border-radius: 14px; margin: 8px 0 18px; }
        .article-body strong { font-weight: 700; }
        .app-cta { background: linear-gradient(135deg, #C41E3A, #E14B63); border-radius: 20px; padding: 32px; text-align: center; margin: 36px 0 8px; color: #fff; }
        .app-cta h3 { color: #fff; font-size: 1.25rem; margin-bottom: 8px; }
        .app-cta p { color: rgba(255,255,255,0.9); font-size: 0.92rem; margin-bottom: 18px; }
        .app-cta-btn { display: inline-block; background: #fff; color: #C41E3A; font-weight: 700; padding: 12px 26px; border-radius: 999px; text-decoration: none; font-size: 0.92rem; }
        .related { padding: 0 24px 48px; }
        .related .container { background: #fff; border-radius: 16px; padding: 24px 28px; border: 1px solid rgba(0,0,0,0.04); }
        .related h3 { font-size: 0.8rem; text-transform: uppercase; color: #999; margin-bottom: 12px; letter-spacing: 0; }
        .related a { display: block; color: #C41E3A; text-decoration: none; font-weight: 600; font-size: 0.98rem; margin-bottom: 8px; }
        .related a:hover { text-decoration: underline; }
        .footer { padding: 32px 24px; text-align: center; background: #FDF8F4; border-top: 1px solid rgba(0,0,0,0.05); }
        .footer-links { display: flex; justify-content: center; gap: 28px; margin-bottom: 16px; flex-wrap: wrap; }
        .footer-links a { color: #888; text-decoration: none; font-size: 0.8rem; letter-spacing: -0.06em; }
        .footer-links a:hover { color: #C41E3A; }
        .footer-copyright { font-size: 0.75rem; color: #AAA; }
        @media (max-width: 480px) { .article-title { font-size: 1.7rem; } .article-body { padding: 28px 22px; } }
    </style>
</head>
<body>
    <header class="header">
        <a href="/" class="header-logo"><img src="/icon.png" alt="LoveCheck" class="header-icon"> Love Check</a>
    </header>

    <nav class="breadcrumb"><a href="/">Home</a> &rsaquo; <a href="/blog">Blog</a> &rsaquo; ${title}</nav>

    <article>
        <div class="container">
            <span class="article-tag">${tag}</span>
            <h1 class="article-title">${title}</h1>
            <p class="article-meta">Updated ${dateLabel}</p>
            ${hero}
            <div class="article-body">
                ${bodyHtml}
                <div class="app-cta">
                    <h3>Feel closer, every day</h3>
                    <p>LoveCheck turns connection into a fun daily ritual — couple quizzes, deep-question games, and a shared streak you build together.</p>
                    <a class="app-cta-btn" href="https://apps.apple.com/app/lovecheck-couple-game/id6504616839" target="_blank" rel="noopener">Get LoveCheck free &rarr;</a>
                </div>
            </div>
        </div>
    </article>
${relatedSection}
    <footer class="footer">
        <div class="container">
            <div class="footer-links">
                <a href="/">Home</a>
                <a href="/blog">Blog</a>
                <a href="/privacy">Privacy Policy</a>
                <a href="/terms">Terms of Service</a>
                <a href="mailto:hello@lovecheck.us">Support</a>
            </div>
            <p class="footer-copyright">&copy; 2026 LoveCheck. All rights reserved.</p>
        </div>
    </footer>
</body>
</html>`;
}
