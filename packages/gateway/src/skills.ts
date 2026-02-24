/**
 * SkillsManager — manages agent skill files (SKILL.md).
 *
 * Skills are operator-authored markdown instruction files that extend
 * what the agent knows how to do. They are prompt content only (not
 * executable code), injected into the LLM's system prompt.
 *
 * Security model (mirrors SoulManager):
 * - SHA-256 hash verification on every read (tamper detection)
 * - Files must live in the configured skills directory (no symlink following)
 * - YAML frontmatter validated (name + description required)
 * - All events are audit-logged
 * - Read-only at runtime — no agent-authored skills
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { AuditLogger } from './audit.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillMetadata {
  name: string;
  description: string;
  alwaysLoad?: boolean;
}

export interface SkillEntry {
  /** Skill name from frontmatter */
  name: string;
  /** One-line description from frontmatter */
  description: string;
  /** Whether to always inject full content into the system prompt */
  alwaysLoad: boolean;
  /** SHA-256 hash of the entire SKILL.md file at load time */
  hash: string;
  /** Absolute path to the SKILL.md file */
  filePath: string;
  /** Whether this skill is enabled (from config overrides) */
  enabled: boolean;
}

/** Lightweight catalog entry for prompt injection. */
export interface SkillCatalogEntry {
  name: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SkillOverride {
  enabled?: boolean;
  alwaysLoad?: boolean;
}

export interface SkillsConfig {
  directory?: string;
  overrides?: Record<string, SkillOverride>;
  charBudget?: number;
}

const DEFAULT_CHAR_BUDGET = 6000;
const SKILL_FILENAME = 'SKILL.md';

// ---------------------------------------------------------------------------
// SkillsManager
// ---------------------------------------------------------------------------

export class SkillsManager {
  private skillsDir: string;
  private auditLogger: AuditLogger;
  private overrides: Record<string, SkillOverride>;
  private charBudget: number;

  /** Loaded skills, keyed by name. */
  private skills: Map<string, SkillEntry> = new Map();

  constructor(
    skillsDir: string,
    auditLogger: AuditLogger,
    config?: SkillsConfig,
  ) {
    this.skillsDir = path.resolve(skillsDir);
    this.auditLogger = auditLogger;
    this.overrides = config?.overrides ?? {};
    this.charBudget = config?.charBudget ?? DEFAULT_CHAR_BUDGET;

    this.initialize();
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  private initialize(): void {
    if (!fs.existsSync(this.skillsDir)) {
      console.warn(`[skills] Skills directory not found: ${this.skillsDir}`);
      return;
    }

    const stat = fs.lstatSync(this.skillsDir);
    if (!stat.isDirectory()) {
      console.warn(`[skills] Skills path is not a directory: ${this.skillsDir}`);
      return;
    }

    // Scan for subdirectories containing SKILL.md
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[skills] Failed to read skills directory: ${error.message}`);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Security: reject symlinked directories to prevent path traversal
      const dirPath = path.join(this.skillsDir, entry.name);
      const dirStat = fs.lstatSync(dirPath);
      if (dirStat.isSymbolicLink()) {
        console.warn(`[skills] Ignoring symlink: ${dirPath}`);
        this.auditLogger.logSkillEvent('skill_load_error', {
          directory: entry.name,
          reason: 'Symlinked directory rejected',
        });
        continue;
      }

      const skillFilePath = path.join(dirPath, SKILL_FILENAME);
      if (!fs.existsSync(skillFilePath)) continue;

      // Security: reject symlinked SKILL.md files
      const fileStat = fs.lstatSync(skillFilePath);
      if (fileStat.isSymbolicLink()) {
        console.warn(`[skills] Ignoring symlinked SKILL.md: ${skillFilePath}`);
        this.auditLogger.logSkillEvent('skill_load_error', {
          file: skillFilePath,
          reason: 'Symlinked SKILL.md rejected',
        });
        continue;
      }

      try {
        const content = fs.readFileSync(skillFilePath, 'utf-8');
        const parsed = this.parseFrontmatter(content);

        if (!parsed) {
          console.warn(`[skills] Invalid frontmatter in ${skillFilePath}, skipping`);
          this.auditLogger.logSkillEvent('skill_load_error', {
            file: skillFilePath,
            reason: 'Invalid or missing YAML frontmatter',
          });
          continue;
        }

        const { metadata } = parsed;

        // Check config overrides
        const override = this.overrides[metadata.name];
        const enabled = override?.enabled !== false; // default: enabled
        const alwaysLoad = override?.alwaysLoad ?? metadata.alwaysLoad ?? false;

        const hash = this.computeHash(content);

        const skillEntry: SkillEntry = {
          name: metadata.name,
          description: metadata.description,
          alwaysLoad,
          hash,
          filePath: skillFilePath,
          enabled,
        };

        this.skills.set(metadata.name, skillEntry);

        this.auditLogger.logSkillEvent('skill_loaded', {
          name: metadata.name,
          description: metadata.description,
          hash: hash.slice(0, 12),
          enabled,
          alwaysLoad,
          path: skillFilePath,
        });

        const status = enabled ? 'enabled' : 'disabled';
        console.log(
          `[skills] Loaded: ${metadata.name} (${status}, hash: ${hash.slice(0, 12)}...)`,
        );
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error(`[skills] Failed to load ${skillFilePath}: ${error.message}`);
        this.auditLogger.logSkillEvent('skill_load_error', {
          file: skillFilePath,
          error: error.message,
        });
      }
    }

    console.log(`[skills] ${this.skills.size} skill(s) loaded from ${this.skillsDir}`);
  }

  // -------------------------------------------------------------------------
  // Hash Computation
  // -------------------------------------------------------------------------

  computeHash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
  }

  // -------------------------------------------------------------------------
  // Frontmatter Parsing
  // -------------------------------------------------------------------------

  /**
   * Parse YAML frontmatter from a SKILL.md file.
   *
   * Expects:
   * ---
   * name: skill-name
   * description: One-line description
   * alwaysLoad: true (optional)
   * ---
   * [Markdown body]
   *
   * Uses a minimal parser (no YAML library dependency) since the
   * frontmatter is intentionally simple key-value pairs.
   */
  parseFrontmatter(content: string): { metadata: SkillMetadata; body: string } | null {
    const trimmed = content.trimStart();
    if (!trimmed.startsWith('---')) return null;

    const endIndex = trimmed.indexOf('---', 3);
    if (endIndex === -1) return null;

    const frontmatterBlock = trimmed.slice(3, endIndex).trim();
    const body = trimmed.slice(endIndex + 3).trim();

    // Parse simple key: value pairs
    const metadata: Record<string, string> = {};
    for (const line of frontmatterBlock.split('\n')) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      if (key && value) {
        metadata[key] = value;
      }
    }

    const name = metadata['name'];
    const description = metadata['description'];

    if (!name || !description) return null;

    return {
      metadata: {
        name,
        description,
        alwaysLoad: metadata['alwaysLoad'] === 'true',
      },
      body,
    };
  }

  // -------------------------------------------------------------------------
  // Catalog (Lightweight)
  // -------------------------------------------------------------------------

  /**
   * Get a lightweight catalog of all enabled skills.
   * Used for prompt injection (name + description only).
   */
  getCatalog(): SkillCatalogEntry[] {
    const entries: SkillCatalogEntry[] = [];
    for (const skill of this.skills.values()) {
      if (!skill.enabled) continue;
      entries.push({
        name: skill.name,
        description: skill.description,
      });
    }
    return entries;
  }

  // -------------------------------------------------------------------------
  // Full Content Access
  // -------------------------------------------------------------------------

  /**
   * Get the full markdown body of a skill by name.
   * Verifies hash integrity on every read.
   *
   * Returns null if the skill doesn't exist, is disabled, or
   * fails integrity verification.
   */
  getSkillContent(name: string): string | null {
    const skill = this.skills.get(name);
    if (!skill || !skill.enabled) return null;

    try {
      const content = fs.readFileSync(skill.filePath, 'utf-8');
      const currentHash = this.computeHash(content);

      if (currentHash !== skill.hash) {
        this.auditLogger.logSkillEvent('skill_tamper_detected', {
          name: skill.name,
          expectedHash: skill.hash.slice(0, 12),
          actualHash: currentHash.slice(0, 12),
          path: skill.filePath,
        });

        console.error(
          `[skills] TAMPER DETECTED: ${skill.name} hash mismatch! ` +
          `Expected ${skill.hash.slice(0, 12)}..., got ${currentHash.slice(0, 12)}...`,
        );

        // Disable the tampered skill
        skill.enabled = false;
        return null;
      }

      const parsed = this.parseFrontmatter(content);

      this.auditLogger.logSkillEvent('skill_accessed', {
        name: skill.name,
        hash: skill.hash.slice(0, 12),
      });

      return parsed?.body ?? null;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[skills] Failed to read ${skill.name}: ${error.message}`);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // AlwaysLoad Content
  // -------------------------------------------------------------------------

  /**
   * Get the full content of all skills marked as alwaysLoad,
   * respecting the character budget.
   */
  getAlwaysLoadContent(): Array<{ name: string; content: string }> {
    const result: Array<{ name: string; content: string }> = [];
    let charUsed = 0;

    for (const skill of this.skills.values()) {
      if (!skill.enabled || !skill.alwaysLoad) continue;

      const content = this.getSkillContent(skill.name);
      if (!content) continue;

      if (charUsed + content.length > this.charBudget) {
        console.warn(
          `[skills] Skipping alwaysLoad skill "${skill.name}" — exceeds char budget ` +
          `(${charUsed}/${this.charBudget})`,
        );
        continue;
      }

      result.push({ name: skill.name, content });
      charUsed += content.length;
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /** Get the number of loaded skills (enabled or not). */
  getSkillCount(): number {
    return this.skills.size;
  }

  /** Get the number of enabled skills. */
  getEnabledCount(): number {
    let count = 0;
    for (const skill of this.skills.values()) {
      if (skill.enabled) count++;
    }
    return count;
  }

  /** Check if a skill exists and is enabled. */
  hasSkill(name: string): boolean {
    const skill = this.skills.get(name);
    return skill != null && skill.enabled;
  }

  /** Get the character budget. */
  getCharBudget(): number {
    return this.charBudget;
  }
}
