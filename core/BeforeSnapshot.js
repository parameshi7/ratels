// core/BeforeSnapshot.js
//
// User Story A3 (5 pts · High)
// As a developer, I want to capture a "before" snapshot of my system
// state prior to installing a package, so that I have a clean baseline
// to compare against.
//
// This module owns the *generic* snapshot engine: it defines the
// snapshot shape, orchestrates a set of pluggable "collectors", and
// produces the baseline object. Deeper, security-specific collectors
// (SSH keys, sudoers, startup items -> A8; systemd/registry -> G1/G2)
// register themselves into this same engine later; A3 ships with the
// general-purpose collectors it needs to be useful on its own:
// env vars, PATH entries, running processes, open network ports,
// and the OS temp directory listing.

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { detectOs } = require('./OsDetection');
const { detectPackageManagers } = require('./PackageManagerDetection');

/** Runs a command and resolves to trimmed stdout, or '' on any failure. Never rejects. */
function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 8000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? '' : String(stdout));
    });
  });
}

/** Collects a copy of the current environment variables. */
function collectEnvVars() {
  return { ...process.env };
}

/** Collects PATH entries, in order, exactly as the shell would see them. */
function collectPath() {
  const raw = process.env.PATH || process.env.Path || '';
  const separator = os.platform() === 'win32' ? ';' : ':';
  return raw.split(separator).filter(Boolean);
}

/** Collects a snapshot of currently running processes (name + pid only). */
async function collectProcesses(osId) {
  if (osId === 'windows') {
    const output = await run('tasklist', ['/FO', 'CSV', '/NH']);
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const cols = line.split('","').map((c) => c.replace(/(^")|("$)/g, ''));
        return { name: cols[0], pid: Number(cols[1]) || null };
      });
  }

  const output = await run('ps', ['-Ao', 'pid,comm']);
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, ...rest] = line.split(/\s+/);
      return { pid: Number(pid) || null, name: rest.join(' ') };
    });
}

/** Collects currently open/listening network ports. */
async function collectNetworkPorts(osId) {
  if (osId === 'windows') {
    const output = await run('netstat', ['-ano']);
    return parseNetstatLines(output);
  }
  // macOS and Linux both support `-an`; Linux also has `ss` but netstat
  // remains broadly available and keeps parsing consistent for now.
  const output = await run('netstat', ['-an']);
  return parseNetstatLines(output);
}

function parseNetstatLines(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(tcp|udp)/i.test(line))
    .map((line) => {
      const cols = line.split(/\s+/);
      return { protocol: cols[0], localAddress: cols[3] || cols[1] || null, state: cols[5] || null };
    });
}

/** Collects a listing of the OS temp directory (name + size + mtime only). */
function collectTempFiles() {
  const dir = os.tmpdir();
  try {
    return fs.readdirSync(dir).map((name) => {
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        return { name, size: stat.size, mtime: stat.mtime.toISOString(), isDirectory: stat.isDirectory() };
      } catch {
        return { name, size: null, mtime: null, isDirectory: null };
      }
    });
  } catch {
    return [];
  }
}

/**
 * Captures a full "before" snapshot of the system.
 *
 * @returns {Promise<object>} snapshot - see shape below
 *
 * Snapshot shape:
 * {
 *   id: string,            // unique snapshot id (timestamp-based)
 *   type: 'before',
 *   capturedAt: string,    // ISO timestamp
 *   os: object,            // from OsDetection.detectOs()
 *   packageManagers: object, // from PackageManagerDetection.detectPackageManagers()
 *   state: {
 *     env: Record<string,string>,
 *     path: string[],
 *     processes: {pid:number, name:string}[],
 *     network: {protocol:string, localAddress:string, state:string}[],
 *     tempFiles: {name:string, size:number, mtime:string, isDirectory:boolean}[],
 *   }
 * }
 */
async function captureBeforeSnapshot() {
  const osInfo = detectOs();

  const [packageManagers, processes, network] = await Promise.all([
    detectPackageManagers({ osId: osInfo.id }),
    collectProcesses(osInfo.id),
    collectNetworkPorts(osInfo.id),
  ]);

  return {
    id: `before-${Date.now()}`,
    type: 'before',
    capturedAt: new Date().toISOString(),
    os: osInfo,
    packageManagers,
    state: {
      env: collectEnvVars(),
      path: collectPath(),
      processes,
      network,
      tempFiles: collectTempFiles(),
    },
  };
}

module.exports = {
  captureBeforeSnapshot,
  // Exported for reuse by AfterSnapshot.js (and future collectors in
  // A6/A7/A8/G1/G2) so "before" and "after" snapshots stay identical
  // in shape and collection method — a prerequisite for a meaningful
  // diff in A9.
  collectEnvVars,
  collectPath,
  collectProcesses,
  collectNetworkPorts,
  collectTempFiles,
};

// Allow running this file directly for a quick manual check:
//   node core/BeforeSnapshot.js
if (require.main === module) {
  captureBeforeSnapshot().then((snapshot) => {
    console.log(JSON.stringify(snapshot, null, 2));
  });
}