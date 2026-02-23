/**
 * SoulManager — manages the agent's identity file (SOUL.md).
 *
 * Responsibilities:
 * - Loads the soul file at startup and verifies integrity via SHA-256
 * - Detects file tampering on every read (hash mismatch)
 * - Applies updates atomically (write to .tmp, rename)
 * - Maintains version history in SQLite
 * - Provides safe fallback content when the soul file is unavailable
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { AuditLogger } from './audit.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SoulVersion {
  id: string;
  version: number;
  content: string;
  hash: string;
  changedBy: string;
  rationale: string;
  context: string;
  appliedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DB_PATH = '/data/soul.db';

const FALLBACK_IDENTITY =
  'You are ArgusClaw, a personal AI assistant. Be helpful, concise, and direct.';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS soul_versions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  hash TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '',
  applied_at TEXT NOT NULL
);
`;

// ---------------------------------------------------------------------------
// SoulManager
// ---------------------------------------------------------------------------

export class SoulManager {
  private soulFilePath: string;
  private auditLogger: AuditLogger;
  private db: Database.Database;
  private blessedHash: string = '';

  constructor(soulFilePath: string, auditLogger: AuditLogger, dbPath?: string) {
    this.soulFilePath = soulFilePath;
    this.auditLogger = auditLogger;

    const resolvedDbPath = dbPath ?? process.env['SOUL_DB_PATH'] ?? DEFAULT_DB_PATH;
    const dbDir = path.dirname(resolvedDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(resolvedDbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);

    this.initialize();
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  private initialize(): void {
    if (!fs.existsSync(this.soulFilePath)) {
      console.warn(`[soul] Soul file not found: ${this.soulFilePath}`);
      this.blessedHash = '';
      return;
    }

    const content = fs.readFileSync(this.soulFilePath, 'utf-8');
    this.blessedHash = this.computeHash(content);

    // Insert version 1 if no versions exist
    const count = this.db.prepare('SELECT COUNT(*) as cnt FROM soul_versions').get() as { cnt: number };
    if (count.cnt === 0) {
      const id = crypto.randomUUID();
      this.db.prepare(
        `INSERT INTO soul_versions (id, version, content, hash, changed_by, rationale, context, applied_at)
         VALUES (?, 1, ?, ?, 'system', 'Initial load', '', ?)`,
      ).run(id, content, this.blessedHash, new Date().toISOString());
    }

    this.auditLogger.logSoulEvent('soul_loaded', {
      hash: this.blessedHash,
      path: this.soulFilePath,
      contentLength: content.length,
    });

    console.log(`[soul] Soul loaded: ${this.soulFilePath} (hash: ${this.blessedHash.slice(0, 12)}...)`);
  }

  // -------------------------------------------------------------------------
  // Hash Computation
  // -------------------------------------------------------------------------

  computeHash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
  }

  // -------------------------------------------------------------------------
  // Content Access
  // -------------------------------------------------------------------------

  /**
   * Read the soul file and verify its hash against the blessed hash.
   * Throws on tamper detection.
   */
  getContent(): string {
    if (!fs.existsSync(this.soulFilePath)) {
      throw new Error(`Soul file not found: ${this.soulFilePath}`);
    }

    const content = fs.readFileSync(this.soulFilePath, 'utf-8');
    const currentHash = this.computeHash(content);

    if (this.blessedHash && currentHash !== this.blessedHash) {
      this.auditLogger.logSoulEvent('soul_tamper_detected', {
        expectedHash: this.blessedHash,
        actualHash: currentHash,
        path: this.soulFilePath,
      });

      console.error(
        `[soul] TAMPER DETECTED: Soul file hash mismatch! ` +
        `Expected ${this.blessedHash.slice(0, 12)}..., got ${currentHash.slice(0, 12)}...`,
      );

      throw new Error('Soul file integrity check failed: hash mismatch');
    }

    return content;
  }

  /**
   * Safe wrapper around getContent(). Returns fallback identity on error.
   */
  getContentSafe(): string {
    try {
      return this.getContent();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[soul] Failed to read soul file: ${error.message}. Using fallback.`);
      return FALLBACK_IDENTITY;
    }
  }

  /**
   * Get the current blessed hash.
   */
  getHash(): string {
    return this.blessedHash;
  }

  // -------------------------------------------------------------------------
  // Updates
  // -------------------------------------------------------------------------

  /**
   * Apply a soul update atomically.
   *
   * Writes to a temp file then renames, recomputes the blessed hash,
   * and inserts a new version record.
   */
  applySoulUpdate(proposedContent: string, rationale: string, context: string): SoulVersion {
    // Write atomically: tmp file then rename
    const tmpPath = this.soulFilePath + '.tmp';
    fs.writeFileSync(tmpPath, proposedContent, 'utf-8');
    fs.renameSync(tmpPath, this.soulFilePath);

    // Recompute blessed hash
    this.blessedHash = this.computeHash(proposedContent);

    // Determine next version number
    const latest = this.db.prepare(
      'SELECT MAX(version) as maxVer FROM soul_versions',
    ).get() as { maxVer: number | null };
    const nextVersion = (latest.maxVer ?? 0) + 1;

    const id = crypto.randomUUID();
    const appliedAt = new Date().toISOString();

    this.db.prepare(
      `INSERT INTO soul_versions (id, version, content, hash, changed_by, rationale, context, applied_at)
       VALUES (?, ?, ?, ?, 'agent', ?, ?, ?)`,
    ).run(id, nextVersion, proposedContent, this.blessedHash, rationale, context, appliedAt);

    const version: SoulVersion = {
      id,
      version: nextVersion,
      content: proposedContent,
      hash: this.blessedHash,
      changedBy: 'agent',
      rationale,
      context,
      appliedAt,
    };

    this.auditLogger.logSoulEvent('soul_update_applied', {
      version: nextVersion,
      hash: this.blessedHash,
      rationale,
      contentLength: proposedContent.length,
    });

    console.log(`[soul] Soul updated to version ${nextVersion} (hash: ${this.blessedHash.slice(0, 12)}...)`);

    return version;
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  /**
   * Get all soul versions, most recent first.
   */
  getHistory(): SoulVersion[] {
    const rows = this.db.prepare(
      'SELECT id, version, content, hash, changed_by, rationale, context, applied_at FROM soul_versions ORDER BY version DESC',
    ).all() as Array<{
      id: string;
      version: number;
      content: string;
      hash: string;
      changed_by: string;
      rationale: string;
      context: string;
      applied_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      version: row.version,
      content: row.content,
      hash: row.hash,
      changedBy: row.changed_by,
      rationale: row.rationale,
      context: row.context,
      appliedAt: row.applied_at,
    }));
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}
