import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { DEFAULT_WORKSPACE, type DocumentKind, type Workspace, type WorkspaceConfiguration, type WorkspaceDocument, type WorkspaceExport, type EndpointOverview, type MockProfile } from '../shared/workspaces.js';
import { isEvent, isReplay, isSummary, type EventFilters, type EventPage, type EventSummary, type ReplayExecution, type ReplayPage, type WebhookEvent } from '../shared/contracts.js';
import type { EventMetadata } from './normalize.js';
import { detectProvider } from '../shared/providers.js';
import { editableText } from '../shared/replay.js';
import { validateDocument } from './workspaces.js';

export class InvalidRecordError extends Error {}

export class EventStore {
  private readonly db: DatabaseSync;

  constructor(path: string, private readonly bodyLimit = 1_048_576) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          summary TEXT NOT NULL,
          details TEXT NOT NULL,
          body BLOB NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS event_index (
          sequence INTEGER PRIMARY KEY REFERENCES events(sequence),
          method TEXT NOT NULL, status INTEGER NOT NULL, path TEXT NOT NULL,
          content_type TEXT NOT NULL, received_at TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        CREATE INDEX IF NOT EXISTS event_filter ON event_index(method, status, sequence);
        CREATE INDEX IF NOT EXISTS event_pins ON event_index(pinned, sequence);
        CREATE INDEX IF NOT EXISTS event_dates ON event_index(received_at, sequence);
        CREATE TABLE IF NOT EXISTS events_search (rowid INTEGER PRIMARY KEY, text TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS replays (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          source_event_id TEXT NOT NULL REFERENCES events(id), execution TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS replay_history ON replays(source_event_id, sequence);
      `);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(`CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS local_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS workspace_documents (workspace_id TEXT NOT NULL REFERENCES workspaces(id), kind TEXT NOT NULL,
            id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workspace_id, kind, id)) STRICT;`);
        this.db.prepare('INSERT OR IGNORE INTO workspaces VALUES (?, ?, ?)').run(DEFAULT_WORKSPACE, 'local', new Date().toISOString());
        this.db.prepare('INSERT OR IGNORE INTO local_settings VALUES (?, ?)').run('active_workspace', DEFAULT_WORKSPACE);
        if (!this.db.prepare('PRAGMA table_info(events)').all().some((r) => r.name === 'workspace_id')) {
          // SQLite requires a NULL default when adding a foreign key to a populated table.
          this.db.exec('ALTER TABLE events ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)');
        }
        this.db.prepare('UPDATE events SET workspace_id = ? WHERE workspace_id IS NULL').run(DEFAULT_WORKSPACE);
        const replayColumns = this.db.prepare('PRAGMA table_info(replays)').all();
        const hasReplayWorkspace = replayColumns.some((r) => r.name === 'workspace_id');
        const hasReplayRequest = replayColumns.some((r) => r.name === 'source_request_id');
        if (!hasReplayWorkspace || !hasReplayRequest || replayColumns.some((r) => r.name === 'source_event_id' && r.notnull === 1)) {
          const replaySequence = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'replays'").get()?.seq ?? 0;
          this.db.exec(`ALTER TABLE replays RENAME TO replays_legacy;
            DROP INDEX replay_history;
            CREATE TABLE replays (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
              source_event_id TEXT REFERENCES events(id), source_request_id TEXT,
              workspace_id TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE}' REFERENCES workspaces(id), execution TEXT NOT NULL) STRICT;
            INSERT INTO replays(sequence, id, source_event_id, source_request_id, workspace_id, execution)
              SELECT sequence, id, source_event_id, ${hasReplayRequest ? 'source_request_id' : 'NULL'},
                coalesce(${hasReplayWorkspace ? 'workspace_id' : 'NULL'},
                  (SELECT workspace_id FROM events WHERE id = replays_legacy.source_event_id), '${DEFAULT_WORKSPACE}'),
                execution FROM replays_legacy;
            DROP TABLE replays_legacy;
            CREATE INDEX replay_history ON replays(source_event_id, sequence);`);
          this.db.prepare("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'replays'").run(replaySequence);
        } else {
          this.db.prepare(`UPDATE replays SET workspace_id = coalesce(
            (SELECT workspace_id FROM events WHERE id = replays.source_event_id), ?) WHERE workspace_id IS NULL`).run(DEFAULT_WORKSPACE);
        }
        this.db.exec('CREATE INDEX IF NOT EXISTS workspace_events ON events(workspace_id, sequence); CREATE INDEX IF NOT EXISTS workspace_replays ON replays(workspace_id, sequence);');
        this.db.exec(`UPDATE replays SET execution = json_set(execution, '$.state', 'completed', '$.result.error',\n          json('{"code":"INTERRUPTED","message":"Execution interrupted; the destination may have received the request."}'))\n          WHERE json_valid(execution) AND json_extract(execution, '$.state') = 'running';`);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of this.db.prepare('SELECT e.* FROM events e LEFT JOIN event_index i ON e.sequence = i.sequence WHERE i.sequence IS NULL').iterate()) {
          try {
            const summary: unknown = JSON.parse(String(row.summary));
            const details = JSON.parse(String(row.details)) as EventMetadata;
            if (isSummary(summary) && row.body instanceof Uint8Array) this.index(summary, details, Buffer.from(row.body));
          } catch { /* Invalid historical records remain isolated. */ }
        }
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch (error) { this.db.close(); throw error; }
  }

  create(event: EventMetadata, body: Buffer, startedAt: number, workspaceId = this.activeWorkspace()): EventSummary {
    const { requestTarget, httpVersion, headers, query, userAgent, sourceIp, contentEncoding, response, ...summary } = event;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('INSERT INTO events (id, summary, details, body, workspace_id) VALUES (?, ?, ?, ?, ?)')
        .run(event.id, JSON.stringify(summary), JSON.stringify({ requestTarget, httpVersion, headers, query, userAgent, sourceIp, contentEncoding, response }), body, workspaceId);
      const saved: EventSummary = { ...summary, workspaceId, sequence: Number(result.lastInsertRowid), durationMs: Number((performance.now() - startedAt).toFixed(3)) };
      this.db.prepare('UPDATE events SET summary = ? WHERE sequence = ?').run(JSON.stringify(saved), saved.sequence);
      this.index(saved, event, body);
      this.db.exec('COMMIT');
      return saved;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private index(summary: EventSummary, details: EventMetadata, body: Buffer): void {
    this.db.prepare('INSERT INTO event_index(sequence, method, status, path, content_type, received_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(summary.sequence, summary.method, summary.responseStatus, summary.path, summary.contentType ?? '', summary.receivedAt);
    let text = '';
    if (!details.contentEncoding || details.contentEncoding === 'identity') {
      const charset = summary.contentType?.match(/charset\s*=\s*"?([^;"\s]+)/i)?.[1] ?? 'utf-8';
      try {
        text = new TextDecoder(charset, { fatal: true }).decode(body);
        if (/^(application\/json|[^;]+\+json)(;|$)/i.test(summary.contentType ?? '')) {
          try { text = JSON.stringify(JSON.parse(text) as unknown); } catch { /* Invalid JSON is searchable as received. */ }
        }
      } catch { /* Binary bodies are not searched as text. */ }
    }
    this.db.prepare('INSERT INTO events_search(rowid, text) VALUES (?, ?)').run(summary.sequence,
      [summary.path, details.requestTarget, JSON.stringify(details.query), JSON.stringify(details.headers), text].join('\n').toLowerCase());
  }

  list(limit: number, before?: number, filters: EventFilters = {}, workspaceId = this.activeWorkspace()): EventPage {
    const conditions: string[] = ['e.workspace_id = ?'];
    const values: (string | number)[] = [workspaceId];
    if (before !== undefined) { conditions.push('e.sequence < ?'); values.push(before); }
    for (const [key, column] of [['method', 'method'], ['status', 'status'], ['pinned', 'pinned']] as const) {
      if (filters[key]) { conditions.push(`i.${column} = ?`); values.push(key === 'method' ? filters[key] : Number(filters[key])); }
    }
    for (const [key, column] of [['path', 'path'], ['contentType', 'content_type']] as const) {
      if (filters[key]) { conditions.push(`instr(lower(i.${column}), lower(?)) > 0`); values.push(filters[key]); }
    }
    if (filters.from) { conditions.push('i.received_at >= ?'); values.push(filters.from); }
    if (filters.to) { conditions.push('i.received_at <= ?'); values.push(filters.to); }
    if (filters.search) {
      conditions.push('EXISTS (SELECT 1 FROM events_search s WHERE s.rowid = e.sequence AND instr(s.text, ?) > 0)');
      values.push(filters.search.toLowerCase());
    }
    if (filters.exactPath) { conditions.push('i.path = ?'); values.push(filters.exactPath); }
    const rows = this.db.prepare(`SELECT e.sequence, e.summary, i.pinned FROM events e LEFT JOIN event_index i ON e.sequence = i.sequence
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY e.sequence DESC LIMIT ?`).all(...values, limit + 1);
    const scanned = rows.slice(0, limit);
    const events: EventSummary[] = [];
    for (const row of scanned) {
      try {
        const summary: unknown = JSON.parse(String(row.summary));
        if (isSummary(summary) && summary.sequence === row.sequence) events.push({ ...summary, workspaceId, pinned: row.pinned === 1 });
      } catch { /* An invalid row cannot prevent access to the other events. */ }
    }
    return {
      events,
      nextCursor: rows.length > limit ? Number(scanned.at(-1)!.sequence) : null,
      skippedRecords: scanned.length - events.length,
    };
  }

  get(id: string, workspaceId = this.activeWorkspace()): WebhookEvent | null {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
    if (!row) return null;
    try {
      if (!(row.body instanceof Uint8Array)) throw new InvalidRecordError();
      const summary: unknown = JSON.parse(String(row.summary));
      const details: unknown = JSON.parse(String(row.details));
      if (!isSummary(summary) || typeof details !== 'object' || details === null) throw new InvalidRecordError();
      const event: unknown = { ...summary, ...details, rawBody: { encoding: 'base64', data: Buffer.from(row.body).toString('base64') } };
      if (!isEvent(event) || event.bodySize !== row.body.length || event.sequence !== row.sequence || event.id !== row.id) throw new InvalidRecordError();
      if (!event.provider) {
        let payload: unknown;
        try { const text = editableText(event.rawBody, event.headers); payload = text === null ? undefined : JSON.parse(text); } catch { /* Historical non-JSON content remains opaque. */ }
        event.provider = detectProvider({ headers: event.headers, payload });
      }
      return { ...event, workspaceId, pinned: this.db.prepare('SELECT pinned FROM event_index WHERE sequence = ?').get(event.sequence)?.pinned === 1 };
    } catch { throw new InvalidRecordError('Record unavailable or invalid.'); }
  }

  pin(id: string, pinned: boolean, workspaceId = this.activeWorkspace()): boolean {
    const result = this.db.prepare('UPDATE event_index SET pinned = ? WHERE sequence = (SELECT sequence FROM events WHERE id = ? AND workspace_id = ?)').run(pinned ? 1 : 0, id, workspaceId);
    return result.changes === 1;
  }

  createReplay(execution: Omit<ReplayExecution, 'sequence'>, workspaceId = this.activeWorkspace()): ReplayExecution {
    if (execution.sourceEventId && !this.get(execution.sourceEventId, workspaceId)) throw new InvalidRecordError();
    if (execution.savedRequestId && !this.document('requests', execution.savedRequestId, workspaceId)) throw new InvalidRecordError();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const inserted = this.db.prepare('INSERT INTO replays(id, source_event_id, source_request_id, workspace_id, execution) VALUES (?, ?, ?, ?, ?)')
        .run(execution.id, execution.sourceEventId, execution.savedRequestId ?? null, workspaceId, JSON.stringify(execution));
      const saved = { ...execution, workspaceId, sequence: Number(inserted.lastInsertRowid) };
      this.saveReplay(saved);
      this.db.exec('COMMIT');
      return saved;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  saveReplay(execution: ReplayExecution): void {
    if (execution.savedRequestId !== undefined) {
      const row = this.db.prepare('SELECT source_request_id FROM replays WHERE id = ? AND workspace_id = ?').get(execution.id, execution.workspaceId ?? this.activeWorkspace());
      if (row) execution.savedRequestId = row.source_request_id === null ? null : String(row.source_request_id);
    }
    this.db.prepare('UPDATE replays SET execution = ? WHERE id = ? AND workspace_id = ?').run(JSON.stringify(execution), execution.id, execution.workspaceId ?? this.activeWorkspace());
  }

  getReplay(id: string, workspaceId = this.activeWorkspace()): ReplayExecution | null {
    const row = this.db.prepare('SELECT execution FROM replays WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
    if (!row) return null;
    try {
      const execution: unknown = JSON.parse(String(row.execution));
      if (!isReplay(execution)) throw new InvalidRecordError();
      return { ...execution, workspaceId };
    } catch { throw new InvalidRecordError(); }
  }

  listReplays(id: string, limit: number, before?: number, workspaceId = this.activeWorkspace(), saved = false): ReplayPage {
    const rows = this.db.prepare(`SELECT id, sequence, source_event_id,
      json_extract(execution, '$.executedAt') AS executed_at, json_extract(execution, '$.state') AS state,
      json_extract(execution, '$.request.method') AS method, json_extract(execution, '$.request.destinationUrl') AS destination_url,
      json_extract(execution, '$.result.durationMs') AS duration_ms, json_extract(execution, '$.result.status') AS status,
      json_extract(execution, '$.result.error') AS error
      FROM replays WHERE ${saved ? 'source_request_id' : 'source_event_id'} = ? AND workspace_id = ? AND json_valid(execution) ${before === undefined ? '' : 'AND sequence < ?'} ORDER BY sequence DESC LIMIT ?`)
      .all(id, workspaceId, ...(before === undefined ? [] : [before]), limit + 1);
    const executions = rows.slice(0, limit).map((row) => {
      return { id: String(row.id), sequence: Number(row.sequence), sourceEventId: row.source_event_id === null ? null : String(row.source_event_id), executedAt: String(row.executed_at), state: row.state === 'running' ? 'running' as const : 'completed' as const,
        method: String(row.method), destinationUrl: String(row.destination_url), durationMs: Number(row.duration_ms),
        ...(row.status === null ? {} : { status: Number(row.status) }), ...(row.error ? { error: JSON.parse(String(row.error)) as { code: string; message: string } } : {}) };
    });
    return { executions, nextCursor: rows.length > limit ? executions.at(-1)!.sequence : null };
  }

  activeWorkspace(): string { return String(this.db.prepare("SELECT value FROM local_settings WHERE key = 'active_workspace'").get()!.value); }
  hasReplayId(id: string): boolean { return !!this.db.prepare('SELECT 1 FROM replays WHERE id = ?').get(id); }
  workspaces(): Workspace[] { return this.db.prepare('SELECT id, name, created_at FROM workspaces ORDER BY created_at, id').all().map((r) => ({ id: String(r.id), name: String(r.name), createdAt: String(r.created_at) })); }
  hasWorkspace(id: string): boolean { return !!this.db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(id); }
  createWorkspace(name: string): Workspace {
    if (this.workspaces().length >= 100) throw new Error('Limit of 100 workspaces.');
    const workspace = { id: randomUUID(), name, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run(workspace.id, name, workspace.createdAt); return workspace;
  }
  activate(id: string): void {
    if (!this.hasWorkspace(id)) throw new Error('Workspace not found.');
    this.db.prepare("UPDATE local_settings SET value = ? WHERE key = 'active_workspace'").run(id);
  }
  configuration(workspaceId = this.activeWorkspace()): WorkspaceConfiguration {
    const config: WorkspaceConfiguration = { requests: [], mocks: [], bindings: [], transformations: [] };
    for (const row of this.db.prepare('SELECT id, kind, data FROM workspace_documents WHERE workspace_id = ? ORDER BY rowid').all(workspaceId)) {
      const value = this.readDocument(String(row.kind), String(row.id), String(row.data));
      (config[row.kind as DocumentKind] as WorkspaceDocument[]).push(value);
    } return config;
  }
  document(kind: DocumentKind, id: string, workspaceId = this.activeWorkspace()): WorkspaceDocument | null {
    const row = this.db.prepare('SELECT data FROM workspace_documents WHERE workspace_id = ? AND kind = ? AND id = ?').get(workspaceId, kind, id);
    return row ? this.readDocument(kind, id, String(row.data)) : null;
  }
  private readDocument(kind: string, id: string, data: string): WorkspaceDocument {
    try {
      if (!['requests', 'mocks', 'bindings', 'transformations'].includes(kind)) throw new Error();
      const value = validateDocument(kind as DocumentKind, JSON.parse(data), this.bodyLimit);
      if (value.id !== id) throw new Error();
      return value;
    } catch { throw new InvalidRecordError('Invalid stored configuration. Original data has been preserved.'); }
  }
  putDocument(kind: DocumentKind, value: WorkspaceDocument, workspaceId = this.activeWorkspace()): void {
    if (this.db.prepare('SELECT 1 FROM workspace_documents WHERE workspace_id = ? AND id = ? AND kind != ?').get(workspaceId, value.id, kind)
      || this.db.prepare('SELECT 1 FROM events WHERE workspace_id = ? AND id = ?').get(workspaceId, value.id)
      || this.db.prepare('SELECT 1 FROM replays WHERE workspace_id = ? AND id = ?').get(workspaceId, value.id)) throw new Error('This ID belongs to another record.');
    if (!this.document(kind, value.id, workspaceId) && Number(this.db.prepare('SELECT count(*) AS n FROM workspace_documents WHERE workspace_id = ?').get(workspaceId)!.n) >= 500) throw new Error('Limit of 500 configurations per workspace.');
    const serialized = JSON.stringify(value);
    const bytes = Number(this.db.prepare('SELECT coalesce(sum(length(CAST(data AS BLOB))), 0) AS n FROM workspace_documents WHERE workspace_id = ? AND NOT (kind = ? AND id = ?)').get(workspaceId, kind, value.id)!.n);
    if (bytes + Buffer.byteLength(serialized) > 10_485_760) throw new Error('Workspace configuration exceeds 10 MB.');
    this.db.prepare('INSERT INTO workspace_documents VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, kind, id) DO UPDATE SET data = excluded.data')
      .run(workspaceId, kind, value.id, serialized);
  }
  deleteDocument(kind: DocumentKind, id: string, workspaceId = this.activeWorkspace()): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (kind === 'mocks') this.db.prepare("DELETE FROM workspace_documents WHERE workspace_id = ? AND kind = 'bindings' AND json_extract(data, '$.profileId') = ?").run(workspaceId, id);
      if (kind === 'requests') this.db.prepare("UPDATE replays SET source_request_id = NULL, execution = json_set(execution, '$.savedRequestId', NULL) WHERE workspace_id = ? AND source_request_id = ?").run(workspaceId, id);
      const result = this.db.prepare('DELETE FROM workspace_documents WHERE workspace_id = ? AND kind = ? AND id = ?').run(workspaceId, kind, id);
      this.db.exec('COMMIT'); return result.changes === 1;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  endpoints(workspaceId = this.activeWorkspace()): EndpointOverview[] {
    return this.db.prepare(`SELECT i.path, count(*) AS count, max(e.sequence) AS latest FROM event_index i JOIN events e ON e.sequence = i.sequence
      WHERE e.workspace_id = ? GROUP BY i.path ORDER BY latest DESC LIMIT 100`).all(workspaceId).map((row) => {
      const recent: EventSummary = JSON.parse(String(this.db.prepare('SELECT summary FROM events WHERE sequence = ?').get(row.latest!)!.summary)) as EventSummary;
      const method = String(this.db.prepare(`SELECT i.method FROM event_index i JOIN events e ON e.sequence = i.sequence
        WHERE e.workspace_id = ? AND i.path = ? GROUP BY i.method ORDER BY count(*) DESC, i.method LIMIT 1`).get(workspaceId, row.path!)!.method);
      return { path: String(row.path), count: Number(row.count), method, recent, profile: this.mockForPath(String(row.path), workspaceId) };
    });
  }
  mockForPath(path: string, workspaceId: string): MockProfile | null {
    const row = this.db.prepare(`SELECT m.id, m.data FROM workspace_documents b JOIN workspace_documents m ON m.workspace_id = b.workspace_id
      AND m.kind = 'mocks' AND m.id = json_extract(b.data, '$.profileId')
      WHERE b.workspace_id = ? AND b.kind = 'bindings' AND json_extract(b.data, '$.path') = ? LIMIT 1`).get(workspaceId, path);
    return row ? this.readDocument('mocks', String(row.id), String(row.data)) as MockProfile : null;
  }
  exportWorkspace(workspaceId: string): WorkspaceExport {
    const size = this.db.prepare(`SELECT (SELECT coalesce(sum(length(CAST(summary AS BLOB)) + length(CAST(details AS BLOB)) + length(body) * 4 / 3), 0) FROM events WHERE workspace_id = ?)
      + (SELECT coalesce(sum(length(CAST(execution AS BLOB))), 0) FROM replays WHERE workspace_id = ?)
      + (SELECT coalesce(sum(length(CAST(data AS BLOB))), 0) FROM workspace_documents WHERE workspace_id = ?) AS n`).get(workspaceId, workspaceId, workspaceId)!;
    if (Number(size.n) > 10_485_760) throw new Error('Workspace data exceeds the 10 MB export limit.');
    const eventRows = this.db.prepare('SELECT id FROM events WHERE workspace_id = ? ORDER BY sequence LIMIT 1001').all(workspaceId);
    const replayRows = this.db.prepare('SELECT id FROM replays WHERE workspace_id = ? ORDER BY sequence LIMIT 1001').all(workspaceId);
    if (eventRows.length > 1000 || replayRows.length > 1000) throw new Error('Export limited to 1,000 events and 1,000 executions.');
    return { format: 'weebhooklab-workspace', version: 1, workspace: this.workspaces().find((w) => w.id === workspaceId)!, exportedAt: new Date().toISOString(), redacted: false,
      ...this.configuration(workspaceId), events: eventRows.map((r) => this.get(String(r.id), workspaceId)!), replays: replayRows.map((r) => this.getReplay(String(r.id), workspaceId)!) };
  }
  importWorkspace(input: WorkspaceExport): Workspace {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const workspace = this.createWorkspace(`${input.workspace.name} (importado)`.slice(0, 100));
      const ids = new Map<string, string>();
      for (const item of [...input.requests, ...input.mocks, ...input.bindings, ...input.transformations, ...input.events, ...input.replays]) ids.set(item.id, randomUUID());
      for (const kind of ['requests', 'mocks', 'bindings', 'transformations'] as const) for (const item of input[kind]) {
        this.putDocument(kind, { ...item, id: ids.get(item.id)!, ...('profileId' in item ? { profileId: ids.get(item.profileId)! } : {}) }, workspace.id);
      }
      for (const event of input.events) {
        const { rawBody, ...metadata } = event;
        const id = ids.get(event.id)!;
        const inserted = this.db.prepare('INSERT INTO events(id, summary, details, body, workspace_id) VALUES (?, ?, ?, ?, ?)')
          .run(id, '{}', '{}', Buffer.from(rawBody.data, 'base64'), workspace.id);
        const { requestTarget, httpVersion, headers, query, userAgent, sourceIp, contentEncoding, response, ...summary } = metadata;
        const saved = { ...summary, id, workspaceId: workspace.id, sequence: Number(inserted.lastInsertRowid) };
        this.db.prepare('UPDATE events SET summary = ?, details = ? WHERE id = ?').run(JSON.stringify(saved), JSON.stringify({ requestTarget, httpVersion, headers, query, userAgent, sourceIp, contentEncoding, response }), id);
        this.index(saved, metadata, Buffer.from(rawBody.data, 'base64'));
        if (event.pinned) this.db.prepare('UPDATE event_index SET pinned = 1 WHERE sequence = ?').run(saved.sequence);
      }
      for (const replay of input.replays) {
        const saved = { ...replay, id: ids.get(replay.id)!, workspaceId: workspace.id, sourceEventId: replay.sourceEventId ? ids.get(replay.sourceEventId)! : null,
          savedRequestId: replay.savedRequestId ? ids.get(replay.savedRequestId)! : null, state: 'completed' as const };
        if (replay.state === 'running') saved.result = { ...replay.result, error: { code: 'INTERRUPTED', message: 'Execution imported without a final result; no request was sent.' } };
        const row = this.db.prepare('INSERT INTO replays(id, source_event_id, source_request_id, workspace_id, execution) VALUES (?, ?, ?, ?, ?)')
          .run(saved.id, saved.sourceEventId, saved.savedRequestId, workspace.id, '{}');
        this.saveReplay({ ...saved, sequence: Number(row.lastInsertRowid) });
      }
      this.db.exec('COMMIT'); return workspace;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  ping(): void { this.db.prepare('SELECT 1').get(); }
  close(): void { this.db.close(); }
}
