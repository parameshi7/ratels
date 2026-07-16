// core/InstallMonitor.js
//
// User Story A4 (5 pts · High)
// As a developer, I want the tool to wrap or monitor my package
// installation command while it runs, so that nothing happens
// outside its visibility.
//
// This is the orchestrator that ties A3 (before snapshot) and A5
// (after snapshot) around the actual install command: capture
// baseline -> run the command live (streaming its output) -> capture
// the after snapshot, regardless of whether the command succeeded or
// failed. The resulting bundle is what A9's diff engine will consume.

'use strict';

const { spawn } = require('child_process');
const { captureBeforeSnapshot } = require('./BeforeSnapshot');
const { captureAfterSnapshot } = require('./AfterSnapshot');

/**
 * Runs a command, streaming its stdout/stderr live to the parent
 * process (so the developer sees normal install output as it
 * happens), while also buffering it for the report. Never rejects on
 * a non-zero exit code — that's just part of the result.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<{exitCode: number|null, signal: string|null, stdout: string, stderr: string, startedAt: string, finishedAt: string, durationMs: number}>}
 */
function runMonitoredCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const startedAt = new Date();
    let stdout = '';
    let stderr = '';

    let child;
    try {
      child = spawn(command, args, { shell: false, windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }

    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      stderr += chunk.toString();
    });

    child.on('error', reject);

    child.on('close', (exitCode, signal) => {
      const finishedAt = new Date();
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt - startedAt,
      });
    });
  });
}

/**
 * Wraps a full monitored install: before snapshot -> run command ->
 * after snapshot. If the command throws (e.g. binary not found), the
 * "after" snapshot is still captured so partial side effects aren't
 * missed, and the error is attached to the result rather than thrown,
 * so callers always get a complete before/after pair to work with.
 *
 * @param {string} command - e.g. 'npm'
 * @param {string[]} args - e.g. ['install', 'left-pad']
 * @returns {Promise<{
 *   command: string,
 *   args: string[],
 *   before: object,   // from captureBeforeSnapshot()
 *   after: object,    // from captureAfterSnapshot(), linked via beforeId
 *   execution: object|null, // from runMonitoredCommand(), null if it threw
 *   error: string|null,
 * }>}
 */
async function monitorInstall(command, args = []) {
  const before = await captureBeforeSnapshot();

  let execution = null;
  let error = null;

  try {
    execution = await runMonitoredCommand(command, args);
  } catch (err) {
    error = err.message;
  }

  const after = await captureAfterSnapshot({ beforeId: before.id });

  return { command, args, before, after, execution, error };
}

module.exports = {
  runMonitoredCommand,
  monitorInstall,
};

// Allow running this file directly, e.g.:
//   node core/InstallMonitor.js npm install left-pad
if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);

  if (!command) {
    console.error('Usage: node core/InstallMonitor.js <command> [args...]');
    console.error('Example: node core/InstallMonitor.js npm install left-pad');
    process.exit(1);
  }

  monitorInstall(command, args).then((result) => {
    if (result.error) {
      console.error(`\nCommand failed to launch: ${result.error}`);
    } else {
      console.error(`\nCommand exited with code ${result.execution.exitCode} in ${result.execution.durationMs}ms`);
    }
    console.error(`Before snapshot: ${result.before.id}`);
    console.error(`After snapshot:  ${result.after.id} (linked to ${result.after.beforeId})`);
    // Full bundle available on stdout for piping into the diff engine (A9):
    console.log(JSON.stringify(result, null, 2));
  });
}