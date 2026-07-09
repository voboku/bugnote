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

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const mobile = matchMedia("(max-width: 700px), (pointer: coarse)").matches;
  const maxParticleCount = mobile ? 2600 : 5600;
  const minParticleCount = mobile ? 1200 : 2600;
  const particles = [];
  const defaultTouchRadius = mobile ? 24 : 18;
  const pointer = { x: -9999, y: -9999, active: false, radius: defaultTouchRadius };
  const params = { grain: 0.11, density: 0.52, pitch: 1, spray: 0.12 };
  const effects = { drift: false, reverse: false, scatter: false, freeze: false };

  let audioContext = null;
  let master = null;
  let compressor = null;
  let recordDestination = null;
  let decoded = null;
  let slices = [];
  let lastTrigger = 0;
  let activeVoices = 0;
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
    if (audioContext.createMediaStreamDestination) {
      recordDestination = audioContext.createMediaStreamDestination();
      compressor.connect(recordDestination);
    }
    audioContext.addEventListener("statechange", () => announce(audioContext.state));
  }

  async function unlockAudio() {
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
    }
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
    const count = Math.max(128, Math.min(512, Math.round(decoded.duration * 22)));
    const length = Math.max(0.035, Math.min(0.32, params.grain));
    const usable = Math.max(0, decoded.duration - length);
    slices = Array.from({ length: count }, (_, index) => ({
      start: usable * index / Math.max(1, count - 1),
      duration: Math.min(length, decoded.duration)
    }));
  }

  async function loadFile(file) {
    if (!file) return;
    announce("loading");
    try {
      buildAudioGraph();
      const bytes = await readFile(file);
      decoded = await decodeAudio(bytes);
      makeSlices();
      fileInput.value = "";
      upload.textContent = "↻";
      announce("ready");
      await unlockAudio();
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
      source.connect(gain).connect(pan).connect(master);
      return;
    }
    const pan = audioContext.createPanner();
    pan.panningModel = "equalpower";
    if (pan.positionX) pan.positionX.value = panValue;
    else pan.setPosition(panValue, 0, 1 - Math.abs(panValue));
    source.connect(gain).connect(pan).connect(master);
  }

  function triggerGrain(particle, distance) {
    if (!decoded || !slices.length || !audioContext || audioContext.state !== "running") return;
    const nowMs = performance.now();
    const cooldown = 14 + (1 - params.density) * 85;
    if (nowMs - lastTrigger < cooldown || activeVoices >= (mobile ? 18 : 32)) return;
    lastTrigger = nowMs;

    const source = audioContext.createBufferSource();
    const gain = audioContext.createGain();
    const slice = slices[particle.index % slices.length];
    const now = audioContext.currentTime;
    const duration = Math.min(slice.duration, decoded.duration);
    const yPitch = 0.68 + 0.82 * (1 - particle.sy / Math.max(1, height));
    source.buffer = decoded;
    source.playbackRate.value = Math.max(0.25, Math.min(3, params.pitch * yPitch));
    const level = Math.max(0.025, (1 - distance / pointer.radius) * 0.42);
    const attack = Math.min(0.018, duration * 0.3);
    const release = Math.min(0.055, duration * 0.45);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(level, now + attack);
    gain.gain.setValueAtTime(level, Math.max(now + attack, now + duration - release));
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    connectPan(source, gain, (particle.sx / Math.max(1, width)) * 2 - 1);
    activeVoices++;
    source.onended = () => { activeVoices = Math.max(0, activeVoices - 1); };
    const offset = effects.reverse ? Math.max(0, decoded.duration - slice.start - duration) : slice.start;
    source.start(now, Math.max(0, Math.min(offset, decoded.duration - 0.001)), duration);
    source.stop(now + duration + 0.02);
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
        size: 0.55 + Math.random() * 1.45
      });
    }
  }

  function resize() {
    width = innerWidth;
    height = innerHeight;
    dpr = Math.min(devicePixelRatio || 1, mobile ? 1.1 : 1.35);
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

  function drawNebula(cx, cy, type, time) {
    ctx.fillStyle = "rgba(255,249,168,.28)";
    const points = type === "density" ? 58 : 34;
    for (let i = 0; i < points; i++) {
      const seed = i * 9.37;
      const a = seed + time * 0.00014;
      let rx = 25 + (i % 9) * 4;
      let ry = 25 + (i % 7) * 4;
      if (type === "pitch") { rx *= 0.45; ry *= 1.7; }
      if (type === "spray") { rx *= 1.45; ry *= 1.25; }
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * rx, cy + Math.sin(a * 1.17) * ry, 0.7 + i % 3 * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function render(time) {
    const dt = lastFrameTime ? Math.min(50, time - lastFrameTime) : 16.67;
    lastFrameTime = time;
    adaptParticleBudget(dt);

    ctx.fillStyle = "#7398d5";
    ctx.fillRect(0, 0, width, height);
    drawNebula(30, 140, "grain", time);
    drawNebula(width - 30, 140, "density", time);
    drawNebula(30, height - 90, "pitch", time);
    drawNebula(width - 30, height - 90, "spray", time);

    if (!effects.freeze) angle += (effects.drift ? 0.004 : 0.0014) * (dt / 16.67);
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const scale = Math.min(width, height) * (mobile ? 0.37 : 0.39);
    const centerX = width * 0.5;
    const centerY = height * 0.53;

    const pointerRadiusSq = pointer.radius * pointer.radius;
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
      if (pointer.active && distSq < pointerRadiusSq) {
        const dist = Math.sqrt(distSq);
        const force = (1 - dist / pointer.radius) * (effects.scatter ? 8 : 4.2);
        p.vx += dx / Math.max(1, dist) * force;
        p.vy += dy / Math.max(1, dist) * force;
        if (Math.random() < params.density * 0.1) triggerGrain(p, dist);
      }
      p.vx += -p.ox * 0.025;
      p.vy += -p.oy * 0.025;
      p.vx *= 0.88;
      p.vy *= 0.88;
      p.ox += p.vx;
      p.oy += p.vy;
      p.sx = homeX + p.ox;
      p.sy = homeY + p.oy;
      const alpha = 0.35 + perspective * 0.48;
      ctx.globalAlpha = alpha;
      ctx.fillRect(p.sx, p.sy, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    if (pointer.active) {
      ctx.fillStyle = "rgba(255,254,240,.72)";
      ctx.beginPath();
      ctx.arc(pointer.x, pointer.y, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    requestAnimationFrame(render);
  }

  function updatePointer(event, active = true) {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.active = active;
  }

  function syncTouchSize() {
    if (!touchSize) return;
    touchSize.value = String(pointer.radius);
    if (touchSizeValue) touchSizeValue.textContent = String(Math.round(pointer.radius));
  }

  function updateTouchSize(event) {
    pointer.radius = Number(event.target.value);
    if (touchSizeValue) touchSizeValue.textContent = event.target.value;
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

  upload.addEventListener("pointerdown", unlockAudio);
  upload.addEventListener("touchend", unlockAudio, { passive: true });
  fileInput.addEventListener("change", event => loadFile(event.target.files?.[0]));
  recordButton.addEventListener("click", toggleRecording);
  if (touchSize) {
    syncTouchSize();
    ["pointerdown", "touchstart", "click"].forEach(type => {
      touchSize.addEventListener(type, event => event.stopPropagation(), { passive: true });
    });
    touchSize.addEventListener("input", updateTouchSize);
  }
  effectButtons.forEach(button => {
    ["pointerdown", "touchstart"].forEach(type => {
      button.addEventListener(type, event => event.stopPropagation(), { passive: true });
    });
    button.addEventListener("click", event => {
      event.stopPropagation();
      const name = button.dataset.effect;
      effects[name] = !effects[name];
      button.setAttribute("aria-pressed", String(effects[name]));
      unlockAudio();
    });
  });
  window.addEventListener("pointerdown", async event => { await unlockAudio(); updatePointer(event); }, { passive: true });
  window.addEventListener("pointermove", event => updatePointer(event, event.pointerType === "mouse" || event.buttons > 0), { passive: true });
  window.addEventListener("pointerup", event => updatePointer(event, false), { passive: true });
  window.addEventListener("pointercancel", () => { pointer.active = false; }, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && audioContext && audioContext.state !== "running") audioContext.resume().catch(() => {});
  });
  window.addEventListener("pageshow", () => {
    if (audioContext && audioContext.state !== "running") audioContext.resume().catch(() => {});
  });
  window.addEventListener("resize", resize, { passive: true });

  resize();
  initParticles();
  requestAnimationFrame(render);
})();
