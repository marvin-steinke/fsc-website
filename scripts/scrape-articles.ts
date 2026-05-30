import * as cheerio from 'cheerio';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'src', 'data');

interface Article {
  title: string;
  url: string;
  date: string;
}

/** Returns today's date as dd.MM.yyyy. */
function today(): string {
  const d = new Date();
  return [
    d.getDate().toString().padStart(2, '0'),
    (d.getMonth() + 1).toString().padStart(2, '0'),
    d.getFullYear(),
  ].join('.');
}

/** Extract the first dd.MM.yyyy date from a text block. */
function extractDate(text: string): string {
  // The BFB site inserts &#8203; (U+200B zero-width space) between date
  // components to deter scraping; strip them before matching.
  const cleaned = text.replace(/\u200b/g, '');
  return cleaned.match(/(?<!\d)(\d{2}\.\d{2}\.\d{4})(?!\d)/)?.[1] ?? '';
}

/** Safely resolve a potentially relative href against a base URL. */
function resolveUrl(href: string, base: string): string {
  if (!href) return '';
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

async function fetchHtml(url: string, extraHeaders: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; FSC-Scraper/2.0)',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5',
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/**
 * Scrape BFB news from https://www.berliner-fechterbund.de/news/index.php?rubrik=1
 *
 * The site may show a cookie-consent overlay; we pass accept-cookies headers.
 * Multiple selectors are tried in priority order to handle Joomla template
 * variations.
 */
async function scrapeBfb(): Promise<Article[]> {
  const base = 'https://www.berliner-fechterbund.de';
  const url = `${base}/news/index.php?rubrik=1`;

  const html = await fetchHtml(url, {
    Cookie: 'cookieconsent_status=dismiss; cookie_consent=1; cms_cookie=1',
  });

  const $ = cheerio.load(html);
  const articles: Article[] = [];
  const seen = new Set<string>();
  const tried = new Set<object>();

  const selectors = [
    '.mod-articles-category-title a',
    '.blog .article-header a',
    '.items-leading .article-header a',
    'h2.article-header a',
    '.leading-0 h2 a',
    '.item-title a',
    'h2 a',
    'h3 a',
    '[class*="title"] a',
    'a[href*="index.php?option=com_content"]',
    'a[href*="/news/"]',
  ];

  for (const sel of selectors) {
    $(sel).each((_, el) => {
      if (articles.length >= 5) return false;
      if (tried.has(el)) return;
      tried.add(el);

      const href = $(el).attr('href') ?? '';
      if (!href || href === '#') return;

      const title = $(el).text().trim().replace(/\s+/g, ' ');
      if (!title || title.length < 5 || seen.has(href)) return;

      const lowerTitle = title.toLowerCase();
      if (['news', 'home', 'start', 'aktuell', 'mehr', 'more', 'weiterlesen'].includes(lowerTitle))
        return;

      seen.add(href);

      // Walk up the DOM until we reach a container that includes the article
      // description (which starts with the date). Stop at max 8 levels.
      let container = $(el).parent();
      for (let i = 0; i < 8; i++) {
        if (extractDate(container.text())) break;
        const up = container.parent();
        if (!up.length) break;
        container = up;
      }
      articles.push({ title, url: resolveUrl(href, base), date: extractDate(container.text()) || today() });
    });

    if (articles.length >= 5) break;
  }

  return articles;
}

/**
 * Scrape DFB news from https://www.fechten.org/news/listenansicht
 *
 * Article titles are in heading elements (h2/h3) whose links point to /n/<slug>.
 * The date (dd.MM.yyyy) appears inside the surrounding container element.
 */
async function scrapeDfb(): Promise<Article[]> {
  const base = 'https://www.fechten.org';
  const html = await fetchHtml(`${base}/news/listenansicht`);
  const $ = cheerio.load(html);

  const articles: Article[] = [];
  const seen = new Set<string>();

  $('h1 a, h2 a, h3 a, h4 a').each((_, el) => {
    if (articles.length >= 5) return false;

    const href = $(el).attr('href') ?? '';
    if (!href.includes('/n/')) return;

    const title = $(el).text().trim().replace(/\s+/g, ' ');
    if (!title || seen.has(href)) return;
    seen.add(href);

    const container = $(el)
      .closest('article, [class*="item"], [class*="news"], [class*="entry"], li, div')
      .first();
    articles.push({ title, url: resolveUrl(href, base), date: extractDate(container.text()) || today() });
  });

  return articles;
}

/**
 * Merge freshly scraped articles with cached data.
 * If an article title already exists in the cache its original date is kept,
 * but only when the cached date is non-empty (avoids perpetuating stale empty values).
 */
function merge(fresh: Article[], cached: Article[]): Article[] {
  return fresh.map((a) => {
    const hit = cached.find((c) => c.title === a.title);
    return (hit && hit.date) ? { ...a, date: hit.date } : a;
  });
}

function readCached(filename: string): Article[] {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, filename), 'utf-8')) as Article[];
  } catch {
    return [];
  }
}

function write(filename: string, data: Article[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, filename), JSON.stringify(data, null, 2) + '\n', 'utf-8');
  console.log(`  ✓ ${filename}: ${data.length} article(s)`);
}

async function main(): Promise<void> {
  console.log('Scraping articles…');

  const [dfbFresh, bfbFresh] = await Promise.all([
    scrapeDfb().catch((err: unknown) => {
      console.error('  ✗ DFB scrape failed:', (err as Error).message);
      return [] as Article[];
    }),
    scrapeBfb().catch((err: unknown) => {
      console.error('  ✗ BFB scrape failed:', (err as Error).message);
      return [] as Article[];
    }),
  ]);

  console.log(`  DFB: ${dfbFresh.length} article(s) scraped`);
  console.log(`  BFB: ${bfbFresh.length} article(s) scraped`);

  const dfbMerged = merge(dfbFresh, readCached('articles_dfb.json'));
  const bfbMerged = merge(bfbFresh, readCached('articles_bfb.json'));

  // Only overwrite if we actually got results; preserve stale data on failure
  if (dfbMerged.length > 0) write('articles_dfb.json', dfbMerged);
  else console.warn('  ⚠ DFB: no articles scraped, keeping existing data');

  if (bfbMerged.length > 0) write('articles_bfb.json', bfbMerged);
  else console.warn('  ⚠ BFB: no articles scraped, keeping existing data');

  console.log('Done.');
}

main().catch((err: unknown) => {
  console.error('Fatal scraper error:', err);
  process.exit(1);
});
