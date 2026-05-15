'use strict';

/**
 * EventLog — Immutable event log for all KB operations.
 * Every write creates an event. Events are append-only.
 * Current state can be rebuilt from the event stream.
 * Non-fatal: logging failures never block KB operations.
 */

class EventLog {
  constructor(db) {
    this.db = db;
    this._initTable();
  }

  _initTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        project_id TEXT,
        entry_id TEXT,
        actor TEXT DEFAULT 'system',
        payload TEXT,
        session_id TEXT,
        timestamp TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_entry ON events(entry_id);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    `);
  }

  /**
   * Emit an event. Non-fatal — catches all errors.
   */
  emit(type, projectId, entryId, payload = {}, actor = 'system') {
    try {
      this.db.prepare(`
        INSERT INTO events (event_type, project_id, entry_id, actor, payload, session_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        type,
        projectId || null,
        entryId || null,
        actor,
        typeof payload === 'string' ? payload : JSON.stringify(payload),
        process.env.MERIDIAN_SESSION_ID || null
      );
    } catch (err) {
      // Non-fatal: never block KB operations
      if (process.env.NODE_ENV !== 'test') {
        console.error('EventLog.emit failed:', err.message);
      }
    }
  }

  /**
   * Query events with filters.
   */
  query({ project, type, entry, actor, since, limit = 50 } = {}) {
    const conditions = [];
    const params = [];

    if (project) { conditions.push('project_id = ?'); params.push(project); }
    if (type) { conditions.push('event_type = ?'); params.push(type); }
    if (entry) { conditions.push('entry_id = ?'); params.push(entry); }
    if (actor) { conditions.push('actor = ?'); params.push(actor); }
    if (since) { conditions.push('timestamp >= ?'); params.push(since); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM events ${where} ORDER BY timestamp DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params);
    return rows.map(r => {
      try { r.payload = JSON.parse(r.payload); } catch { /* keep as string */ }
      return r;
    });
  }

  /**
   * Get aggregate stats by event type.
   */
  getStats() {
    const rows = this.db.prepare(`
      SELECT event_type, COUNT(*) as count
      FROM events
      GROUP BY event_type
      ORDER BY count DESC
    `).all();

    const total = rows.reduce((sum, r) => sum + r.count, 0);
    return { total, byType: Object.fromEntries(rows.map(r => [r.event_type, r.count])) };
  }

  /**
   * Get recent activity for a project (for dashboard/feed).
   */
  getRecentActivity(projectId, limit = 20) {
    const sql = projectId
      ? 'SELECT * FROM events WHERE project_id = ? ORDER BY timestamp DESC LIMIT ?'
      : 'SELECT * FROM events ORDER BY timestamp DESC LIMIT ?';
    const params = projectId ? [projectId, limit] : [limit];

    const rows = this.db.prepare(sql).all(...params);
    return rows.map(r => {
      try { r.payload = JSON.parse(r.payload); } catch {}
      return r;
    });
  }
}

module.exports = { EventLog };
