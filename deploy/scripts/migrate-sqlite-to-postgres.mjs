#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import pg from "pg";

const { Client } = pg;
const options = parseOptions(process.argv.slice(2));

if (!existsSync(options.sqlitePath)) {
  throw new Error(`SQLite database not found: ${options.sqlitePath}`);
}

const sqlite = new Database(options.sqlitePath, { readonly: true, fileMustExist: true });
sqlite.pragma("query_only = ON");
sqlite.exec("BEGIN");
const postgres = new Client({ connectionString: options.postgresUrl });

try {
  await postgres.connect();
  await postgres.query("SELECT pg_advisory_lock(hashtext($1))", ["archive-mail-sqlite-migration"]);
  if (options.reset) await postgres.query(`DROP SCHEMA IF EXISTS ${identifier(options.schema)} CASCADE`);
  await postgres.query(`CREATE SCHEMA IF NOT EXISTS ${identifier(options.schema)}`);
  await createMigrationStateTable(postgres, options.schema);

  const tables = sqlite.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().filter((table) => shouldMigrateTable(String(table.name), String(table.sql ?? "")));
  const migratedNames = new Set(tables.map((table) => String(table.name)));
  let totalRows = 0;

  for (const table of tables) {
    const tableName = String(table.name);
    const columns = tableColumns(sqlite, tableName);
    if (columns.length === 0) continue;
    const sourceCount = Number(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${identifier(tableName)}`).get().count);
    process.stdout.write(`Migrating ${tableName} (${sourceCount.toLocaleString()} rows)... `);
    await postgres.query("BEGIN");
    try {
      await postgres.query(createTableSql(options.schema, tableName, columns));
      await postgres.query(`TRUNCATE TABLE ${qualified(options.schema, tableName)}`);
      await copyRows(sqlite, postgres, options.schema, tableName, columns, options.batchSize);
      await postgres.query("COMMIT");
    } catch (error) {
      await postgres.query("ROLLBACK");
      throw error;
    }
    const targetCount = Number((await postgres.query(
      `SELECT COUNT(*)::bigint AS count FROM ${qualified(options.schema, tableName)}`
    )).rows[0]?.count ?? 0);
    if (targetCount !== sourceCount) {
      throw new Error(`${tableName} count mismatch: SQLite=${sourceCount}, PostgreSQL=${targetCount}`);
    }
    await recordTableState(postgres, options.schema, tableName, sourceCount);
    totalRows += sourceCount;
    process.stdout.write("done\n");
  }

  await createIndexes(sqlite, postgres, options.schema, tables);
  await createForeignKeys(sqlite, postgres, options.schema, tables, migratedNames);
  await createSearchIndexes(postgres, options.schema, migratedNames);
  await postgres.query(`ANALYZE`);
  await postgres.query(
    `INSERT INTO ${qualified(options.schema, "_migration_summary")}
      (id, source_path, table_count, row_count, completed_at)
     VALUES (1, $1, $2, $3, NOW())
     ON CONFLICT (id) DO UPDATE SET
       source_path = excluded.source_path,
       table_count = excluded.table_count,
       row_count = excluded.row_count,
       completed_at = excluded.completed_at`,
    [options.sqlitePath, tables.length, totalRows]
  );
  sqlite.exec("COMMIT");
  process.stdout.write(`Migration complete: ${tables.length} tables and ${totalRows.toLocaleString()} rows copied.\n`);
} finally {
  try {
    await postgres.query("SELECT pg_advisory_unlock(hashtext($1))", ["archive-mail-sqlite-migration"]);
  } catch {}
  await postgres.end().catch(() => undefined);
  if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
  sqlite.close();
}

function parseOptions(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument?.startsWith("--")) continue;
    if (argument === "--reset") {
      values.set("reset", "true");
      continue;
    }
    const [key, inlineValue] = argument.slice(2).split("=", 2);
    const value = inlineValue ?? args[++index];
    if (key && value !== undefined) values.set(key, value);
  }
  const schema = values.get("schema") ?? process.env.POSTGRES_SCHEMA ?? "archive_mail";
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error("PostgreSQL schema must be a simple identifier");
  const postgresUrl = values.get("postgres") ?? process.env.DATABASE_URL ?? postgresUrlFromEnvironment();
  if (!postgresUrl?.startsWith("postgresql://") && !postgresUrl?.startsWith("postgres://")) {
    throw new Error("Set DATABASE_URL or pass --postgres postgresql://user:password@host:5432/database");
  }
  const requestedBatchSize = Number(values.get("batch-size") ?? process.env.MIGRATION_BATCH_SIZE ?? 100);
  return {
    sqlitePath: resolve(values.get("sqlite") ?? process.env.SQLITE_PATH ?? "/data/archive-mail.sqlite"),
    postgresUrl,
    schema,
    reset: values.get("reset") === "true" || process.env.MIGRATION_RESET === "true",
    batchSize: Math.max(1, Math.min(500, Number.isFinite(requestedBatchSize) ? Math.floor(requestedBatchSize) : 100))
  };
}

function postgresUrlFromEnvironment() {
  if (!process.env.PGHOST) return undefined;
  const user = encodeURIComponent(process.env.PGUSER ?? "archive_mail");
  const password = encodeURIComponent(process.env.PGPASSWORD ?? "");
  const host = process.env.PGHOST;
  const port = process.env.PGPORT ?? "5432";
  const database = encodeURIComponent(process.env.PGDATABASE ?? "archive_mail");
  return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}

function shouldMigrateTable(name, sql) {
  if (name === "_migration_state" || name === "_migration_summary") return false;
  if (/\bVIRTUAL\s+TABLE\b/i.test(sql)) return false;
  if (/^(message_fts|attachment_fts)(_|$)/.test(name)) return false;
  return true;
}

function tableColumns(database, tableName) {
  return database.prepare(`PRAGMA table_info(${identifier(tableName)})`).all().map((column) => ({
    name: String(column.name),
    type: postgresType(String(column.type ?? "")),
    notNull: Boolean(column.notnull),
    primaryKeyPosition: Number(column.pk ?? 0)
  }));
}

function postgresType(sqliteType) {
  const normalized = sqliteType.toUpperCase();
  if (normalized.includes("BLOB")) return "BYTEA";
  if (normalized.includes("BOOL")) return "BIGINT";
  if (normalized.includes("INT")) return "BIGINT";
  if (normalized.includes("REAL") || normalized.includes("FLOA") || normalized.includes("DOUB")) {
    return "DOUBLE PRECISION";
  }
  if (normalized.includes("NUM") || normalized.includes("DEC")) return "NUMERIC";
  return "TEXT";
}

function createTableSql(schema, tableName, columns) {
  const primaryKey = columns
    .filter((column) => column.primaryKeyPosition > 0)
    .sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition)
    .map((column) => identifier(column.name));
  const definitions = columns.map((column) => (
    `${identifier(column.name)} ${column.type}${column.notNull ? " NOT NULL" : ""}`
  ));
  if (primaryKey.length > 0) definitions.push(`PRIMARY KEY (${primaryKey.join(", ")})`);
  return `CREATE TABLE IF NOT EXISTS ${qualified(schema, tableName)} (${definitions.join(", ")})`;
}

async function copyRows(sqliteDatabase, postgresClient, schema, tableName, columns, batchSize) {
  const columnNames = columns.map((column) => column.name);
  const rows = sqliteDatabase.prepare(`SELECT * FROM ${identifier(tableName)}`).iterate();
  let batch = [];
  let estimatedBytes = 0;
  for (const row of rows) {
    batch.push(row);
    estimatedBytes += estimateRowBytes(row);
    if (batch.length >= batchSize || estimatedBytes >= 4 * 1024 * 1024) {
      await insertBatch(postgresClient, schema, tableName, columnNames, batch);
      batch = [];
      estimatedBytes = 0;
    }
  }
  if (batch.length > 0) await insertBatch(postgresClient, schema, tableName, columnNames, batch);
}

async function insertBatch(client, schema, tableName, columns, rows) {
  const values = [];
  const tuples = rows.map((row) => {
    const placeholders = columns.map((column) => {
      values.push(normalizeValue(row[column]));
      return `$${values.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });
  await client.query(
    `INSERT INTO ${qualified(schema, tableName)} (${columns.map(identifier).join(", ")}) VALUES ${tuples.join(", ")}`,
    values
  );
}

function normalizeValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (typeof value === "string" && value.includes("\u0000")) {
    return value.replaceAll("\u0000", "\uFFFD");
  }
  return value;
}

function estimateRowBytes(row) {
  let size = 0;
  for (const value of Object.values(row)) {
    if (Buffer.isBuffer(value)) size += value.length;
    else if (typeof value === "string") size += Buffer.byteLength(value);
    else size += 16;
  }
  return size;
}

async function createMigrationStateTable(client, schema) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${qualified(schema, "_migration_state")} (
      table_name TEXT PRIMARY KEY,
      row_count BIGINT NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${qualified(schema, "_migration_summary")} (
      id BIGINT PRIMARY KEY,
      source_path TEXT NOT NULL,
      table_count BIGINT NOT NULL,
      row_count BIGINT NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL
    )
  `);
}

async function recordTableState(client, schema, tableName, rowCount) {
  await client.query(
    `INSERT INTO ${qualified(schema, "_migration_state")} (table_name, row_count, completed_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (table_name) DO UPDATE SET row_count = excluded.row_count, completed_at = excluded.completed_at`,
    [tableName, rowCount]
  );
}

async function createIndexes(sqliteDatabase, postgresClient, schema, tables) {
  process.stdout.write("Creating PostgreSQL indexes...\n");
  for (const table of tables) {
    const tableName = String(table.name);
    const indexes = sqliteDatabase.prepare(`PRAGMA index_list(${identifier(tableName)})`).all();
    for (const index of indexes) {
      const indexName = String(index.name);
      if (indexName.startsWith("sqlite_autoindex_") || Boolean(index.partial)) continue;
      const columns = sqliteDatabase.prepare(`PRAGMA index_info(${identifier(indexName)})`).all();
      if (columns.length === 0 || columns.some((column) => Number(column.cid) < 0)) continue;
      const unique = Boolean(index.unique) ? "UNIQUE " : "";
      const targetColumns = columns.sort((left, right) => Number(left.seqno) - Number(right.seqno))
        .map((column) => identifier(String(column.name)));
      await postgresClient.query(
        `CREATE ${unique}INDEX IF NOT EXISTS ${identifier(indexName)} ON ${qualified(schema, tableName)} (${targetColumns.join(", ")})`
      );
    }
  }
}

async function createForeignKeys(sqliteDatabase, postgresClient, schema, tables, migratedNames) {
  process.stdout.write("Creating PostgreSQL foreign keys...\n");
  for (const table of tables) {
    const tableName = String(table.name);
    const foreignKeys = sqliteDatabase.prepare(`PRAGMA foreign_key_list(${identifier(tableName)})`).all();
    const groups = Map.groupBy(foreignKeys, (row) => Number(row.id));
    for (const [id, rows] of groups) {
      const ordered = rows.sort((left, right) => Number(left.seq) - Number(right.seq));
      const targetTable = String(ordered[0]?.table ?? "");
      if (!migratedNames.has(targetTable)) continue;
      const constraintName = `${tableName}_fk_${id}`.slice(0, 60);
      const fromColumns = ordered.map((row) => identifier(String(row.from)));
      const toColumns = ordered.map((row) => identifier(String(row.to)));
      const onDelete = foreignKeyAction(String(ordered[0]?.on_delete ?? "NO ACTION"));
      const onUpdate = foreignKeyAction(String(ordered[0]?.on_update ?? "NO ACTION"));
      await postgresClient.query(
        `ALTER TABLE ${qualified(schema, tableName)} DROP CONSTRAINT IF EXISTS ${identifier(constraintName)}`
      );
      await postgresClient.query(
        `ALTER TABLE ${qualified(schema, tableName)} ADD CONSTRAINT ${identifier(constraintName)}
         FOREIGN KEY (${fromColumns.join(", ")}) REFERENCES ${qualified(schema, targetTable)} (${toColumns.join(", ")})
         ON DELETE ${onDelete} ON UPDATE ${onUpdate} NOT VALID`
      );
    }
  }
}

async function createSearchIndexes(client, schema, migratedNames) {
  if (migratedNames.has("messages")) {
    await client.query(`
      CREATE INDEX IF NOT EXISTS messages_postgres_search_idx
      ON ${qualified(schema, "messages")}
      USING GIN (to_tsvector('simple',
        COALESCE(subject, '') || ' ' || COALESCE(sender_name, '') || ' ' ||
        COALESCE(sender_address, '') || ' ' || COALESCE(recipients_text, '') || ' ' || COALESCE(body_text, '')
      ))
    `);
  }
  if (migratedNames.has("attachments")) {
    await client.query(`
      CREATE INDEX IF NOT EXISTS attachments_postgres_search_idx
      ON ${qualified(schema, "attachments")}
      USING GIN (to_tsvector('simple', COALESCE(filename, '') || ' ' || COALESCE(extracted_text, '')))
    `);
  }
}

function foreignKeyAction(value) {
  const normalized = value.toUpperCase();
  return ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"].includes(normalized)
    ? normalized
    : "NO ACTION";
}

function identifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function qualified(schema, tableName) {
  return `${identifier(schema)}.${identifier(tableName)}`;
}
