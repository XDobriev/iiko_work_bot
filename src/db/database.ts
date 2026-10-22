import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

let dbInstance: DatabaseSync | null = null;

export function getDatabase(customPath?: string): DatabaseSync {
  if (dbInstance && !customPath) {
    return dbInstance;
  }

  const dbPath = customPath || config.db.path;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);

  // Initialize schema
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT,
      supplier TEXT,
      warehouse TEXT DEFAULT 'kitchen',
      total_calculated REAL NOT NULL DEFAULT 0,
      total_written REAL,
      status TEXT NOT NULL DEFAULT 'pending', -- pending, confirmed, rejected, synced
      iiko_document_id TEXT,
      telegram_user_id INTEGER,
      telegram_message_id INTEGER,
      photo_file_id TEXT,
      raw_json TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      qty REAL NOT NULL DEFAULT 0,
      price REAL NOT NULL DEFAULT 0,
      sum REAL NOT NULL DEFAULT 0,
      unit TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_items_norm_name ON invoice_items(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_invoices_supplier ON invoices(supplier);
    CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(date);
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
  `);

  if (!customPath) {
    dbInstance = db;
  }

  return db;
}
