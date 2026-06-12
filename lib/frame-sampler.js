// frame-sampler.js — pick + load representative frames for a clip.
//
// Sampling rule (per DESIGN.md): 3 frames at 10% / 50% / 90% of clip duration;
// 1 frame at 50% if the clip is under 2 seconds.
//
// The CEP panel does the actual PNG export via ExtendScript (Premiere owns the
// renderer). This module: (a) tells the panel WHICH timestamps to export,
// (b) loads exported PNGs from disk and base64-encodes them for Claude Vision.
// Local-only design — server and Premiere share a filesystem.

const fs = require('fs');
const path = require('path');
const os = require('os');

const FRAME_DIR = path.join(os.tmpdir(), 'adaptive-color-agent-frames');
const MAX_FRAME_BYTES = 5 * 1024 * 1024; // Claude image limit headroom

function sampleTimes(startSec, durationSec) {
  if (durationSec < 2) {
    return [startSec + durationSec * 0.5];
  }
  return [
    startSec + durationSec * 0.1,
    startSec + durationSec * 0.5,
    startSec + durationSec * 0.9,
  ];
}

function ensureFrameDir() {
  fs.mkdirSync(FRAME_DIR, { recursive: true });
  return FRAME_DIR;
}

// Only accept PNGs that live inside FRAME_DIR — the panel passes paths over
// HTTP, so treat them as untrusted (path traversal guard).
function isSafeFramePath(p) {
  if (typeof p !== 'string' || !p.toLowerCase().endsWith('.png')) return false;
  const resolved = path.resolve(p);
  return resolved.startsWith(FRAME_DIR + path.sep);
}

function loadFrames(framePaths) {
  const frames = [];
  const errors = [];
  for (const p of framePaths || []) {
    if (!isSafeFramePath(p)) {
      errors.push(`rejected path: ${p}`);
      continue;
    }
    try {
      const stat = fs.statSync(p);
      if (stat.size > MAX_FRAME_BYTES) {
        errors.push(`frame too large (${Math.round(stat.size / 1024)}KB): ${path.basename(p)}`);
        continue;
      }
      frames.push({
        path: p,
        base64: fs.readFileSync(p).toString('base64'),
      });
    } catch (e) {
      errors.push(`unreadable: ${path.basename(p)} (${e.message})`);
    }
  }
  return { frames, errors };
}

function cleanupFrames(framePaths) {
  for (const p of framePaths || []) {
    if (!isSafeFramePath(p)) continue;
    try { fs.unlinkSync(p); } catch (e) { /* best-effort */ }
  }
}

module.exports = { FRAME_DIR, sampleTimes, ensureFrameDir, loadFrames, cleanupFrames, isSafeFramePath };
