// style-model.js — taste profile persistence + learning.
//
// Learning mechanism (per DESIGN.md):
//   - Store last 50 feedback deltas (user's manual tweak after AI grade).
//   - Per-parameter bias = weighted running average; most recent 25 weigh 2x.
//   - Biases are injected into the Claude Vision prompt (prompt-engineering
//     learning, no ML training).

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.ACA_DATA_DIR || path.join(__dirname, '..');
const PROFILE_PATH = path.join(DATA_DIR, 'profile.json');
const MAX_FEEDBACK = 50;

const LUMETRI_PARAMS = [
  'exposure', 'contrast', 'highlights', 'shadows',
  'whites', 'blacks', 'temperature', 'tint', 'saturation',
];

function defaultProfile(name) {
  return {
    version: 1,
    name: name || 'My Look',
    created_at: new Date().toISOString(),
    base_style: {
      exposure_tendency: 0,
      contrast_preference: 'medium',
      saturation_range: [0.85, 1.15],
      color_temperature_bias: 'neutral',
      shadow_lift: false,
      highlight_rolloff: 'soft',
    },
    layer_stack: [
      { name: 'Exposure + Base', type: 'correction', params: {} },
      { name: 'Color Grade', type: 'creative', params: {} },
      { name: 'Touch-up', type: 'finishing', params: {} },
    ],
    series_profiles: {
      weekly: { mood: 'cinematic', overrides: {} },
      reel: { mood: 'punchy', overrides: {} },
      carousel: { mood: 'clean', overrides: {} },
    },
    captured_stacks: [],
    references: [],
    feedback_history: [],
  };
}

function loadProfile() {
  try {
    const raw = fs.readFileSync(PROFILE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// Atomic write-then-rename (RIT pattern) so a crash never corrupts the profile.
function saveProfile(profile) {
  const tmp = PROFILE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(profile, null, 2));
  fs.renameSync(tmp, PROFILE_PATH);
}

function initProfile(name) {
  const existing = loadProfile();
  if (existing) return { profile: existing, existed: true };
  const profile = defaultProfile(name);
  saveProfile(profile);
  return { profile, existed: false };
}

// Record one feedback event: the delta between what AI applied and what the
// user settled on. delta[param] = final - applied.
function recordFeedback(profile, entry) {
  profile.feedback_history.push({
    at: new Date().toISOString(),
    series: entry.series || 'default',
    clip_name: entry.clip_name || '',
    delta: entry.delta,
  });
  if (profile.feedback_history.length > MAX_FEEDBACK) {
    profile.feedback_history = profile.feedback_history.slice(-MAX_FEEDBACK);
  }
  saveProfile(profile);
  return profile;
}

// Compute per-parameter biases from feedback history.
// Most recent half of the window weighs 2x.
function computeBiases(profile, series) {
  // Intentional: feedback tagged 'default' (or untagged legacy entries) is a
  // global taste signal and applies to every series. Series-specific feedback
  // only applies to its own series.
  const history = (profile.feedback_history || []).filter(
    f => !series || !f.series || f.series === series || f.series === 'default'
  );
  const biases = {};
  if (!history.length) return biases;

  const half = Math.ceil(history.length / 2);
  for (const param of LUMETRI_PARAMS) {
    let weightedSum = 0;
    let weightTotal = 0;
    history.forEach((f, i) => {
      const v = f.delta ? Number(f.delta[param]) : NaN;
      if (!Number.isFinite(v)) return;
      const w = i >= history.length - half ? 2 : 1; // recent half 2x
      weightedSum += v * w;
      weightTotal += w;
    });
    if (weightTotal > 0) {
      const bias = weightedSum / weightTotal;
      // Ignore noise below a meaningful threshold.
      if (Math.abs(bias) >= 0.5 || (param === 'exposure' && Math.abs(bias) >= 0.05)) {
        biases[param] = Number(bias.toFixed(2));
      }
    }
  }
  return biases;
}

// Store a captured grading stack (read from the user's timeline) as a style
// reference. Keeps the latest 10.
function captureStack(profile, stack) {
  profile.captured_stacks = profile.captured_stacks || [];
  profile.captured_stacks.push({
    at: new Date().toISOString(),
    series: stack.series || 'default',
    layers: stack.layers || [],
  });
  if (profile.captured_stacks.length > 10) {
    profile.captured_stacks = profile.captured_stacks.slice(-10);
  }
  saveProfile(profile);
  return profile;
}

// Human-readable style summary injected into the vision prompt.
function describeStyle(profile, series) {
  const b = profile.base_style || {};
  const lines = [];
  lines.push(`Contrast preference: ${b.contrast_preference || 'medium'}`);
  lines.push(`Color temperature bias: ${b.color_temperature_bias || 'neutral'}`);
  if (b.shadow_lift) lines.push('Prefers lifted shadows');
  lines.push(`Highlight rolloff: ${b.highlight_rolloff || 'soft'}`);

  const sp = (profile.series_profiles || {})[series];
  if (sp && sp.mood) lines.push(`This clip belongs to the "${series}" series — mood: ${sp.mood}`);

  const stacks = profile.captured_stacks || [];
  if (stacks.length) {
    const latest = stacks[stacks.length - 1];
    const summarized = (latest.layers || [])
      .map(l => {
        const params = Object.entries(l.params || {})
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        return `${l.name}: ${params || 'defaults'}`;
      })
      .join(' | ');
    if (summarized) lines.push(`User's typical grading stack: ${summarized}`);
  }

  const biases = computeBiases(profile, series);
  const biasLines = Object.entries(biases).map(
    ([k, v]) => `${k}: user consistently adjusts AI output by ${v > 0 ? '+' : ''}${v}`
  );
  if (biasLines.length) {
    lines.push('Learned corrections from past feedback:');
    lines.push(...biasLines.map(l => '  - ' + l));
  }
  return lines.join('\n');
}

module.exports = {
  LUMETRI_PARAMS,
  PROFILE_PATH,
  defaultProfile,
  loadProfile,
  saveProfile,
  initProfile,
  recordFeedback,
  computeBiases,
  captureStack,
  describeStyle,
};
