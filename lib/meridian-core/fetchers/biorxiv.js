'use strict';

const https = require('https');

const USER_AGENT = 'Meridian/0.1 (research-kb)';

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpGet(res.headers.location));
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
// HTML parsing helpers
// ---------------------------------------------------------------------------

/**
 * Very lightweight HTML→text extractor. Strips all tags, decodes common
 * HTML entities, and collapses whitespace.
 */
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
 * Extract the main article body from bioRxiv full-text HTML.
 * Targets the <div class="article-body"> or <section> elements.
 */
function extractBioRxivFullText(html) {
  // Try to find the abstract section
  let match = html.match(/<div[^>]+class="[^"]*article-body[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (!match) {
    // Fall back to <section> elements
    match = html.match(/<section[^>]*>([\s\S]*?)<\/section>/gi);
    if (match) {
      return htmlToText(match.join(' '));
    }
  }
  if (match) return htmlToText(match[1]);
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * fetchBioRxiv(doi)
 *
 * Fetch paper metadata and full text from bioRxiv.
 *
 * @param {string} doi - bioRxiv DOI, e.g. '10.1101/2024.03.15.585200'
 * @returns {Promise<object>} Unified paper shape
 */
async function fetchBioRxiv(doi) {
  // Metadata from bioRxiv API
  const metaUrl = `https://api.biorxiv.org/details/biorxiv/${doi}/na/json`;
  const metaBody = await httpGet(metaUrl);
  const metaData = JSON.parse(metaBody);

  const collection = metaData.collection;
  if (!Array.isArray(collection) || collection.length === 0) {
    throw new Error(`bioRxiv returned no data for DOI ${doi}`);
  }

  // Use the latest version (last item in collection)
  const paper = collection[collection.length - 1];

  const title = paper.title || '';
  const authors = paper.authors || '';
  const abstract = paper.abstract || '';
  const date = paper.date || '';
  const journal = paper.server || 'bioRxiv';
  const version = paper.version || '1';

  // Attempt full-text HTML from bioRxiv
  let fullText = null;
  const fullUrl = `https://www.biorxiv.org/content/${doi}.full`;
  try {
    const html = await httpGet(fullUrl);
    fullText = extractBioRxivFullText(html);
  } catch (_) {
    // Full text unavailable — that's fine
  }

  return {
    title,
    authors,
    abstract,
    fullText,
    date,
    source: `bioRxiv:${doi}`,
    sourceUrl: `https://www.biorxiv.org/content/${doi}v${version}`,
    doi,
    peerReviewed: false,
    journal,
    pmid: null,
  };
}

module.exports = { fetchBioRxiv };
