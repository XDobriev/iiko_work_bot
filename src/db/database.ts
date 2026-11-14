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

  // Ensure photos directory exists
  const photosDir = path.resolve(dir, 'photos');
  if (!fs.existsSync(photosDir)) {
    fs.mkdirSync(photosDir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);

  // Initialize and migrate schema
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id TEXT DEFAULT 'beyni',
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
      local_photo_path TEXT,
      raw_json TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `);

  // Ensure columns exist if table was created in older version
  const invoiceColumns = (db.prepare(`PRAGMA table_info(invoices)`).all() as Array<{ name: string }>).map(c => c.name);
  const requiredColumns: Record<string, string> = {
    restaurant_id: "TEXT DEFAULT 'beyni'",
    warehouse: "TEXT DEFAULT 'kitchen'",
    total_calculated: "REAL NOT NULL DEFAULT 0",
    total_written: "REAL",
    status: "TEXT NOT NULL DEFAULT 'pending'",
    iiko_document_id: "TEXT",
    telegram_user_id: "INTEGER",
    telegram_message_id: "INTEGER",
    photo_file_id: "TEXT",
    local_photo_path: "TEXT",
    raw_json: "TEXT"
  };

  for (const [col, colDef] of Object.entries(requiredColumns)) {
    if (!invoiceColumns.includes(col)) {
      db.exec(`ALTER TABLE invoices ADD COLUMN ${col} ${colDef};`);
    }
  }

  db.exec(`
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

    -- Mapping between handwritten short names and official iiko products
    CREATE TABLE IF NOT EXISTS product_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_name TEXT NOT NULL UNIQUE,
      normalized_name TEXT NOT NULL,
      iiko_product_name TEXT NOT NULL,
      iiko_product_id TEXT,
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    -- Active editing sessions to survive server/process restarts
    CREATE TABLE IF NOT EXISTS bot_edit_sessions (
      user_id INTEGER PRIMARY KEY,
      invoice_id INTEGER NOT NULL,
      card_message_id INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      edit_prompt_message_id INTEGER,
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_items_norm_name ON invoice_items(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_invoices_supplier ON invoices(supplier);
    CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(date);
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_invoices_restaurant ON invoices(restaurant_id);
  `);

  if (!customPath) {
    dbInstance = db;
  }

  return db;
}
