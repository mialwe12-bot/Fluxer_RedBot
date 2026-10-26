import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

interface Migration {
  id: number;
  sql: string;
}

/** Kern-Migrationen. Neue Einträge immer nur anhängen, nie bestehende ändern. */
const CORE_MIGRATIONS: Migration[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS config (
        namespace TEXT NOT NULL,
        scope     TEXT NOT NULL,
        scope_id  TEXT NOT NULL,
        key       TEXT NOT NULL,
        value     TEXT NOT NULL,
        PRIMARY KEY (namespace, scope, scope_id, key)
      );
      CREATE INDEX IF NOT EXISTS config_scope_idx ON config (namespace, scope);
    `,
  },
  {
    id: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS permission_rules (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_id  TEXT NOT NULL,      -- 'global' oder Guild-ID
        model     TEXT NOT NULL,      -- 'cog:<name>' oder 'cmd:<qualifizierter name>'
        subject   TEXT NOT NULL,      -- 'user:<id>', 'role:<id>', 'channel:<id>', 'guild:<id>', 'default'
        allow     INTEGER NOT NULL,
        UNIQUE (scope_id, model, subject)
      );
    `,
  },
];

/** Öffnet (und migriert) die SQLite-Datenbank. `file` = ':memory:' für Tests. */
export function openDatabase(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, 'core', CORE_MIGRATIONS);
  return db;
}

/**
 * Führt Migrationen für einen Namensraum aus (Kern oder Cog). Jede Migration läuft genau einmal,
 * in einer Transaktion. Cogs nutzen das über `cog.migrate([...])`.
 */
export function migrate(db: DB, namespace: string, migrations: Migration[] | string[]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    namespace TEXT NOT NULL, id INTEGER NOT NULL, applied_at TEXT NOT NULL,
    PRIMARY KEY (namespace, id))`);
  const list: Migration[] = migrations.map((m, i) => (typeof m === 'string' ? { id: i + 1, sql: m } : m));
  const done = new Set(
    (db.prepare('SELECT id FROM migrations WHERE namespace = ?').all(namespace) as { id: number }[]).map((r) => r.id),
  );
  const mark = db.prepare('INSERT INTO migrations (namespace, id, applied_at) VALUES (?, ?, ?)');
  for (const m of list) {
    if (done.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      mark.run(namespace, m.id, new Date().toISOString());
    })();
  }
}
