// core/NetworkProcessTempDiff.js
//
// User Story A7 (5 pts · High)
// As a developer, I want the tool to record changes to open network
// ports, running processes, and temp files, so that I can catch
// suspicious network or process activity.
//
// Consumes a pair of snapshots produced by BeforeSnapshot.js /
// AfterSnapshot.js (state.network, state.processes, state.tempFiles)
// and produces a focused diff covering this story's three concerns.
// Feeds into A9's overall structured diff engine as another section
// of the full report.

'use strict';

/**
 * Diffs the network port list between two snapshots.
 * Ports are compared by (protocol, localAddress) since that pair
 * identifies a listening/connected socket well enough for this
 * story's purpose, without over-fitting to a specific netstat format.
 *
 * @returns {{
 *   opened: object[],  // entries present after but not before
 *   closed: object[],  // entries present before but not after
 * }}
 */
function diffNetworkPorts(beforePorts = [], afterPorts = []) {
  const keyOf = (p) => `${p.protocol}|${p.localAddress}`;

  const beforeMap = new Map(beforePorts.map((p) => [keyOf(p), p]));
  const afterMap = new Map(afterPorts.map((p) => [keyOf(p), p]));

  const opened = [...afterMap.entries()].filter(([key]) => !beforeMap.has(key)).map(([, v]) => v);
  const closed = [...beforeMap.entries()].filter(([key]) => !afterMap.has(key)).map(([, v]) => v);

  return { opened, closed };
}

/**
 * Diffs the process list between two snapshots.
 * Matched by `name` rather than `pid`, since PIDs are recycled
 * constantly and comparing them directly would produce noise on
 * every single run. This surfaces genuinely new or vanished process
 * *names*, and a count delta for processes that were already running
 * (e.g. a process that spawned extra worker instances).
 *
 * @returns {{
 *   started: {name: string, pid: number}[],  // process names that appeared
 *   stopped: {name: string, pid: number}[],   // process names that disappeared
 *   countChanged: {name: string, before: number, after: number}[],
 * }}
 */
function diffProcesses(beforeProcs = [], afterProcs = []) {
  const countBy = (list) => {
    const map = new Map();
    for (const p of list) {
      map.set(p.name, (map.get(p.name) || 0) + 1);
    }
    return map;
  };

  const beforeCounts = countBy(beforeProcs);
  const afterCounts = countBy(afterProcs);

  const started = [];
  const stopped = [];
  const countChanged = [];

  for (const [name, afterCount] of afterCounts) {
    const beforeCount = beforeCounts.get(name) || 0;
    if (beforeCount === 0) {
      const example = afterProcs.find((p) => p.name === name);
      started.push({ name, pid: example ? example.pid : null });
    } else if (beforeCount !== afterCount) {
      countChanged.push({ name, before: beforeCount, after: afterCount });
    }
  }

  for (const [name, beforeCount] of beforeCounts) {
    if (!afterCounts.has(name)) {
      const example = beforeProcs.find((p) => p.name === name);
      stopped.push({ name, pid: example ? example.pid : null });
    }
  }

  return { started, stopped, countChanged };
}

/**
 * Diffs the temp directory listing between two snapshots.
 * Matched by file `name`. Flags files that appeared, disappeared, or
 * changed size/mtime — the common signature of malware staging files,
 * dropped payloads, or install-script scratch files left behind.
 *
 * @returns {{
 *   added: object[],
 *   removed: object[],
 *   modified: Array<{name: string, before: object, after: object}>,
 * }}
 */
function diffTempFiles(beforeFiles = [], afterFiles = []) {
  const beforeMap = new Map(beforeFiles.map((f) => [f.name, f]));
  const afterMap = new Map(afterFiles.map((f) => [f.name, f]));

  const added = [...afterMap.values()].filter((f) => !beforeMap.has(f.name));
  const removed = [...beforeMap.values()].filter((f) => !afterMap.has(f.name));

  const modified = [];
  for (const [name, afterFile] of afterMap) {
    const beforeFile = beforeMap.get(name);
    if (!beforeFile) continue;
    if (beforeFile.size !== afterFile.size || beforeFile.mtime !== afterFile.mtime) {
      modified.push({ name, before: beforeFile, after: afterFile });
    }
  }

  return { added, removed, modified };
}

/**
 * Runs the full A7 diff (network + processes + temp files) against a
 * before/after snapshot pair from BeforeSnapshot.js / AfterSnapshot.js.
 *
 * @param {object} before - snapshot from captureBeforeSnapshot()
 * @param {object} after - snapshot from captureAfterSnapshot()
 * @returns {{
 *   network: ReturnType<diffNetworkPorts>,
 *   processes: ReturnType<diffProcesses>,
 *   tempFiles: ReturnType<diffTempFiles>,
 *   hasSuspiciousChanges: boolean,
 * }}
 */
function diffNetworkProcessTemp(before, after) {
  const network = diffNetworkPorts(before?.state?.network, after?.state?.network);
  const processes = diffProcesses(before?.state?.processes, after?.state?.processes);
  const tempFiles = diffTempFiles(before?.state?.tempFiles, after?.state?.tempFiles);

  // Heuristic: any newly opened port, any brand-new process name, or any
  // added temp file is worth a second look — these are cheap, common
  // signals for a compromised or overly-chatty install script.
  const hasSuspiciousChanges =
    network.opened.length > 0 || processes.started.length > 0 || tempFiles.added.length > 0;

  return { network, processes, tempFiles, hasSuspiciousChanges };
}

module.exports = {
  diffNetworkPorts,
  diffProcesses,
  diffTempFiles,
  diffNetworkProcessTemp,
};

// Allow running this file directly against two saved snapshot JSON files:
//   node core/NetworkProcessTempDiff.js before.json after.json
if (require.main === module) {
  const fs = require('fs');
  const [beforePath, afterPath] = process.argv.slice(2);

  if (!beforePath || !afterPath) {
    console.error('Usage: node core/NetworkProcessTempDiff.js <before.json> <after.json>');
    process.exit(1);
  }

  const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(fs.readFileSync(afterPath, 'utf8'));

  console.log(JSON.stringify(diffNetworkProcessTemp(before, after), null, 2));
}