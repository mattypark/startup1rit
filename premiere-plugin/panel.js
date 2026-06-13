// Adaptive Color Agent panel logic.
// Bridges HTML UI <-> ExtendScript host (jsx/host.jsx) <-> backend API.
//
// Grading flow:
//   1. ACA_listClips()           — read clips from active sequence
//   2. POST /api/grade/plan      — backend picks sample times + frame paths
//   3. ACA_exportFrames(payload) — Premiere exports PNGs to temp dir
//   4. POST /api/grade           — Claude Vision -> Lumetri adjustments
//   5. ACA_applyGrade(...)       — set Lumetri params on each clip
//   6. User tweaks, then "Send feedback":
//      ACA_readLumetri(...) vs applied -> POST /api/feedback (learning signal)

(function () {
  var cs = new CSInterface();
  var F = '\u0001';
  var R = '\u0002';

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    body: document.body,
    backend: $('backend'),
    series: $('series'),
    log: $('log'),
    status: $('status'),
    profileName: $('profile-name'),
    profileMeta: $('profile-meta'),
    profileCard: $('profile-card'),
    progress: $('progress'),
    progressBar: $('progress-bar'),
    btnInit: $('btn-init'),
    btnCapture: $('btn-capture'),
    btnGrade: $('btn-grade'),
    btnFeedback: $('btn-feedback'),
    btnReconnect: $('btn-reconnect'),
  };

  var state = {
    projectName: '',
    profileReady: false,
    // last grade results: [{ name, track, clipIndex, adjustments }]
    lastGrade: [],
  };

  try {
    if (localStorage.aca_backend) els.backend.value = localStorage.aca_backend;
  } catch (e) {}

  function log(msg, cls) {
    var line = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    var div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = line;
    els.log.appendChild(div);
    els.log.scrollTop = els.log.scrollHeight;
  }
  function setStatus(msg) { els.status.textContent = msg; }
  function setBodyState(s) { els.body.setAttribute('data-state', s); }
  function setProgress(done, total) {
    if (total <= 0) { els.progress.style.display = 'none'; return; }
    els.progress.style.display = 'block';
    els.progressBar.style.width = Math.round((done / total) * 100) + '%';
  }

  function backendUrl() {
    var v = (els.backend.value || '').trim().replace(/\/+$/, '');
    try { localStorage.aca_backend = v; } catch (e) {}
    return v;
  }

  function evalAsync(script) {
    return new Promise(function (resolve) {
      cs.evalScript(script, function (result) { resolve(result); });
    });
  }

  // Call a host.jsx function with an optional payload string.
  function callHost(fnName, payload) {
    var script = payload == null
      ? fnName + '()'
      : fnName + '(' + JSON.stringify(payload) + ')';
    return evalAsync(script).then(function (raw) {
      if (raw == null || raw === '' || raw === 'EvalScript error.' || raw === 'undefined') {
        return { error: 'ExtendScript returned nothing (' + fnName + '). Restart Premiere.' };
      }
      var parts = String(raw).split(F);
      if (parts[0] === 'ERR') return { error: parts[1] || 'unknown ExtendScript error' };
      if (parts[0] !== 'OK') return { error: 'Unrecognized host response: ' + String(raw).slice(0, 120) };
      return { ok: true, parts: parts.slice(1), raw: String(raw) };
    });
  }

  async function api(path, opts) {
    opts = opts || {};
    var res = await fetch(backendUrl() + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    var json = await res.json().catch(function () { return { error: 'Non-JSON response' }; });
    if (!res.ok) {
      var err = new Error(json.error || ('HTTP ' + res.status));
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  // ---------- bootstrap ----------

  async function boot() {
    setStatus('Reading project from Premiere…');
    var info = await callHost('ACA_projectInfo');
    if (info.error) {
      setBodyState('no-project');
      els.profileName.textContent = 'No project open';
      els.profileMeta.textContent = info.error;
      setStatus('Open a Premiere project to continue.');
      return;
    }
    state.projectName = info.parts[0] || 'Untitled';
    log('Project: ' + state.projectName);
    await checkProfile();
  }

  async function checkProfile() {
    setStatus('Checking taste profile…');
    try {
      var resp = await api('/api/profile');
      state.profileReady = true;
      els.profileCard.classList.remove('missing');
      els.btnInit.style.display = 'none';
      els.profileName.textContent = resp.profile.name;
      var biases = Object.keys(resp.learned_biases || {}).length;
      els.profileMeta.textContent =
        resp.profile.feedback_history.length + ' feedback events · ' +
        biases + ' learned biases · $' + resp.weekly_spend_usd.toFixed(2) + ' this week';
      setBodyState('ready');
      setStatus('Ready. Pick a series and hit Grade.');
    } catch (e) {
      if (e.status === 404) {
        state.profileReady = false;
        els.profileCard.classList.add('missing');
        els.btnInit.style.display = '';
        els.profileName.textContent = state.projectName;
        els.profileMeta.textContent = 'No taste profile yet.';
        setBodyState('no-profile');
        setStatus('Create your taste profile to start.');
      } else {
        setStatus('Cannot reach backend. Is `npm start` running?');
        log('Backend error: ' + e.message, 'err');
      }
    }
  }

  // ---------- actions ----------

  async function doInit() {
    setStatus('Creating taste profile…');
    els.btnInit.disabled = true;
    try {
      var resp = await api('/api/profile/init', {
        method: 'POST',
        body: { name: state.projectName ? state.projectName + ' Look' : undefined },
      });
      log('Profile ' + (resp.existed ? 'loaded' : 'created') + ': ' + resp.profile.name, 'ok');
      await checkProfile();
    } catch (e) {
      log('Init failed: ' + e.message, 'err');
      setStatus('Init failed.');
    } finally {
      els.btnInit.disabled = false;
    }
  }

  function parseClipList(result) {
    // parts[0] = sequence name; raw records after first \u0002
    var recs = result.raw.split(R);
    var head = recs[0].split(F); // ["OK", seqName]
    var clips = [];
    for (var i = 1; i < recs.length; i++) {
      var f = recs[i].split(F);
      clips.push({
        name: f[0] || 'Clip',
        start_sec: parseFloat(f[1]) || 0,
        duration_sec: Math.max(0.001, parseFloat(f[2]) || 0.001),
        track: parseInt(f[3], 10) || 0,
        clipIndex: parseInt(f[4], 10) || 0,
      });
    }
    return { sequence: head[1] || 'sequence', clips: clips };
  }

  function parseKv(str) {
    var out = {};
    (str || '').split(',').forEach(function (pair) {
      var kv = pair.split('=');
      var v = parseFloat(kv[1]);
      if (kv[0] && isFinite(v)) out[kv[0]] = v;
    });
    return out;
  }

  function kvString(obj) {
    return Object.keys(obj).map(function (k) { return k + '=' + obj[k]; }).join(',');
  }

  // Capture the user's current grading stack: read Lumetri off every clip that has one.
  async function doCapture() {
    setStatus('Capturing your current grade…');
    var listed = await callHost('ACA_listClips');
    if (listed.error) { log('Capture failed: ' + listed.error, 'err'); setStatus('Capture failed.'); return; }
    var parsed = parseClipList(listed);
    if (!parsed.clips.length) { setStatus('No clips in sequence.'); return; }

    var layers = [];
    for (var i = 0; i < parsed.clips.length; i++) {
      var c = parsed.clips[i];
      var read = await callHost('ACA_readLumetri', c.track + F + c.clipIndex);
      if (read.error) continue; // clips without Lumetri are fine
      var params = parseKv(read.parts[0]);
      if (Object.keys(params).length) {
        layers.push({ name: c.name + ' (V' + (c.track + 1) + ')', type: 'correction', params: params });
      }
    }
    if (!layers.length) {
      setStatus('No Lumetri grades found on the timeline.');
      log('Nothing to capture — grade a clip first, then capture.', 'warn');
      return;
    }
    try {
      var resp = await api('/api/profile/capture', {
        method: 'POST',
        body: { series: els.series.value, layers: layers.slice(0, 10) },
      });
      log('Captured ' + layers.length + ' graded layer(s). Stacks stored: ' + resp.captured_stacks, 'ok');
      setStatus('Grade captured into your taste profile.');
      checkProfile();
    } catch (e) {
      log('Capture failed: ' + e.message, 'err');
      setStatus('Capture failed.');
    }
  }

  async function doGrade() {
    if (!state.profileReady) { setStatus('Create a profile first.'); return; }
    setStatus('Reading timeline…');
    els.btnGrade.disabled = true;
    try {
      var listed = await callHost('ACA_listClips');
      if (listed.error) throw new Error(listed.error);
      var parsed = parseClipList(listed);
      if (!parsed.clips.length) throw new Error('No clips in active sequence.');
      log('Found ' + parsed.clips.length + ' clips in "' + parsed.sequence + '"');

      // Step 1: plan frame exports
      var plan = await api('/api/grade/plan', {
        method: 'POST',
        body: {
          clips: parsed.clips.map(function (c) {
            return { name: c.name, track: c.track, start_sec: c.start_sec, duration_sec: c.duration_sec };
          }),
        },
      });

      // Step 2: export frames via ExtendScript
      setStatus('Exporting frames from Premiere…');
      var exportRecords = [];
      plan.plan.forEach(function (p) {
        p.sample_times.forEach(function (t, j) {
          exportRecords.push(t + F + p.frame_paths[j]);
        });
      });
      var exported = await callHost('ACA_exportFrames', exportRecords.join(R));
      if (exported.error) throw new Error('Frame export failed: ' + exported.error);
      var okCount = parseInt(exported.parts[0], 10) || 0;
      var failCount = parseInt(exported.parts[1], 10) || 0;
      log('Exported ' + okCount + ' frames' + (failCount ? ', ' + failCount + ' failed' : ''), failCount ? 'warn' : 'ok');
      if (exported.parts[2]) log('  ' + exported.parts[2], 'warn');
      if (!okCount) throw new Error('No frames exported — check the log.');

      // Step 3: grade
      setStatus('Analyzing with Claude… (this can take up to a minute)');
      setProgress(1, 3);
      var graded = await api('/api/grade', {
        method: 'POST',
        body: {
          series: els.series.value,
          clips: plan.plan.map(function (p) {
            return {
              name: p.name, track: p.track,
              start_sec: p.start_sec, duration_sec: p.duration_sec,
              frames: p.frame_paths,
            };
          }),
        },
      });
      setProgress(2, 3);

      // Step 4: apply per clip.
      // Match results to clips by track + start_sec (not array index) so a
      // truncated or reordered response can never grade the wrong clip.
      function findClip(r) {
        for (var k = 0; k < parsed.clips.length; k++) {
          var c = parsed.clips[k];
          if (c.track === r.track && Math.abs(c.start_sec - r.start_sec) < 0.001) return c;
        }
        return null;
      }
      state.lastGrade = [];
      var applied = 0, failed = 0;
      for (var i = 0; i < graded.results.length; i++) {
        var r = graded.results[i];
        var clip = findClip(r);
        if (!clip) {
          failed++;
          log('No timeline match for result "' + r.name + '" (track ' + r.track + ')', 'err');
          continue;
        }
        if (r.error || !r.adjustments || !Object.keys(r.adjustments).length) {
          failed++;
          log('Skip "' + r.name + '": ' + (r.error || 'no adjustments'), 'warn');
          continue;
        }
        var payload = clip.track + F + clip.clipIndex + F + kvString(r.adjustments);
        var ap = await callHost('ACA_applyGrade', payload);
        if (ap.error) {
          failed++;
          log('Apply failed "' + r.name + '": ' + ap.error, 'err');
          continue;
        }
        applied++;
        state.lastGrade.push({
          name: clip.name, track: clip.track, clipIndex: clip.clipIndex,
          adjustments: r.adjustments,
        });
        if (r.warnings && r.warnings.length) log('  "' + r.name + '" notes: ' + r.warnings.join('; '), 'warn');
        setProgress(2 + (i + 1) / graded.results.length, 3);
      }
      setProgress(0, 0);
      log('Graded ' + applied + ' clips' + (failed ? ', ' + failed + ' skipped' : '') +
          ' in ' + (graded.elapsed_ms / 1000).toFixed(1) + 's · $' +
          graded.weekly_spend_usd.toFixed(2) + '/$' + graded.weekly_ceiling_usd + ' this week', 'ok');
      setStatus(applied
        ? 'Done. Tweak anything you dislike, then hit Send feedback.'
        : 'Nothing graded — see log.');
    } catch (e) {
      setProgress(0, 0);
      log('Grade failed: ' + e.message, 'err');
      setStatus('Grade failed.');
    } finally {
      els.btnGrade.disabled = false;
    }
  }

  // Compare current Lumetri values to what the AI applied → learning signal.
  async function doFeedback() {
    if (!state.lastGrade.length) {
      setStatus('Grade something first — feedback compares your tweaks to the AI grade.');
      return;
    }
    setStatus('Reading your tweaks…');
    els.btnFeedback.disabled = true;
    try {
      var learnedAny = false;
      for (var i = 0; i < state.lastGrade.length; i++) {
        var g = state.lastGrade[i];
        var read = await callHost('ACA_readLumetri', g.track + F + g.clipIndex);
        if (read.error) { log('Read failed "' + g.name + '": ' + read.error, 'warn'); continue; }
        var current = parseKv(read.parts[0]);
        var resp = await api('/api/feedback', {
          method: 'POST',
          body: {
            series: els.series.value,
            clip_name: g.name,
            applied: g.adjustments,
            final: current,
          },
        });
        if (resp.learned) {
          learnedAny = true;
          log('Learned from "' + g.name + '": ' + JSON.stringify(resp.delta), 'ok');
        }
      }
      setStatus(learnedAny
        ? 'Feedback recorded. Next grade gets closer to your taste.'
        : 'No tweaks detected — the AI grade matched your taste.');
      state.lastGrade = [];
      checkProfile();
    } catch (e) {
      log('Feedback failed: ' + e.message, 'err');
      setStatus('Feedback failed.');
    } finally {
      els.btnFeedback.disabled = false;
    }
  }

  // ---------- wiring ----------

  els.btnInit.addEventListener('click', doInit);
  els.btnCapture.addEventListener('click', doCapture);
  els.btnGrade.addEventListener('click', doGrade);
  els.btnFeedback.addEventListener('click', doFeedback);
  els.btnReconnect.addEventListener('click', function () { boot(); });

  boot();
})();
