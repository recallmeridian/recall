'use strict';

const https = require('https');

const USER_AGENT = 'Meridian/0.1 (research-kb)';

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

/**
 * GET a URL and return the response body as a string.
 * @param {string} url
 * @returns {Promise<string>}
 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      // Follow redirects (301, 302, 307, 308)
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
// PubMed E-utilities helpers
// ---------------------------------------------------------------------------

/**
 * Fetch PubMed summary JSON for a given PMID.
 */
async function fetchSummary(pmid) {
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmid}&retmode=json`;
  const body = await httpGet(url);
  return JSON.parse(body);
}

/**
 * Fetch PubMed abstract text for a given PMID.
 */
async function fetchAbstract(pmid) {
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&rettype=abstract&retmode=text`;
  return httpGet(url);
}

/**
 * Fetch PMC full-text XML for a given PMCID (numeric, without 'PMC' prefix).
 */
async function fetchPMCFullText(pmcid) {
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${pmcid}&rettype=xml`;
  return httpGet(url);
}

/**
 * Extract plain text paragraphs from PMC XML (very light parse).
 */
function extractTextFromPMCXml(xml) {
  // Pull all <p>...</p> content and strip tags
  const paragraphs = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length > 20) paragraphs.push(text);
  }
  return paragraphs.join('\n\n') || null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * fetchByPMID(pmid)
 *
 * Fetch paper metadata from PubMed. Attempts to pull full text from PMC
 * if a PMCID is available; otherwise falls back to the abstract text.
 *
 * @param {string} pmid
 * @returns {Promise<object>} Unified paper shape
 */
async function fetchByPMID(pmid) {
  const [summaryData, abstractText] = await Promise.all([
    fetchSummary(pmid),
    fetchAbstract(pmid).catch(() => ''),
  ]);

  const result = summaryData.result;
  if (!result || !result[pmid]) {
    throw new Error(`PubMed returned no data for PMID ${pmid}`);
  }

  const doc = result[pmid];

  // Title
  const title = doc.title || '';

  // Authors: array of { name: 'Last FM' } objects
  const authors = Array.isArray(doc.authors)
    ? doc.authors.map((a) => a.name).join(', ')
    : '';

  // Journal
  const journal = doc.source || doc.fulljournalname || '';

  // Publication date
  const date = doc.pubdate || doc.epubdate || '';

  // DOI — stored in articleids
  let doi = null;
  if (Array.isArray(doc.articleids)) {
    const doiEntry = doc.articleids.find((a) => a.idtype === 'doi');
    if (doiEntry) doi = doiEntry.value;
  }

  // PMC ID — try to get full text
  let fullText = null;
  let pmcid = null;
  if (Array.isArray(doc.articleids)) {
    const pmcEntry = doc.articleids.find((a) => a.idtype === 'pmc');
    if (pmcEntry) {
      pmcid = pmcEntry.value.replace(/^PMC/i, '');
    }
  }
  if (pmcid) {
    try {
      const xml = await fetchPMCFullText(pmcid);
      fullText = extractTextFromPMCXml(xml);
    } catch (_) {
      // PMC full text unavailable — that's fine
    }
  }

  // Abstract: the efetch abstract text is the most complete; strip the
  // boilerplate header lines (PMID /title lines) by keeping lines after
  // the blank line following the author list.
  const abstract = abstractText.trim();

  return {
    title,
    authors,
    abstract,
    fullText,
    date,
    source: `PubMed:${pmid}`,
    sourceUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    doi,
    peerReviewed: true,
    journal,
    pmid,
  };
}

/**
 * pmidFromDOI(doi)
 *
 * Look up a PMID from a DOI using PubMed ESearch.
 *
 * @param {string} doi
 * @returns {Promise<string|null>} PMID string or null if not found
 */
async function pmidFromDOI(doi) {
  const encodedDoi = encodeURIComponent(doi);
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodedDoi}[doi]&retmode=json`;
  const body = await httpGet(url);
  const data = JSON.parse(body);
  const ids = data.esearchresult && data.esearchresult.idlist;
  if (Array.isArray(ids) && ids.length > 0) {
    return ids[0];
  }
  return null;
}

module.exports = { fetchByPMID, pmidFromDOI };
