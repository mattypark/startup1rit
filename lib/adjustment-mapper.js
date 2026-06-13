// adjustment-mapper.js — clamp + validate AI recommendations into safe
// Lumetri Basic Correction parameter ranges (relative mode, per DESIGN.md).
//
// Ranges mirror Premiere's Lumetri sliders. AI returns RELATIVE adjustments
// from the default state (all zeros, saturation 100), so the relative value
// IS the absolute slider value for an ungraded clip.

const RANGES = {
  exposure:    { min: -5,    max: 5 },
  contrast:    { min: -100,  max: 100 },
  highlights:  { min: -100,  max: 100 },
  shadows:     { min: -100,  max: 100 },
  whites:      { min: -100,  max: 100 },
  blacks:      { min: -100,  max: 100 },
  temperature: { min: -100,  max: 100 },
  tint:        { min: -100,  max: 100 },
  saturation:  { min: -100,  max: 100 }, // relative delta from default 100
};

// Defensive caps tighter than slider extremes: a "grade" should never slam a
// slider to the rail. Keeps one bad AI response from nuking a clip.
const SANITY = {
  exposure:    { min: -2,   max: 2 },
  contrast:    { min: -60,  max: 60 },
  highlights:  { min: -60,  max: 60 },
  shadows:     { min: -60,  max: 60 },
  whites:      { min: -40,  max: 40 },
  blacks:      { min: -40,  max: 40 },
  temperature: { min: -50,  max: 50 },
  tint:        { min: -30,  max: 30 },
  saturation:  { min: -40,  max: 40 },
};

// Parse a value that may arrive as "+0.3", "-10", 12, etc.
function parseAdjustment(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/^\+/, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// raw: object from Claude (possibly messy). Returns { adjustments, warnings }.
function mapAdjustments(raw) {
  const adjustments = {};
  const warnings = [];
  if (!raw || typeof raw !== 'object') {
    return { adjustments, warnings: ['AI returned no usable adjustment object'] };
  }
  for (const [param, range] of Object.entries(RANGES)) {
    if (!(param in raw)) continue;
    const parsed = parseAdjustment(raw[param]);
    if (parsed === null) {
      warnings.push(`unparseable value for ${param}: ${JSON.stringify(raw[param])}`);
      continue;
    }
    // Clamp straight to the sanity caps (always inside slider RANGES) — a
    // "grade" should never slam a slider to the rail.
    const cap = SANITY[param];
    if (parsed < cap.min || parsed > cap.max) {
      warnings.push(`${param} ${parsed} outside sanity cap [${cap.min}, ${cap.max}], clamped`);
    }
    adjustments[param] = Number(clamp(parsed, cap.min, cap.max).toFixed(2));
  }
  const unknownKeys = Object.keys(raw).filter(k => !(k in RANGES));
  if (unknownKeys.length) warnings.push(`ignored unknown params: ${unknownKeys.join(', ')}`);
  return { adjustments, warnings };
}

module.exports = { RANGES, SANITY, parseAdjustment, mapAdjustments };
