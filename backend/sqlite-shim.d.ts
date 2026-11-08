declare module 'tjs:sqlite' {
  export class Statement {
    run(...params: unknown[]): void;
    all(...params: unknown[]): Record<string, unknown>[];
    finalize(): void;
  }

  export class Database {
    constructor(path: string);
    prepare(sql: string): Statement;
    exec(sql: string): void;
    close(): void;
  }
}
