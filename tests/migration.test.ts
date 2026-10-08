import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventStore } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { DEFAULT_WORKSPACE } from '../src/shared/workspaces.js';
import type { EventPage, ReplayExecution, WebhookEvent } from '../src/shared/contracts.js';

async function databasePath(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'weebhooklab-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return join(directory, 'events.sqlite');
}

function seedStage2(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      summary TEXT NOT NULL, details TEXT NOT NULL, body BLOB NOT NULL) STRICT;
    CREATE TABLE event_index (sequence INTEGER PRIMARY KEY REFERENCES events(sequence), method TEXT NOT NULL,
      status INTEGER NOT NULL, path TEXT NOT NULL, content_type TEXT NOT NULL, received_at TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE events_search (rowid INTEGER PRIMARY KEY, text TEXT NOT NULL) STRICT;
    CREATE TABLE replays (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      source_event_id TEXT NOT NULL REFERENCES events(id), execution TEXT NOT NULL) STRICT;
    CREATE INDEX replay_history ON replays(source_event_id, sequence);`);
  const bodies = [Buffer.from(' {"legacy":"João"}\r\n'), Buffer.from([0, 255, 128, 13, 10])];
  const events = bodies.map((body, index) => {
    const summary = { id: randomUUID(), sequence: index ? 37 : 12, method: 'POST', path: '/hooks/legacy',
      receivedAt: '2026-10-01T12:00:00.000Z', contentType: index ? 'application/octet-stream' : 'application/json',
      bodySize: body.length, responseStatus: 200, durationMs: 3.5 };
    const details = { requestTarget: '/hooks/legacy?item=one&item=two', httpVersion: '1.1',
      headers: [['content-type', summary.contentType], ['x-repeat', 'one'], ['x-repeat', 'two']],
      query: { item: ['one', 'two'] }, userAgent: null, sourceIp: '127.0.0.1', contentEncoding: null,
      response: { headers: [['Content-Type', 'application/json']], body: '{"received":true}' } };
    db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)').run(summary.sequence, summary.id, JSON.stringify(summary), JSON.stringify(details), body);
    db.prepare('INSERT INTO event_index VALUES (?, ?, ?, ?, ?, ?, ?)').run(summary.sequence, summary.method, 200, summary.path, summary.contentType, summary.receivedAt, index ? 0 : 1);
    db.prepare('INSERT INTO events_search VALUES (?, ?)').run(summary.sequence, `legacy joão ${index}`);
    return { summary, details, body };
  });
  const executions: ReplayExecution[] = events.map((event, index) => ({
    id: randomUUID(), sequence: index ? 9 : 5, sourceEventId: event.summary.id, executedAt: '2026-10-01T12:01:00.000Z', state: index ? 'running' : 'completed',
    request: { destinationUrl: 'http://127.0.0.1:3000/echo', method: 'POST', headers: [['Content-Type', event.summary.contentType]],
      body: { encoding: 'base64', data: event.body.toString('base64') }, bodySize: event.body.length, timeoutMs: 10000 },
    result: { status: 201, durationMs: 25, headers: [['X-Result', 'kept']], contentType: 'text/plain',
      body: { encoding: 'base64', data: Buffer.from('accepted\r\n').toString('base64') }, bodySize: 10, receivedSize: 10, truncated: false },
  }));
  for (const execution of executions) db.prepare('INSERT INTO replays VALUES (?, ?, ?, ?)').run(execution.sequence, execution.id, execution.sourceEventId, JSON.stringify(execution));
  db.exec("UPDATE sqlite_sequence SET seq = 70 WHERE name = 'events'; UPDATE sqlite_sequence SET seq = 90 WHERE name = 'replays';");
  db.close();
  return { events, executions };
}

function checkIntegrity(path: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    for (const table of ['events', 'replays']) {
      assert(db.prepare(`PRAGMA foreign_key_list(${table})`).all().some((fk) => fk.from === 'workspace_id' && fk.table === 'workspaces'));
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE workspace_id IS NULL`).get()?.n, 0);
      if (db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n) {
        assert.throws(() => db.prepare(`UPDATE ${table} SET workspace_id = ?`).run(randomUUID()), /FOREIGN KEY constraint failed/);
      }
    }
    assert.throws(() => db.prepare('INSERT INTO replays(id, workspace_id, execution) VALUES (?, ?, ?)').run(randomUUID(), randomUUID(), '{}'), /FOREIGN KEY constraint failed/);
  } finally { db.close(); }
}

test('migra banco real da Etapa 2 com dados, pins, bytes e histórico, sem falhar nos reinícios', async (t) => {
  const path = await databasePath(t); const legacy = seedStage2(path);
  for (let startup = 0; startup < 3; startup++) {
    const store = new EventStore(path);
    try {
      assert.equal(store.activeWorkspace(), DEFAULT_WORKSPACE);
      assert.equal(store.workspaces().length, 1);
      assert.equal(store.list(50).events.length, 2);
      assert.equal(store.list(50, undefined, { pinned: '1', search: 'João' }).events[0]?.id, legacy.events[0]!.summary.id);
      assert(store.list(50).events.every((event) => event.workspaceId === DEFAULT_WORKSPACE));
      for (const { summary, details, body } of legacy.events) {
        const event = store.get(summary.id)!;
        assert.equal(event.workspaceId, DEFAULT_WORKSPACE); assert.equal(event.sequence, summary.sequence);
        assert.deepEqual(Buffer.from(event.rawBody.data, 'base64'), body);
        assert.deepEqual(event.headers, details.headers); assert.deepEqual(event.query, details.query); assert.deepEqual(event.response, details.response);
      }
      assert.deepEqual(store.getReplay(legacy.executions[0]!.id), { ...legacy.executions[0], workspaceId: DEFAULT_WORKSPACE });
      assert.equal(store.getReplay(legacy.executions[1]!.id)?.result.error?.code, 'INTERRUPTED');
      assert.equal(store.listReplays(legacy.events[0]!.summary.id, 25).executions[0]?.sequence, 5);
    } finally { store.close(); }
    const db = new DatabaseSync(path);
    try {
      for (const { summary, details, body } of legacy.events) {
        const row = db.prepare('SELECT * FROM events WHERE id = ?').get(summary.id)!;
        assert.equal(row.summary, JSON.stringify(summary)); assert.equal(row.details, JSON.stringify(details)); assert.deepEqual(Buffer.from(row.body as Uint8Array), body);
      }
      assert.equal(db.prepare('SELECT execution FROM replays WHERE id = ?').get(legacy.executions[0]!.id)?.execution, JSON.stringify(legacy.executions[0]));
      assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get()?.seq, 70);
      assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'replays'").get()?.seq, 90);
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'replays_legacy'").get()?.n, 0);
    } finally { db.close(); }
    checkIntegrity(path);
  }
  const store = new EventStore(path);
  try {
    assert.equal(store.createReplay({ ...legacy.executions[0]!, id: randomUUID() }).sequence, 91);
  } finally { store.close(); }
});

test('banco novo: captura, workspaces, isolamento e associação sobrevivem aos reinícios', async (t) => {
  const path = await databasePath(t);
  let app = createApp({ databasePath: path });
  try {
    await app.inject({ method: 'POST', url: '/hooks/new', payload: 'first' });
    const original = (await app.inject('/api/events')).json<EventPage>().events[0]!;
    const other = (await app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: 'Other' } })).json<{ id: string }>();
    assert.equal((await app.inject({ method: 'PUT', url: `/api/workspaces/${other.id}/active` })).statusCode, 200);
    assert.equal((await app.inject('/api/events')).json<EventPage>().events.length, 0);
    await app.inject({ method: 'POST', url: '/hooks/new', payload: 'second' });
    const second = (await app.inject('/api/events')).json<EventPage>().events[0]!;
    assert.equal(second.workspaceId, other.id); assert(second.sequence > original.sequence);
    assert.equal((await app.inject(`/api/events/${original.id}`)).statusCode, 404);
    await app.close(); app = createApp({ databasePath: path });
    assert.equal((await app.inject('/api/workspaces')).json<{ activeId: string }>().activeId, other.id);
    assert.equal((await app.inject('/api/events')).json<EventPage>().events[0]?.id, second.id);
    await app.inject({ method: 'PUT', url: `/api/workspaces/${DEFAULT_WORKSPACE}/active` });
    assert.equal((await app.inject('/api/events')).json<EventPage>().events[0]?.id, original.id);
    assert.equal((await app.inject(`/api/events/${second.id}`)).statusCode, 404);
    const event = (await app.inject(`/api/events/${original.id}`)).json<WebhookEvent>();
    assert.equal(Buffer.from(event.rawBody.data, 'base64').toString(), 'first');
    await app.close(); app = createApp({ databasePath: path });
    assert.equal((await app.inject('/api/workspaces')).json<{ activeId: string }>().activeId, DEFAULT_WORKSPACE);
  } finally { await app.close(); }
  checkIntegrity(path);
});

for (const partial of ['events-only', 'replay-columns', 'nullable-replays'] as const) test(`migração independente completa estado parcial ${partial} preservando workspaces existentes`, async (t) => {
  const path = await databasePath(t); const legacy = seedStage2(path); const other = randomUUID();
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
    CREATE TABLE local_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE workspace_documents (workspace_id TEXT NOT NULL REFERENCES workspaces(id), kind TEXT NOT NULL,
      id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workspace_id, kind, id)) STRICT;`);
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run(DEFAULT_WORKSPACE, 'Preserved local', '2026-10-01');
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run(other, 'Preserved other', '2026-10-02');
  db.prepare('INSERT INTO local_settings VALUES (?, ?)').run('active_workspace', other);
  const mock = { id: randomUUID(), name: 'Keep mock', response: { status: 500, headers: [], body: 'keep', delayMs: 0, maxDelayMs: 0 } };
  db.prepare('INSERT INTO workspace_documents VALUES (?, ?, ?, ?)').run(other, 'mocks', mock.id, JSON.stringify(mock));
  db.exec('ALTER TABLE events ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)');
  db.prepare('UPDATE events SET workspace_id = ? WHERE id = ?').run(other, legacy.events[0]!.summary.id);
  if (partial !== 'events-only') {
    if (partial === 'nullable-replays') db.exec(`ALTER TABLE replays RENAME TO old_replays; DROP INDEX replay_history;
      CREATE TABLE replays (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, source_event_id TEXT REFERENCES events(id),
        source_request_id TEXT, workspace_id TEXT REFERENCES workspaces(id), execution TEXT NOT NULL) STRICT;
      INSERT INTO replays(sequence, id, source_event_id, execution) SELECT * FROM old_replays;
      DROP TABLE old_replays; CREATE INDEX replay_history ON replays(source_event_id, sequence);`);
    else db.exec('ALTER TABLE replays ADD COLUMN workspace_id TEXT REFERENCES workspaces(id); ALTER TABLE replays ADD COLUMN source_request_id TEXT');
    db.prepare('UPDATE replays SET workspace_id = ? WHERE id = ?').run(other, legacy.executions[0]!.id);
  }
  db.close();
  for (let startup = 0; startup < 2; startup++) {
    const store = new EventStore(path);
    try {
      assert.equal(store.activeWorkspace(), other); assert.equal(store.workspaces().length, 2);
      assert.equal(store.workspaces().find((w) => w.id === DEFAULT_WORKSPACE)?.name, 'Preserved local');
      assert.deepEqual(store.configuration(other).mocks, [mock]);
      assert.equal(store.get(legacy.events[0]!.summary.id, DEFAULT_WORKSPACE), null);
      assert.equal(store.get(legacy.events[1]!.summary.id, DEFAULT_WORKSPACE)?.workspaceId, DEFAULT_WORKSPACE);
      assert.deepEqual(store.getReplay(legacy.executions[0]!.id, other), { ...legacy.executions[0], workspaceId: other });
      assert.equal(store.getReplay(legacy.executions[0]!.id, DEFAULT_WORKSPACE), null);
      assert.equal(store.getReplay(legacy.executions[1]!.id, DEFAULT_WORKSPACE)?.workspaceId, DEFAULT_WORKSPACE);
    } finally { store.close(); }
    checkIntegrity(path);
  }
});

test('falha durante migração reverte DDL, associações e alterações do histórico', async (t) => {
  const path = await databasePath(t); const legacy = seedStage2(path);
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE workspace_replays (value TEXT) STRICT'); db.close();
  assert.throws(() => new EventStore(path), /workspace_replays/);
  const after = new DatabaseSync(path);
  try {
    assert(!after.prepare('PRAGMA table_info(events)').all().some((row) => row.name === 'workspace_id'));
    assert(!after.prepare('PRAGMA table_info(replays)').all().some((row) => row.name === 'workspace_id'));
    assert.equal(after.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('workspaces', 'local_settings', 'replays_legacy')").get()?.n, 0);
    for (const execution of legacy.executions) assert.equal(after.prepare('SELECT execution FROM replays WHERE id = ?').get(execution.id)?.execution, JSON.stringify(execution));
    after.exec('DROP TABLE workspace_replays');
  } finally { after.close(); }
  const recovered = new EventStore(path);
  try { assert.equal(recovered.list(50).events.length, 2); } finally { recovered.close(); }
  checkIntegrity(path);
});
