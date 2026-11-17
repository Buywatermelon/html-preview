export type Value = string | number | null;
export interface Statement { sql: string; values?: Value[] }
export interface Database {
  all<T>(sql: string, values?: Value[]): Promise<T[]>;
  batch(statements: Statement[]): Promise<void>;
}
export function d1Database(db: D1Database): Database {
  return {
    async all<T>(sql: string, values: Value[] = []) { return (await db.prepare(sql).bind(...values).all<T>()).results; },
    async batch(statements) { await db.batch(statements.map(({sql,values = []}) => db.prepare(sql).bind(...values))); },
  };
}
