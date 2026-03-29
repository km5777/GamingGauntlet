// --- WEB AUDIO API SOUND EFFECTS ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let audioInitialized = false;

// We must unlock AudioContext on first user interaction
['mousedown', 'touchstart', 'keydown'].forEach(evt => {
    window.addEventListener(evt, () => {
        if (!audioInitialized) {
            audioCtx.resume();
            audioInitialized = true;
        }
    }, { once: true, capture: true });
});

// Helper for soft synthetic tones
function playTone(type, freqStart, freqEnd, duration, volLevel = 0.1) {
    if (!audioInitialized || audioCtx.state === 'suspended') return;
    
    // SFX volume is independent (user wants it unmuted by music slider)
    volLevel = volLevel * 1.5;

    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    osc.type = type;
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    const now = audioCtx.currentTime;
    
    osc.frequency.setValueAtTime(freqStart, now);
    if (freqEnd && freqStart !== freqEnd) {
        osc.frequency.exponentialRampToValueAtTime(freqEnd, now + duration);
    }
    
    // Envelope to prevent clipping/pops
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(volLevel, now + 0.05);
    gainNode.gain.setValueAtTime(volLevel, now + duration - 0.05);
    gainNode.gain.linearRampToValueAtTime(0, now + duration);
    
    osc.start(now);
    osc.stop(now + duration);
}

// Helper for noise (good for UI clicks/snaps/percussion)
function playNoise(duration, volLevel = 0.1, lowpassFreq = 2000) {
    if (!audioInitialized || audioCtx.state === 'suspended') return;
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
    gainNode.connect(audioCtx.destination);
    
    noise.start();
}

window.SFX = {
    // Basic Interactions
    hover: () => playTone('sine', 1200, 1600, 0.03, 0.02), // High tick
    cardHover: () => playTone('sine', 500, 800, 0.06, 0.03), // Bubble bloop
    click: () => playTone('triangle', 800, 300, 0.08, 0.05), // Snappy pop

    // Game Logic
    correct: () => {
        playTone('sine', 600, 600, 0.08, 0.06); // Coin get part 1
        setTimeout(() => playTone('sine', 1200, 1200, 0.2, 0.08), 80); // Coin get part 2
    },
    incorrect: () => {
        playTone('triangle', 300, 100, 0.35, 0.07); // Womp womp (large pitch drop)
    },
    rank: () => {
        playTone('sine', 300, 700, 0.12, 0.06); // Boing up!
    },
    keep: () => {
        playTone('sine', 500, 1000, 0.15, 0.06); // Ascending slide
    },
    kill: () => {
        playTone('sawtooth', 400, 50, 0.2, 0.08); // Angry cartoon zip down
        playNoise(0.1, 0.05, 1000); // Small thud
    },

    // Multiplayer
    roomCreate: () => {
        playTone('sine', 400, 600, 0.1, 0.05);
        setTimeout(() => playTone('sine', 600, 900, 0.1, 0.05), 100);
        setTimeout(() => playTone('sine', 900, 1200, 0.2, 0.06), 200); // Magical flourish
    },
    playerJoin: () => playTone('sine', 400, 800, 0.15, 0.06), // Happy zip up
    playerLeave: () => playTone('sine', 800, 400, 0.15, 0.06), // Sad zip down

    // UI State
    popup: () => playTone('sine', 300, 500, 0.15, 0.06), // Bubbly reveal
    openUI: () => playTone('sine', 600, 300, 0.1, 0.05) // Soft closing zipper
};

// Global Automatic Sound Hooks for Clicks & Hovers
// Sound plays exactly ONCE when the cursor enters an interactive element.
// Reset only when the cursor fully leaves that element (mouseout).
let _lastHoverTarget = null;

document.addEventListener('mouseover', (e) => {
    if (!audioInitialized) return;

    // Find the outermost interactive element the cursor is inside
    const btn  = e.target.closest('button, .glow-btn, .cyber-btn, .hl-btn, .choice-btn, .kick-btn');
    const card = !btn && (
                    e.target.closest('.game-card') ||
                    e.target.closest('.reveal-choice-card') ||
                    e.target.closest('.pool-card') ||
                    e.target.closest('.mode-card')
                 );

    const hoverTarget = btn || card;
    if (!hoverTarget) return;

    // Same element as last time — cursor is still inside it, skip
    if (hoverTarget === _lastHoverTarget) return;
    _lastHoverTarget = hoverTarget;

    if (btn)  SFX.hover();
    else      SFX.cardHover();
});

// Clear the tracker when the cursor leaves an interactive element
document.addEventListener('mouseout', (e) => {
    if (!_lastHoverTarget) return;
    const leaving = e.target.closest('button, .glow-btn, .cyber-btn, .hl-btn, .choice-btn, .kick-btn') ||
                    e.target.closest('.game-card, .reveal-choice-card, .pool-card, .mode-card');
    // Only reset if relatedTarget (where cursor went) is NOT inside the same element
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

