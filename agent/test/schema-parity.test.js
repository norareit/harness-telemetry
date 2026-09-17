// schema-parity.test.js — the Postgres DDL must match what the sink writes (§6).
// Textual parse: a divergence here is exactly the class of bug that shipped
// every scenario row with priced_at = NULL.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FIELD_ORDER } from "../src/record.js";
import { SCENARIO_COLUMNS, UPDATE_SET } from "../src/sink-postgres.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PG = join(HERE, "..", "..", "server", "postgres");
const schema = readFileSync(join(PG, "init", "01-schema.sql"), "utf8");

/** Column names declared in a CREATE TABLE block, up to its PRIMARY KEY line. */
function columnsOf(sql, tableName) {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${tableName} (`);
  assert.notEqual(start, -1, `table ${tableName} not found`);
  const body = sql.slice(start);
  const block = body.slice(0, body.indexOf("PRIMARY KEY"));
  const cols = [];
  for (const raw of block.split("\n").slice(1)) {
    const line = raw.split("--")[0].trim();
    if (!line) continue;
    const first = line.split(/[\s(]/)[0].replace(/,$/, "");
    if (!first || /^(CONSTRAINT|FOREIGN|CHECK|PRIMARY|UNIQUE)$/i.test(first)) continue;
    cols.push(first);
  }
  return cols;
}

const setEq = (a, b) => assert.deepEqual([...new Set(a)].sort(), [...new Set(b)].sort());

test("usage_event columns == FIELD_ORDER ∪ {synced_at}", () => {
  setEq(columnsOf(schema, "usage_event"), [...FIELD_ORDER, "synced_at"]);
});

test("usage_scenario columns == SCENARIO_COLUMNS ∪ {synced_at}", () => {
  setEq(columnsOf(schema, "usage_scenario"), [...SCENARIO_COLUMNS, "synced_at"]);
});

test("every column the migrations add exists in the fresh-install schema", () => {
  const present = new Set([...columnsOf(schema, "usage_event"), ...columnsOf(schema, "usage_scenario")]);
  for (const file of ["001-add-rates.sql", "002-add-priced-at.sql"]) {
    const sql = readFileSync(join(PG, "migrations", file), "utf8");
    for (const m of sql.matchAll(/ADD COLUMN IF NOT EXISTS\s+(\w+)/g)) {
      assert.ok(present.has(m[1]), `${file} adds ${m[1]} but 01-schema.sql lacks it`);
    }
  }
});

test("UPDATE_SET updates every non-PK FIELD_ORDER column and no PK column", () => {
  const updated = [...UPDATE_SET.matchAll(/(\w+)\s*=\s*EXCLUDED/g)].map((m) => m[1]);
  const expected = FIELD_ORDER.filter((c) => !["harness", "session_id", "message_id"].includes(c));
  setEq(updated, expected);
});
