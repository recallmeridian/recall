'use strict';

/**
 * detectIdentifier(input)
 *
 * Auto-detects the type of a literature identifier.
 *
 * @param {string} input - DOI, PMID, arXiv ID, URL, bioRxiv DOI/URL, etc.
 * @returns {{ type: 'doi'|'pmid'|'arxiv'|'biorxiv'|'unknown', id: string }}
 */
function detectIdentifier(input) {
  if (typeof input !== 'string') {
    return { type: 'unknown', id: String(input) };
  }

  const s = input.trim();

  // 1. PubMed URL: pubmed.ncbi.nlm.nih.gov/(\d+)
  let m = s.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/);
  if (m) return { type: 'pmid', id: m[1] };

  // 2. arXiv URL: arxiv.org/(?:abs|pdf)/(\d{4}\.\d{4,5}(?:v\d+)?)
  m = s.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?)/);
  if (m) return { type: 'arxiv', id: m[1] };

  // 3. bioRxiv URL: biorxiv.org/content/(10\.1101/[\d.]+)
  m = s.match(/biorxiv\.org\/content\/(10\.1101\/[\d.]+)/);
  if (m) return { type: 'biorxiv', id: m[1] };

  // 4. DOI URL: doi.org/(10\.\d{4,}/\S+)
  m = s.match(/doi\.org\/(10\.\d{4,}\/\S+)/);
  if (m) return { type: 'doi', id: m[1] };

  // 5. bioRxiv DOI: ^10\.1101/\d{4}\.\d{2}\.\d{2}\.\d+$
  if (/^10\.1101\/\d{4}\.\d{2}\.\d{2}\.\d+$/.test(s)) {
    return { type: 'biorxiv', id: s };
  }

  // 6. Generic DOI: ^10\.\d{4,}/\S+$
  if (/^10\.\d{4,}\/\S+$/.test(s)) {
    return { type: 'doi', id: s };
  }

  // 7. arXiv ID: ^\d{4}\.\d{4,5}(?:v\d+)?$
  if (/^\d{4}\.\d{4,5}(?:v\d+)?$/.test(s)) {
    return { type: 'arxiv', id: s };
  }

  // 8. PubMed ID: ^\d{6,10}$
  if (/^\d{6,10}$/.test(s)) {
    return { type: 'pmid', id: s };
  }

  // 9. Unknown
  return { type: 'unknown', id: s };
}

module.exports = { detectIdentifier };
