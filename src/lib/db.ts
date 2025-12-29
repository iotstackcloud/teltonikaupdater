import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(process.cwd(), 'data', 'teltonika.db');

// Ensure data directory exists
import fs from 'fs';
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);

// Initialize database schema
db.exec(`
  -- Routers table
  CREATE TABLE IF NOT EXISTS routers (
    id TEXT PRIMARY KEY,
    device_name TEXT NOT NULL,
    ip_address TEXT NOT NULL UNIQUE,
    username TEXT,
    password TEXT,
    current_firmware TEXT,
    available_firmware TEXT,
    last_check DATETIME,
    status TEXT DEFAULT 'unknown',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Update history table
  CREATE TABLE IF NOT EXISTS update_history (
    id TEXT PRIMARY KEY,
    router_id TEXT NOT NULL,
    firmware_before TEXT,
    firmware_after TEXT,
    status TEXT NOT NULL,
    error_message TEXT,
    started_at DATETIME,
    completed_at DATETIME,
    FOREIGN KEY (router_id) REFERENCES routers(id)
  );

  -- Settings table for global credentials
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- Batch jobs table
  CREATE TABLE IF NOT EXISTS batch_jobs (
    id TEXT PRIMARY KEY,
    status TEXT DEFAULT 'pending',
    batch_size INTEGER,
    total_routers INTEGER,
    completed_routers INTEGER DEFAULT 0,
    failed_routers INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    completed_at DATETIME
  );

  -- Firmware versions table (latest versions per device type)
  CREATE TABLE IF NOT EXISTS firmware_versions (
    device_prefix TEXT PRIMARY KEY,
    latest_version TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Create indexes
  CREATE INDEX IF NOT EXISTS idx_routers_status ON routers(status);
  CREATE INDEX IF NOT EXISTS idx_update_history_router ON update_history(router_id);
  CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON batch_jobs(status);
`);

export default db;

// Router types
export interface Router {
  id: string;
  device_name: string;
  ip_address: string;
  username: string | null;
  password: string | null;
  current_firmware: string | null;
  available_firmware: string | null;
  last_check: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface UpdateHistory {
  id: string;
  router_id: string;
  firmware_before: string | null;
  firmware_after: string | null;
  status: string;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface BatchJob {
  id: string;
  status: string;
  batch_size: number;
  total_routers: number;
  completed_routers: number;
  failed_routers: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface FirmwareVersion {
  device_prefix: string;
  latest_version: string;
  updated_at: string;
}

// Database operations
export const routerDb = {
  getAll: (): Router[] => {
    return db.prepare('SELECT * FROM routers ORDER BY device_name').all() as Router[];
  },

  getById: (id: string): Router | undefined => {
    return db.prepare('SELECT * FROM routers WHERE id = ?').get(id) as Router | undefined;
  },

  getByStatus: (status: string): Router[] => {
    return db.prepare('SELECT * FROM routers WHERE status = ?').all(status) as Router[];
  },

  insert: (router: Omit<Router, 'created_at' | 'updated_at' | 'current_firmware' | 'available_firmware' | 'last_check'>): void => {
    db.prepare(`
      INSERT INTO routers (id, device_name, ip_address, username, password, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(router.id, router.device_name, router.ip_address, router.username, router.password, router.status);
  },

  insertMany: (routers: Array<Omit<Router, 'created_at' | 'updated_at' | 'current_firmware' | 'available_firmware' | 'last_check'>>): void => {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO routers (id, device_name, ip_address, username, password, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertMany = db.transaction((routers) => {
      for (const router of routers) {
        insert.run(router.id, router.device_name, router.ip_address, router.username, router.password, router.status);
      }
    });
    insertMany(routers);
  },

  updateFirmwareInfo: (id: string, current: string | null, available: string | null, status: string): void => {
    db.prepare(`
      UPDATE routers
      SET current_firmware = ?, available_firmware = ?, last_check = CURRENT_TIMESTAMP, status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(current, available, status, id);
  },

  updateStatus: (id: string, status: string): void => {
    db.prepare('UPDATE routers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
  },

  deleteAll: (): void => {
    db.prepare('DELETE FROM routers').run();
  },

  count: (): number => {
    const result = db.prepare('SELECT COUNT(*) as count FROM routers').get() as { count: number };
    return result.count;
  },

  countByStatus: (): { status: string; count: number }[] => {
    return db.prepare('SELECT status, COUNT(*) as count FROM routers GROUP BY status').all() as { status: string; count: number }[];
  }
};

export const updateHistoryDb = {
  getAll: (): UpdateHistory[] => {
    return db.prepare('SELECT * FROM update_history ORDER BY started_at DESC').all() as UpdateHistory[];
  },

  getByRouter: (routerId: string): UpdateHistory[] => {
    return db.prepare('SELECT * FROM update_history WHERE router_id = ? ORDER BY started_at DESC').all(routerId) as UpdateHistory[];
  },

  insert: (history: UpdateHistory): void => {
    db.prepare(`
      INSERT INTO update_history (id, router_id, firmware_before, firmware_after, status, error_message, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(history.id, history.router_id, history.firmware_before, history.firmware_after, history.status, history.error_message, history.started_at, history.completed_at);
  },

  update: (id: string, updates: Partial<UpdateHistory>): void => {
    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = Object.values(updates);
    db.prepare(`UPDATE update_history SET ${fields} WHERE id = ?`).run(...values, id);
  },

  getRecent: (limit: number = 50): (UpdateHistory & { device_name: string; ip_address: string })[] => {
    return db.prepare(`
      SELECT uh.*, r.device_name, r.ip_address
      FROM update_history uh
      JOIN routers r ON uh.router_id = r.id
      ORDER BY uh.started_at DESC
      LIMIT ?
    `).all(limit) as (UpdateHistory & { device_name: string; ip_address: string })[];
  }
};

export const settingsDb = {
  get: (key: string): string | null => {
    const result = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return result?.value ?? null;
  },

  set: (key: string, value: string): void => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  },

  getGlobalCredentials: (): { username: string; password: string } | null => {
    const username = settingsDb.get('global_username');
    const password = settingsDb.get('global_password');
    if (username && password) {
      return { username, password };
    }
    return null;
  },

  setGlobalCredentials: (username: string, password: string): void => {
    settingsDb.set('global_username', username);
    settingsDb.set('global_password', password);
  }
};

export const batchJobDb = {
  getAll: (): BatchJob[] => {
    return db.prepare('SELECT * FROM batch_jobs ORDER BY created_at DESC').all() as BatchJob[];
  },

  getById: (id: string): BatchJob | undefined => {
    return db.prepare('SELECT * FROM batch_jobs WHERE id = ?').get(id) as BatchJob | undefined;
  },

  getActive: (): BatchJob | undefined => {
    return db.prepare("SELECT * FROM batch_jobs WHERE status IN ('pending', 'running') ORDER BY created_at DESC LIMIT 1").get() as BatchJob | undefined;
  },

  insert: (job: Omit<BatchJob, 'completed_routers' | 'failed_routers' | 'started_at' | 'completed_at'>): void => {
    db.prepare(`
      INSERT INTO batch_jobs (id, status, batch_size, total_routers, created_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(job.id, job.status, job.batch_size, job.total_routers);
  },

  update: (id: string, updates: Partial<BatchJob>): void => {
    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = Object.values(updates);
    db.prepare(`UPDATE batch_jobs SET ${fields} WHERE id = ?`).run(...values, id);
  }
};

export const firmwareVersionDb = {
  getAll: (): FirmwareVersion[] => {
    return db.prepare('SELECT * FROM firmware_versions ORDER BY device_prefix').all() as FirmwareVersion[];
  },

  getByPrefix: (prefix: string): FirmwareVersion | undefined => {
    return db.prepare('SELECT * FROM firmware_versions WHERE device_prefix = ?').get(prefix) as FirmwareVersion | undefined;
  },

  getLatestForFirmware: (currentFirmware: string): string | null => {
    // Extract prefix from firmware string (e.g., "RUT9_R_00.07.06.11" -> "RUT9")
    const match = currentFirmware.match(/^([A-Z0-9]+)_/);
    if (!match) return null;

    const prefix = match[1];
    const version = firmwareVersionDb.getByPrefix(prefix);
    return version?.latest_version ?? null;
  },

  upsert: (prefix: string, latestVersion: string): void => {
    db.prepare(`
      INSERT OR REPLACE INTO firmware_versions (device_prefix, latest_version, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `).run(prefix, latestVersion);
  },

  delete: (prefix: string): void => {
    db.prepare('DELETE FROM firmware_versions WHERE device_prefix = ?').run(prefix);
  },

  // Helper to check if an update is available based on version comparison
  isUpdateAvailable: (currentFirmware: string | null): { available: boolean; latestVersion: string | null } => {
    if (!currentFirmware) return { available: false, latestVersion: null };

    const latestVersion = firmwareVersionDb.getLatestForFirmware(currentFirmware);
    if (!latestVersion) return { available: false, latestVersion: null };

    // Compare versions - firmware format: XXX_R_00.07.06.20
    // Extract version numbers for comparison
    const currentMatch = currentFirmware.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    const latestMatch = latestVersion.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);

    if (!currentMatch || !latestMatch) {
      // Fallback to string comparison
      return { available: currentFirmware !== latestVersion, latestVersion };
    }

    // Compare version numbers
    for (let i = 1; i <= 4; i++) {
      const curr = parseInt(currentMatch[i], 10);
      const latest = parseInt(latestMatch[i], 10);
      if (latest > curr) return { available: true, latestVersion };
      if (curr > latest) return { available: false, latestVersion };
    }

    return { available: false, latestVersion };
  }
};
