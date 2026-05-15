'use strict';

const http = require('http');
const https = require('https');

const USER_AGENT = 'Meridian/0.1 (research-kb)';

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * GET a URL (http or https) and return the body as a string.
 * Follows redirects up to 5 hops.
 */
function httpGet(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) {
      return reject(new Error(`Too many redirects for ${url}`));
    }

    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
        return resolve(httpGet(next, redirectsLeft - 1));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Atom XML parser (regex-based, no dependencies)
// ---------------------------------------------------------------------------

/**
 * Extract the text content of the first matching XML element.
 */
function extractXmlTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
}

/**
 * Extract all text contents of repeated XML elements.
 */
function extractAllXmlTags(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  }
  return results;
}

/**
 * Parse arXiv Atom feed entry.
 */
function parseAtomEntry(xml) {
  const title = extractXmlTag(xml, 'title') || '';
  const summary = extractXmlTag(xml, 'summary') || '';
  const published = extractXmlTag(xml, 'published') || '';

  // Authors: <name> inside <author>
  const authorBlocks = extractAllXmlTags(xml, 'author');
  const authors = authorBlocks
    .map((block) => extractXmlTag(block, 'name') || block)
    .filter(Boolean)
    .join(', ');

  // DOI link if present
  const doiMatch = xml.match(/<link[^>]+title="doi"[^>]+href="([^"]+)"/i)
    || xml.match(/doi\.org\/(10\.\d{4,}\/\S+)/);
  const doi = doiMatch ? (doiMatch[2] || doiMatch[1].replace(/.*doi\.org\//, '')) : null;

  return { title, summary, published, authors, doi };
}

// ---------------------------------------------------------------------------
// HTML full-text extraction for ar5iv
// ---------------------------------------------------------------------------

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract main article body from ar5iv HTML.
 * ar5iv wraps content in <article> or <section class="ltx_document">.
 */
function extractAr5ivFullText(html) {
  // Try <article> first
  let match = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (match) return htmlToText(match[1]);

  // Try ltx_document section
  match = html.match(/<section[^>]+class="[^"]*ltx_document[^"]*"[^>]*>([\s\S]*?)<\/section>/i);
  if (match) return htmlToText(match[1]);

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * fetchArxiv(id)
 *
 * Fetch paper metadata from the arXiv Atom API and attempt full-text from ar5iv.
 *
 * @param {string} id - arXiv ID, e.g. '2512.13564' or '2512.13564v2'
 * @returns {Promise<object>} Unified paper shape
 */
async function fetchArxiv(id) {
  // Strip version for canonical ID used in source
  const baseId = id.replace(/v\d+$/, '');

  const metaUrl = `http://export.arxiv.org/api/query?id_list=${id}`;
  const xml = await httpGet(metaUrl);

  // Check for error / no results
  if (xml.includes('<opensearch:totalResults>0</opensearch:totalResults>')) {
    throw new Error(`arXiv returned no results for ID ${id}`);
  }

  // Extract the <entry> block
  const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/i);
  if (!entryMatch) {
    throw new Error(`arXiv Atom feed missing <entry> for ID ${id}`);
  }

  const { title, summary, published, authors, doi } = parseAtomEntry(entryMatch[1]);

  // Date: take YYYY-MM-DD from published timestamp
  const date = published ? published.slice(0, 10) : '';

  // Full text via ar5iv
  let fullText = null;
  const fullUrl = `https://ar5iv.labs.arxiv.org/html/${baseId}`;
  try {
    const html = await httpGet(fullUrl);
    fullText = extractAr5ivFullText(html);
  } catch (_) {
    // ar5iv unavailable — that's fine
  }

  return {
    title,
    authors,
    abstract: summary,
    fullText,
    date,
    source: `arXiv:${baseId}`,
    sourceUrl: `https://arxiv.org/abs/${baseId}`,
    doi: doi || null,
    peerReviewed: false,
    journal: 'arXiv',
    pmid: null,
  };
}

module.exports = { fetchArxiv };
