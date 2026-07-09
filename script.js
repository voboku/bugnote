const TWO_PI_CONST = Math.PI * 2;
    const isCoarse = matchMedia("(pointer: coarse)").matches;
    const isSmall = Math.min(innerWidth, innerHeight) < 720;
    const PARTICLE_COUNT = isCoarse || isSmall ? 2600 : 4200;
    const TARGET_SLICES = isCoarse ? 192 : 384;
    const MAX_VOICES = isCoarse ? 22 : 38;
    const PAL = {
      light: [242, 237, 167],
      field: [105, 146, 217],
      mid: [146, 171, 221],
      moss: [137, 157, 57],
      olive: [93, 105, 74],
      ink: [242, 237, 167]
    };

    let particles = [];
    let controlDust = [];
    let pointers = new Map();
    let audioCtx = null;
    let masterGain = null;
    let masterCompressor = null;
    let recordingDestination = null;
    let mediaRecorder = null;
    let recordedChunks = [];
    let isRecording = false;
    let recordingStartedAt = 0;
    let audioBuffer = null;
    let slices = [];
    let loadedName = "";
    let voices = 0;
    let globalLastTrigger = 0;
    let rotation = { x: 0, y: 0, z: 0 };
    let lastFrameMs = 16;
    let fileInput;
    let uploadPulse = 0;
    let message = "";
    let messageUntil = 0;
    let firstSoundTouch = false;

    const settings = {
      grain: 0.42,
      density: 0.48,
      pitch: 0.5,
      spray: 0.46
    };

    const effects = {
      grain: false,
      density: false,
      pitch: false,
      pan: false,
      spray: false,
      reverse: false,
      jitter: false,
      filter: false,
      shimmer: false,
      freeze: false
    };

    const controlMeta = {
      grain: { corner: "tl", lastTouched: -9999, phase: 0, value: () => settings.grain },
      density: { corner: "tr", lastTouched: -9999, phase: 1.6, value: () => settings.density },
      pitch: { corner: "bl", lastTouched: -9999, phase: 3.2, value: () => settings.pitch },
      spray: { corner: "br", lastTouched: -9999, phase: 4.7, value: () => settings.spray }
    };

    function setup() {
      createCanvas(windowWidth, windowHeight);
      pixelDensity(1);
      frameRate(45);
      fileInput = document.getElementById("fileInput");
      fileInput.addEventListener("change", handleFileSelect);
      window.addEventListener("dragover", (event) => event.preventDefault());
      window.addEventListener("drop", handleDrop);
      initParticles();
      initControlDust();
      textFont("ui-monospace, SFMono-Regular, Menlo, Consolas, monospace");
    }

    function draw() {
      lastFrameMs = Math.min(deltaTime || 16, 48);
      const dt = lastFrameMs / 16.6667;
      background(PAL.field[0], PAL.field[1], PAL.field[2], 64);
      noStroke();

      rotation.x += 0.0018 * dt;
      rotation.y += 0.0028 * dt;
      rotation.z += 0.0007 * dt;

      drawControls(dt);
      drawCloud(dt);
      drawPointerFields();
      drawCenterInvitation();
      drawRecorderCore();
      drawEffectSwitches();
      drawTransientText();
    }

    function initParticles() {
      particles = [];
      const radius = Math.min(width, height) * 0.37;
      const golden = Math.PI * (3 - Math.sqrt(5));

      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const y = 1 - (i / (PARTICLE_COUNT - 1)) * 2;
        const radial = Math.sqrt(1 - y * y);
        const theta = golden * i;
        const shellNoise = 0.82 + Math.random() * 0.24;
        particles.push({
          x: Math.cos(theta) * radial * radius * shellNoise,
          y: y * radius * (0.94 + Math.random() * 0.12),
          z: Math.sin(theta) * radial * radius * shellNoise,
          dx: 0,
          dy: 0,
          vx: 0,
          vy: 0,
          size: Math.random() < 0.18 ? 1.7 : 1,
          slice: i % Math.max(TARGET_SLICES, 1),
          last: -9999,
          seed: Math.random() * 1000,
          hot: 0
        });
      }
    }

    function initControlDust() {
      controlDust = [];
      const specs = [
        ["grain", 78],
        ["density", 104],
        ["pitch", 84],
        ["spray", 92]
      ];

      specs.forEach(([type, count]) => {
        for (let i = 0; i < count; i++) {
          const angle = Math.random() * TWO_PI_CONST;
          const ring = Math.pow(Math.random(), type === "density" ? 2.2 : 0.68);
          controlDust.push({
            type,
            angle,
            ring,
            seed: Math.random() * 1000,
            speed: 0.15 + Math.random() * 0.65
          });
        }
      });
    }

    function drawCloud(dt) {
      const cx = width * 0.5;
      const cy = height * 0.5;
      const minDim = Math.min(width, height);
      const perspective = minDim * 0.95;
      const sprayValue = effects.spray ? settings.spray : 0.46;
      const influenceRadius = map(sprayValue, 0, 1, 52, isCoarse ? 150 : 190);
      const influenceRadiusSq = influenceRadius * influenceRadius;
      const forceScale = map(sprayValue, 0, 1, 1.7, 7.2);
      const now = millis();
      const rotCx = Math.cos(rotation.x);
      const rotSx = Math.sin(rotation.x);
      const rotCy = Math.cos(rotation.y);
      const rotSy = Math.sin(rotation.y);
      const rotCz = Math.cos(rotation.z);
      const rotSz = Math.sin(rotation.z);
      const depthRange = minDim * 0.42;
      const pointerList = Array.from(pointers.values());

      blendMode(BLEND);
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        const y1 = p.y * rotCx - p.z * rotSx;
        const z1 = p.y * rotSx + p.z * rotCx;
        const x2 = p.x * rotCy + z1 * rotSy;
        const z2 = -p.x * rotSy + z1 * rotCy;
        const x3 = x2 * rotCz - y1 * rotSz;
        const y3 = x2 * rotSz + y1 * rotCz;
        const scale = perspective / (perspective + z2 + minDim * 0.48);
        const homeX = cx + x3 * scale;
        const homeY = cy + y3 * scale;

        let disturbed = false;
        let nearestAmount = 0;
        for (let j = 0; j < pointerList.length; j++) {
          const pt = pointerList[j];
          const px = homeX + p.dx;
          const py = homeY + p.dy;
          const ddx = px - pt.x;
          const ddy = py - pt.y;
          const dSq = ddx * ddx + ddy * ddy;
          if (dSq < influenceRadiusSq) {
            const d = Math.sqrt(dSq);
            const amt = 1 - d / influenceRadius;
            const inv = d > 0.001 ? 1 / d : 0;
            p.vx += ddx * inv * amt * forceScale * dt;
            p.vy += ddy * inv * amt * forceScale * dt;
            p.hot = Math.min(1, p.hot + amt * 0.34);
            nearestAmount = Math.max(nearestAmount, amt);
            disturbed = true;
          }
        }

        p.vx += -p.dx * 0.012 * dt;
        p.vy += -p.dy * 0.012 * dt;
        p.vx *= Math.pow(0.89, dt);
        p.vy *= Math.pow(0.89, dt);
        p.dx += p.vx * dt;
        p.dy += p.vy * dt;
        p.hot *= Math.pow(0.91, dt);

        if (disturbed) {
          maybeTriggerParticle(p, homeX + p.dx, homeY + p.dy, nearestAmount, now);
        }

        const depth = constrain(map(z2, -depthRange, depthRange, 0.22, 1), 0.12, 1);
        const alpha = 34 + depth * 155 + p.hot * 70;
        const dotSize = (p.size + p.hot * 1.9) * scale * 1.32;
        const hotMix = p.hot;
        const pr = lerp(PAL.ink[0], PAL.moss[0], hotMix * 0.72);
        const pg = lerp(PAL.ink[1], PAL.moss[1], hotMix * 0.72);
        const pb = lerp(PAL.ink[2], PAL.moss[2], hotMix * 0.72);
        fill(pr, pg, pb, alpha);
        circle(homeX + p.dx, homeY + p.dy, dotSize);
      }
      blendMode(BLEND);
    }

    function rotate3d(x, y, z) {
      const cx = Math.cos(rotation.x);
      const sx = Math.sin(rotation.x);
      const cy = Math.cos(rotation.y);
      const sy = Math.sin(rotation.y);
      const cz = Math.cos(rotation.z);
      const sz = Math.sin(rotation.z);

      let y1 = y * cx - z * sx;
      let z1 = y * sx + z * cx;
      let x2 = x * cy + z1 * sy;
      let z2 = -x * sy + z1 * cy;
      let x3 = x2 * cz - y1 * sz;
      let y3 = x2 * sz + y1 * cz;
      return { x: x3, y: y3, z: z2 };
    }

    function maybeTriggerParticle(p, sx, sy, amount, nowMs) {
      if (!audioBuffer || !audioCtx || voices >= MAX_VOICES) return;
      const density = effects.density ? settings.density : 0.48;
      const particleCooldown = map(density, 0, 1, 460, 70);
      const globalGap = map(density, 0, 1, 42, 8);
      const chance = map(density, 0, 1, 0.08, 0.52) * amount;
      if (nowMs - p.last < particleCooldown) return;
      if (nowMs - globalLastTrigger < globalGap) return;
      if (Math.random() > chance) return;

      p.last = nowMs;
      globalLastTrigger = nowMs;
      triggerSlice(p.slice, sx, sy, amount);
    }

    function triggerSlice(sliceIndex, sx, sy, amount) {
      const ctx = audioCtx;
      let slice = slices[sliceIndex % slices.length];
      if (!slice || ctx.state !== "running") return;
      if (effects.freeze && slices.length) {
        const frozenIndex = Math.floor(map(sx, 0, width, 0, slices.length - 1));
        slice = slices[constrain(frozenIndex, 0, slices.length - 1)];
      }

      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      const filter = effects.filter ? ctx.createBiquadFilter() : null;
      const now = ctx.currentTime;
      const grainValue = effects.grain ? settings.grain : 0.42;
      const densityValue = effects.density ? settings.density : 0.48;
      const grainSeconds = map(grainValue, 0, 1, 0.018, 0.24);
      const duration = Math.min(slice.duration, grainSeconds);
      const yRate = effects.pitch ? map(constrain(sy / height, 0, 1), 0, 1, 1.9, 0.48) : 1;
      const globalPitch = effects.pitch ? Math.pow(2, map(settings.pitch, 0, 1, -1.15, 1.15)) : 1;
      const playbackRate = constrain(yRate * globalPitch, 0.2, 4);
      const panValue = effects.pan ? constrain(map(sx, 0, width, -1, 1), -1, 1) : 0;
      const level = Math.pow(amount, 1.35) * map(densityValue, 0, 1, 0.12, 0.34);
      const attack = Math.min(0.018, duration * 0.22);
      const release = Math.min(0.05, duration * 0.42);
      const jitterTime = effects.jitter ? Math.random() * 0.045 : 0;

      source.buffer = audioBuffer;
      source.playbackRate.setValueAtTime(playbackRate, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(level, now + jitterTime + attack);
      gain.gain.setTargetAtTime(0.0001, Math.max(now + jitterTime + attack, now + jitterTime + duration - release), release * 0.32);

      if (filter) {
        filter.type = sy < height * 0.5 ? "highpass" : "lowpass";
        filter.frequency.setTargetAtTime(map(constrain(sy / height, 0, 1), 0, 1, 2800, 420), now, 0.018);
        filter.Q.setTargetAtTime(map(amount, 0, 1, 0.4, 7), now, 0.02);
      }

      const outputNode = filter || gain;
      if (filter) gain.connect(filter);
      if (pan) {
        pan.pan.setTargetAtTime(panValue, now, 0.01);
        source.connect(gain);
        outputNode.connect(pan).connect(masterGain || ctx.destination);
      } else {
        source.connect(gain);
        outputNode.connect(masterGain || ctx.destination);
      }

      voices++;
      source.onended = () => voices = Math.max(0, voices - 1);
      const sliceRange = Math.max(0, slice.duration - duration);
      const jitter = Math.random() * sliceRange;
      const reverseOffset = effects.reverse ? sliceRange - jitter : jitter;
      const startOffset = constrain(reverseOffset + (effects.jitter ? (Math.random() - 0.5) * slice.duration * 0.22 : 0), 0, sliceRange);
      source.start(now + jitterTime, slice.start + startOffset, duration);
      source.stop(now + jitterTime + duration + release + 0.04);

      if (effects.shimmer && amount > 0.38 && voices < MAX_VOICES - 1) {
        triggerShimmer(slice, startOffset, duration, panValue, level * 0.34, now + jitterTime + 0.012);
      }
    }

    function triggerShimmer(slice, startOffset, duration, panValue, level, startTime) {
      const ctx = audioCtx;
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      source.buffer = audioBuffer;
      source.playbackRate.setValueAtTime(2, startTime);
      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.linearRampToValueAtTime(level, startTime + 0.012);
      gain.gain.setTargetAtTime(0.0001, startTime + duration * 0.58, 0.026);
      source.connect(gain);
      if (pan) {
        pan.pan.setTargetAtTime(constrain(panValue * -0.7, -1, 1), startTime, 0.02);
        gain.connect(pan).connect(masterGain || ctx.destination);
      } else {
        gain.connect(masterGain || ctx.destination);
      }
      voices++;
      source.onended = () => voices = Math.max(0, voices - 1);
      source.start(startTime, slice.start + startOffset, Math.min(duration * 0.72, slice.duration));
      source.stop(startTime + duration * 0.78 + 0.05);
    }

    function drawControls(dt) {
      const pad = Math.max(74, Math.min(width, height) * 0.12);
      const t = millis() * 0.001;
      const centers = {
        grain: { x: pad, y: pad },
        density: { x: width - pad, y: pad },
        pitch: { x: pad, y: height - pad },
        spray: { x: width - pad, y: height - pad }
      };

      blendMode(BLEND);
      controlDust.forEach((d) => {
        const c = centers[d.type];
        const value = settings[d.type];
        const enabled = effects[d.type] !== false;
        let rx = 34;
        let ry = 34;
        let spin = d.angle + t * d.speed;

        if (d.type === "grain") {
          rx = map(value, 0, 1, 20, 78) * (0.7 + d.ring);
          ry = rx * (0.62 + 0.24 * sin(t * 2 + d.seed));
        } else if (d.type === "density") {
          rx = map(value, 0, 1, 48, 22) * (0.4 + d.ring * 0.72);
          ry = rx;
          spin *= 0.55;
        } else if (d.type === "pitch") {
          rx = 20 + d.ring * 24;
          ry = map(value, 0, 1, 38, 118) * (0.38 + d.ring);
          spin += Math.sin(d.seed) * 0.8;
        } else {
          rx = map(value, 0, 1, 34, 125) * (0.24 + d.ring);
          ry = rx * (0.66 + 0.35 * sin(d.seed + t));
          spin += sin(t * 1.7 + d.seed) * 0.7;
        }

        const px = c.x + Math.cos(spin) * rx;
        const py = c.y + Math.sin(spin) * ry;
        const active = millis() - controlMeta[d.type].lastTouched < 900;
        const alpha = (active ? 115 : 54) * (enabled ? 1 : 0.28);
        fill(PAL.ink[0], PAL.ink[1], PAL.ink[2], alpha * (0.32 + d.ring));
        circle(px, py, active ? 2.2 : 1.25);
      });
      blendMode(BLEND);

      Object.entries(centers).forEach(([type, c]) => {
        const hot = controlHeat(c.x, c.y);
        const recent = millis() - controlMeta[type].lastTouched;
        drawControlGuide(type, c.x, c.y, hot, recent, t);
      });
    }

    function drawControlGuide(type, x, y, hot, recent, t) {
      const value = settings[type];
      const enabled = effects[type] !== false;
      const visible = hot > 0.035 || recent < 1900;
      const alpha = (visible ? 30 + hot * 96 : 18) * (enabled ? 1 : 0.32);
      const pulse = sin(t * 4.5 + controlMeta[type].phase) * 3;

      noFill();
      stroke(PAL.ink[0], PAL.ink[1], PAL.ink[2], alpha);
      strokeWeight(1);

      if (type === "grain") {
        const inner = 22 + value * 48;
        circle(x, y, inner + pulse);
        circle(x, y, inner * 1.55 + pulse * 0.6);
        fill(PAL.ink[0], PAL.ink[1], PAL.ink[2], visible ? 115 : 54);
        noStroke();
        circle(x + inner * 0.52, y, 3.4);
      } else if (type === "density") {
        for (let ring = 0; ring < 3; ring++) {
          const r = 52 - value * 29 + ring * 9;
          circle(x, y, r + pulse * 0.35);
        }
        noStroke();
        fill(PAL.ink[0], PAL.ink[1], PAL.ink[2], visible ? 120 : 62);
        const dots = 5 + Math.round(value * 11);
        for (let i = 0; i < dots; i++) {
          const a = i * TWO_PI_CONST / dots + t * 0.12;
          const rr = 8 + (i % 4) * (2.2 + (1 - value) * 1.8);
          circle(x + cos(a) * rr, y + sin(a) * rr, 2.2);
        }
      } else if (type === "pitch") {
        const top = y - 82;
        const bottom = y + 82;
        const beadY = lerp(bottom, top, value);
        line(x, bottom, x, top);
        line(x - 13, top, x + 13, top);
        line(x - 13, bottom, x + 13, bottom);
        noStroke();
        fill(PAL.ink[0], PAL.ink[1], PAL.ink[2], visible ? 130 : 58);
        circle(x, beadY, 7);
        circle(x, top, 2.4);
        circle(x, bottom, 2.4);
      } else {
        const r = 28 + value * 86;
        for (let i = 0; i < 9; i++) {
          const a = i * TWO_PI_CONST / 9 + t * 0.18;
          const start = 18 + value * 12;
          line(x + cos(a) * start, y + sin(a) * start, x + cos(a) * r, y + sin(a) * r);
        }
        noStroke();
        fill(PAL.ink[0], PAL.ink[1], PAL.ink[2], visible ? 125 : 54);
        for (let i = 0; i < 5; i++) {
          const a = i * TWO_PI_CONST / 5 - t * 0.25;
          circle(x + cos(a) * r * 0.72, y + sin(a) * r * 0.72, 2.8);
        }
      }
      noStroke();
    }

    function controlHeat(x, y) {
      let heat = 0;
      pointers.forEach((pt) => {
        heat = Math.max(heat, 1 - Math.min(1, dist(pt.x, pt.y, x, y) / 130));
      });
      return heat;
    }

    function drawPointerFields() {
      blendMode(BLEND);
      pointers.forEach((pt) => {
        const breath = 0.45 + sin(millis() * 0.018) * 0.18;
        noStroke();
        fill(PAL.ink[0], PAL.ink[1], PAL.ink[2], 82);
        circle(pt.x, pt.y, 1.7 + breath);
        fill(PAL.olive[0], PAL.olive[1], PAL.olive[2], 22);
        circle(pt.x, pt.y, 5.5 + breath * 1.6);
      });
      blendMode(BLEND);
      noStroke();
    }

    function drawCenterInvitation() {
      const cx = width / 2;
      const cy = height / 2;
      const active = audioBuffer ? 0 : 1;
      uploadPulse += 0.025;
      const core = audioBuffer ? 2.2 : 4.2 + active * sin(uploadPulse * 2);
      const glow = audioBuffer ? 18 : 78;

      blendMode(BLEND);
      noStroke();
      fill(PAL.mid[0], PAL.mid[1], PAL.mid[2], glow * 0.34);
      circle(cx, cy, 42 + sin(uploadPulse * 0.7) * 7);
      fill(PAL.light[0], PAL.light[1], PAL.light[2], glow * 0.42);
      circle(cx, cy, 18 + sin(uploadPulse) * 3);
      fill(PAL.ink[0], PAL.ink[1], PAL.ink[2], audioBuffer ? 92 : 180);
      circle(cx, cy, core);
      blendMode(BLEND);
    }

    function drawRecorderCore() {
      const x = width / 2;
      const y = height - Math.max(54, height * 0.085);
      const t = millis() * 0.001;
      const hover = controlHeat(x, y);
      const pulse = isRecording ? 8 + sin(t * 8) * 4 : 0;

      blendMode(BLEND);
      noStroke();
      fill(isRecording ? color(PAL.moss[0], PAL.moss[1], PAL.moss[2], 150) : color(PAL.mid[0], PAL.mid[1], PAL.mid[2], 36 + hover * 70));
      circle(x, y, 32 + pulse + hover * 12);
      fill(isRecording ? color(PAL.light[0], PAL.light[1], PAL.light[2], 210) : color(PAL.ink[0], PAL.ink[1], PAL.ink[2], 92 + hover * 70));
      circle(x, y, isRecording ? 9 + sin(t * 10) * 1.5 : 6);

      blendMode(BLEND);
    }

    function effectSwitchPositions() {
      const keys = ["grain", "density", "pitch", "spray"];
      const gap = Math.min(52, Math.max(38, width * 0.06));
      const start = width / 2 - gap * (keys.length - 1) / 2;
      const y = Math.max(34, height * 0.07);
      return keys.map((key, index) => ({ key, x: start + gap * index, y }));
    }

    function drawEffectSwitches() {
      const t = millis() * 0.001;
      effectSwitchPositions().forEach((sw, index) => {
        const on = effects[sw.key];
        const hot = controlHeat(sw.x, sw.y);
        const a = on ? 135 + hot * 70 : 38 + hot * 42;
        const r = on ? 8 + sin(t * 2.4 + index) * 1.1 : 6.2;

        noFill();
        stroke(PAL.ink[0], PAL.ink[1], PAL.ink[2], a);
        strokeWeight(1);

        if (sw.key === "grain") {
          circle(sw.x, sw.y, r * 1.9);
          circle(sw.x, sw.y, r * 0.95);
        } else if (sw.key === "density") {
          for (let i = 0; i < 7; i++) {
            const angle = i * TWO_PI_CONST / 7 + t * 0.25;
            circle(sw.x + cos(angle) * r * 0.78, sw.y + sin(angle) * r * 0.78, on ? 2.2 : 1.4);
          }
        } else if (sw.key === "pitch") {
          line(sw.x, sw.y - r, sw.x, sw.y + r);
          line(sw.x - 4, sw.y - r * 0.45, sw.x, sw.y - r);
          line(sw.x + 4, sw.y + r * 0.45, sw.x, sw.y + r);
        } else if (sw.key === "pan") {
          line(sw.x - r, sw.y, sw.x + r, sw.y);
          circle(sw.x - r * 0.85, sw.y, 3);
          circle(sw.x + r * 0.85, sw.y, 3);
        } else if (sw.key === "spray") {
          for (let i = 0; i < 6; i++) {
            const angle = i * TWO_PI_CONST / 6 + t * 0.18;
            line(sw.x + cos(angle) * 2, sw.y + sin(angle) * 2, sw.x + cos(angle) * r, sw.y + sin(angle) * r);
          }
        } else if (sw.key === "reverse") {
          line(sw.x + r, sw.y - r * 0.7, sw.x - r, sw.y);
          line(sw.x - r, sw.y, sw.x + r, sw.y + r * 0.7);
          line(sw.x - r, sw.y, sw.x - r * 0.2, sw.y - r * 0.55);
        } else if (sw.key === "jitter") {
          for (let i = 0; i < 5; i++) {
            const angle = i * TWO_PI_CONST / 5 + t * 1.1;
            circle(sw.x + cos(angle) * r * (0.35 + (i % 2) * 0.35), sw.y + sin(angle) * r * 0.75, on ? 2.4 : 1.5);
          }
        } else if (sw.key === "filter") {
          line(sw.x - r, sw.y + r * 0.65, sw.x - r * 0.2, sw.y - r * 0.45);
          line(sw.x - r * 0.2, sw.y - r * 0.45, sw.x + r * 0.35, sw.y - r * 0.45);
          line(sw.x + r * 0.35, sw.y - r * 0.45, sw.x + r, sw.y + r * 0.65);
        } else if (sw.key === "shimmer") {
          for (let i = 0; i < 4; i++) {
            const angle = i * TWO_PI_CONST / 4 + t * 0.45;
            line(sw.x, sw.y, sw.x + cos(angle) * r, sw.y + sin(angle) * r);
          }
          circle(sw.x, sw.y, r * 0.7);
        } else if (sw.key === "freeze") {
          rect(sw.x - r * 0.58, sw.y - r * 0.58, r * 1.16, r * 1.16);
          line(sw.x - r * 0.58, sw.y, sw.x + r * 0.58, sw.y);
          line(sw.x, sw.y - r * 0.58, sw.x, sw.y + r * 0.58);
        }

        noStroke();
        fill(on ? PAL.light[0] : PAL.olive[0], on ? PAL.light[1] : PAL.olive[1], on ? PAL.light[2] : PAL.olive[2], on ? 135 : 70);
        circle(sw.x, sw.y, on ? 3.8 : 2.4);
        if (!on) {
          stroke(PAL.olive[0], PAL.olive[1], PAL.olive[2], 110);
          strokeWeight(1);
          line(sw.x - r * 0.9, sw.y + r * 0.9, sw.x + r * 0.9, sw.y - r * 0.9);
          noStroke();
        }
      });
      noStroke();
    }

    function toggleEffectAt(x, y) {
      const hit = effectSwitchPositions().find((sw) => dist(x, y, sw.x, sw.y) < 22);
      if (!hit) return false;
      effects[hit.key] = !effects[hit.key];
      if (controlMeta[hit.key]) controlMeta[hit.key].lastTouched = millis();
      return true;
    }

    function drawTransientText() {
      const now = millis();
      const names = {
        grain: "grain",
        density: "density",
        pitch: "pitch",
        spray: "spray"
      };
      const positions = {
        grain: [Math.max(74, Math.min(width, height) * 0.12), Math.max(74, Math.min(width, height) * 0.12) + 70],
        density: [width - Math.max(74, Math.min(width, height) * 0.12), Math.max(74, Math.min(width, height) * 0.12) + 70],
        pitch: [Math.max(74, Math.min(width, height) * 0.12), height - Math.max(74, Math.min(width, height) * 0.12) - 70],
        spray: [width - Math.max(74, Math.min(width, height) * 0.12), height - Math.max(74, Math.min(width, height) * 0.12) - 70]
      };

      Object.keys(controlMeta).forEach((key) => {
        const age = now - controlMeta[key].lastTouched;
        if (age < 1350) {
          const a = map(age, 0, 1350, 145, 0);
          fill(PAL.ink[0], PAL.ink[1], PAL.ink[2], a);
          textAlign(CENTER, CENTER);
          textSize(10);
          const valueDots = "·".repeat(1 + Math.round(settings[key] * 7));
          text(`${names[key]} ${valueDots}`, positions[key][0], positions[key][1]);
        }
      });
    }

    function touchStarted(event) {
      userStartAudio();
      setPointer("touch", mouseX, mouseY);
      handleWorldPress(mouseX, mouseY);
      return false;
    }

    function touchMoved() {
      setPointer("touch", mouseX, mouseY);
      handleControlTouch(mouseX, mouseY);
      return false;
    }

    function touchEnded() {
      pointers.delete("touch");
      return false;
    }

    function mousePressed() {
      userStartAudio();
      setPointer("mouse", mouseX, mouseY);
      handleWorldPress(mouseX, mouseY);
      return false;
    }

    function mouseDragged() {
      setPointer("mouse", mouseX, mouseY);
      handleControlTouch(mouseX, mouseY);
      return false;
    }

    function mouseMoved() {
      if (!isCoarse) {
        setPointer("mouse", mouseX, mouseY);
      }
    }

    function mouseReleased() {
      if (!isCoarse) pointers.delete("mouse");
      return false;
    }

    function setPointer(id, x, y) {
      pointers.set(id, { x, y, time: millis() });
      firstSoundTouch = true;
    }

    function handleWorldPress(x, y) {
      if (toggleEffectAt(x, y)) {
        return;
      }
      handleControlTouch(x, y, 1);
      if (isRecorderHit(x, y)) {
        toggleRecording();
        return;
      }
      if (dist(x, y, width / 2, height / 2) < 74) {
        openFilePicker();
      }
    }

    function isRecorderHit(x, y) {
      const rx = width / 2;
      const ry = height - Math.max(54, height * 0.085);
      return dist(x, y, rx, ry) < 58;
    }

    function handleControlTouch(x, y, strength = 1) {
      const pad = Math.max(74, Math.min(width, height) * 0.12);
      const zones = {
        grain: { x: pad, y: pad },
        density: { x: width - pad, y: pad },
        pitch: { x: pad, y: height - pad },
        spray: { x: width - pad, y: height - pad }
      };
      Object.entries(zones).forEach(([key, c]) => {
        const d = dist(x, y, c.x, c.y);
        if (d < 172) {
          const pull = (1 - d / 172) * strength;
          const angle = atan2(y - c.y, x - c.x);
          let target;
          if (key === "grain") target = constrain(d / 172, 0, 1);
          if (key === "density") target = constrain(1 - d / 172, 0, 1);
          if (key === "pitch") target = constrain(map(y, height, height - pad * 2.25, 0, 1), 0, 1);
          if (key === "spray") target = constrain(map(d + Math.abs(Math.sin(angle)) * 36, 8, 196, 0, 1), 0, 1);
          settings[key] = lerp(settings[key], target, 0.08 + pull * 0.22);
          controlMeta[key].lastTouched = millis();
        }
      });
    }

    async function userStartAudio() {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = audioCtx.createGain();
        masterCompressor = audioCtx.createDynamicsCompressor();
        masterGain.gain.value = 1.65;
        masterCompressor.threshold.value = -18;
        masterCompressor.knee.value = 18;
        masterCompressor.ratio.value = 3.5;
        masterCompressor.attack.value = 0.004;
        masterCompressor.release.value = 0.18;
        recordingDestination = audioCtx.createMediaStreamDestination();
        masterGain.connect(masterCompressor);
        masterCompressor.connect(audioCtx.destination);
        masterCompressor.connect(recordingDestination);
      }
      if (audioCtx.state !== "running") {
        await audioCtx.resume();
      }
    }

    async function toggleRecording() {
      await userStartAudio();
      if (isRecording) {
        stopRecording();
      } else {
        startRecording();
      }
    }

    function startRecording() {
      if (!window.MediaRecorder || !recordingDestination) {
        message = "recording is not available in this browser";
        messageUntil = millis() + 2600;
        return;
      }
      if (!audioBuffer) {
        message = "feed a sound first, then record";
        messageUntil = millis() + 2200;
        return;
      }

      const options = recordingOptions();
      recordedChunks = [];
      try {
        mediaRecorder = new MediaRecorder(recordingDestination.stream, options);
      } catch (error) {
        mediaRecorder = new MediaRecorder(recordingDestination.stream);
      }

      mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size > 0) recordedChunks.push(event.data);
      });
      mediaRecorder.addEventListener("stop", saveRecording);
      mediaRecorder.start(250);
      isRecording = true;
      recordingStartedAt = millis();
      message = "recording the constellation";
      messageUntil = millis() + 1500;
    }

    function stopRecording() {
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }
      isRecording = false;
      message = "saving recording...";
      messageUntil = millis() + 1600;
    }

    function recordingOptions() {
      const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/aac"
      ];
      for (const mimeType of candidates) {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(mimeType)) {
          return { mimeType };
        }
      }
      return {};
    }

    function saveRecording() {
      if (!recordedChunks.length) {
        message = "nothing was recorded";
        messageUntil = millis() + 2200;
        return;
      }
      const mimeType = mediaRecorder && mediaRecorder.mimeType ? mediaRecorder.mimeType : "audio/webm";
      const blob = new Blob(recordedChunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const extension = mimeType.includes("mp4") || mimeType.includes("aac") ? "m4a" : "webm";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      link.href = url;
      link.download = `constellation-${stamp}.${extension}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      message = "recording saved";
      messageUntil = millis() + 2400;
      recordingStartedAt = millis();
    }

    function openFilePicker() {
      userStartAudio();
      fileInput.value = "";
      fileInput.click();
    }

    async function handleFileSelect(event) {
      const file = event.target.files && event.target.files[0];
      if (file) await loadAudioFile(file);
    }

    async function handleDrop(event) {
      event.preventDefault();
      const file = event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) {
        await userStartAudio();
        await loadAudioFile(file);
      }
    }

    async function loadAudioFile(file) {
      try {
        message = "listening...";
        messageUntil = millis() + 1200;
        const arrayBuffer = await file.arrayBuffer();
        await userStartAudio();
        audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
        loadedName = file.name.replace(/\.[^.]+$/, "");
        chopAudio();
        reassignSlices();
        message = loadedName ? `${loadedName} lives in the cloud` : "sound lives in the cloud";
        messageUntil = millis() + 2600;
      } catch (error) {
        console.error(error);
        message = "this sound could not be opened";
        messageUntil = millis() + 2600;
      }
    }

    function chopAudio() {
      if (!audioBuffer) return;
      const count = constrain(Math.round(map(audioBuffer.duration, 0.4, 180, 128, TARGET_SLICES)), 128, isCoarse ? 256 : 512);
      const sliceDuration = audioBuffer.duration / count;
      slices = [];
      for (let i = 0; i < count; i++) {
        slices.push({
          start: i * sliceDuration,
          duration: Math.max(0.012, Math.min(sliceDuration, audioBuffer.duration - i * sliceDuration))
        });
      }
    }

    function reassignSlices() {
      if (!slices.length) return;
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        const normalizedX = (p.x / (Math.min(width, height) * 0.37) + 1) * 0.5;
        const band = Math.floor(normalizedX * slices.length);
        p.slice = (band + Math.floor(Math.random() * 9)) % slices.length;
      }
    }

    function windowResized() {
      resizeCanvas(windowWidth, windowHeight);
      initParticles();
      reassignSlices();
    }

    function keyPressed() {
      if (key === " " || key === "Enter") openFilePicker();
      if (key === "r" || key === "R") toggleRecording();
    }
