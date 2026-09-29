import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';

export interface VectorRecord {
  path: string;
  mtime: number;
  vector: Float32Array;
}

/**
 * Safely convert a Uint8Array blob from SQLite into a Float32Array
 * Handles non-4-byte-aligned memory offsets seamlessly to prevent RangeErrors
 */
function toFloat32Array(u8: Uint8Array, length?: number): Float32Array {
  const targetLen = length !== undefined ? length : Math.floor(u8.byteLength / 4);
  if (u8.byteOffset % 4 === 0) {
    return new Float32Array(u8.buffer, u8.byteOffset, targetLen);
  }
  const alignedBuf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + targetLen * 4);
  return new Float32Array(alignedBuf, 0, targetLen);
}

export class DatabaseService {
  private dbPath: string;
  private dbDir: string;
  private SQL: SqlJsStatic | null = null;
  private db: Database | null = null;
  private isInitialized: boolean = false;
  private initPromise: Promise<void> | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private isDirty: boolean = false;

  constructor(vaultBasePath: string) {
    this.dbDir = path.join(vaultBasePath, '.echobrain');
    this.dbPath = path.join(this.dbDir, 'echobrain.db');
  }

  /**
   * Initialize WASM SQLite and load existing database or create a new one
   */
  public async init(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        if (!fsSync.existsSync(this.dbDir)) {
          await fs.mkdir(this.dbDir, { recursive: true });
        }

        // Locate sql-wasm.wasm binary buffer
        const wasmBinary = this.findWasmBinary();
        if (wasmBinary) {
          this.SQL = await initSqlJs({ wasmBinary });
        } else {
          this.SQL = await initSqlJs();
        }

        // Read existing database file if present
        let fileBuffer: Buffer | null = null;
        if (fsSync.existsSync(this.dbPath)) {
          try {
            fileBuffer = await fs.readFile(this.dbPath);
          } catch (e) {
            console.warn('[EchoBrain DB] Failed to read existing db file, creating new:', e);
          }
        }

        this.db = fileBuffer && fileBuffer.length > 0
          ? new this.SQL.Database(new Uint8Array(fileBuffer))
          : new this.SQL.Database();

        this.registerCustomFunctions();
        this.initSchema();
        this.isInitialized = true;
        console.log('[EchoBrain DB] SQLite WASM database initialized successfully.');
      } catch (err) {
        console.error('[EchoBrain DB] Failed to initialize SQLite WASM:', err);
        throw err;
      }
    })();

    return this.initPromise;
  }

  private findWasmBinary(): ArrayBuffer | null {
    const currentDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    const candidatePaths = [
      path.join(currentDir, 'sql-wasm.wasm'),
      path.join(this.dbDir, '..', '.obsidian', 'plugins', 'echobrain-local', 'sql-wasm.wasm'),
      path.resolve('sql-wasm.wasm'),
      path.resolve('node_modules/sql.js/dist/sql-wasm.wasm')
    ];

    for (const p of candidatePaths) {
      try {
        if (fsSync.existsSync(p)) {
          const buf = fsSync.readFileSync(p);
          if (buf.length > 0) {
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          }
        }
      } catch {
        // ignore and check next
      }
    }
    return null;
  }

  /**
   * Register high-performance native scalar function for cosine similarity in SQL
   */
  private registerCustomFunctions(): void {
    if (!this.db) return;

    this.db.create_function('cosine_sim', (blobA: Uint8Array, blobB: Uint8Array) => {
      if (!blobA || !blobB) return 0;
      const vecA = toFloat32Array(blobA);
      const vecB = toFloat32Array(blobB);
      if (vecA.length !== vecB.length || vecA.length === 0) return 0;

      let dot = 0;
      let normA = 0;
      let normB = 0;
      for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
      }
      const denom = Math.sqrt(normA) * Math.sqrt(normB);
      return denom > 0 ? dot / denom : 0;
    });
  }

  /**
   * Initialize table schemas and indexes
   */
  private initSchema(): void {
    if (!this.db) return;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS note_vectors (
        path TEXT PRIMARY KEY,
        mtime INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        dim INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vectors_mtime ON note_vectors(mtime);
    `);
  }

  /**
   * Insert or update a single vector record
   */
  public async upsertVector(filePath: string, mtime: number, vector: number[] | Float32Array): Promise<void> {
    await this.init();
    if (!this.db) return;

    const f32 = vector instanceof Float32Array ? vector : new Float32Array(vector);
    const blob = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);

    const stmt = this.db.prepare(`
      INSERT INTO note_vectors (path, mtime, embedding, dim)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        mtime = excluded.mtime,
        embedding = excluded.embedding,
        dim = excluded.dim;
    `);

    stmt.run([filePath, mtime, blob, f32.length]);
    stmt.free();
    this.scheduleSave();
  }

  /**
   * Get vector for a specific document path (optionally checking mtime freshness)
   */
  public getVector(filePath: string, currentMtime?: number): Float32Array | null {
    if (!this.db || !this.isInitialized) return null;

    const stmt = this.db.prepare('SELECT mtime, embedding, dim FROM note_vectors WHERE path = ?');
    stmt.bind([filePath]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as { mtime: number; embedding: Uint8Array; dim: number };
      stmt.free();

      // Invalidate if modified
      if (currentMtime !== undefined && row.mtime !== currentMtime) {
        return null;
      }

      return toFloat32Array(row.embedding, row.dim);
    }
    stmt.free();
    return null;
  }

  /**
   * Delete vector record for a single document
   */
  public deleteVector(filePath: string): void {
    if (!this.db || !this.isInitialized) return;

    this.db.run('DELETE FROM note_vectors WHERE path = ?', [filePath]);
    this.scheduleSave();
  }

  /**
   * Rename a document path in database
   */
  public renameVector(oldPath: string, newPath: string): void {
    if (!this.db || !this.isInitialized) return;

    this.db.run('UPDATE note_vectors SET path = ? WHERE path = ?', [newPath, oldPath]);
    this.scheduleSave();
  }

  /**
   * Get all cached vectors into memory Map for high-speed batch operations
   */
  public getAllVectors(): Map<string, { mtime: number; vector: Float32Array }> {
    const map = new Map<string, { mtime: number; vector: Float32Array }>();
    if (!this.db || !this.isInitialized) return map;

    const stmt = this.db.prepare('SELECT path, mtime, embedding, dim FROM note_vectors');
    while (stmt.step()) {
      const row = stmt.getAsObject() as { path: string; mtime: number; embedding: Uint8Array; dim: number };
      const vec = toFloat32Array(row.embedding, row.dim);
      map.set(row.path, { mtime: row.mtime, vector: vec });
    }
    stmt.free();
    return map;
  }

  /**
   * Native SQL vector similarity search
   */
  public querySimilar(
    queryVector: number[] | Float32Array,
    limit: number = 10,
    minSim: number = 0.20
  ): { path: string; mtime: number; sim: number }[] {
    if (!this.db || !this.isInitialized) return [];

    // Ensure custom SQL functions are active (in case export() reset function table)
    this.registerCustomFunctions();

    const f32 = queryVector instanceof Float32Array ? queryVector : new Float32Array(queryVector);
    const queryBlob = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);

    const stmt = this.db.prepare(`
      SELECT path, mtime, cosine_sim(?, embedding) AS sim
      FROM note_vectors
      WHERE cosine_sim(?, embedding) >= ?
      ORDER BY sim DESC
      LIMIT ?;
    `);

    stmt.bind([queryBlob, queryBlob, minSim, limit]);
    const results: { path: string; mtime: number; sim: number }[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as { path: string; mtime: number; sim: number };
      results.push({
        path: row.path,
        mtime: row.mtime,
        sim: row.sim
      });
    }
    stmt.free();
    return results;
  }

  /**
   * Get total number of stored vectors
   */
  public count(): number {
    if (!this.db || !this.isInitialized) return 0;
    const stmt = this.db.prepare('SELECT count(*) as total FROM note_vectors');
    stmt.step();
    const count = (stmt.getAsObject() as { total: number }).total || 0;
    stmt.free();
    return count;
  }

  /**
   * Debounced asynchronous persistence to disk (1.5 seconds)
   */
  public scheduleSave(): void {
    this.isDirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);

    this.saveTimer = setTimeout(async () => {
      await this.saveImmediate();
    }, 1500);
  }

  /**
   * Immediately write database to disk via atomic write + rename
   */
  public async saveImmediate(): Promise<void> {
    if (!this.db || !this.isDirty) return;
    this.isDirty = false;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    try {
      if (!fsSync.existsSync(this.dbDir)) {
        await fs.mkdir(this.dbDir, { recursive: true });
      }
      const data = this.db.export();
      // sql.js export() resets custom functions, immediately re-register
      this.registerCustomFunctions();

      const tmpPath = `${this.dbPath}.tmp`;
      await fs.writeFile(tmpPath, Buffer.from(data));
      await fs.rename(tmpPath, this.dbPath);
    } catch (err) {
      console.error('[EchoBrain DB] Failed to persist database to disk:', err);
    }
  }

  /**
   * Graceful close
   */
  public async close(): Promise<void> {
    await this.saveImmediate();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.isInitialized = false;
  }
}
