#!/usr/bin/env node
// test/happy-path.js
//
// Runs every module built so far, in dependency order, against the
// happy path (nothing errors, no elevated permissions needed), and
// logs every step's result to BOTH the console and a log file under
// ./logs/, so you have a saved record of the test run.
//
// Usage:
//   node test/happy-path.js
//
// What it exercises, in order:
//   A1  OsDetection
//   A2  PackageManagerDetection
//   D1  Config (ensureConfigExists / loadConfig)
//   E4  CredentialStore (set/get/delete round-trip, using a fake key)
//   A3  BeforeSnapshot (via A4)
//   A4  InstallMonitor (runs `npm install left-pad` for real)
//   A5  AfterSnapshot (via A4)
//   A6  EnvPathShellDiff
//   A7  NetworkProcessTempDiff
//   A8  SecurityFlagsDiff
//   A9  StructuredDiffEngine
//   B1  PlainTextReport
//   B3  SnapshotStore (save + list + load round-trip)
//
// Each step is wrapped so one failure doesn't stop the rest of the
// run — you get a full pass/fail summary at the end either way.

'use strict';

const fs = require('fs');
const path = require('path');

const { detectOs } = require('../core/OsDetection');
const { detectPackageManagers } = require('../core/PackageManagerDetection');
const { ensureConfigExists, loadConfig, getConfigPath } = require('../core/Config');
const { setCredential, getCredential, deleteCredential } = require('../core/CredentialStore');
const { monitorInstall } = require('../core/InstallMonitor');
const { diffEnvPathShell } = require('../core/EnvPathShellDiff');
const { diffNetworkProcessTemp } = require('../core/NetworkProcessTempDiff');
const { flagSecurityChanges } = require('../core/SecurityFlagsDiff');
const { computeStructuredDiff } = require('../core/StructuredDiffEngine');
const { renderPlainTextReport } = require('../core/PlainTextReport');
const {
  saveSnapshotPair,
  saveReport,
  listSnapshots,
  listReports,
  loadSnapshot,
  loadReport,
} = require('../core/SnapshotStore');

// ---------------------------------------------------------------------------
// Logger: writes every line to both the console and a timestamped log file.
// ---------------------------------------------------------------------------

const LOG_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_PATH = path.join(LOG_DIR, `happy-path-${Date.now()}.log`);
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

function log(message = '') {
  const line = typeof message === 'string' ? message : JSON.stringify(message, null, 2);
  console.log(line);
  logStream.write(line + '\n');
}

function logHeader(title) {
  log('');
  log('='.repeat(70));
  log(title);
  log('='.repeat(70));
}

// ---------------------------------------------------------------------------
// Tiny step runner: logs PASS/FAIL per step, never throws out of the run.
// ---------------------------------------------------------------------------

const results = [];

async function step(name, fn) {
  log(`\n--- ${name} ---`);
  try {
    const value = await fn();
    log(`[PASS] ${name}`);
    results.push({ name, status: 'PASS' });
    return value;
  } catch (err) {
    log(`[FAIL] ${name}: ${err.message}`);
    log(err.stack);
    results.push({ name, status: 'FAIL', error: err.message });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The actual happy-path run
// ---------------------------------------------------------------------------

async function main() {
  logHeader('SUPPLY CHAIN SECURITY MONITOR — HAPPY PATH TEST RUN');
  log(`Log file: ${LOG_PATH}`);
  log(`Started:  ${new Date().toISOString()}`);

  // A1 — OS detection
  const osInfo = await step('A1 OsDetection.detectOs()', () => {
    const info = detectOs();
    log(info);
    if (!info.id) throw new Error('detectOs() returned no id');
    return info;
  });

  // A2 — Package manager detection
  await step('A2 PackageManagerDetection.detectPackageManagers()', async () => {
    const result = await detectPackageManagers({ osId: osInfo?.id });
    log(result);
    if (!result.available.includes('npm')) {
      throw new Error('npm not detected — required for the rest of this test run');
    }
  });

  // D1 — Config
  await step('D1 Config (ensureConfigExists / loadConfig)', () => {
    const created = ensureConfigExists();
    log(`Config path: ${getConfigPath()} (created just now: ${created})`);
    const config = loadConfig();
    log(config);
    if (!config.ai || !config.paths || !config.collectors) {
      throw new Error('Loaded config is missing expected top-level sections');
    }
  });

  // E4 — CredentialStore round-trip, using an obviously fake test key
  await step('E4 CredentialStore (set/get/delete round-trip)', () => {
    const testProvider = 'test-provider';
    const testKey = 'fake-key-for-happy-path-test-only';

    setCredential(testProvider, testKey);
    const retrieved = getCredential(testProvider);
    log(`Stored and retrieved credential matches: ${retrieved === testKey}`);
    if (retrieved !== testKey) throw new Error('Retrieved credential did not match what was stored');

    const deleted = deleteCredential(testProvider);
    log(`Cleaned up test credential: ${deleted}`);
    if (!deleted) throw new Error('Failed to clean up the test credential');
  });

  // A3/A4/A5 — full monitored install (real npm install of a tiny, harmless package)
  const bundle = await step('A3+A4+A5 InstallMonitor.monitorInstall("npm", ["install", "left-pad"])', async () => {
    const result = await monitorInstall('npm', ['install', 'left-pad']);
    log(`before snapshot id: ${result.before?.id}`);
    log(`after snapshot id:  ${result.after?.id}`);
    log(`exit code:          ${result.execution?.exitCode}`);
    if (result.error) throw new Error(`monitorInstall reported an error: ${result.error}`);
    if (result.execution?.exitCode !== 0) throw new Error(`npm install exited with code ${result.execution?.exitCode}`);
    return result;
  });

  // A6 — env/PATH/shell diff
  const envPathShell = await step('A6 EnvPathShellDiff.diffEnvPathShell()', () => {
    const diff = diffEnvPathShell(bundle.before, bundle.after);
    log(`hasSuspiciousChanges: ${diff.hasSuspiciousChanges}`);
    return diff;
  });

  // A7 — network/process/temp diff
  const networkProcessTemp = await step('A7 NetworkProcessTempDiff.diffNetworkProcessTemp()', () => {
    const diff = diffNetworkProcessTemp(bundle.before, bundle.after);
    log(`hasSuspiciousChanges: ${diff.hasSuspiciousChanges}`);
    return diff;
  });

  // A8 — security flagging
  const security = await step('A8 SecurityFlagsDiff.flagSecurityChanges()', () => {
    const result = flagSecurityChanges(bundle.before, bundle.after);
    log(`findings: ${result.findings.length}, highestSeverity: ${result.highestSeverity}`);
    return result;
  });

  // A9 — structured diff engine (recomputes internally, but we already
  // exercised A6/A7/A8 individually above — this checks the combined path)
  const report = await step('A9 StructuredDiffEngine.computeStructuredDiff(bundle)', () => {
    const result = computeStructuredDiff(bundle);
    log(`overallRisk: ${result.overallRisk}`);
    log('summary:');
    for (const line of result.summary) log(`  - ${line}`);
    if (!result.meta.beforeId || !result.meta.afterId) {
      throw new Error('Structured diff report is missing before/after ids in meta');
    }
    return result;
  });

  // B1 — plain-text report
  const plainText = await step('B1 PlainTextReport.renderPlainTextReport(report)', () => {
    const text = renderPlainTextReport(report);
    log('--- rendered report ---');
    log(text);
    log('--- end rendered report ---');
    if (!text.includes('SUPPLY CHAIN SECURITY MONITOR')) {
      throw new Error('Rendered report is missing expected header');
    }
    return text;
  });

  // B3 — snapshot/report storage round-trip
  await step('B3 SnapshotStore (save + list + load round-trip)', () => {
    const { beforePath, afterPath } = saveSnapshotPair(bundle.before, bundle.after);
    log(`Saved before snapshot: ${beforePath}`);
    log(`Saved after snapshot:  ${afterPath}`);

    const { jsonPath, textPath, id } = saveReport(report, plainText);
    log(`Saved report (json): ${jsonPath}`);
    log(`Saved report (text): ${textPath}`);

    const snapshots = listSnapshots();
    const reports = listReports();
    log(`Total snapshots on disk: ${snapshots.length}`);
    log(`Total reports on disk:   ${reports.length}`);

    const reloadedBefore = loadSnapshot(bundle.before.id);
    const reloadedReport = loadReport(id);

    if (reloadedBefore.id !== bundle.before.id) {
      throw new Error('Reloaded snapshot id does not match the one that was saved');
    }
    if (reloadedReport.meta.afterId !== report.meta.afterId) {
      throw new Error('Reloaded report does not match the one that was saved');
    }
  });

  // ---------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------
  logHeader('SUMMARY');
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;

  for (const r of results) {
    log(`  [${r.status}] ${r.name}${r.error ? ` — ${r.error}` : ''}`);
  }
  log('');
  log(`Total: ${results.length}   Passed: ${passed}   Failed: ${failed}`);
  log(`Finished: ${new Date().toISOString()}`);
  log(`Full log saved to: ${LOG_PATH}`);

  logStream.end();
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  log(`\n[FATAL] Unexpected error outside step handling: ${err.message}`);
  log(err.stack);
  logStream.end();
  process.exitCode = 1;
});