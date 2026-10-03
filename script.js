// ================================================================
// SANCTORUM.AI — Video Scroll Controller
//
// Core fix: video.currentTime is expensive. Browsers decode a
// new frame on every seek. Calling it on every raw ScrollTrigger
// onUpdate callback (which fires at 60fps during fast scrolling)
// overwhelms the video decoder, causing the "stuck/stuttering"
// symptom particularly visible in the latter half of videos where
// the decoder has more work to do.
//
// Solution: RAF-batched seek scheduler per video.
// ScrollTrigger onUpdate only sets a targetTime variable.
// A single requestAnimationFrame loop drains the target once per
// display frame, only if the target actually changed by > 1 frame.
// This gives smooth seek behaviour at 60fps without overloading
// the decoder pipeline.
// ================================================================

gsap.registerPlugin(ScrollTrigger);

// Keep references to prevent duplicate initialization
const _scrubInstances = {};

// ----------------------------------------------------------------
// Entry point — called after window load so all layout is settled
// ----------------------------------------------------------------
window.addEventListener("load", () => {
  initIntroOverlay();
  initNavHighlight();
  initAmbientSound();
});

// ================================================================
// 1. INTRO OVERLAY — Intro.mp4 (plays normally; not scrubbed)
// ================================================================
function initIntroOverlay() {
  const screen   = document.getElementById("introScreen");
  const video    = document.getElementById("introVideo");
  const enterBtn = document.getElementById("enterBtn");
  const skipBtn  = document.getElementById("skipBtn");
  const bar      = document.getElementById("introProgressBar");

  if (!screen || !video) {
    // No intro — boot scroll systems immediately
    bootScrollSystems();
    return;
  }

  // Prevent page scroll during intro
  document.body.style.overflow = "hidden";

  video.muted = true;
  video.play().catch(() => {
    // Browser blocked autoplay — Enter button is visible fallback
  });

  video.addEventListener("timeupdate", () => {
    if (video.duration && isFinite(video.duration)) {
      if (bar) bar.style.width = ((video.currentTime / video.duration) * 100) + "%";
    }
  });

  video.addEventListener("ended", dismiss);
  if (enterBtn) enterBtn.addEventListener("click", dismiss);
  if (skipBtn)  skipBtn.addEventListener("click",  dismiss);

  function dismiss() {
    if (screen.classList.contains("is-dismissed")) return;
    video.pause();
    screen.classList.add("is-dismissed");
    document.body.style.overflow = "";

    // Remove overlay from DOM after CSS animation ends
    screen.addEventListener("animationend", () => screen.remove(), { once: true });

    // Boot scroll systems AFTER overlay is gone so measurements are accurate
    bootScrollSystems();
  }
}

// ================================================================
// 2. SCROLL SYSTEMS — called once, after intro dismissed (or immediately)
// ================================================================
function bootScrollSystems() {
  setupVideoSection({
    sectionId:  "genesis",
    pinId:      "sanctumPin",
    videoId:    "sanctumVideo",
    needleId:   "sanctumNeedle",
    stageAId:   "heroStage",
    stageBId:   "aboutStage"
  });

  setupVideoSection({
    sectionId:  "dimensions",
    pinId:      "mirrorPin",
    videoId:    "mirrorVideo",
    needleId:   "mirrorNeedle",
    stageAId:   "experienceStage",
    stageBId:   "projectsStage"
  });
}

// ================================================================
// 3. CORE VIDEO SECTION SETUP
//    Single ScrollTrigger + seek-chain scheduler per video.
//    Uses fastSeek() where available for keyframe-aware seeking.
//    Seek-chain: after each 'seeked' event, re-applies if target
//    has drifted, preventing decoder stalls on sparse-keyframe video.
// ================================================================
function setupVideoSection({ sectionId, pinId, videoId, needleId, stageAId, stageBId }) {
  const section = document.getElementById(sectionId);
  const pin     = document.getElementById(pinId);
  const video   = document.getElementById(videoId);
  const needle  = document.getElementById(needleId);
  const stageA  = document.getElementById(stageAId);
  const stageB  = document.getElementById(stageBId);

  if (!section || !pin || !video) {
    console.warn("[Sanctorum] Missing DOM:", sectionId);
    return;
  }

  // Kill any previous instance for this section (guards against double-init)
  if (_scrubInstances[sectionId]) {
    _scrubInstances[sectionId].kill?.();
    _scrubInstances[sectionId] = null;
  }

  // ── Video: strictly scrub-only, never autoplays ──────────────────
  video.muted        = true;
  video.defaultMuted = true;
  video.playsInline  = true;
  video.autoplay     = false;
  video.loop         = false;
  video.preload      = "auto";
  video.pause();

  // ── Seek-chain state ─────────────────────────────────────────────
  // targetTime  : the time we WANT the video to be at right now
  // seeking     : true while the video decoder is processing a seek
  // rafPending  : RAF handle for the next frame's seek attempt
  let targetTime  = 0;
  let prevApplied = -1;   // last value actually written to video.currentTime
  let seeking     = false;
  let rafPending  = null;

  // Supports fastSeek (less precise, but respects keyframes — avoids stalls)
  const canFastSeek = typeof video.fastSeek === "function";

  function doSeek(t) {
    const clamped = Math.max(0, Math.min(t, video.duration));
    prevApplied = clamped;
    seeking = true;
    try {
      if (canFastSeek) {
        video.fastSeek(clamped);
      } else {
        video.currentTime = clamped;
      }
    } catch (_) {
      seeking = false;
    }
  }

  // After the decoder finishes a seek, check whether the target has
  // drifted (user scrolled while we were decoding). If so, seek again.
  function onSeeked() {
    seeking = false;
    const delta = Math.abs(targetTime - prevApplied);
    if (delta > 0.033) {       // > 1 frame at 30fps
      doSeek(targetTime);
    }
  }
  video.addEventListener("seeked", onSeeked);

  // RAF-batched entry point: coalesces rapid ScrollTrigger callbacks
  // into a single seek per display frame.
  function scheduleSeek(t) {
    const dur = video.duration;
    if (!dur || !Number.isFinite(dur) || dur <= 0) return;

    targetTime = Math.max(0, Math.min(t, dur));

    if (rafPending !== null) return;  // already queued

    rafPending = requestAnimationFrame(() => {
      rafPending = null;
      if (seeking) return;          // decoder busy — onSeeked will re-apply
      const delta = Math.abs(targetTime - prevApplied);
      if (delta < 0.01) return;     // sub-frame change, skip
      doSeek(targetTime);
    });
  }

  // ── Initialize: reveal first frame ───────────────────────────────
  function showFirstFrame() {
    scheduleSeek(0.001);
  }

  // ── Build ScrollTrigger only after metadata is ready ─────────────
  function initScrollTrigger() {
    // Clean up again in case of a race (e.g. loadedmetadata fired twice)
    if (_scrubInstances[sectionId]) {
      _scrubInstances[sectionId].kill?.();
      _scrubInstances[sectionId] = null;
    }

    showFirstFrame();

    // 2.2× viewport scroll travel: enough to cover full video duration
    // while giving comfortable scroll pacing.
    const scrollTravel = () => Math.round(window.innerHeight * 2.2);

    const st = ScrollTrigger.create({
      trigger:       section,
      start:         "top top",
      end:           () => "+=" + scrollTravel(),
      pin:           pin,
      pinSpacing:    true,
      scrub:         true,
      anticipatePin: 1,

      onUpdate(self) {
        const p = self.progress;  // 0.0 → 1.0

        // ── Video seek ───────────────────────────────────────────
        const dur = video.duration;
        if (dur && Number.isFinite(dur)) {
          scheduleSeek(p * dur);
        }

        // ── HUD ──────────────────────────────────────────────────
        if (needle) {
          needle.style.top = (p * 70) + "%";
        }

        // ── Stage A: Hero / Experience ───────────────────────────
        // Visible 0%–38%, fades out 38%–52%
        if (stageA) {
          if (p <= 0.38) {
            stageA.style.opacity       = "1";
            stageA.style.transform     = "translateY(0px)";
            stageA.style.pointerEvents = "auto";
          } else if (p < 0.52) {
            const t = (p - 0.38) / 0.14;
            stageA.style.opacity       = String(1 - t);
            stageA.style.transform     = `translateY(${-24 * t}px)`;
            stageA.style.pointerEvents = "none";
          } else {
            stageA.style.opacity       = "0";
            stageA.style.pointerEvents = "none";
          }
        }

        // ── Stage B: About / Projects ────────────────────────────
        // Hidden 0%–52%, fades in 52%–68%, visible 68%–100%
        if (stageB) {
          if (p <= 0.52) {
            stageB.style.opacity       = "0";
            stageB.style.transform     = "translateY(24px)";
            stageB.style.pointerEvents = "none";
          } else if (p < 0.68) {
            const t = (p - 0.52) / 0.16;
            stageB.style.opacity       = String(t);
            stageB.style.transform     = `translateY(${24 * (1 - t)}px)`;
            stageB.style.pointerEvents = t > 0.5 ? "auto" : "none";
          } else {
            stageB.style.opacity       = "1";
            stageB.style.transform     = "translateY(0px)";
            stageB.style.pointerEvents = "auto";
          }
        }
      }
    });

    _scrubInstances[sectionId] = {
      kill() {
        st.kill();
        video.removeEventListener("seeked", onSeeked);
        if (rafPending !== null) {
          cancelAnimationFrame(rafPending);
          rafPending = null;
        }
      }
    };
  }

  // Guard: only initialize once metadata (and therefore duration) is ready.
  if (video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0) {
    initScrollTrigger();
  } else {
    video.addEventListener("loadedmetadata", initScrollTrigger, { once: true });
    video.load();
  }
}

// ================================================================
// 4. NAVIGATION ACTIVE STATE
// ================================================================
function initNavHighlight() {
  const links = document.querySelectorAll(".nav-link[data-section]");
  if (!links.length) return;

  const sectionMap = [
    { key: "genesis",       el: document.getElementById("genesis")       },
    { key: "essence",       el: document.getElementById("genesis")       }, // same container
    { key: "dimensions",    el: document.getElementById("dimensions")    },
    { key: "constellation", el: document.getElementById("constellation") },
    { key: "transmit",      el: document.getElementById("transmit")      },
  ];

  function onScroll() {
    const scrollMid = window.scrollY + window.innerHeight * 0.4;
    let active = null;

    for (const { key, el } of sectionMap) {
      if (!el) continue;
      if (scrollMid >= el.offsetTop && scrollMid < el.offsetTop + el.offsetHeight) {
        active = key;
      }
    }

    links.forEach(link => {
      link.classList.toggle("is-active", link.dataset.section === active);
    });
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

// ================================================================
// 5. CONTACT FORM
// ================================================================
function handleFormSubmit() {
  const btn     = document.getElementById("submitBtn");
  const success = document.getElementById("formSuccess");

  if (!btn) return;

  const label = btn.querySelector(".btn-text");
  btn.disabled = true;
  if (label) label.textContent = "Sending…";

  setTimeout(() => {
    if (label) label.textContent = "Sent ✓";
    btn.style.background = "#00e599";
    btn.style.color = "#04060d";
    if (success) success.classList.remove("hidden");
  }, 700);
}
window.handleFormSubmit = handleFormSubmit;

// ================================================================
// 6. AMBIENT TONE (Web Audio API — no external file needed)
// ================================================================
function initAmbientSound() {
  const toggle = document.getElementById("soundToggle");
  const label  = document.getElementById("auraLabel");
  if (!toggle) return;

  let active = false;
  let ctx, gainNode, osc1, osc2;

  toggle.addEventListener("click", () => {
    if (!active) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        ctx      = new AC();
        gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(0, ctx.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.04, ctx.currentTime + 1.5);
        gainNode.connect(ctx.destination);

        osc1 = ctx.createOscillator();
        osc1.type = "sine"; osc1.frequency.value = 108;
        osc1.connect(gainNode); osc1.start();

        osc2 = ctx.createOscillator();
        osc2.type = "sine"; osc2.frequency.value = 162;
        osc2.connect(gainNode); osc2.start();

        active = true;
        if (label) label.textContent = "AURA ON";
      } catch (e) { /* Audio API not available */ }
    } else {
      if (gainNode && ctx) {
        gainNode.gain.setValueAtTime(gainNode.gain.value, ctx.currentTime);
        gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.8);
        setTimeout(() => {
          ctx.close();
          active = false;
          if (label) label.textContent = "AURA OFF";
        }, 900);
      }
    }
  });
}
