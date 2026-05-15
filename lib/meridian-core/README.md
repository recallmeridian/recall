# @meridian/core

Local-first knowledge engine for the Meridian platform. Manages MIF v4.0 entries as individual JSON files with a SQLite index for fast full-text search, hybrid (BM25 + dense) retrieval with research-grounded reranking, and hub-local usage telemetry.

## Install

```bash
npm install @meridian/core
```

## Quick Start

```javascript
const meridian = require('@meridian/core');

// Initialize a data directory
const kb = meridian.init('~/.meridian');

// Create a project
kb.createProject('my-lab', { type: 'research', description: 'Pancreatic cancer research' });

// Add an entry (MIF v4.0 shape)
kb.addEntry('my-lab', {
  id: 'kras-g12c-resistance',
  schemaVersion: '4.0',
  projectId: 'my-lab',
  name: 'KRAS G12C Resistance',
  description: 'PANC-1 cells showed resistance to sotorasib via PI3K bypass...',
  category: 'experimental-finding',
  status: 'active',
  confidence: {
    value: 0.85,
    lastVerified: '2026-04-25T00:00:00Z',
    decayDays: 180,
    exempt: false,
    verificationStatus: 'verified'
  },
  fusion: { fusedFrom: [], fusedAt: null, fusionDepth: 0 },
  practicalValue: 'high',
  disease_area: 'pancreatic cancer',
  genes: ['KRAS'],
  // domain-specific fields go in _extensions
  _extensions: { isNegativeResult: false, evidenceLevel: 'cell-line' }
});

// Search
const results = kb.search('KRAS resistance');

// Fetch a paper
const paper = await meridian.fetch('10.1038/s41586-021-03819-2');
```

## API

### `meridian.init(dataDir)` — Initialize data directory, returns KBStore

```javascript
const kb = meridian.init('~/.meridian');
// or use default:
const kb = meridian.init();
```

### `meridian.fetch(identifier)` — Fetch paper from DOI, PMID, arXiv, or bioRxiv

```javascript
// All of these work:
const paper1 = await meridian.fetch('10.1038/s41586-021-03819-2');  // DOI
const paper2 = await meridian.fetch('33414491');                     // PMID
const paper3 = await meridian.fetch('2103.14030');                   // arXiv
const paper4 = await meridian.fetch('https://pubmed.ncbi.nlm.nih.gov/33414491');
```

### KBStore methods:

- `createProject(id, options)` — Create a new project
- `listProjects()` — List all projects
- `addEntry(projectId, data)` — Add a MIF entry (validates, indexes)
- `getEntry(projectId, entryId)` — Get entry with staleness computed
- `updateEntry(projectId, entryId, updates)` — Update entry fields
- `listEntries(projectId, filters)` — List entries with optional filters
- `search(query)` — Full-text search via SQLite FTS5
- `query(queryStr)` — SQL-like query interface
- `getStaleEntries(projectId)` — Entries past their decay threshold
- `verifyEntry(projectId, entryId)` — Update lastVerified timestamp
- `addRelationship(from, to, type, note)` — Add typed relationship
- `getRelationships(entryId)` — Get all relationships for an entry
- `getContradictions(projectId)` — Find contradiction pairs
- `rebuildIndex()` — Rebuild SQLite from JSON files

## Data Storage

All entries are stored as individual JSON files under `~/.meridian/projects/{projectId}/entries/`. A SQLite database at `~/.meridian/meridian.db` indexes them for fast search.

```
~/.meridian/
├── projects/
│   ├── my-lab/
│   │   └── entries/
│   │       ├── kras-g12c-resistance.json
│   │       └── pi3k-pathway.json
│   └── project.json (metadata)
├── meridian.db           (FTS5 index)
└── relationships.db      (graph data)
```

## License

Apache-2.0
