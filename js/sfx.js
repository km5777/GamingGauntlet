// --- WEB AUDIO API SOUND EFFECTS ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let audioInitialized = false;

// Dedicated SFX bus — always locked at 1.0, completely isolated from the
// music slider or any GainNode the music pipeline adds to the audio graph.
// All SFX route through sfxBus → audioCtx.destination, never through any
// shared gain node, so the volume slider cannot affect them.
const sfxBus = audioCtx.createGain();
sfxBus.gain.value = 1.0;
sfxBus.connect(audioCtx.destination);

// --- AUDIO CONTEXT SELF-HEALING ---
function tryResumeAudio() {
    if (!audioInitialized) audioInitialized = true;
    if (audioCtx.state !== 'running') audioCtx.resume();
}

// Persistent listeners — fire on every interaction, not just the first one
['mousedown', 'pointerdown', 'touchstart', 'keydown'].forEach(evt => {
    window.addEventListener(evt, tryResumeAudio, { capture: true, passive: true });
});

// Also resume the moment the user switches back to this tab
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && audioInitialized) audioCtx.resume();
});

// Helper for soft synthetic tones
function playTone(type, freqStart, freqEnd, duration, volLevel = 0.1) {
    if (!audioInitialized) return;

    // FIX 1: Do NOT return after resuming. 
    // If the context was suspended (e.g., by your music slider code), 
    // wake it up but keep executing so the sound is actually scheduled!
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }

    // SFX volume is independent (user wants it unmuted by music slider)
    volLevel = volLevel * 1.5;

    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc.type = type;
    osc.connect(gainNode);
    gainNode.connect(sfxBus); // → sfxBus → audioCtx.destination

    const now = audioCtx.currentTime;

    osc.frequency.setValueAtTime(freqStart, now);
    if (freqEnd && freqStart !== freqEnd) {
        osc.frequency.exponentialRampToValueAtTime(freqEnd, now + duration);
    }

    // FIX 2: Dynamic envelope timing. 
    // Prevents DOMExceptions by making sure the ramp time never exceeds the duration itself.
    const rampTime = Math.min(0.05, duration * 0.2); // Uses 20% of duration, capped at 50ms

    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(volLevel, now + rampTime);
    gainNode.gain.setValueAtTime(volLevel, now + duration - rampTime);
    gainNode.gain.linearRampToValueAtTime(0, now + duration);

    osc.start(now);
    osc.stop(now + duration);
}

// Helper for noise (good for UI clicks/snaps/percussion)
function playNoise(duration, volLevel = 0.1, lowpassFreq = 2000) {
    if (!audioInitialized) return;

    // Same fix: wake up, but don't bail out.
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }

    // SFX volume is independent
    volLevel = volLevel * 1.5;

    const bufferSize = audioCtx.sampleRate * duration;
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
    }

    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;

    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = lowpassFreq;

    const gainNode = audioCtx.createGain();
    gainNode.gain.setValueAtTime(volLevel, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);

    noise.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(sfxBus); // → sfxBus → audioCtx.destination

    noise.start();
}

window.SFX = {
    // Basic Interactions
    hover: () => playTone('sine', 1200, 1600, 0.03, 0.02),
    cardHover: () => playTone('sine', 500, 800, 0.06, 0.03),
    click: () => playTone('triangle', 800, 300, 0.08, 0.05),

    // Game Logic
    correct: () => {
        playTone('sine', 600, 600, 0.08, 0.06);
        setTimeout(() => playTone('sine', 1200, 1200, 0.2, 0.08), 80);
    },
    incorrect: () => {
        playTone('triangle', 300, 100, 0.35, 0.07);
    },
    rank: () => {
        playTone('sine', 300, 700, 0.12, 0.06);
    },
    keep: () => {
        playTone('sine', 500, 1000, 0.15, 0.06);
    },
    kill: () => {
        playTone('sawtooth', 400, 50, 0.2, 0.08);
        playNoise(0.1, 0.05, 1000);
    },

    // Multiplayer
    roomCreate: () => {
        playTone('sine', 400, 600, 0.1, 0.05);
        setTimeout(() => playTone('sine', 600, 900, 0.1, 0.05), 100);
        setTimeout(() => playTone('sine', 900, 1200, 0.2, 0.06), 200);
    },
    playerJoin: () => playTone('sine', 400, 800, 0.15, 0.06),
    playerLeave: () => playTone('sine', 800, 400, 0.15, 0.06),

    // UI State
    popup: () => playTone('sine', 300, 500, 0.15, 0.06),
    openUI: () => playTone('sine', 600, 300, 0.1, 0.05)
};

// --- GLOBAL AUTOMATIC SOUND HOOKS ---
let _lastHoverTarget = null;

document.addEventListener('mouseover', (e) => {
    if (!audioInitialized) return; // Prevents "audio explosions" before first click

    const btn = e.target.closest('button, .glow-btn, .cyber-btn, .hl-btn, .choice-btn, .kick-btn');
    const card = !btn && (
        e.target.closest('.game-card') ||
        e.target.closest('.reveal-choice-card') ||
        e.target.closest('.pool-card') ||
        e.target.closest('.mode-card')
    );

    const hoverTarget = btn || card;
    if (!hoverTarget) return;

    if (hoverTarget === _lastHoverTarget) return;
    _lastHoverTarget = hoverTarget;

    if (btn) SFX.hover();
    else SFX.cardHover();
});

document.addEventListener('mouseout', (e) => {
    if (!_lastHoverTarget) return;
    const leaving = e.target.closest('button, .glow-btn, .cyber-btn, .hl-btn, .choice-btn, .kick-btn') ||
        e.target.closest('.game-card, .reveal-choice-card, .pool-card, .mode-card');
    if (leaving && leaving === _lastHoverTarget && !_lastHoverTarget.contains(e.relatedTarget)) {
        _lastHoverTarget = null;
    }
});

document.addEventListener('mousedown', (e) => {
    if (!audioInitialized) return;
    const isInteractive = e.target.closest('button, .glow-btn, .cyber-btn, .hl-btn, .choice-btn') ||
        e.target.closest('.game-card, .reveal-choice-card, .pool-card');
    if (isInteractive) SFX.click();
});