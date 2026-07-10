(() => {
  "use strict";

  const canvas = document.querySelector("#cloud");
  const ctx = canvas.getContext("2d", { alpha: false });
  const fileInput = document.querySelector("#audio-file");
  const upload = document.querySelector("#upload");
  const recordButton = document.querySelector("#record");
  const saveLink = document.querySelector("#save");
  const stateNode = document.querySelector("#audio-state");
  const effectButtons = [...document.querySelectorAll("[data-effect]")];
  const touchSize = document.querySelector("#touch-size");
  const touchSizeValue = document.querySelector("#touch-size-value");
  const chopCountInput = document.querySelector("#chop-count");
  const chopCountValue = document.querySelector("#chop-count-value");

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const mobile = matchMedia("(max-width: 700px), (pointer: coarse)").matches;
  const maxParticleCount = mobile ? 3600 : 8000;
  const minParticleCount = maxParticleCount;
  const grainStartIntervalMs = 50;
  let sliceCount = 512;
  const particles = [];
  const pointer = {
    x: -9999,
    y: -9999,
    active: false,
    soundActive: false,
    down: false,
    touching: false,
    lastMoved: 0,
    radius: mobile ? 24 : 18
  };
  const baseParams = { stretch: 0, ambient: 0, pitch: 0, spray: 0 };
  const params = { stretch: 0.45, ambient: 0.5, pitch: 1, spray: 0.12 };
  const paramEnabled = { stretch: false, ambient: false, pitch: false, spray: false };
  const controlRanges = {
    stretch: [0, 1],
    ambient: [0, 1],
    pitch: [0.55, 1.85],
    spray: [0, 0.48]
  };

  let audioContext = null;
  let master = null;
  let compressor = null;
  let ambientInput = null;
  let ambientDelay = null;
  let ambientFeedback = null;
  let ambientFilter = null;
  let ambientWet = null;
  let recordDestination = null;
  let decoded = null;
  let slices = [];
  let activeVoices = 0;
  let lastGrainStartedAt = -Infinity;
  let recorder = null;
  let recordedChunks = [];
  let angle = 0;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let renderParticleLimit = maxParticleCount;
  let lastFrameTime = 0;
  let slowFrames = 0;
  let fastFrames = 0;
  let audioUnlocking = false;
  let effectDrag = null;
  let activeNebula = null;

  function announce(message) {
    stateNode.textContent = message;
    document.documentElement.dataset.audioState = message;
  }

  function buildAudioGraph() {
    if (!AudioContextClass) throw new Error("Web Audio is not supported");
    if (audioContext && audioContext.state !== "closed") return;
    try {
      audioContext = new AudioContextClass({ latencyHint: "interactive" });
    } catch (_) {
      audioContext = new AudioContextClass();
    }
    master = audioContext.createGain();
    master.gain.value = 1.35;
    compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 14;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.18;
    master.connect(compressor);
    compressor.connect(audioContext.destination);
    ambientInput = audioContext.createGain();
    ambientDelay = audioContext.createDelay(3);
    ambientFeedback = audioContext.createGain();
    ambientFilter = audioContext.createBiquadFilter();
    ambientWet = audioContext.createGain();
    ambientFilter.type = "lowpass";
    ambientInput.connect(ambientDelay);
    ambientDelay.connect(ambientFilter);
    ambientFilter.connect(ambientWet);
    ambientWet.connect(master);
    ambientFilter.connect(ambientFeedback);
    ambientFeedback.connect(ambientDelay);
    updateAmbientGraph(true);
    if (audioContext.createMediaStreamDestination) {
      recordDestination = audioContext.createMediaStreamDestination();
      compressor.connect(recordDestination);
    }
    audioContext.addEventListener("statechange", () => announce(audioContext.state));
  }

  async function unlockAudio() {
    if (audioUnlocking) return audioContext?.state === "running";
    audioUnlocking = true;
    try {
      buildAudioGraph();
      if (audioContext.state !== "running") await audioContext.resume();
      const buffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(master);
      source.start(0);
      announce(audioContext.state);
      return audioContext.state === "running";
    } catch (error) {
      console.error("Audio unlock failed", error);
      announce("audio-error");
      return false;
    } finally {
      audioUnlocking = false;
    }
  }

  function wakeAudioSoon() {
    unlockAudio().catch(() => {});
  }

  function decodeAudio(arrayBuffer) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ok = value => { if (!settled) { settled = true; resolve(value); } };
      const fail = error => { if (!settled) { settled = true; reject(error); } };
      try {
        const result = audioContext.decodeAudioData(arrayBuffer.slice(0), ok, fail);
        if (result && typeof result.then === "function") result.then(ok, fail);
      } catch (error) {
        fail(error);
      }
    });
  }

  function readFile(file) {
    if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("File read failed"));
      reader.readAsArrayBuffer(file);
    });
  }

  function makeSlices() {
    const sliceDuration = decoded.duration / sliceCount;
    slices = Array.from({ length: sliceCount }, (_, index) => ({
      start: index * sliceDuration,
      duration: sliceDuration
    }));
    particles.forEach(particle => {
      particle.sliceIndex = particle.index % sliceCount;
      particle.lastPlayed = -Infinity;
      particle.insidePointer = false;
    });
  }

  function valueToNorm(name) {
    const [min, max] = controlRanges[name];
    return clamp01((params[name] - min) / Math.max(0.0001, max - min));
  }

  function normToValue(name, value) {
    const [min, max] = controlRanges[name];
    return min + clamp01(value) * (max - min);
  }

  function effectiveParam(name) {
    return paramEnabled[name] ? params[name] : baseParams[name];
  }

  function updateAmbientGraph(immediate = false) {
    if (!audioContext || !ambientDelay || !ambientFeedback || !ambientFilter || !ambientWet) return;
    const amount = effectiveParam("ambient");
    const now = audioContext.currentTime;
    const timeConstant = immediate ? 0.001 : 0.04;
    ambientWet.gain.cancelScheduledValues(now);
    ambientDelay.delayTime.cancelScheduledValues(now);
    ambientFeedback.gain.cancelScheduledValues(now);
    ambientFilter.frequency.cancelScheduledValues(now);
    ambientWet.gain.setTargetAtTime(amount * 0.72, now, timeConstant);
    ambientDelay.delayTime.setTargetAtTime(0.2 + amount * 0.62, now, timeConstant);
    ambientFeedback.gain.setTargetAtTime(0.12 + amount * 0.46, now, timeConstant);
    ambientFilter.frequency.setTargetAtTime(5200 - amount * 3500, now, timeConstant);
  }

  async function loadFile(file) {
    if (!file) return;
    announce("loading");
    try {
      buildAudioGraph();
      const bytes = await readFile(file);
      decoded = await decodeAudio(bytes);
      makeSlices();
      lastGrainStartedAt = -Infinity;
      fileInput.value = "";
      upload.textContent = "↻";
      announce("ready");
      wakeAudioSoon();
    } catch (error) {
      console.error("Audio file could not be decoded", error);
      announce("decode-error");
      upload.textContent = "＋";
    }
  }

  function connectPan(source, gain, panValue) {
    if (typeof audioContext.createStereoPanner === "function") {
      const pan = audioContext.createStereoPanner();
      pan.pan.value = panValue;
      source.connect(gain);
      gain.connect(pan);
      pan.connect(master);
      if (ambientInput) pan.connect(ambientInput);
      return;
    }
    const pan = audioContext.createPanner();
    pan.panningModel = "equalpower";
    if (pan.positionX) pan.positionX.value = panValue;
    else pan.setPosition(panValue, 0, 1 - Math.abs(panValue));
    source.connect(gain);
    gain.connect(pan);
    pan.connect(master);
    if (ambientInput) pan.connect(ambientInput);
  }

  function triggerGrain(particle, distance) {
    if (!decoded || !slices.length || !audioContext) return false;
    if (audioContext.state !== "running") {
      wakeAudioSoon();
      return false;
    }
    let source = null;
    let gain = null;
    let releaseVoice = null;
    try {
      const stretch = effectiveParam("stretch");
      const pitch = effectiveParam("pitch");
      const spray = effectiveParam("spray");
      const voiceLimit = mobile ? 4 : 6;
      if (activeVoices >= voiceLimit) return false;

      source = audioContext.createBufferSource();
      gain = audioContext.createGain();
      const slice = slices[particle.sliceIndex];
      const now = audioContext.currentTime;
      const proximity = clamp01(1 - distance / pointer.radius);
      const baseWindow = 0.12 + proximity * 0.1;
      const desiredDuration = Math.min(1.8, baseWindow * (1 + stretch * 5));
      const sprayOffset = (Math.random() * 2 - 1) * spray * slice.duration * 1.35;
      const rawOffset = slice.start + sprayOffset;
      const maxOffset = Math.max(0, decoded.duration - Math.min(desiredDuration, decoded.duration));
      const offset = Math.max(0, Math.min(rawOffset, maxOffset));
      const availableDuration = Math.max(0.001, decoded.duration - offset);
      const duration = Math.min(availableDuration, desiredDuration);
      const sprayPitch = 1 + (Math.random() * 2 - 1) * spray * 0.35;
      const pitchMultiplier = pitch > 0 ? pitch : 1;
      source.buffer = decoded;
      source.playbackRate.value = Math.max(0.5, Math.min(1.8, pitchMultiplier * sprayPitch));
      const envelopeDuration = Math.min(3, duration / source.playbackRate.value);
      const level = Math.max(0.025, proximity * 0.42);
      const envelope = new Float32Array(64);
      for (let i = 0; i < envelope.length; i++) {
        const phase = i / (envelope.length - 1);
        const cosineWindow = Math.sin(Math.PI * phase) ** 2;
        envelope[i] = cosineWindow * level;
      }
      gain.gain.setValueCurveAtTime(envelope, now, envelopeDuration);
      connectPan(source, gain, (particle.sx / Math.max(1, width)) * 2 - 1);

      let released = false;
      releaseVoice = () => {
        if (released) return;
        released = true;
        activeVoices = Math.max(0, activeVoices - 1);
      };
      activeVoices++;
      source.onended = releaseVoice;
      source.start(now, offset, duration);
      source.stop(now + envelopeDuration + 0.02);
      window.setTimeout(releaseVoice, Math.ceil((envelopeDuration + 0.5) * 1000));
      return true;
    } catch (error) {
      releaseVoice?.();
      try { source?.disconnect(); } catch (_) {}
      try { gain?.disconnect(); } catch (_) {}
      console.error("Grain playback failed", error);
      return false;
    }
  }

  function initParticles() {
    particles.length = 0;
    renderParticleLimit = maxParticleCount;
    slowFrames = 0;
    fastFrames = 0;
    for (let i = 0; i < maxParticleCount; i++) {
      const u = Math.random() * 2 - 1;
      const phi = Math.random() * Math.PI * 2;
      const radius = 0.62 + Math.random() * 0.38;
      particles.push({
        index: i,
        x: Math.sqrt(1 - u * u) * Math.cos(phi) * radius,
        y: u * radius,
        z: Math.sqrt(1 - u * u) * Math.sin(phi) * radius,
        ox: 0,
        oy: 0,
        vx: 0,
        vy: 0,
        sx: 0,
        sy: 0,
        sliceIndex: i % sliceCount,
        lastPlayed: -Infinity,
        insidePointer: false,
        size: 0.55 + Math.random() * 1.45
      });
    }
  }

  function resize() {
    width = innerWidth;
    height = innerHeight;
    dpr = Math.min(devicePixelRatio || 1, mobile ? 1.25 : 1.6);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function adaptParticleBudget(dt) {
    if (dt > 38) {
      slowFrames++;
      fastFrames = 0;
    } else if (dt < 22) {
      fastFrames++;
      slowFrames = Math.max(0, slowFrames - 1);
    } else {
      slowFrames = Math.max(0, slowFrames - 1);
      fastFrames = 0;
    }
    if (slowFrames >= 12 && renderParticleLimit > minParticleCount) {
      renderParticleLimit = Math.max(minParticleCount, Math.floor(renderParticleLimit * 0.82));
      slowFrames = 0;
      return;
    }
    if (fastFrames >= 240 && renderParticleLimit < maxParticleCount) {
      renderParticleLimit = Math.min(maxParticleCount, Math.ceil(renderParticleLimit * 1.08));
      fastFrames = 0;
    }
  }

  function nebulaCenter(name) {
    if (name === "stretch") return { x: 30, y: 140 };
    if (name === "ambient") return { x: width - 30, y: 140 };
    if (name === "pitch") return { x: 30, y: height - 90 };
    return { x: width - 30, y: height - 90 };
  }

  function findNebulaAt(x, y) {
    const names = ["stretch", "ambient", "pitch", "spray"];
    const radius = mobile ? 108 : 126;
    for (const name of names) {
      const center = nebulaCenter(name);
      const dx = x - center.x;
      const dy = y - center.y;
      if (dx * dx + dy * dy < radius * radius) return name;
    }
    return null;
  }

  function updateNebulaControl(name, x, y) {
    const center = nebulaCenter(name);
    const radius = mobile ? 108 : 126;
    const dx = x - center.x;
    const dy = y - center.y;
    const radial = clamp01(Math.sqrt(dx * dx + dy * dy) / radius);
    let amount = clamp01(0.5 - dy / (radius * 1.35));
    if (name === "stretch") amount = radial;
    if (name === "ambient") amount = radial;
    if (name === "spray") amount = radial;
    if (name === "pitch") amount = clamp01(0.5 - dy / (radius * 1.2));
    paramEnabled[name] = true;
    params[name] = normToValue(name, amount);
    if (name === "ambient") updateAmbientGraph();
    syncAllEffectVisuals();
  }

  function drawNebula(cx, cy, type, time) {
    const amount = paramEnabled[type] ? valueToNorm(type) : 0.08;
    ctx.fillStyle = `rgba(255,249,168,${0.16 + amount * 0.26})`;
    const points = Math.round((type === "ambient" ? 42 : 26) + amount * (type === "ambient" ? 52 : 36));
    for (let i = 0; i < points; i++) {
      const seed = i * 9.37;
      const a = seed + time * (0.00008 + amount * 0.0002);
      let rx = 18 + amount * 16 + (i % 9) * (2.8 + amount * 2.2);
      let ry = 18 + amount * 16 + (i % 7) * (2.8 + amount * 2.2);
      if (type === "stretch") { rx *= 1.35 + amount * 1.8; ry *= 0.48 + amount * 0.18; }
      if (type === "ambient") { rx *= 1.05 + amount * 1.25; ry *= 1.05 + amount * 1.25; }
      if (type === "pitch") { rx *= 0.42; ry *= 1.35 + amount * 0.85; }
      if (type === "spray") { rx *= 1.1 + amount * 0.85; ry *= 1.05 + amount * 0.58; }
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * rx, cy + Math.sin(a * 1.17) * ry, 0.55 + amount * 0.75 + i % 3 * 0.25, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function render(time) {
    const dt = lastFrameTime ? Math.min(50, time - lastFrameTime) : 16.67;
    lastFrameTime = time;
    adaptParticleBudget(dt);
    ctx.fillStyle = "#7398d5";
    ctx.fillRect(0, 0, width, height);
    drawNebula(nebulaCenter("stretch").x, nebulaCenter("stretch").y, "stretch", time);
    drawNebula(nebulaCenter("ambient").x, nebulaCenter("ambient").y, "ambient", time);
    drawNebula(nebulaCenter("pitch").x, nebulaCenter("pitch").y, "pitch", time);
    drawNebula(nebulaCenter("spray").x, nebulaCenter("spray").y, "spray", time);

    angle += 0.0014 * (dt / 16.67);
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const scale = Math.min(width, height) * (mobile ? 0.37 : 0.39);
    const centerX = width * 0.5;
    const centerY = height * 0.53;
    const pointerRadiusSq = pointer.radius * pointer.radius;
    const audibleCandidates = [];
    const frameNow = performance.now();

    ctx.fillStyle = "#fff9a8";
    for (let i = 0; i < renderParticleLimit; i++) {
      const p = particles[i];
      const xr = p.x * ca - p.z * sa;
      const zr = p.x * sa + p.z * ca;
      const perspective = 0.78 + (zr + 1) * 0.16;
      const homeX = centerX + xr * scale * perspective;
      const homeY = centerY + p.y * scale * perspective;
      const dx = homeX + p.ox - pointer.x;
      const dy = homeY + p.oy - pointer.y;
      const distSq = dx * dx + dy * dy;
      if (pointer.active && distSq > 0.1 && distSq < pointerRadiusSq) {
        const dist = Math.sqrt(distSq);
        const force = (1 - dist / pointer.radius) * 4.2;
        p.vx += dx / Math.max(1, dist) * force;
        p.vy += dy / Math.max(1, dist) * force;
        const particleCooldown = 120;
        if (pointer.soundActive && !p.insidePointer && frameNow - p.lastPlayed >= particleCooldown) {
          audibleCandidates.push({ particle: p, distance: dist });
        }
        if (!pointer.soundActive) p.insidePointer = false;
      } else {
        p.insidePointer = false;
      }
      p.vx += -p.ox * 0.025;
      p.vy += -p.oy * 0.025;
      p.vx *= 0.88;
      p.vy *= 0.88;
      p.ox += p.vx;
      p.oy += p.vy;
      p.sx = homeX + p.ox;
      p.sy = homeY + p.oy;
      ctx.globalAlpha = 0.35 + perspective * 0.48;
      ctx.fillRect(p.sx, p.sy, p.size, p.size);
    }
    if (audibleCandidates.length > 0) {
      audibleCandidates.sort((a, b) => a.distance - b.distance);
      if (frameNow - lastGrainStartedAt >= grainStartIntervalMs) {
        for (const candidate of audibleCandidates) {
          if (triggerGrain(candidate.particle, candidate.distance)) {
            candidate.particle.lastPlayed = frameNow;
            candidate.particle.insidePointer = true;
            lastGrainStartedAt = frameNow;
            break;
          }
        }
      }
    }
    ctx.globalAlpha = 1;

    requestAnimationFrame(render);
  }

  function updatePointer(event, active = true) {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.active = true;
    pointer.soundActive = active;
    if (active) {
      pointer.lastMoved = performance.now();
      if (audioContext && audioContext.state !== "running") wakeAudioSoon();
    }
  }

  function isInterfaceTarget(event) {
    return event.target instanceof Element
      && !!event.target.closest("#upload, #record, #save, #audio-file, .effects, .touch-size, .chop-count");
  }

  function beginWorldPointer(event) {
    if (isInterfaceTarget(event)) {
      pointer.active = false;
      pointer.soundActive = false;
      pointer.down = false;
      pointer.touching = false;
      return;
    }
    if (event.pointerType === "touch") pointer.touching = true;
    pointer.down = true;
    const control = findNebulaAt(event.clientX, event.clientY);
    if (control) {
      activeNebula = control;
      updatePointer(event, false);
      updateNebulaControl(control, event.clientX, event.clientY);
      wakeAudioSoon();
      return;
    }
    updatePointer(event);
    wakeAudioSoon();
  }

  function moveWorldPointer(event) {
    if (activeNebula) {
      updatePointer(event, false);
      updateNebulaControl(activeNebula, event.clientX, event.clientY);
      return;
    }
    const isTouchPointer = event.pointerType === "touch" || pointer.touching;
    const shouldSound = isTouchPointer
      ? pointer.down || event.buttons > 0
      : true;
    updatePointer(event, shouldSound);
  }

  function endWorldPointer(event) {
    const wasTouch = event.pointerType === "touch" || pointer.touching;
    pointer.down = false;
    pointer.touching = false;
    if (activeNebula) {
      activeNebula = null;
      pointer.active = false;
      pointer.soundActive = false;
      return;
    }
    updatePointer(event, !wasTouch);
    if (wasTouch) pointer.active = false;
  }

  function syncTouchSize() {
    if (!touchSize) return;
    touchSize.value = String(pointer.radius);
    if (touchSizeValue) touchSizeValue.textContent = String(Math.round(pointer.radius));
    updateTouchSizeVisual();
  }

  function updateTouchSize(event) {
    pointer.radius = Number(event.target.value);
    if (touchSizeValue) touchSizeValue.textContent = event.target.value;
    updateTouchSizeVisual();
  }

  function updateTouchSizeVisual() {
    if (!touchSize) return;
    const min = Number(touchSize.min);
    const max = Number(touchSize.max);
    const progress = Math.max(0, Math.min(1, (pointer.radius - min) / Math.max(1, max - min)));
    touchSize.closest(".touch-size")?.style.setProperty("--touch-fill", `${(progress * 100).toFixed(1)}%`);
  }

  function clamp01(value) {
    return Math.max(0, Math.min(1, value));
  }

  function syncChopCount() {
    if (!chopCountInput) return;
    chopCountInput.value = String(sliceCount);
    if (chopCountValue) chopCountValue.textContent = String(sliceCount);
    const min = Number(chopCountInput.min);
    const max = Number(chopCountInput.max);
    const progress = clamp01((sliceCount - min) / Math.max(1, max - min));
    chopCountInput.closest(".chop-count")?.style.setProperty("--chop-fill", `${(progress * 100).toFixed(1)}%`);
  }

  function updateChopCount(event) {
    sliceCount = Number(event.target.value);
    syncChopCount();
    if (decoded) makeSlices();
  }

  function syncEffectVisual(button) {
    const name = button.dataset.effect;
    const amount = valueToNorm(name);
    button.style.setProperty("--effect-amount", amount.toFixed(3));
    button.setAttribute("aria-pressed", String(!!paramEnabled[name]));
  }

  function syncAllEffectVisuals() {
    effectButtons.forEach(syncEffectVisual);
  }

  function toggleEffect(button) {
    const name = button.dataset.effect;
    paramEnabled[name] = !paramEnabled[name];
    if (name === "ambient") updateAmbientGraph();
    syncEffectVisual(button);
    wakeAudioSoon();
  }

  function beginEffectDrag(event, button) {
    event.stopPropagation();
    const name = button.dataset.effect;
    effectDrag = {
      button,
      name,
      pointerId: event.pointerId,
      startY: event.clientY,
      startAmount: valueToNorm(name),
      moved: false
    };
    button.setPointerCapture?.(event.pointerId);
  }

  function moveEffectDrag(event) {
    if (!effectDrag || event.pointerId !== effectDrag.pointerId) return;
    event.stopPropagation();
    const delta = (effectDrag.startY - event.clientY) / 96;
    if (Math.abs(event.clientY - effectDrag.startY) > 4) effectDrag.moved = true;
    paramEnabled[effectDrag.name] = true;
    params[effectDrag.name] = normToValue(effectDrag.name, effectDrag.startAmount + delta);
    if (effectDrag.name === "ambient") updateAmbientGraph();
    syncEffectVisual(effectDrag.button);
  }

  function endEffectDrag(event) {
    if (!effectDrag || event.pointerId !== effectDrag.pointerId) return;
    event.stopPropagation();
    const drag = effectDrag;
    effectDrag = null;
    drag.button.releasePointerCapture?.(event.pointerId);
    if (!drag.moved) toggleEffect(drag.button);
    else wakeAudioSoon();
  }

  async function toggleRecording() {
    await unlockAudio();
    if (!recordDestination || !window.MediaRecorder) return announce("recording-unsupported");
    if (recorder && recorder.state === "recording") {
      recorder.stop();
      return;
    }
    recordedChunks = [];
    const mimeTypes = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
    const mimeType = mimeTypes.find(type => MediaRecorder.isTypeSupported?.(type)) || "";
    recorder = new MediaRecorder(recordDestination.stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = event => { if (event.data.size) recordedChunks.push(event.data); };
    recorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: recorder.mimeType || "audio/mp4" });
      saveLink.href = URL.createObjectURL(blob);
      saveLink.download = `bugnote-${new Date().toISOString().replace(/[:.]/g, "-")}.${blob.type.includes("mp4") ? "m4a" : "webm"}`;
      saveLink.hidden = false;
      recordButton.setAttribute("aria-pressed", "false");
      announce("recorded");
    };
    recorder.start(250);
    recordButton.setAttribute("aria-pressed", "true");
    announce("recording");
  }

  upload.addEventListener("pointerdown", wakeAudioSoon);
  upload.addEventListener("touchend", wakeAudioSoon, { passive: true });
  fileInput.addEventListener("change", event => loadFile(event.target.files?.[0]));
  recordButton.addEventListener("click", toggleRecording);
  if (touchSize) {
    syncTouchSize();
    ["pointerdown", "touchstart", "click"].forEach(type => {
      touchSize.addEventListener(type, event => event.stopPropagation(), { passive: true });
    });
    touchSize.addEventListener("input", updateTouchSize);
  }
  if (chopCountInput) {
    syncChopCount();
    ["pointerdown", "touchstart", "click"].forEach(type => {
      chopCountInput.addEventListener(type, event => event.stopPropagation(), { passive: true });
    });
    chopCountInput.addEventListener("input", updateChopCount);
  }
  effectButtons.forEach(button => {
    syncEffectVisual(button);
    button.addEventListener("pointerdown", event => beginEffectDrag(event, button));
    button.addEventListener("pointermove", moveEffectDrag);
    button.addEventListener("pointerup", endEffectDrag);
    button.addEventListener("pointercancel", event => {
      event.stopPropagation();
      effectDrag = null;
    });
    button.addEventListener("click", event => {
      event.stopPropagation();
      event.preventDefault();
    });
  });
  window.addEventListener("pointerdown", beginWorldPointer, { passive: true });
  window.addEventListener("pointermove", moveWorldPointer, { passive: true });
  window.addEventListener("pointerup", endWorldPointer, { passive: true });
  window.addEventListener("pointercancel", () => {
    pointer.active = false;
    pointer.soundActive = false;
    pointer.down = false;
    pointer.touching = false;
    activeNebula = null;
  }, { passive: true });
  document.documentElement.addEventListener("pointerleave", () => {
    pointer.active = false;
    pointer.soundActive = false;
    pointer.down = false;
    pointer.touching = false;
  }, { passive: true });
  window.addEventListener("blur", () => {
    pointer.active = false;
    pointer.soundActive = false;
    pointer.down = false;
    pointer.touching = false;
  });
  window.addEventListener("touchstart", () => {
    pointer.touching = true;
    wakeAudioSoon();
  }, { passive: true });
  window.addEventListener("touchend", () => {
    pointer.touching = false;
    pointer.down = false;
    pointer.active = false;
    pointer.soundActive = false;
  }, { passive: true });
  window.addEventListener("touchcancel", () => {
    pointer.touching = false;
    pointer.down = false;
    pointer.active = false;
    pointer.soundActive = false;
  }, { passive: true });
  window.addEventListener("mousedown", wakeAudioSoon, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && audioContext && audioContext.state !== "running") wakeAudioSoon();
  });
  window.addEventListener("pageshow", () => {
    if (audioContext && audioContext.state !== "running") wakeAudioSoon();
  });
  window.addEventListener("resize", resize, { passive: true });

  resize();
  initParticles();
  requestAnimationFrame(render);
})();
