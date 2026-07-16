// core/OsDetection.js
//
// User Story A1 (2 pts · High)
// As a developer, I want the tool to automatically detect my host OS
// (Windows/macOS/Linux), so that it can adapt its monitoring approach
// without manual configuration.

'use strict';

const os = require('os');

/**
 * Supported OS identifiers used throughout the rest of the tool
 * (collectors, config defaults, package-manager detection, etc.)
 */
const SUPPORTED_OS = Object.freeze({
  WINDOWS: 'windows',
  MACOS: 'macos',
  LINUX: 'linux',
  UNKNOWN: 'unknown',
});

/**
 * Maps Node's os.platform() values to our normalized OS identifiers.
 * See: https://nodejs.org/api/os.html#osplatform
 */
const PLATFORM_MAP = Object.freeze({
  win32: SUPPORTED_OS.WINDOWS,
  darwin: SUPPORTED_OS.MACOS,
  linux: SUPPORTED_OS.LINUX,
});

/**
 * Detects the current host operating system.
 *
 * @returns {{
 *   id: string,            // normalized id: 'windows' | 'macos' | 'linux' | 'unknown'
 *   platform: string,      // raw Node os.platform() value, e.g. 'darwin'
 *   release: string,       // OS release/version string
 *   arch: string,          // CPU architecture, e.g. 'x64', 'arm64'
 *   hostname: string,      // machine hostname
 *   isSupported: boolean,  // whether this OS has full collector support
 * }}
 */
function detectOs() {
  const platform = os.platform();
  const id = PLATFORM_MAP[platform] || SUPPORTED_OS.UNKNOWN;

  return {
    id,
    platform,
    release: os.release(),
    arch: os.arch(),
    hostname: os.hostname(),
    isSupported: id !== SUPPORTED_OS.UNKNOWN,
  };
}

/** Convenience boolean helpers, handy in collectors/config code. */
function isWindows(info = detectOs()) {
  return info.id === SUPPORTED_OS.WINDOWS;
}

function isMacOs(info = detectOs()) {
  return info.id === SUPPORTED_OS.MACOS;
}

function isLinux(info = detectOs()) {
  return info.id === SUPPORTED_OS.LINUX;
}

module.exports = {
  SUPPORTED_OS,
  detectOs,
  isWindows,
  isMacOs,
  isLinux,
};

// Allow running this file directly for a quick manual check:
//   node core/OsDetection.js
if (require.main === module) {
  const info = detectOs();
  if (!info.isSupported) {
    console.warn(`Warning: unrecognized platform "${info.platform}". Some collectors may not work.`);
  }
  console.log(JSON.stringify(info, null, 2));
}