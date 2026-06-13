// Adaptive Color Agent — backend.
// Local-only Express server. The CEP panel inside Premiere Pro is the only
// intended client. Follows RIT hardening patterns: helmet, rate limits, zod
// strict schemas, atomic persistence.
//
// Endpoints (per DESIGN.md):
//   POST /api/profile/init     — create/load taste profile
//   GET  /api/profile          — read current profile + learned biases
//   POST /api/profile/capture  — store the user's current grading stack
//   POST /api/grade/plan       — frame timestamps the panel should export
//   POST /api/grade            — analyze frames → Lumetri adjustments per clip
//   POST /api/feedback         — record user tweaks as learning signal
//   GET  /api/history          — grading history + budget status

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const fs = require('fs');
const path = require('path');

const styleModel = require('./lib/style-model');
const vision = require('./lib/vision');
const mapper = require('./lib/adjustment-mapper');
const sampler = require('./lib/frame-sampler');

const PORT = Number(process.env.PORT) || 3001;
const DATA_DIR = process.env.ACA_DATA_DIR || __dirname;
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const MAX_CLIPS_PER_GRADE = 50;
const MAX_NAME_LEN = 200;
const MAX_DURATION_SEC = 60 * 60 * 24;

// ---------- app ----------

const app = express();
app.set('trust proxy', 'loopback');
app.use(helmet());
app.use(cors({ origin: true, methods: ['GET', 'POST'], credentials: false }));
app.use(express.json({ limit: 512 * 1024 }));

const limiterRead = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
const limiterGrade = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Grade rate limit — wait a minute.' } });
const limiterWrite = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });

// ---------- persistence: history ----------

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  } catch (e) {
    return { grades: [] };
  }
}

function saveHistory(history) {
  const tmp = HISTORY_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(history, null, 2));
  fs.renameSync(tmp, HISTORY_PATH);
}

// ---------- schemas ----------

const SERIES = z.enum(['weekly', 'reel', 'carousel', 'default']);

const ClipPlanSchema = z.object({
  name: z.string().min(1).max(MAX_NAME_LEN),
  track: z.number().int().min(0).max(99),
  start_sec: z.number().finite().min(0).max(MAX_DURATION_SEC),
  duration_sec: z.number().finite().min(0.001).max(MAX_DURATION_SEC),
}).strict();

const GradePlanSchema = z.object({
  clips: z.array(ClipPlanSchema).min(1).max(MAX_CLIPS_PER_GRADE),
}).strict();

const ClipFramesSchema = ClipPlanSchema.extend({
  frames: z.array(z.string().max(1024)).min(1).max(3),
}).strict();

const GradeSchema = z.object({
  series: SERIES.optional().default('default'),
  clips: z.array(ClipFramesSchema).min(1).max(MAX_CLIPS_PER_GRADE),
}).strict();

const AdjustmentValues = z.record(z.string(), z.number().finite());

const FeedbackSchema = z.object({
  series: SERIES.optional().default('default'),
  clip_name: z.string().min(1).max(MAX_NAME_LEN),
  applied: AdjustmentValues,   // what the AI set
  final: AdjustmentValues,     // what the user settled on
}).strict();

const LayerSchema = z.object({
  name: z.string().min(1).max(MAX_NAME_LEN),
  type: z.string().max(40).optional().default('correction'),
  params: AdjustmentValues.optional().default({}),
}).strict();

const CaptureSchema = z.object({
  series: SERIES.optional().default('default'),
  layers: z.array(LayerSchema).min(1).max(10),
}).strict();

const InitSchema = z.object({
  name: z.string().min(1).max(80).optional(),
}).strict();

function validate(schema, body, res) {
  const parsed = schema.safeParse(body || {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues.slice(0, 5) });
    return null;
  }
  return parsed.data;
}

function requireProfile(res) {
  const profile = styleModel.loadProfile();
  if (!profile) {
    res.status(404).json({ error: 'No profile yet. POST /api/profile/init first.' });
    return null;
  }
  return profile;
}

// ---------- routes ----------

app.get('/api/health', limiterRead, (req, res) => {
  res.json({ ok: true, service: 'adaptive-color-agent', model: vision.MODEL });
});

app.post('/api/profile/init', limiterWrite, (req, res) => {
  const data = validate(InitSchema, req.body, res);
  if (!data) return;
  const { profile, existed } = styleModel.initProfile(data.name);
  res.json({ ok: true, existed, profile });
});

app.get('/api/profile', limiterRead, (req, res) => {
  const profile = requireProfile(res);
  if (!profile) return;
  res.json({
    ok: true,
    profile,
    learned_biases: styleModel.computeBiases(profile),
    weekly_spend_usd: Number(vision.weeklySpendUsd().toFixed(4)),
  });
});

app.post('/api/profile/capture', limiterWrite, (req, res) => {
  const data = validate(CaptureSchema, req.body, res);
  if (!data) return;
  const profile = requireProfile(res);
  if (!profile) return;
  styleModel.captureStack(profile, data);
  res.json({ ok: true, captured_stacks: profile.captured_stacks.length });
});

// Step 1 of grading: panel asks where to export frames.
app.post('/api/grade/plan', limiterRead, (req, res) => {
  const data = validate(GradePlanSchema, req.body, res);
  if (!data) return;
  const dir = sampler.ensureFrameDir();
  const plan = data.clips.map((clip, i) => ({
    name: clip.name,
    track: clip.track,
    start_sec: clip.start_sec,
    duration_sec: clip.duration_sec,
    sample_times: sampler.sampleTimes(clip.start_sec, clip.duration_sec),
    frame_paths: sampler
      .sampleTimes(clip.start_sec, clip.duration_sec)
      .map((t, j) => path.join(dir, `clip${i}-f${j}-${Date.now()}.png`)),
  }));
  res.json({ ok: true, frame_dir: dir, plan });
});

// Step 2: panel exported frames; analyze and return adjustments per clip.
app.post('/api/grade', limiterGrade, async (req, res) => {
  const data = validate(GradeSchema, req.body, res);
  if (!data) return;
  const profile = requireProfile(res);
  if (!profile) return;

  let budget;
  try {
    budget = vision.checkBudget();
  } catch (e) {
    return res.status(402).json({ error: e.message, code: e.code });
  }

  const styleDescription = styleModel.describeStyle(profile, data.series);
  const results = [];
  const startedAt = Date.now();

  for (const clip of data.clips) {
    const { frames, errors } = sampler.loadFrames(clip.frames);
    if (!frames.length) {
      results.push({ name: clip.name, track: clip.track, start_sec: clip.start_sec, error: 'no readable frames', frame_errors: errors });
      continue;
    }
    try {
      const analysis = await vision.analyzeFrames(frames, styleDescription);
      const { adjustments, warnings } = mapper.mapAdjustments(analysis.raw);
      results.push({
        name: clip.name,
        track: clip.track,
        start_sec: clip.start_sec,
        adjustments,
        warnings: warnings.concat(errors),
        cost_usd: Number(analysis.cost_usd.toFixed(5)),
      });
    } catch (e) {
      results.push({ name: clip.name, track: clip.track, start_sec: clip.start_sec, error: e.message, code: e.code });
      if (e.code === 'BUDGET_EXCEEDED') break; // stop burning the queue
    } finally {
      sampler.cleanupFrames(clip.frames);
    }
  }

  const history = loadHistory();
  history.grades.push({
    at: new Date().toISOString(),
    series: data.series,
    clip_count: data.clips.length,
    graded: results.filter(r => r.adjustments).length,
    failed: results.filter(r => r.error).length,
    elapsed_ms: Date.now() - startedAt,
  });
  if (history.grades.length > 200) history.grades = history.grades.slice(-200);
  saveHistory(history);

  res.json({
    ok: true,
    series: data.series,
    results,
    elapsed_ms: Date.now() - startedAt,
    weekly_spend_usd: Number(vision.weeklySpendUsd().toFixed(4)),
    weekly_ceiling_usd: budget.ceiling,
  });
});

app.post('/api/feedback', limiterWrite, (req, res) => {
  const data = validate(FeedbackSchema, req.body, res);
  if (!data) return;
  const profile = requireProfile(res);
  if (!profile) return;

  // Delta = what the user changed AFTER the AI grade. That's the signal.
  const delta = {};
  for (const param of styleModel.LUMETRI_PARAMS) {
    const a = Number(data.applied[param]);
    const f = Number(data.final[param]);
    if (Number.isFinite(a) && Number.isFinite(f) && a !== f) {
      delta[param] = Number((f - a).toFixed(2));
    }
  }
  if (!Object.keys(delta).length) {
    return res.json({ ok: true, learned: false, note: 'No changes detected — AI grade accepted as-is. Good signal too.' });
  }
  styleModel.recordFeedback(profile, { series: data.series, clip_name: data.clip_name, delta });
  res.json({
    ok: true,
    learned: true,
    delta,
    feedback_count: profile.feedback_history.length,
    learned_biases: styleModel.computeBiases(profile, data.series),
  });
});

app.get('/api/history', limiterRead, (req, res) => {
  const history = loadHistory();
  res.json({
    ok: true,
    grades: history.grades.slice(-50),
    weekly_spend_usd: Number(vision.weeklySpendUsd().toFixed(4)),
  });
});

// ---------- start ----------

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Adaptive Color Agent backend on http://127.0.0.1:${PORT}`);
  console.log(`Model: ${vision.MODEL}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('WARNING: ANTHROPIC_API_KEY not set — /api/grade will fail. Copy .env.example to .env.');
  }
});
