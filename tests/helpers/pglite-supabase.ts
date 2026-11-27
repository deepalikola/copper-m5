// A tiny stand-in for the supabase-js query builder that runs on PGlite (a real
// Postgres in the test process). It supports just what the refund store uses,
// so the store's own code and the migration are tested together, without a
// Supabase project or network.
import type { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
type Filter = { column: string; values: unknown[] };

class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private payload: Row = {};
  private filters: Filter[] = [];
  private orderColumn: string | null = null;
  private returning = true;
  private single = false;

  constructor(
    private db: PGlite,
    private table: string,
  ) {}

  select() {
    if (this.op !== "select") this.returning = true;
    return this;
  }
  insert(row: Row) {
    this.op = "insert";
    this.payload = row;
    this.returning = false;
    return this;
  }
  upsert(row: Row) {
    this.op = "upsert";
    this.payload = row;
    this.returning = false;
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.payload = patch;
    this.returning = false;
    return this;
  }
  delete() {
    this.op = "delete";
    this.returning = false;
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push({ column, values: [value] });
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push({ column, values });
    return this;
  }
  order(column: string) {
    this.orderColumn = column;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  returns() {
    return this;
  }

  private where(params: unknown[]) {
    if (this.filters.length === 0) return "";
    const clauses = this.filters.map(({ column, values }) => {
      const marks = values.map((v) => `$${params.push(v)}`);
      return `${column} in (${marks.join(", ")})`;
    });
    return ` where ${clauses.join(" and ")}`;
  }

  private async execute() {
    const params: unknown[] = [];
    const columns = Object.keys(this.payload);
    let sql: string;
    if (this.op === "insert" || this.op === "upsert") {
      const marks = columns.map((c) => `$${params.push(this.payload[c])}`);
      sql = `insert into ${this.table} (${columns.join(", ")}) values (${marks.join(", ")})`;
      if (this.op === "upsert")
        sql += ` on conflict (${columns[0]}) do update set ${columns
          .slice(1)
          .map((c) => `${c} = excluded.${c}`)
          .join(", ")}`;
    } else if (this.op === "update") {
      const sets = columns.map(
        (c) => `${c} = $${params.push(this.payload[c])}`,
      );
      sql = `update ${this.table} set ${sets.join(", ")}${this.where(params)}`;
    } else if (this.op === "delete") {
      sql = `delete from ${this.table}${this.where(params)}`;
    } else {
      sql = `select * from ${this.table}${this.where(params)}`;
      if (this.orderColumn) sql += ` order by ${this.orderColumn}`;
    }
    if (this.returning && this.op !== "select") sql += " returning *";
    const { rows } = await this.db.query<Row>(sql, params);
    return this.single ? (rows[0] ?? null) : rows;
  }

  then<R1, R2>(
    onfulfilled?: (v: {
      data: unknown;
      error: unknown;
    }) => R1 | PromiseLike<R1>,
    onrejected?: (reason: unknown) => R2 | PromiseLike<R2>,
  ) {
    const run = this.execute().then(
      (data) => ({ data, error: null }),
      (error: { message: string; code?: string }) => ({
        data: null,
        error: { message: error.message, code: error.code },
      }),
    );
    return run.then(onfulfilled, onrejected);
  }
}

export function supabaseOnPglite(db: PGlite): SupabaseClient {
  return { from: (table: string) => new Query(db, table) } as never;
}
