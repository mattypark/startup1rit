// vision.js — Claude Vision frame analysis → Lumetri adjustment recommendations.
//
// Relative mode (per DESIGN.md): Claude is told the clip starts at Premiere's
// default Lumetri state (all zeros) and returns relative adjustments that move
// the frame toward the user's learned style.
//
// Cost guard: estimated spend tracked in usage.json; refuses new grades once
// the rolling 7-day estimate exceeds WEEKLY_COST_CEILING_USD (default $10).

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const WEEKLY_CEILING = Number(process.env.WEEKLY_COST_CEILING_USD) || 10;
// When packaged as a desktop app the project dir is read-only, so honor an
// ACA_DATA_DIR override for writable persistence; fall back to project root.
const DATA_DIR = process.env.ACA_DATA_DIR || path.join(__dirname, '..');
const USAGE_PATH = path.join(DATA_DIR, 'usage.json');

// Rough per-MTok pricing for cost estimation (Sonnet-class). Estimation only —
// the ceiling is a budget brake, not an invoice.
const PRICE_IN_PER_MTOK = 3;
const PRICE_OUT_PER_MTOK = 15;

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set. Copy .env.example to .env and add your key.');
  }
  if (!client) client = new Anthropic();
  return client;
}

// ---------- cost tracking ----------

function loadUsage() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'));
  } catch (e) {
    return { events: [] };
  }
}

function saveUsage(usage) {
  const tmp = USAGE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(usage, null, 2));
  fs.renameSync(tmp, USAGE_PATH);
}

function weeklySpendUsd() {
  const usage = loadUsage();
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  return usage.events
    .filter(e => new Date(e.at).getTime() > weekAgo)
    .reduce((sum, e) => sum + (e.cost_usd || 0), 0);
}

function recordUsage(inputTokens, outputTokens) {
  const cost =
    (inputTokens / 1e6) * PRICE_IN_PER_MTOK +
    (outputTokens / 1e6) * PRICE_OUT_PER_MTOK;
  const usage = loadUsage();
  usage.events.push({
    at: new Date().toISOString(),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: Number(cost.toFixed(5)),
  });
  // Keep 30 days of events.
  const monthAgo = Date.now() - 30 * 24 * 3600 * 1000;
  usage.events = usage.events.filter(e => new Date(e.at).getTime() > monthAgo);
  saveUsage(usage);
  return cost;
}

function checkBudget() {
  const spent = weeklySpendUsd();
  if (spent >= WEEKLY_CEILING) {
    const err = new Error(
      `Weekly API budget reached ($${spent.toFixed(2)} of $${WEEKLY_CEILING}). ` +
      'Grading paused until the rolling 7-day window clears. ' +
      'Raise WEEKLY_COST_CEILING_USD in .env to override.'
    );
    err.code = 'BUDGET_EXCEEDED';
    throw err;
  }
  return { spent, ceiling: WEEKLY_CEILING };
}

// ---------- prompting ----------

function buildPrompt(styleDescription) {
  return [
    'You are a professional colorist assistant analyzing video frame(s) from one clip.',
    '',
    "The user's preferred color grading style:",
    styleDescription || '(no style data yet — aim for a clean, natural correction)',
    '',
    "Starting from Premiere Pro's default Lumetri Color state (all sliders at 0,",
    'saturation at 100), what relative adjustments would move this footage toward',
    "the user's style? Account for the footage's existing exposure and color cast.",
    '',
    'Respond with ONLY a JSON object — no prose, no markdown fences. Keys:',
    'exposure (-5..5), contrast (-100..100), highlights (-100..100),',
    'shadows (-100..100), whites (-100..100), blacks (-100..100),',
    'temperature (-100..100, positive = warmer), tint (-100..100),',
    'saturation (-100..100, relative delta from default 100).',
    '',
    'Example: {"exposure": 0.3, "contrast": 38, "highlights": -10, "shadows": 15,',
    '"whites": 5, "blacks": -8, "temperature": 18, "tint": 2, "saturation": -8}',
  ].join('\n');
}

// Extract JSON from a model response defensively (handles stray fences/prose).
function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

// frames: [{ base64 }] — analyze together, one recommendation per call.
async function analyzeFrames(frames, styleDescription) {
  checkBudget();
  const anthropic = getClient();

  const content = frames.map(f => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: f.base64 },
  }));
  content.push({ type: 'text', text: buildPrompt(styleDescription) });

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: 'user', content }],
  });

  const inputTokens = response.usage ? response.usage.input_tokens : 0;
  const outputTokens = response.usage ? response.usage.output_tokens : 0;
  const cost = recordUsage(inputTokens, outputTokens);

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
  const parsed = extractJson(text);
  if (!parsed) {
    const err = new Error('Claude did not return parseable JSON adjustments. Raw: ' + text.slice(0, 200));
    err.code = 'BAD_AI_RESPONSE';
    throw err;
  }
  return { raw: parsed, cost_usd: cost, model: MODEL };
}

module.exports = { analyzeFrames, checkBudget, weeklySpendUsd, buildPrompt, extractJson, MODEL };
