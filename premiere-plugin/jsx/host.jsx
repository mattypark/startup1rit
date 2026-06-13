// host.jsx — ExtendScript (ES3) bridge for the Adaptive Color Agent panel.
//
// Wire format (RIT pattern — no JSON in ExtendScript):
//   fields separated by \u0001, records separated by \u0002.
//   Success: "OK\u0001..." — Failure: "ERR\u0001<reason>"
//
// Lumetri Basic Correction parameter display names, in panel order:
//   Exposure, Contrast, Highlights, Shadows, Whites, Blacks,
//   Temperature, Tint, Saturation
//
// NOTE (DESIGN.md spike #1): Lumetri property scaling may differ per Premiere
// version. ACA_readLumetri lets the panel verify a setValue round-trips.

var ACA_F = '\u0001';
var ACA_R = '\u0002';
var ACA_TPS = 254016000000; // ticks per second

var ACA_PARAM_NAMES = [
  'Exposure', 'Contrast', 'Highlights', 'Shadows',
  'Whites', 'Blacks', 'Temperature', 'Tint', 'Saturation'
];
// lowercase keys matching the backend
var ACA_PARAM_KEYS = [
  'exposure', 'contrast', 'highlights', 'shadows',
  'whites', 'blacks', 'temperature', 'tint', 'saturation'
];

function ACA_err(msg) {
  return 'ERR' + ACA_F + msg;
}

function ACA_clean(s) {
  return String(s || '').replace(/[\u0001\u0002]/g, '_');
}

function ACA_projectInfo() {
  try {
    if (typeof app === 'undefined') return ACA_err('app undefined');
    var p = app.project;
    if (!p) return ACA_err('no project');
    var n = 'Untitled';
    try { n = String(p.name || 'Untitled'); } catch (e1) {}
    var pa = '';
    try { pa = String(p.path || ''); } catch (e2) {}
    return 'OK' + ACA_F + ACA_clean(n) + ACA_F + ACA_clean(pa);
  } catch (e) {
    return ACA_err(e && e.toString ? e.toString() : 'unknown');
  }
}

// List video clips on the active sequence.
// OK\u0001<seqName>\u0002<name>\u0001<start>\u0001<dur>\u0001<track>\u0001<clipIndex>\u0002...
function ACA_listClips() {
  try {
    if (typeof app === 'undefined') return ACA_err('app undefined');
    var p = app.project;
    if (!p) return ACA_err('no project');
    var s = p.activeSequence;
    if (!s) return ACA_err('No active sequence (open one in Premiere)');
    var sn = 'sequence';
    try { sn = String(s.name || 'sequence'); } catch (eN) {}
    var out = 'OK' + ACA_F + ACA_clean(sn);
    var vt = s.videoTracks;
    for (var t = 0; t < vt.numTracks; t++) {
      var tr = vt[t];
      for (var c = 0; c < tr.clips.numItems; c++) {
        var cl = tr.clips[c];
        var st = Number(cl.start.ticks) / ACA_TPS;
        var en = Number(cl.end.ticks) / ACA_TPS;
        var nm = 'Clip ' + (c + 1);
        try { if (cl.projectItem && cl.projectItem.name) nm = String(cl.projectItem.name); } catch (eC) {}
        out += ACA_R + ACA_clean(nm) + ACA_F + st + ACA_F + (en - st) + ACA_F + t + ACA_F + c;
      }
    }
    return out;
  } catch (e) {
    return ACA_err(e && e.toString ? e.toString() : 'unknown');
  }
}

// Convert seconds to a frame-accurate timecode string for the QE DOM.
function ACA_secondsToTimecode(sec, fps) {
  var totalFrames = Math.round(sec * fps);
  var f = totalFrames % Math.round(fps);
  var totalSec = Math.floor(totalFrames / fps);
  var ss = totalSec % 60;
  var mm = Math.floor(totalSec / 60) % 60;
  var hh = Math.floor(totalSec / 3600);
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  return pad(hh) + ':' + pad(mm) + ':' + pad(ss) + ':' + pad(f);
}

// Export frames as PNGs via the QE DOM (DESIGN.md spike #2).
// payload: "<seconds>\u0001<outPath>" records joined by \u0002
// Returns OK\u0001<exported>\u0001<failed>[\u0001<errs>]
function ACA_exportFrames(payload) {
  try {
    if (typeof app === 'undefined') return ACA_err('app undefined');
    var s = app.project ? app.project.activeSequence : null;
    if (!s) return ACA_err('No active sequence');
    try { app.enableQE(); } catch (eQ) { return ACA_err('QE DOM unavailable: ' + eQ.toString()); }
    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq) return ACA_err('QE: no active sequence');

    // Sequence fps from settings (e.g. "29.97 fps") with a safe fallback.
    var fps = 30;
    try {
      var ts = String(s.getSettings().videoFrameRate.seconds);
      var parsed = parseFloat(ts);
      if (parsed > 0) fps = 1 / parsed;
    } catch (eF) {
      try {
        var tb = Number(s.timebase); // ticks per frame
        if (tb > 0) fps = ACA_TPS / tb;
      } catch (eF2) {}
    }

    var recs = payload.length ? payload.split(ACA_R) : [];
    var ok = 0, fail = 0;
    var errs = [];
    for (var i = 0; i < recs.length; i++) {
      if (!recs[i]) continue;
      var ff = recs[i].split(ACA_F);
      var sec = parseFloat(ff[0]) || 0;
      var outPath = ff[1];
      try {
        var tc = ACA_secondsToTimecode(sec, fps);
        var done = qeSeq.exportFramePNG(tc, outPath);
        if (done === false) { fail++; errs.push('export returned false @' + tc); }
        else ok++;
      } catch (eX) {
        fail++;
        errs.push('@' + sec + 's: ' + (eX && eX.toString ? eX.toString() : 'unknown'));
      }
    }
    return 'OK' + ACA_F + ok + ACA_F + fail + (errs.length ? ACA_F + ACA_clean(errs.join('; ')) : '');
  } catch (e) {
    return ACA_err(e && e.toString ? e.toString() : 'unknown');
  }
}

function ACA_findClip(track, clipIndex) {
  var s = app.project.activeSequence;
  if (!s) return null;
  if (track >= s.videoTracks.numTracks) return null;
  var tr = s.videoTracks[track];
  if (clipIndex >= tr.clips.numItems) return null;
  return tr.clips[clipIndex];
}

function ACA_findLumetri(clip) {
  try {
    var comps = clip.components;
    for (var i = 0; i < comps.numItems; i++) {
      var nm = String(comps[i].displayName || '');
      if (nm === 'Lumetri Color' || nm.indexOf('Lumetri') === 0) return comps[i];
    }
  } catch (e) {}
  return null;
}

// Add Lumetri Color to a clip via the QE DOM if missing.
function ACA_addLumetri(track, clipIndex) {
  try {
    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    var qeTrack = qeSeq.getVideoTrackAt(track);
    // QE itemAt indexes include empty gaps — walk items counting real clips.
    var seen = -1;
    for (var i = 0; i < qeTrack.numItems; i++) {
      var it = qeTrack.getItemAt(i);
      var ty = '';
      try { ty = String(it.type); } catch (eT) {}
      if (ty === 'Empty') continue;
      seen++;
      if (seen === clipIndex) {
        var fx = qe.project.getVideoEffectByName('Lumetri Color');
        if (!fx) return false;
        it.addVideoEffect(fx);
        return true;
      }
    }
  } catch (e) {}
  return false;
}

// Apply Lumetri adjustments to one clip.
// payload: "<track>\u0001<clipIndex>\u0001<k=v,k=v,...>" (keys lowercase)
// Returns OK\u0001<setCount>\u0001<skipped>[\u0001<errs>]
function ACA_applyGrade(payload) {
  try {
    if (typeof app === 'undefined') return ACA_err('app undefined');
    if (!app.project || !app.project.activeSequence) return ACA_err('No active sequence');
    var ff = payload.split(ACA_F);
    var track = parseInt(ff[0], 10) || 0;
    var clipIndex = parseInt(ff[1], 10) || 0;
    var kvs = (ff[2] || '').split(',');

    var clip = ACA_findClip(track, clipIndex);
    if (!clip) return ACA_err('clip not found at track ' + track + ' index ' + clipIndex);

    var lumetri = ACA_findLumetri(clip);
    if (!lumetri) {
      ACA_addLumetri(track, clipIndex);
      lumetri = ACA_findLumetri(clip);
    }
    if (!lumetri) return ACA_err('Lumetri Color not found and could not be added');

    // Map displayName -> property
    var propByName = {};
    for (var i = 0; i < lumetri.properties.numItems; i++) {
      var pr = lumetri.properties[i];
      try { propByName[String(pr.displayName)] = pr; } catch (eP) {}
    }

    var setCount = 0, skipped = 0;
    var errs = [];
    for (var k = 0; k < kvs.length; k++) {
      if (!kvs[k]) continue;
      var pair = kvs[k].split('=');
      var key = pair[0];
      var val = parseFloat(pair[1]);
      if (!isFinite(val)) { skipped++; continue; }
      var idx = -1;
      for (var j = 0; j < ACA_PARAM_KEYS.length; j++) {
        if (ACA_PARAM_KEYS[j] === key) { idx = j; break; }
      }
      if (idx === -1) { skipped++; errs.push('unknown param ' + key); continue; }
      var prop = propByName[ACA_PARAM_NAMES[idx]];
      if (!prop) { skipped++; errs.push('no Lumetri prop ' + ACA_PARAM_NAMES[idx]); continue; }
      try {
        // Saturation default is 100; backend sends relative delta.
        var target = (key === 'saturation') ? 100 + val : val;
        prop.setValue(target, true);
        setCount++;
      } catch (eS) {
        skipped++;
        errs.push(key + ': ' + (eS && eS.toString ? eS.toString() : 'set failed'));
      }
    }
    return 'OK' + ACA_F + setCount + ACA_F + skipped + (errs.length ? ACA_F + ACA_clean(errs.join('; ')) : '');
  } catch (e) {
    return ACA_err(e && e.toString ? e.toString() : 'unknown');
  }
}

// Read Lumetri params from one clip.
// payload: "<track>\u0001<clipIndex>"
// Returns OK\u0001k=v,k=v,... (lowercase keys, saturation as relative delta)
function ACA_readLumetri(payload) {
  try {
    if (typeof app === 'undefined') return ACA_err('app undefined');
    if (!app.project || !app.project.activeSequence) return ACA_err('No active sequence');
    var ff = payload.split(ACA_F);
    var track = parseInt(ff[0], 10) || 0;
    var clipIndex = parseInt(ff[1], 10) || 0;

    var clip = ACA_findClip(track, clipIndex);
    if (!clip) return ACA_err('clip not found at track ' + track + ' index ' + clipIndex);
    var lumetri = ACA_findLumetri(clip);
    if (!lumetri) return ACA_err('no Lumetri Color on this clip');

    var propByName = {};
    for (var i = 0; i < lumetri.properties.numItems; i++) {
      var pr = lumetri.properties[i];
      try { propByName[String(pr.displayName)] = pr; } catch (eP) {}
    }
    var parts = [];
    for (var j = 0; j < ACA_PARAM_NAMES.length; j++) {
      var prop = propByName[ACA_PARAM_NAMES[j]];
      if (!prop) continue;
      try {
        var v = Number(prop.getValue());
        if (!isFinite(v)) continue;
        if (ACA_PARAM_KEYS[j] === 'saturation') v = v - 100;
        parts.push(ACA_PARAM_KEYS[j] + '=' + v);
      } catch (eG) {}
    }
    if (!parts.length) return ACA_err('could not read any Lumetri values');
    return 'OK' + ACA_F + parts.join(',');
  } catch (e) {
    return ACA_err(e && e.toString ? e.toString() : 'unknown');
  }
}
