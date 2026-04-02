let countdown;

/**
 * isRevealPickLocked — mutex for the Keep/Kill reveal picker.
 * Whichever fires first (click OR auto-timer) sets this to true.
 * The other path checks it and returns immediately, preventing
 * two games from being spliced and two reveal-game events from firing.
 * Reset to false at the start of every showRevealPicker() call.
 */
let isRevealPickLocked = false;

/**
 * isCCRevealing — prevents the Category Clash reveal button from
 * firing twice if a lag spike delivers two socket events back-to-back.
 * Reset at the top of updateCCPlayerControls() on every re-render.
 */
let isCCRevealing = false;

/**
 * ppControlsAbortController — cleans up PP button event listeners
 * without touching the DOM (replaces the old cloneNode pattern).
 */
let ppControlsAbortController = null;

let music = null;
let volSlider = null;

// This runs once when the page is ready
window.addEventListener('DOMContentLoaded', () => {
    music = document.getElementById('bg-music');
    volSlider = document.getElementById('volume-slider');

    if (volSlider && music) {
        music.volume = volSlider.value;

        volSlider.oninput = (e) => {
            music.volume = e.target.value;
        };
    }
});

// Browsers block auto-music. We start it on the FIRST click anywhere.
window.addEventListener('click', () => {
    if (music && music.paused) {
        music.play().catch(e => console.log("Music blocked by browser settings"));
    }
}, { once: true });



// --- TIMER SYSTEM ---
function startGlobalTimer(seconds, onTimeout) {
    clearInterval(countdown);
    const bar = document.getElementById('timer-bar');
    if (!bar) return;

    // 1. Immediately kill any ongoing transition and fill the bar
    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(1)';

    // 2. THE FIX: Force a DOM Reflow. 
    // This forces the browser to instantly draw the full bar before starting the countdown.
    void bar.offsetWidth;

    // 3. Start the smooth CSS transition shrink
    setTimeout(() => {
        bar.style.transition = `transform ${seconds}s linear`;
        bar.style.transform = 'scaleX(0)';
    }, 50);

    // 4. Start the logic countdown
    let timeLeft = seconds;
    countdown = setInterval(() => {
        timeLeft--;
        if (timeLeft <= 0) {
            clearInterval(countdown);
            if (typeof onTimeout === "function") onTimeout();
        }
    }, 1000);
}

// --- DRAFTING UI ---
function renderGameLibrary(games) {
    const lib = document.getElementById('game-library');
    if (!lib) return;

    // Reset styles that might have been changed by Category Clash
    lib.style.display = '';
    lib.style.flexDirection = '';
    lib.style.width = '';
    lib.style.maxWidth = '';

    lib.innerHTML = '';
    window.scrollTo(0, 0);

    games.forEach((game, index) => {
        const card = document.createElement('div');
        card.className = 'game-card';
        card.style.animation = `slideUpFade 0.4s ease forwards ${index * 0.02}s`;
        card.innerHTML = `<img src="${game.background_image}"><h3>${game.name}</h3>`;
        card.onclick = () => {
            if (toggleGameSelection(game.id)) {
                card.classList.toggle('selected');
                document.getElementById('counter').innerText = `SELECTED: ${currentSelections.length} / ${draftLimit}`;
                document.getElementById('confirm-btn').disabled = (currentSelections.length !== draftLimit);
            }
        };
        lib.appendChild(card);
    });
}

function startPlayer2Draft() {
    gameState.turn = "p2";
    currentSelections = [];

    // THE FIX: Clear the library HTML so P1's cards vanish
    const lib = document.getElementById('game-library');
    if (lib) lib.innerHTML = '';

    updateDraftHeader();
    document.getElementById('counter').innerText = `SELECTED: 0 / ${draftLimit}`;
    document.getElementById('confirm-btn').disabled = true;

    // Grab a FRESH 40 for Player 2 (if in Random mode)
    if (currentVariant === 'random') {
        refreshLibraryUI();
    } else if (gameState.phase === 'category_clash') {
        renderCCDraftGrid();
    }

    window.scrollTo(0, 0);
    showModal("TURN SWAP", "Player 1 Draft Complete! Pass the device to Player 2.");
}

// Add this to resetGameToMenu()
function resetRerolls() {
    gameState.player1.rerolls = 2;
    gameState.player2.rerolls = 2;
    rerollBtn.innerText = `REFRESH LIST (2)`;
    rerollBtn.disabled = false;
}
// --- DUEL UI ---
function startKeepKillPhase() {
    document.getElementById('draft-phase').style.display = 'none';
    document.getElementById('duel-phase').style.display = 'flex';
    setupEmptyGrids();
    showRevealPicker();
}

function setupEmptyGrids() {
    ['p1', 'p2'].forEach(p => {
        const title = document.getElementById(`${p}-status-title`);
        if (title) title.innerText = `${getPlayerName(p).toUpperCase()} STATUS`;

        const grid = document.getElementById(`${p}-grid`);
        if (!grid) return;
        grid.innerHTML = '';
        for (let i = 0; i < 5; i++) grid.innerHTML += `<div class="slot keep-slot" id="${p}-grid-keep-${i}"></div>`;
        for (let i = 0; i < 5; i++) grid.innerHTML += `<div class="slot kill-slot" id="${p}-grid-kill-${i}"></div>`;
    });
}

function showRevealPicker() {
    // Reset the mutex for each new picker round
    isRevealPickLocked = false;

    const container = document.getElementById('active-game-container');
    document.getElementById('action-btns').style.display = 'none';

    const attackerRole = gameState.turn;
    const opponentRole = (attackerRole === 'p1') ? 'p2' : 'p1';
    const isMyTurnToPick = (myRoomData.isOnline) ? (myIdentity === attackerRole) : true;

    if (isMyTurnToPick) {
        const targetName = getPlayerName(opponentRole);
        document.getElementById('duel-status').innerText = `REVEAL A GAME FOR ${targetName}`;

        container.className = 'centered-grid';
        container.innerHTML = '';

        let list = (attackerRole === 'p1') ? gameState.player1.draftedForP2 : gameState.player2.draftedForP1;

        list.forEach((gameId) => {
            const actualId = typeof gameId === 'object' && gameId !== null ? gameId.id : gameId;
            let game = masterGameLibrary.find(g => Number(g.id) === Number(actualId));
            if (!game) {
                game = { id: actualId, name: "Unknown Game", background_image: "" };
            }

            const card = document.createElement('div');
            card.className = 'reveal-choice-card';
            card.style.opacity = '1';
            card.innerHTML = `<img src="${game.background_image}"><div class="reveal-card-label">${game.name}</div>`;

            card.onclick = () => {
                // BUG FIX: isRevealPickLocked prevents the auto-timer from also
                // firing at the exact same moment, which would splice two games
                // and emit two reveal-game events, permanently breaking the round count.
                if (card.dataset.clicked) return;
                if (isRevealPickLocked) return;
                isRevealPickLocked = true;

                card.dataset.clicked = 'true';
                document.querySelectorAll('.reveal-choice-card').forEach(c => c.dataset.clicked = 'true');

                const currentIdx = list.indexOf(gameId);
                if (currentIdx > -1) list.splice(currentIdx, 1);

                if (myRoomData.isOnline) {
                    socket.emit('reveal-game', { roomId: myRoomData.roomId, game });
                }
                startDecisionTurn(game); // FIX: Run locally for online mode too
            };
            container.appendChild(card);
        });

        startGlobalTimer(15, () => {
            if (!isMyTurnToPick) return;
            // BUG FIX: If the player clicked at the last second, the lock is
            // already true — abort the auto-pick so we don't double-splice.
            if (isRevealPickLocked) return;
            isRevealPickLocked = true;

            // Safety: don't splice or emit if the list is somehow empty
            if (!list || list.length === 0) return;

            const idx = Math.floor(Math.random() * list.length);
            const actualId = typeof list[idx] === 'object' && list[idx] !== null ? list[idx].id : list[idx];
            let game = masterGameLibrary.find(g => Number(g.id) === Number(actualId));
            if (!game) {
                game = { id: actualId, name: "Unknown Game", background_image: "" };
            }
            list.splice(idx, 1);

            if (myRoomData.isOnline && socket) {
                socket.emit('reveal-game', { roomId: myRoomData.roomId, game });
            }
            startDecisionTurn(game); // FIX: Run locally for online mode too
        });
    } else {
        document.getElementById('duel-status').innerText = `WAITING FOR ${getPlayerName(attackerRole)} TO PICK...`;
        container.innerHTML = '<div class="spinner"></div>';
        clearInterval(countdown);
    }
}

function startDecisionTurn(game) {
    if (countdown) clearInterval(countdown);

    const attackerRole = gameState.turn;
    const defenderRole = (attackerRole === 'p1') ? 'p2' : 'p1';
    const defenderName = getPlayerName(defenderRole);
    const defenderData = (attackerRole === 'p1') ? gameState.player2 : gameState.player1;

    const isMyTurnToDecide = (myRoomData && myRoomData.isOnline) ? (myIdentity === defenderRole) : true;

    const container = document.getElementById('active-game-container');
    container.className = "duel-main";
    container.innerHTML = `
        <img src="${game.background_image}" class="reveal-image">
        <h2 class="duel-title">${game.name}</h2>
    `;

    if (isMyTurnToDecide) {
        document.getElementById('duel-status').innerText = `${defenderName}: KEEP OR KILL FOR YOURSELF?`;
        document.getElementById('action-btns').style.display = 'flex';

        document.getElementById('keep-btn').onclick = () => handleChoiceWithLimitCheck('keep', game);
        document.getElementById('kill-btn').onclick = () => handleChoiceWithLimitCheck('kill', game);
    } else {
        document.getElementById('duel-status').innerText = `WAITING FOR ${defenderName} TO DECIDE...`;
        document.getElementById('action-btns').style.display = 'none';
    }

    // --- SMART TIMER LOGIC ---
    startGlobalTimer(15, () => {
        if (isMyTurnToDecide) {
            let forcedChoice;
            // If Keeps are full, must Kill. If Kills are full, must Keep.
            if (defenderData.keeps.length >= 5) forcedChoice = 'kill';
            else if (defenderData.kills.length >= 5) forcedChoice = 'keep';
            else forcedChoice = Math.random() > 0.5 ? 'keep' : 'kill';

            if (myRoomData.isOnline && socket) {
                socket.emit('decision-made', { roomId: myRoomData.roomId, choice: forcedChoice, game: game });
            }
            handleChoice(forcedChoice, game);
        }
    });
}

function handleChoiceWithLimitCheck(choice, game) {
    const attackerRole = gameState.turn;
    const defenderData = (attackerRole === 'p1') ? gameState.player2 : gameState.player1;
    const defenderName = getPlayerName((attackerRole === 'p1') ? 'p2' : 'p1');

    // BLOCK ILLEGAL KEEPS
    if (choice === 'keep' && defenderData.keeps.length >= 5) {
        showModal("SLOTS FULL", `${defenderName}, your KEEP slots are full! You must choose KILL.`);
        return;
    }

    // BLOCK ILLEGAL KILLS
    if (choice === 'kill' && defenderData.kills.length >= 5) {
        showModal("SLOTS FULL", `${defenderName}, your KILL slots are full! You must choose KEEP.`);
        return;
    }

    // If we reach here, the move is LEGAL. 
    if (myRoomData.isOnline && socket) {
        socket.emit('decision-made', { roomId: myRoomData.roomId, choice: choice, game: game });
    }
    handleChoice(choice, game);
}

// --- THE CORE FIX ---
function handleChoice(choice, game) {
    if (countdown) clearInterval(countdown);

    const attackerRole = gameState.turn;
    const defenderRole = (attackerRole === 'p1') ? 'p2' : 'p1';
    let defenderData = (attackerRole === 'p1') ? gameState.player2 : gameState.player1;

    // We trust 'choice' here because it was validated before being sent/called
    if (choice === 'keep') {
        if (window.SFX) SFX.keep();
        defenderData.keeps.push(game);
        updateVisualGrid(defenderRole, 'keep', game, defenderData.keeps.length - 1);
    } else {
        if (window.SFX) SFX.kill();
        defenderData.kills.push(game);
        updateVisualGrid(defenderRole, 'kill', game, defenderData.kills.length - 1);
    }

    // Switch Global Turn
    gameState.turn = (gameState.turn === 'p1') ? 'p2' : 'p1';

    const total = gameState.player1.keeps.length + gameState.player1.kills.length +
        gameState.player2.keeps.length + gameState.player2.kills.length;

    if (total === 20) {
        document.getElementById('duel-status').innerText = "GAUNTLET COMPLETE";
        document.getElementById('action-btns').style.display = 'none';

        // Stop any gameplay timers
        if (countdown) clearInterval(countdown);

        showModal("VICTORY", "The Gauntlet has ended! You have survived. Acknowledge to view your final collections.");

        // When they close the modal, the 10-second countdown starts
        document.getElementById('modal-close-btn').onclick = () => {
            document.getElementById('custom-modal').style.display = 'none';
            startEndGameCountdown(10);
        };
    } else {
        showRevealPicker();
    }
}

function updateVisualGrid(playerID, type, game, index) {
    const slotId = `${playerID}-grid-${type}-${index}`;
    const slot = document.getElementById(slotId);
    if (slot) {
        slot.innerHTML = `<img src="${game.background_image || ''}" style="animation: slamReveal 0.3s ease; width:100%; height:100%; object-fit:cover;">`;
    }
}

function showModal(title, message) {
    const modal = document.getElementById('custom-modal');
    if (!modal) return;
    const modalContent = modal.querySelector('.modal-content');

    if (window.SFX) SFX.popup();

    document.getElementById('modal-title').innerText = title;
    document.getElementById('modal-message').innerText = message;
    modal.style.display = 'flex';

    if (modalContent) {
        modalContent.classList.remove('animate-pop-in');
        void modalContent.offsetWidth;
        modalContent.classList.add('animate-pop-in');
    }

    // BUG FIX: music can be null if the modal fires before the user has
    // interacted with the page (e.g. on a network error at startup).
    // A crash here would silently break ALL error handling everywhere.
    let originalVol = 0;
    if (music && !music.paused) {
        originalVol = music.volume;
        music.volume = Math.max(0, originalVol * 0.5);
    }

    document.getElementById('modal-close-btn').onclick = () => {
        closeModalWithAnim(modal);
        if (music && !music.paused) music.volume = originalVol;
    };
}


function resetGameToMenu() {
    // Reset all game-start guards (games.js + multiplayer.js variables)
    if (typeof gameHasStarted !== 'undefined') gameHasStarted = false;
    if (typeof phaseTransitionLock !== 'undefined') phaseTransitionLock = false;
    if (typeof hasReceivedStartDuel !== 'undefined') hasReceivedStartDuel = false;
    if (typeof matchAbortTimer !== 'undefined' && matchAbortTimer) { clearTimeout(matchAbortTimer); matchAbortTimer = null; }
    if (typeof clearHLWatchdog === 'function') clearHLWatchdog();
    if (guestSyncRetryInterval) { clearInterval(guestSyncRetryInterval); guestSyncRetryInterval = null; }


    gameState.phase = "drafting";
    gameState.turn = "p1";
    gameState.player1 = { draftedForP2: [], keeps: [], kills: [], rerolls: 2 };
    gameState.player2 = { draftedForP1: [], keeps: [], kills: [], rerolls: 2 };
    currentSelections = [];


    // ADDED NULL CHECKS FOR ALL UI UPDATES
    const counter = document.getElementById('counter');
    if (counter) counter.innerText = `SELECTED: 0 / ${draftLimit}`;

    const confirmBtn = document.getElementById('confirm-btn');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.innerText = "CONFIRM DRAFT";
        confirmBtn.style.pointerEvents = "auto";
    }

    const indicator = document.getElementById('turn-indicator');
    if (indicator) indicator.innerText = `PLAYER 1: DRAFT ${draftLimit} GAMES`;

    // Hide gameplay, show menu
    const app = document.getElementById('app');
    const duel = document.getElementById('duel-phase');
    const draft = document.getElementById('draft-phase');
    const menu = document.getElementById('main-menu');
    const leaveBtn = document.getElementById('leave-game-btn');

    if (app) app.style.display = 'none';
    if (duel) duel.style.display = 'none';
    if (draft) draft.style.display = 'block';
    if (menu) menu.style.display = 'flex';
    if (leaveBtn) leaveBtn.style.display = 'none'; // Hide leave button on menu

    if (typeof myRoomData !== 'undefined' && myRoomData.isOnline) {
        const lobbyModal = document.getElementById('modal-online-rooms');
        if (lobbyModal) lobbyModal.style.display = 'flex';
    }

    const loadingOverlay = document.getElementById('loading-screen');
    if (loadingOverlay) loadingOverlay.style.display = 'none';

    const hlPhase = document.getElementById('hl-phase');
    if (hlPhase) hlPhase.style.display = 'none';

    const brPhase = document.getElementById('br-phase');
    if (brPhase) brPhase.style.display = 'none';

    const ccPhase = document.getElementById('cc-phase');
    if (ccPhase) ccPhase.style.display = 'none';

    const kcuPhase = document.getElementById('kcu-phase');
    if (kcuPhase) kcuPhase.style.display = 'none';

    const oupPhase = document.getElementById('oup-phase');
    if (oupPhase) oupPhase.style.display = 'none';

    const ppPhase = document.getElementById('pp-phase');
    if (ppPhase) ppPhase.style.display = 'none';

    // Reset Higher Lower scores
    hlState.p1Score = 0;
    hlState.p2Score = 0;
    hlState.roundCount = 0;
}

document.getElementById('confirm-btn').onclick = handleConfirm;

document.getElementById('open-games-btn').onclick = () => {
    if (window.SFX) SFX.openUI();
    document.getElementById('modal-game-selection').style.display = 'flex';
    document.getElementById('modes-grid').style.display = 'block';
    document.getElementById('sub-mode-selection').style.display = 'none';
};

document.getElementById('open-online-btn').onclick = () => {
    if (window.SFX) SFX.openUI();
    // Start the socket connection only when the user wants to play online
    if (typeof connectMultiplayer === "function") connectMultiplayer();

    document.getElementById('modal-online-rooms').style.display = 'flex';
};
function setActiveMode(activeId) {
    const modes = [
        'mode-keep-kill', 'mode-higher-lower', 'mode-blind-ranking',
        'mode-category-clash', 'mode-keep-cut-upgrade', 'mode-oup', 'mode-price-paradox'
    ];
    modes.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            if (id === activeId) el.classList.add('active-mode');
            else el.classList.remove('active-mode');
        }
    });
}

// --- NEW GAME SELECTION NAVIGATION LOGIC ---
let selectionHistory = [];

function showSelectionStep(stepId, title) {
    document.querySelectorAll(".selection-step").forEach(s => s.style.display = "none");
    const targetStep = document.getElementById(stepId);
    if (targetStep) targetStep.style.display = "block";

    const titleEl = document.getElementById("gauntlet-modal-title");
    if (titleEl && title) titleEl.innerText = title;

    const backBtn = document.getElementById("gauntlet-back-btn");
    if (stepId === "step-mode-selection") {
        selectionHistory = [];
        if (backBtn) backBtn.style.display = "none";
        if (titleEl) titleEl.innerText = "SELECT CHALLENGE";
    } else {
        if (backBtn) backBtn.style.display = "block";
        if (!selectionHistory.includes(stepId)) {
            selectionHistory.push(stepId);
        }
    }
}

const gauntletBackBtn = document.getElementById("gauntlet-back-btn");
if (gauntletBackBtn) {
    gauntletBackBtn.onclick = () => {
        if (window.SFX) window.SFX.click();
        selectionHistory.pop();
        const prevStep = selectionHistory[selectionHistory.length - 1] || "step-mode-selection";
        let prevTitle = "SELECT CHALLENGE";
        if (prevStep === "step-pp-variants") prevTitle = "PRICE PARADOX";
        if (prevStep === "step-draft-variants") prevTitle = "PICK YOUR POISON";
        if (prevStep === "step-br-limits") prevTitle = "RANKING LIMITS";
        showSelectionStep(prevStep, prevTitle);
    };
}

document.getElementById('open-games-btn').onclick = () => {
    if (window.SFX) SFX.openUI();
    document.getElementById('modal-game-selection').style.display = 'flex';
    showSelectionStep("step-mode-selection");
};

document.getElementById('mode-keep-kill').onclick = () => {
    if (window.SFX) SFX.click();
    gameState.phase = "drafting";
    draftLimit = 10;
    setActiveMode('mode-keep-kill');
    showSelectionStep("step-draft-variants", "PICK YOUR POISON");
};
document.getElementById('variant-random').onclick = () => {
    if (window.SFX) SFX.click();
    currentVariant = 'random';
    showSelectionStep("step-play-options", "CHOOSE ARENA");
};

// Must be lowercase 'search'
document.getElementById('variant-search').onclick = () => {
    if (window.SFX) SFX.click();
    currentVariant = 'search';
    showSelectionStep("step-play-options", "CHOOSE ARENA");
};

document.getElementById('mode-higher-lower').onclick = () => {
    if (window.SFX) SFX.click();
    gameState.phase = "higher_lower";
    currentVariant = 'random';
    setActiveMode('mode-higher-lower');
    showSelectionStep("step-play-options", "HIGHER / LOWER");
};

const brModeBtn = document.getElementById('mode-blind-ranking');
if (brModeBtn) {
    brModeBtn.onclick = () => {
        if (window.SFX) SFX.click();
        gameState.phase = "blind_ranking";
        currentVariant = 'search';
        setActiveMode('mode-blind-ranking');
        showSelectionStep("step-br-limits", "RANKING LIMITS");
    };
}

const ccModeBtn = document.getElementById('mode-category-clash');
if (ccModeBtn) {
    ccModeBtn.onclick = () => {
        if (window.SFX) SFX.click();
        gameState.phase = "category_clash";
        currentVariant = 'search';
        draftLimit = 5;
        setActiveMode('mode-category-clash');
        showSelectionStep("step-play-options", "CATEGORY CLASH");
    };
}

const kcuModeBtn = document.getElementById('mode-keep-cut-upgrade');
if (kcuModeBtn) {
    kcuModeBtn.onclick = () => {
        if (window.SFX) SFX.click();
        gameState.phase = "keep_cut_upgrade";
        currentVariant = 'search';
        draftLimit = 3;
        setActiveMode('mode-keep-cut-upgrade');
        showSelectionStep("step-play-options", "THE TRINITY VERDICT");
    };
}

const oupModeBtn = document.getElementById('mode-oup');
if (oupModeBtn) {
    oupModeBtn.onclick = () => {
        if (window.SFX) SFX.click();
        gameState.phase = "oup";
        currentVariant = 'search';
        draftLimit = 5;
        setActiveMode('mode-oup');
        showSelectionStep("step-play-options", "THE RATING SCALES");
    };
}

const ppModeBtn = document.getElementById('mode-price-paradox');
if (ppModeBtn) {
    ppModeBtn.onclick = () => {
        if (window.SFX) SFX.click();
        gameState.phase = "price_paradox";
        setActiveMode('mode-price-paradox');
        showSelectionStep("step-pp-variants", "PRICE PARADOX");
    };
}

const ppTacticalBtn = document.getElementById('pp-variant-tactical');
if (ppTacticalBtn) {
    ppTacticalBtn.onclick = () => {
        if (window.SFX) SFX.click();
        currentVariant = 'search';
        draftLimit = 3;
        ppGlobalMode = false;
        showSelectionStep("step-play-options", "THE PRICE PARADOX");
    };
}

const ppGlobalBtn = document.getElementById('pp-variant-global');
if (ppGlobalBtn) {
    ppGlobalBtn.onclick = () => {
        if (window.SFX) SFX.click();
        currentVariant = 'random_10';
        draftLimit = 0;
        ppGlobalMode = true;
        showSelectionStep("step-play-options", "GLOBAL PARADOX");
    };
}

const brLimit5Btn = document.getElementById('br-limit-5');
if (brLimit5Btn) {
    brLimit5Btn.onclick = () => {
        if (window.SFX) SFX.click();
        draftLimit = 5;
        showSelectionStep("step-play-options", "BLIND RANKING");
    };
}

const brLimit10Btn = document.getElementById('br-limit-10');
if (brLimit10Btn) {
    brLimit10Btn.onclick = () => {
        if (window.SFX) SFX.click();
        draftLimit = 10;
        showSelectionStep("step-play-options", "BLIND RANKING");
    };
}

document.getElementById('play-local-btn').onclick = () => {
    myRoomData.isOnline = false;
    if (gameState.phase === 'category_clash') {
        document.getElementById('modal-game-selection').style.display = 'none';
        document.getElementById('modal-category-prompt').style.display = 'flex';
    } else {
        closeModals();
        loadGames();
    }
};

document.getElementById('cc-confirm-setup-btn').onclick = () => {
    const topic = document.getElementById('cc-category-input').value.trim();
    if (!topic || topic.length < 2) return showModal("ERROR", "Please enter a valid category.");

    ccState.category = topic;
    closeModals();

    if (myRoomData.isOnline) {
        socket.emit('start-game-request', {
            roomId: myRoomData.roomId,
            variant: currentVariant,
            phase: gameState.phase,
            limit: draftLimit,
            categoryText: topic
        });
    } else {
        loadGames();
    }
};

document.addEventListener('DOMContentLoaded', () => {
    const beforeBtn = document.getElementById('hl-before-btn');
    const afterBtn = document.getElementById('hl-after-btn');
    if (beforeBtn) beforeBtn.onclick = () => makeHLGuess('before');
    if (afterBtn) afterBtn.onclick = () => makeHLGuess('after');
});

document.getElementById('play-online-btn').onclick = () => {
    if (!myRoomData.roomId) return showModal("ERROR", "No Room!");
    if (myRoomData.players.length < 2) return showModal("ERROR", "Wait for P2");

    if (!amILeader) {
        return showModal("ACCESS DENIED", "Only the Room Leader can start the match!");
    }

    if (gameState.phase === 'category_clash') {
        document.getElementById('modal-game-selection').style.display = 'none';
        document.getElementById('modal-category-prompt').style.display = 'flex';
    } else {
        socket.emit('start-game-request', {
            roomId: myRoomData.roomId,
            variant: currentVariant,
            phase: gameState.phase,
            limit: draftLimit
        });
    }
};

function closeModalWithAnim(modalElement) {
    if (!modalElement || modalElement.style.display === 'none' || modalElement.style.display === '') return;
    const content = modalElement.querySelector('.modal-content');
    if (content) {
        content.classList.remove('animate-pop-in');
        content.classList.add('animate-pop-out');
        setTimeout(() => {
            modalElement.style.display = 'none';
            content.classList.remove('animate-pop-out');
        }, 220);
    } else {
        modalElement.style.display = 'none';
    }
}

function closeModals() {
    document.querySelectorAll('.modal-overlay').forEach(m => closeModalWithAnim(m));
    selectionHistory = []; // Reset when closing
}


function getPlayerName(role) {
    if (!myRoomData || !myRoomData.isOnline) {
        return role === 'p1' ? "PLAYER 1" : "PLAYER 2";
    }
    const p = myRoomData.players.find(pl => pl.role === role);
    return p ? p.name.toUpperCase() : "PLAYER";
}

function startEndGameCountdown(seconds) {
    const container = document.getElementById('endgame-countdown-container');
    const timerNum = document.getElementById('return-timer-num');
    const bar = document.getElementById('endgame-timer-bar');

    container.style.display = 'block';
    let timeLeft = seconds;
    timerNum.innerText = timeLeft;

    // Reset and start bar animation
    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(1)';
    setTimeout(() => {
        bar.style.transition = `transform ${seconds}s linear`;
        bar.style.transform = 'scaleX(0)';
    }, 50);

    const interval = setInterval(() => {
        timeLeft--;
        if (timeLeft >= 0) timerNum.innerText = timeLeft;

        if (timeLeft <= 0) {
            clearInterval(interval);
            container.style.display = 'none';
            resetGameToMenu();
        }
    }, 1000);
}

const leaveGameBtn = document.getElementById('leave-game-btn');
const leaveModal = document.getElementById('modal-leave-confirm');
const confirmLeaveBtn = document.getElementById('confirm-leave-btn');
const cancelLeaveBtn = document.getElementById('cancel-leave-btn');

if (leaveGameBtn) {
    leaveGameBtn.onclick = () => {
        // Show our beautiful custom modal instead of the default browser popup
        leaveModal.style.display = 'flex';
    };
}

if (cancelLeaveBtn) {
    cancelLeaveBtn.onclick = () => {
        // Just hide the modal and go back to the game
        closeModalWithAnim(leaveModal);
    };
}

if (confirmLeaveBtn) {
    confirmLeaveBtn.onclick = () => {
        leaveModal.style.display = 'none';

        // If playing online, tell the server we are leaving the room
        if (typeof myRoomData !== 'undefined' && myRoomData && myRoomData.isOnline && typeof socket !== 'undefined' && socket) {
            socket.emit('leave-room', myRoomData.roomId);
            if (typeof resetLocalRoomState === 'function') resetLocalRoomState();
        }

        // Immediately kick ourselves back to the menu
        if (typeof countdown !== 'undefined') clearInterval(countdown);
        resetGameToMenu();
    };
}

window.addEventListener('DOMContentLoaded', () => {
    const music = document.getElementById('bg-music');
    const volSlider = document.getElementById('volume-slider');

    const savedVol = localStorage.getItem('gauntletVolume');
    if (savedVol !== null && music && volSlider) {
        music.volume = savedVol;
        volSlider.value = savedVol;
    }

    if (volSlider) {
        volSlider.oninput = (e) => {
            const val = e.target.value;
            if (music) music.volume = val;
            localStorage.setItem('gauntletVolume', val);
        };
    }
});

// --- REFRESH / REROLL BUTTON ---
const rerollBtn = document.getElementById('reroll-btn');
if (rerollBtn) {
    rerollBtn.onclick = () => {
        const currentPlayer = (!myRoomData.isOnline) ? ((gameState.turn === 'p1') ? gameState.player1 : gameState.player2) : ((myIdentity === 'p1') ? gameState.player1 : gameState.player2);

        if (currentPlayer.rerolls > 0) {
            currentPlayer.rerolls--;

            // Clear current selections to prevent picking non-existent cards
            currentSelections = [];
            const counter = document.getElementById('counter');
            if (counter) counter.innerText = `SELECTED: 0 / ${draftLimit}`;
            document.getElementById('confirm-btn').disabled = true;

            // Pull a NEW 40 directly from the Master Pool
            refreshLibraryUI();
            updateDraftHeader();
            window.scrollTo(0, 0);
        }
    };
}

function updateDraftHeader() {
    const indicator = document.getElementById('turn-indicator');
    const rrBtn = document.getElementById('reroll-btn');
    if (!indicator || !rrBtn) return;

    // Ensure state exists
    if (!gameState.player1 || !gameState.player2) {
        gameState.player1 = { rerolls: 2 };
        gameState.player2 = { rerolls: 2 };
    }

    if (gameState.phase === 'category_clash') {
        indicator.innerText = `CATEGORY: ${ccState.category ? ccState.category.toUpperCase() : ""}`;
    } else {
        if (!myRoomData.isOnline) {
            indicator.innerText = (gameState.turn === 'p1') ? `PLAYER 1: DRAFT ${draftLimit} GAMES` : `PLAYER 2: DRAFT ${draftLimit} GAMES`;
        } else {
            // Online: Each player is drafting simultaneously for the OTHER player
            const targetRole = (myIdentity === 'p1') ? 'p2' : 'p1';
            const targetName = getPlayerName(targetRole);
            indicator.innerText = `DRAFTING FOR ${targetName}`;
        }
    }

    // In online mode, we are technically always using our own rerolls regardless of the 'global' turn
    const currentPlayer = (!myRoomData.isOnline) ? ((gameState.turn === 'p1') ? gameState.player1 : gameState.player2) : ((myIdentity === 'p1') ? gameState.player1 : gameState.player2);
    rrBtn.innerText = `REFRESH LIST (${currentPlayer.rerolls})`;
    rrBtn.disabled = (currentPlayer.rerolls <= 0);
}

// Update this in startPlayer2Draft and resetGameToMenu to reset the button text
function updateRerollButtonUI() {
    const currentPlayer = (!myRoomData.isOnline) ? ((gameState.turn === 'p1') ? gameState.player1 : gameState.player2) : ((myIdentity === 'p1') ? gameState.player1 : gameState.player2);
    rerollBtn.innerText = `REFRESH LIST (${currentPlayer.rerolls})`;
    rerollBtn.disabled = (currentPlayer.rerolls <= 0);
}

const searchInput = document.getElementById('game-search-input');
const resultsBox = document.getElementById('search-results-dropdown');

let searchTimeout = null;

if (searchInput) {
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value;

        // Clear the previous timer every time the user types
        clearTimeout(searchTimeout);

        if (query.length < 3) {
            resultsBox.innerHTML = '';
            resultsBox.style.display = 'none';
            return;
        }

        // Show a "Searching..." hint immediately for better UX
        resultsBox.style.display = 'block';
        resultsBox.innerHTML = '<div style="padding:15px; color:#8a8d98; font-size:12px;">SEARCHING...</div>';

        // Wait 50ms after the user stops typing to call the API (ultra-fast)
        searchTimeout = setTimeout(async () => {
            const results = await searchRAWG(query);

            // If the user cleared the input while we were waiting for API
            if (searchInput.value.length < 3) {
                resultsBox.style.display = 'none';
                return;
            }

            resultsBox.innerHTML = '';

            if (results.length === 0) {
                resultsBox.innerHTML = '<div style="padding:15px; color:#ff5e62; font-size:12px;">NO GAMES FOUND</div>';
                return;
            }

            results.forEach(game => {
                const div = document.createElement('div');
                div.className = 'search-result-item';
                div.innerHTML = `
                    <img src="${game.background_image || ''}" onerror="this.onerror=null; this.style.backgroundColor='#1a1c24'; this.src='';">
                    <div class="search-result-info">
                        <h4>${game.name}</h4>
                        <p>${game.released ? game.released.split('-')[0] : 'N/A'}</p>
                    </div>
                `;
                div.onclick = () => {
                    addGameFromSearch(game);
                    resultsBox.style.display = 'none';
                    searchInput.value = '';
                };
                resultsBox.appendChild(div);
            });
        }, 250);
    });

    // Close dropdown if user clicks anywhere else
    document.addEventListener('click', (e) => {
        if (e.target !== searchInput && e.target !== resultsBox) {
            resultsBox.style.display = 'none';
        }
    });
}

function renderCCDraftGrid() {
    const lib = document.getElementById('game-library');
    lib.innerHTML = '';
    lib.style.display = 'flex';
    lib.style.flexDirection = 'column';
    lib.style.gap = '15px';
    lib.style.width = '100%';
    lib.style.maxWidth = '600px';

    for (let i = 0; i < 5; i++) {
        const slot = document.createElement('div');
        slot.className = 'br-slot';

        const gameId = currentSelections[i];
        if (gameId) {
            const actualId = typeof gameId === 'object' && gameId !== null ? gameId.id : gameId;
            let game = masterGameLibrary.find(g => Number(g.id) === Number(actualId));
            if (!game) {
                game = { id: actualId, name: "Unknown Game", background_image: "" };
            }
            slot.innerHTML = `
                <div class="br-slot-num">${i + 1}</div>
                <div class="br-slot-content" style="cursor:pointer;" title="Click to remove">
                    <img src="${game.background_image || ''}" style="height: 50px; width: auto; max-width: 80px; object-fit: cover; border-radius: 4px;">
                    <span style="font-size: 14px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-left: 10px; width: 100%; color:var(--text-main); text-align: left;">${game.name}</span>
                </div>
            `;
            slot.onclick = () => {
                currentSelections[i] = null;
                const count = currentSelections.filter(x => x).length;
                document.getElementById('counter').innerText = `SELECTED: ${count} / ${draftLimit}`;
                document.getElementById('confirm-btn').disabled = (count !== draftLimit);
                renderCCDraftGrid();
            };
            slot.style.border = '2px solid var(--accent)';
        } else {
            slot.innerHTML = `<div class="br-slot-num">${i + 1}</div><div class="br-slot-content" style="justify-content:center; color:#8a8d98; font-style:italic;">EMPTY</div>`;
        }
        lib.appendChild(slot);
    }
}

function promptRankSelection(game) {
    if (window.SFX) window.SFX.popup();
    const modal = document.getElementById('modal-cc-rank-chooser');
    if (!modal) return;

    document.getElementById('cc-rank-game-target').innerText = game.name;
    const container = document.getElementById('cc-rank-buttons-container');
    container.innerHTML = '';

    // Ensure array is size 5
    while (currentSelections.length < 5) currentSelections.push(null);

    for (let i = 0; i < 5; i++) {
        const existingId = currentSelections[i];
        let label = `PLACE IN RANK ${i + 1}`;
        let btnCls = 'glow-btn';
        if (existingId) {
            const actualId = typeof existingId === 'object' && existingId !== null ? existingId.id : existingId;
            let extGame = masterGameLibrary.find(g => Number(g.id) === Number(actualId));
            label = `REPLACE RANK ${i + 1} (${extGame ? extGame.name : 'Filled'})`;
            btnCls = 'glow-btn cancel-btn';
        }

        const btn = document.createElement('button');
        btn.className = btnCls;
        btn.style.width = '100%';
        btn.style.textAlign = 'left';
        btn.style.marginBottom = '5px';
        btn.innerText = label;

        btn.onclick = () => {
            currentSelections[i] = game.id;
            const count = currentSelections.filter(x => x).length;
            document.getElementById('counter').innerText = `SELECTED: ${count} / ${draftLimit}`;
            document.getElementById('confirm-btn').disabled = (count !== draftLimit);
            modal.style.display = 'none';
            renderCCDraftGrid();
            if (window.SFX) window.SFX.click();
        };
        container.appendChild(btn);
    }

    modal.style.display = 'flex';
}

function addGameFromSearch(game) {
    if (!masterGameLibrary.find(g => g.id === game.id)) masterGameLibrary.push(game);
    if (currentSelections.includes(game.id)) return showModal("ALREADY PICKED", "Game already in list.");

    if (gameState.phase === 'category_clash') {
        promptRankSelection(game);
    } else {
        if (currentSelections.length >= draftLimit) return showModal("LIMIT REACHED", `You already have ${draftLimit} games!`);
        currentSelections.push(game.id);
        document.getElementById('counter').innerText = `SELECTED: ${currentSelections.length} / ${draftLimit}`;
        document.getElementById('confirm-btn').disabled = (currentSelections.length !== draftLimit);
        const lib = document.getElementById('game-library');
        lib.style.display = '';
        lib.style.flexDirection = '';
        lib.style.width = '';
        lib.style.maxWidth = '';

        const card = document.createElement('div');
        card.className = 'game-card selected';
        card.innerHTML = `<img src="${game.background_image}"><h3>${game.name}</h3>`;

        card.onclick = () => {
            const idx = currentSelections.indexOf(game.id);
            if (idx > -1) {
                currentSelections.splice(idx, 1);
                card.remove();
                document.getElementById('counter').innerText = `SELECTED: ${currentSelections.length} / ${draftLimit}`;
                document.getElementById('confirm-btn').disabled = (currentSelections.length !== draftLimit);
            }
        };

        document.getElementById('game-library').appendChild(card);
    }
}

let isRevealing = false;

function setupHLRound() {
    isRevealing = false;
    // 1. Show the container immediately
    const hlPage = document.getElementById('hl-phase');
    if (hlPage) hlPage.style.display = 'flex';

    // 2. DATA CHECK: If games aren't in hlState yet, stop and wait for the socket
    if (!hlState.currentStandardGame || !hlState.nextGame) {
        console.log("Waiting for data sync...");
        const indicator = document.getElementById('hl-turn-indicator');
        if (indicator) indicator.innerText = "SYNCHRONIZING ARENA...";
        return;
    }

    // 3. APPLY NAMES (Using your logic)
    const p1Name = getPlayerName('p1');
    const p2Name = getPlayerName('p2');
    const label1 = document.getElementById('hl-p1-label');
    const label2 = document.getElementById('hl-p2-label');

    if (label1) label1.innerHTML = `${p1Name}: <span id="hl-p1-score">${hlState.p1Score}</span>`;
    if (label2) label2.innerHTML = `${p2Name}: <span id="hl-p2-score">${hlState.p2Score}</span>`;

    // 4. TURN INDICATOR (Overwrites SYNCING text)
    const activeName = getPlayerName(gameState.turn);
    const turnHeader = document.getElementById('hl-turn-indicator');
    if (turnHeader) turnHeader.innerText = `${activeName.toUpperCase()}'S TURN`;

    // 5. ROUND & FEEDBACK RESET
    const roundNum = document.getElementById('hl-round-num');
    if (roundNum) roundNum.innerText = hlState.roundCount + 1;

    const nextCard = document.getElementById('hl-next-card');
    if (nextCard) nextCard.classList.remove('correct', 'incorrect');

    // 6. RENDER IMAGES (With safety fallbacks)
    const stdImg = document.getElementById('hl-standard-img');
    const nxtImg = document.getElementById('hl-next-img');
    const stdTitle = document.getElementById('hl-standard-name');
    const nxtTitle = document.getElementById('hl-next-name');
    const stdYear = document.getElementById('hl-standard-year');

    if (stdImg) stdImg.src = hlState.currentStandardGame.background_image || "";
    if (nxtImg) nxtImg.src = hlState.nextGame.background_image || "";
    if (stdTitle) stdTitle.innerText = hlState.currentStandardGame.name || "Unknown";
    if (nxtTitle) nxtTitle.innerText = hlState.nextGame.name || "Unknown";

    if (stdYear) {
        const yearValue = hlState.currentStandardGame.released ? hlState.currentStandardGame.released.split('-')[0] : "N/A";
        stdYear.innerText = yearValue;
    }

    // 7. RESET "????" BADGE
    const nextBadge = document.getElementById('hl-next-year');
    if (nextBadge) {
        nextBadge.innerText = "????";
        nextBadge.classList.add('hidden');
    }

    // 8. BUTTON VISIBILITY (Only show for the active player)
    const isMyTurn = (myRoomData.isOnline) ? (myIdentity === gameState.turn) : true;
    const controls = document.getElementById('hl-controls');
    if (controls) controls.style.display = isMyTurn ? 'flex' : 'none';
}


function makeHLGuess(choice) {
    if (isRevealing) return;
    isRevealing = true;

    // BLOCK CLICK IF GAMES ARE MISSING (Prevents the 'released' error)
    if (!hlState.currentStandardGame || !hlState.nextGame) {
        isRevealing = false;
        return;
    }

    const stdYear = hlState.currentStandardGame.released ? parseInt(hlState.currentStandardGame.released.split('-')[0]) : 0;
    const nextYear = hlState.nextGame.released ? parseInt(hlState.nextGame.released.split('-')[0]) : 0;

    const isCorrect = (choice === 'before') ? (nextYear <= stdYear) : (nextYear >= stdYear);

    // Visual Reveal
    const yearBadge = document.getElementById('hl-next-year');
    yearBadge.innerText = nextYear === 0 ? "N/A" : nextYear;
    yearBadge.classList.remove('hidden');

    const nextCard = document.getElementById('hl-next-card');
    if (isCorrect) {
        if (window.SFX) SFX.correct();
        nextCard.classList.add('correct');
        if (gameState.turn === 'p1') hlState.p1Score += 10;
        else hlState.p2Score += 10;
    } else {
        if (window.SFX) SFX.incorrect();
        nextCard.classList.add('incorrect');
    }

    // Update scores in UI
    document.getElementById('hl-p1-score').innerText = hlState.p1Score;
    document.getElementById('hl-p2-score').innerText = hlState.p2Score;

    if (myRoomData.isOnline) {
        socket.emit('hl-guess-sync', {
            roomId: myRoomData.roomId,
            score1: hlState.p1Score,
            score2: hlState.p2Score,
            nextYear: nextYear === 0 ? "N/A" : nextYear,
            isCorrect: isCorrect,
            guesser: myIdentity
        });
    }

    setTimeout(() => {
        // Only the leader (or offline) drives round progression.
        // The guest waits for hl-receive-next from the leader.
        if (!myRoomData.isOnline || amILeader) {
            proceedHL();
        } else {
            // Guest: start watchdog — if hl-receive-next doesn't arrive, request resync
            if (typeof startHLWatchdog === 'function') startHLWatchdog();
        }
    }, 2000);
}

// --- BLIND RANKING LOGIC ---
function startBlindRankingPhase() {
    document.getElementById('draft-phase').style.display = 'none';
    document.getElementById('br-phase').style.display = 'block';

    brState.p1Pool = [...gameState.player2.draftedForP1];
    brState.p2Pool = [...gameState.player1.draftedForP2];
    brState.p1Ranking = new Array(draftLimit).fill(null);
    brState.p2Ranking = new Array(draftLimit).fill(null);

    setupBRGrids();
    if (!myRoomData.isOnline) {
        gameState.turn = 'p1';
        drawNextBRGame('p1');
    } else {
        drawNextBRGame('p1');
        drawNextBRGame('p2');
    }
}

function setupBRGrids() {
    ['p1', 'p2'].forEach(p => {
        const title = document.getElementById(`br-${p}-title`);
        if (title) title.innerText = `${getPlayerName(p).toUpperCase()} RANKING`;

        const slotsContainer = document.getElementById(`br-${p}-slots`);
        slotsContainer.innerHTML = '';

        let isOpponent = false;
        if (myRoomData.isOnline && myIdentity !== p) isOpponent = true;

        for (let i = 0; i < draftLimit; i++) {
            const slot = document.createElement('div');
            slot.className = 'br-slot';
            slot.id = `br-${p}-slot-${i}`;

            if (isOpponent) {
                slot.style.cursor = 'default';
                slot.style.borderStyle = 'solid';
                slot.style.borderColor = 'rgba(255, 255, 255, 0.05)';
                slot.style.pointerEvents = 'none';
            }

            slot.innerHTML = `<div class="br-slot-num">${i + 1}</div><div class="br-slot-content"></div>`;

            slot.onclick = () => {
                if (myRoomData.isOnline && myIdentity !== p) return;
                if (!myRoomData.isOnline && gameState.turn !== p) return;

                if (window.SFX) SFX.rank();
                tryPlaceBRGame(p, i);
            };

            slotsContainer.appendChild(slot);
        }
    });

    document.getElementById('br-p1-title').innerText = getPlayerName('p1') + ' RANKING';
    document.getElementById('br-p2-title').innerText = getPlayerName('p2') + ' RANKING';
}

function drawNextBRGame(role) {
    let pool = role === 'p1' ? brState.p1Pool : brState.p2Pool;
    if (pool.length === 0) {
        if (role === 'p1') brState.p1CurrentGame = null;
        else brState.p2CurrentGame = null;

        if (!myRoomData.isOnline) {
            if (role === 'p1' && gameState.turn === 'p1') {
                gameState.turn = 'p2';
                showModal("TURN SWAP", "Player 1 is done! Pass the device to Player 2.");
                drawNextBRGame('p2');
                return;
            }
        }

        renderBRActiveGame(); // Forces the active card to safely blank out to 'WAITING FOR OPPONENT'
        checkBRFinished();
        return;
    }

    const idx = Math.floor(Math.random() * pool.length);
    const gameId = pool.splice(idx, 1)[0];
    const actualId = typeof gameId === 'object' && gameId !== null ? gameId.id : gameId;
    let gameInfo = masterGameLibrary.find(g => Number(g.id) === Number(actualId));

    if (!gameInfo) {
        gameInfo = { id: actualId, name: "Unknown Game", background_image: "" };
    }

    if (role === 'p1') brState.p1CurrentGame = gameInfo;
    else brState.p2CurrentGame = gameInfo;

    renderBRActiveGame();
}

function renderBRActiveGame() {
    let activeRole = null;
    if (myRoomData.isOnline) {
        activeRole = myIdentity;
    } else {
        activeRole = gameState.turn;
    }

    const game = activeRole === 'p1' ? brState.p1CurrentGame : brState.p2CurrentGame;

    const status = document.getElementById('br-current-status');
    const cardImg = document.getElementById('br-active-img');
    const cardName = document.getElementById('br-active-name');
    const activeReveal = document.getElementById('br-active-reveal');

    if (!game) {
        status.innerText = "WAITING FOR OPPONENT...";
        cardImg.src = '';
        cardName.innerText = '';
        activeReveal.style.opacity = '0.5';
    } else {
        status.innerText = myRoomData.isOnline ? "YOUR NEXT GAME TO RANK:" : `${getPlayerName(activeRole).toUpperCase()}, RANK THIS GAME:`;
        cardImg.src = game.background_image || '';
        cardName.innerText = game.name;
        activeReveal.style.opacity = '1';
    }
}

function tryPlaceBRGame(role, slotIndex) {
    const game = role === 'p1' ? brState.p1CurrentGame : brState.p2CurrentGame;
    if (!game) return;

    let ranking = role === 'p1' ? brState.p1Ranking : brState.p2Ranking;
    if (ranking[slotIndex] !== null) return;

    ranking[slotIndex] = game;
    updateBRSlot(role, slotIndex, game);

    if (myRoomData.isOnline) {
        socket.emit('br-place-game', {
            roomId: myRoomData.roomId,
            role: role,
            slotIndex: slotIndex,
            gameId: game.id
        });
        drawNextBRGame(role);
    } else {
        drawNextBRGame(role);
    }
}

function updateBRSlot(role, slotIndex, game) {
    const slotEl = document.getElementById(`br-${role}-slot-${slotIndex}`);
    if (slotEl) {
        let isMyGrid = false;
        if (myRoomData.isOnline && myIdentity === role) isMyGrid = true;
        if (!myRoomData.isOnline && gameState.turn === role) isMyGrid = true;

        slotEl.querySelector('.br-slot-content').innerHTML = `
            <img src="${game.background_image || ''}" style="height: 50px; width: auto; max-width: 80px; object-fit: cover; border-radius: 4px;">
            <span style="font-size: 14px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-left: 10px; width: 100%; color:var(--text-main);">${game.name}</span>
        `;
        slotEl.style.border = role === 'p1' ? '2px solid var(--neon-p1)' : '2px solid var(--neon-p2)';
        slotEl.style.boxShadow = role === 'p1' ? '0 0 10px rgba(0, 240, 255, 0.5)' : '0 0 10px rgba(255, 0, 255, 0.5)';
        slotEl.style.cursor = 'default';
        if (isMyGrid) slotEl.style.pointerEvents = 'none';
    }
}

function checkBRFinished() {
    const p1Done = brState.p1Ranking.every(slot => slot !== null);
    const p2Done = brState.p2Ranking.every(slot => slot !== null);

    if (p1Done && p2Done) {
        document.getElementById('br-current-status').innerText = "RANKING COMPLETE!";
        document.getElementById('br-active-reveal').innerHTML = '<h2 style="color:var(--neon-p1); font-family:var(--font-head); font-size: 32px; text-align:center; margin-top: 50px; text-shadow: 0 0 15px var(--neon-p1);">ALL DONE!</h2><button class="glow-btn pink" onclick="resetGameToMenu()" style="margin-top:20px;">BACK TO MENU</button>';
    }
}

// --- CATEGORY CLASH LOGIC ---

function startCategoryClashPhase() {
    document.getElementById('draft-phase').style.display = 'none';
    document.getElementById('cc-phase').style.display = 'block';

    const uiTitle = document.getElementById('cc-topic-title');
    if (uiTitle && ccState.category) uiTitle.innerText = ccState.category.toUpperCase();

    setupCCGrids();
    ccState.revealIndex = 4; // Start at bottom of list (rank 5)
    ccState.revealTurn = 'p1';

    updateCCPlayerControls();
    if (window.SFX) window.SFX.popup();
}

function setupCCGrids() {
    ['p1', 'p2'].forEach(p => {
        const slotsContainer = document.getElementById(`cc-${p}-slots`);
        if (!slotsContainer) return;
        slotsContainer.innerHTML = '';

        for (let i = 0; i < 5; i++) {
            const slot = document.createElement('div');
            slot.className = 'br-slot cc-hidden-card';
            slot.id = `cc-${p}-slot-${i}`;

            // Start Hidden
            slot.innerHTML = `<div class="br-slot-num">${i + 1}</div><div class="br-slot-content" style="justify-content:center; color:#8a8d98; font-style:italic;">HIDDEN</div>`;
            slotsContainer.appendChild(slot);
        }
    });
}

function updateCCPlayerControls() {
    // BUG FIX: Reset the reveal lock on every re-render so the button
    // is always interactive after an incoming socket event updates state.
    isCCRevealing = false;

    const isMyTurn = (!myRoomData.isOnline) ? true : (myIdentity === ccState.revealTurn);
    const btn = document.getElementById('cc-reveal-btn');
    const indicator = document.getElementById('cc-turn-indicator');
    if (!btn || !indicator) return;

    if (ccState.revealIndex < 0) {
        indicator.innerText = 'ALL RANKS REVEALED!';
        btn.style.display = 'none';
        if (!document.getElementById('cc-finish-btn')) {
            const finishBtn = document.createElement('button');
            finishBtn.id = 'cc-finish-btn';
            finishBtn.className = 'glow-btn pink';
            finishBtn.innerText = 'BACK TO MENU';
            finishBtn.style.marginTop = '20px';
            finishBtn.onclick = resetGameToMenu;
            indicator.parentNode.appendChild(finishBtn);
        }
        return;
    }

    const rankNum = ccState.revealIndex + 1;
    const actorName = getPlayerName(ccState.revealTurn);

    if (isMyTurn) {
        indicator.innerText = `YOUR TURN TO REVEAL RANK ${rankNum}`;
        btn.innerText = `REVEAL RANK ${rankNum}`;
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.style.display = 'block';

        btn.onclick = () => {
            btn.disabled = true;
            btn.style.opacity = '0.5';

            const draftList = (ccState.revealTurn === 'p1')
                ? gameState.player1.draftedForP2
                : gameState.player2.draftedForP1;
            const gameId = draftList[ccState.revealIndex];

            const data = {
                isCCReveal: true,
                role: ccState.revealTurn,
                index: ccState.revealIndex,
                gameId: gameId
            };

            if (myRoomData.isOnline && socket) {
                socket.emit('hl-guess-sync', {
                    roomId: myRoomData.roomId,
                    ...data
                });
            }

            // FIX: Always apply locally using the synchronized handler
            handleCCRevealSync(data);
        };
    } else {
        indicator.innerText = `WAITING FOR ${actorName.toUpperCase()}...`;
        btn.style.display = 'none';
    }
}

function ccRevealGameVisual(role, idx, game) {
    if (window.SFX) window.SFX.rank();
    const slotEl = document.getElementById(`cc-${role}-slot-${idx}`);
    if (slotEl && game) {
        slotEl.style.animation = 'pop-in 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
        slotEl.classList.remove('cc-hidden-card');
        slotEl.style.backgroundColor = '#1a1c24';
        slotEl.querySelector('.br-slot-content').innerHTML = `
            <img src="${game.background_image || ''}" style="height: 50px; width: auto; max-width: 80px; object-fit: cover; border-radius: 4px;">
            <span style="font-size: 14px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-left: 10px; width: 100%; color:var(--text-main); text-align: left;">${game.name}</span>
        `;
        slotEl.style.border = role === 'p1' ? '2px solid var(--neon-p1)' : '2px solid var(--neon-p2)';
    }
}

function handleCCRevealSync(data) {
    // FIX: Strict guard prevents double-execution if the server echoes the event back
    if (ccState.revealTurn !== data.role || ccState.revealIndex !== data.index) return;

    const actualId = typeof data.gameId === 'object' && data.gameId !== null ? data.gameId.id : data.gameId;
    let game = masterGameLibrary.find(g => Number(g.id) === Number(actualId));
    if (!game) game = { id: actualId, name: "Unknown Game", background_image: "" };

    if (typeof ccRevealGameVisual === 'function') ccRevealGameVisual(data.role, data.index, game);

    if (data.role === 'p1') {
        ccState.revealTurn = 'p2';
    } else {
        ccState.revealTurn = 'p1';
        ccState.revealIndex--;
    }

    if (typeof updateCCPlayerControls === 'function') updateCCPlayerControls();
}

// --- KEEP CUT UPGRADE (KCU) LOGIC ---
let kcuState = {
    p1Choices: { keep: null, cut: null, upgrade: null },
    p2Choices: { keep: null, cut: null, upgrade: null },
    turn: 'p1',
    p1Locked: false,
    p2Locked: false
};

function startKeepCutUpgradePhase() {
    document.getElementById('draft-phase').style.display = 'none';
    const kcuPhase = document.getElementById('kcu-phase');
    if (kcuPhase) kcuPhase.style.display = 'block';

    kcuState = {
        p1Choices: { keep: null, cut: null, upgrade: null },
        p2Choices: { keep: null, cut: null, upgrade: null },
        turn: myRoomData.isOnline ? myIdentity : 'p1',
        p1Locked: false,
        p2Locked: false
    };
    renderKCUBoard();
}

function renderKCUBoard() {
    const container = document.getElementById('kcu-cards-container');
    if (!container) return;
    container.innerHTML = '';

    const isP1Turn = (kcuState.turn === 'p1');
    const listToJudge = isP1Turn ? gameState.player2.draftedForP1 : gameState.player1.draftedForP2;

    document.getElementById('kcu-title').innerText = myRoomData.isOnline ? "FATE'S TRIFECTA" : `PLAYER ${isP1Turn ? 1 : 2}: CHOOSE THEIR FATE`;
    document.getElementById('kcu-subtitle').innerText = "Assign EXACTLY ONE fate to each game.";

    listToJudge.forEach((gameId) => {
        const actualId = typeof gameId === 'object' && gameId !== null ? gameId.id : gameId;
        let game = masterGameLibrary.find(g => Number(g.id) === Number(actualId));
        if (!game) {
            game = { id: actualId, name: "Unknown Game", background_image: "" };
        }

        const card = document.createElement('div');
        card.className = 'game-card br-slot empty';
        card.style.height = '380px';
        card.style.flexDirection = 'column';
        card.style.position = 'relative';
        card.style.cursor = 'default';
        card.style.overflow = 'visible';
        card.style.border = '2px solid var(--border-subtle)';

        card.innerHTML = `
            <img src="${game.background_image || ''}" style="width:100%; height:200px; object-fit:cover; border-radius:5px 5px 0 0;">
            <h3 style="padding:10px; font-size:16px; min-height:40px; margin:0; text-align:center;">${game.name}</h3>
            <div style="flex:1;"></div>
            <div class="kcu-actions" style="display:flex; justify-content:space-between; width:100%; padding: 5px; box-sizing:border-box; gap: 5px;">
                <button class="kcu-btn keep-btn glow-btn" style="flex:1; font-size:10px; padding:8px 0; min-width:0; background:rgba(0,255,100,0.1);" onclick="assignFate('${gameId}', 'keep')">KEEP</button>
                <button class="kcu-btn cut-btn glow-btn" style="flex:1; font-size:10px; padding:8px 0; min-width:0; background:rgba(255,0,0,0.1);" onclick="assignFate('${gameId}', 'cut')">CUT</button>
                <button class="kcu-btn upgrade-btn glow-btn" style="flex:1; font-size:10px; padding:8px 0; min-width:0; background:rgba(255,200,0,0.1);" onclick="assignFate('${gameId}', 'upgrade')">UPGRADE</button>
            </div>
            <div id="kcu-fate-badge-${gameId}" class="fate-badge" style="display:none; position:absolute; top:-15px; right:-15px; padding: 10px; font-size: 20px; border-radius: 50%; box-shadow: 0 0 15px black; z-index: 10;"></div>
        `;

        container.appendChild(card);
    });

    document.getElementById('kcu-confirm-btn').style.display = 'none';
    updateKCUButtons();
}

function assignFate(gameId, fate) {
    if (window.SFX) SFX.click();
    const isP1Turn = (kcuState.turn === 'p1');
    let choices = isP1Turn ? kcuState.p1Choices : kcuState.p2Choices;

    // Remove if already assigned this exact fate
    if (choices[fate] === Number(gameId)) {
        choices[fate] = null;
    } else {
        // Remove this game from any previous fate
        if (choices.keep === Number(gameId)) choices.keep = null;
        if (choices.cut === Number(gameId)) choices.cut = null;
        if (choices.upgrade === Number(gameId)) choices.upgrade = null;

        choices[fate] = Number(gameId);
    }

    updateKCUButtons();
}

function updateKCUButtons() {
    const isP1Turn = (kcuState.turn === 'p1');
    let choices = isP1Turn ? kcuState.p1Choices : kcuState.p2Choices;
    const listToJudge = isP1Turn ? gameState.player2.draftedForP1 : gameState.player1.draftedForP2;

    listToJudge.forEach(gameId => {
        gameId = Number(gameId);
        const fate = choices.keep === gameId ? 'keep' : choices.cut === gameId ? 'cut' : choices.upgrade === gameId ? 'upgrade' : null;
        const badge = document.getElementById(`kcu-fate-badge-${gameId}`);
        if (badge) {
            if (fate) {
                badge.style.display = 'block';
                if (fate === 'keep') { badge.innerText = "🛡️ KEEP"; badge.style.background = "var(--correct)"; badge.style.color = "white"; badge.style.fontSize = "12px"; }
                if (fate === 'cut') { badge.innerText = "❌ CUT"; badge.style.background = "var(--incorrect)"; badge.style.color = "white"; badge.style.fontSize = "12px"; }
                if (fate === 'upgrade') { badge.innerText = "✨ UPGRADE"; badge.style.background = "var(--accent)"; badge.style.color = "white"; badge.style.fontSize = "12px"; }
            } else {
                badge.style.display = 'none';
            }
        }
    });

    const confirmBtn = document.getElementById('kcu-confirm-btn');
    if (choices.keep && choices.cut && choices.upgrade) {
        confirmBtn.style.display = 'block';
    } else {
        confirmBtn.style.display = 'none';
    }
}

document.getElementById('kcu-confirm-btn').onclick = () => {
    if (window.SFX) window.SFX.click();
    document.getElementById('kcu-confirm-btn').style.display = 'none';
    const isP1Turn = (kcuState.turn === 'p1');
    if (myRoomData.isOnline) {
        if (isP1Turn) kcuState.p1Locked = true;
        else kcuState.p2Locked = true;

        const myChoices = isP1Turn ? kcuState.p1Choices : kcuState.p2Choices;

        document.getElementById('kcu-subtitle').innerText = "WAITING ON OPPONENT...";
        document.getElementById('kcu-cards-container').innerHTML = '';

        // Hijack br-place-game
        if (socket) {
            socket.emit('br-place-game', {
                roomId: myRoomData.roomId,
                isKCU: true,
                role: myIdentity,
                choices: myChoices
            });
        }
        checkKCUFinished();
    } else {
        // LOCAL PLAY SWITCH
        if (isP1Turn) {
            kcuState.turn = 'p2';
            renderKCUBoard();
        } else {
            showKCUSummary();
        }
    }
};

function checkKCUFinished() {
    if (kcuState.p1Locked && kcuState.p2Locked) {
        showKCUSummary();
    }
}

function showKCUSummary() {
    document.getElementById('kcu-title').innerText = "THE VERDICTS ARE IN";
    document.getElementById('kcu-subtitle').innerText = "";
    document.getElementById('kcu-confirm-btn').style.display = 'none';

    const container = document.getElementById('kcu-cards-container');
    container.innerHTML = `<div style="display:flex; flex-direction:column; gap: 40px; width: 100%;">
        <div id="kcu-p1-summary" style="display:flex; flex-direction:column; align-items:center;">
             <h3 class="neon-text" style="color:var(--neon-p1); margin-bottom:15px; text-transform:uppercase;">HOW PLAYER 1 JUDGED PLAYER 2'S GAMES</h3>
             <div id="kcu-p1-grid" style="display:flex; gap:20px;"></div>
        </div>
        <div id="kcu-p2-summary" style="display:flex; flex-direction:column; align-items:center;">
             <h3 class="neon-text" style="color:var(--neon-p2); margin-bottom:15px; text-transform:uppercase;">HOW PLAYER 2 JUDGED PLAYER 1'S GAMES</h3>
             <div id="kcu-p2-grid" style="display:flex; gap:20px;"></div>
        </div>
    </div>`;

    const drawSummary = (choices, draftedList, gridId) => {
        const grid = document.getElementById(gridId);
        draftedList.forEach(gameId => {
            const game = masterGameLibrary.find(g => Number(g.id) === Number(gameId));
            if (!game) return;
            const fate = choices.keep === Number(gameId) ? 'keep' : choices.cut === Number(gameId) ? 'cut' : choices.upgrade === Number(gameId) ? 'upgrade' : 'none';

            let badgeHtml = "";
            let borderColor = "var(--border-subtle)";
            if (fate === 'keep') { badgeHtml = "🛡️ KEEP"; borderColor = "var(--correct)"; }
            if (fate === 'cut') { badgeHtml = "❌ CUT"; borderColor = "var(--incorrect)"; }
            if (fate === 'upgrade') { badgeHtml = "✨ UPGRADE"; borderColor = "var(--accent)"; }

            grid.innerHTML += `
               <div class="game-card" style="width:200px; height:280px; flex-direction:column; border: 2px solid ${borderColor}; cursor:default;">
                   <img src="${game.background_image || ''}" style="width:100%; height:120px; object-fit:cover; border-radius:5px 5px 0 0;">
                   <h3 style="padding:10px; font-size:14px; text-align:center;">${game.name}</h3>
                   <div style="flex:1;"></div>
                   <div style="width:100%; padding: 10px; text-align:center; font-weight:bold; background:${borderColor}; color:white;">${badgeHtml}</div>
               </div>
            `;
        });
    };

    // Player 1's choices on games handed by Player 2
    drawSummary(kcuState.p1Choices, gameState.player2.draftedForP1, 'kcu-p1-grid');
    // Player 2's choices on games handed by Player 1
    drawSummary(kcuState.p2Choices, gameState.player1.draftedForP2, 'kcu-p2-grid');

    const endRow = document.createElement('div');
    endRow.style.width = '100%';
    endRow.style.display = 'flex';
    endRow.style.justifyContent = 'center';
    endRow.style.marginTop = '30px';
    const mainBtn = document.createElement('button');
    mainBtn.className = 'glow-btn pink';
    mainBtn.innerText = 'MAIN MENU';
    mainBtn.onclick = () => {
        if (window.SFX) SFX.click();
        resetGameToMenu();
    };
    endRow.appendChild(mainBtn);
    container.appendChild(endRow);
}

// --- OUP (Overrated, Underrated, Perfectly Rated) LOGIC ---
let oupState = {
    turnIndex: 0,
    p1Judgments: [],
    p2Judgments: []
};

function startOUPPhase() {
    document.getElementById('draft-phase').style.display = 'none';
    const oupPhase = document.getElementById('oup-phase');
    if (oupPhase) oupPhase.style.display = 'flex';

    oupState = {
        turnIndex: 0,
        p1Judgments: [],
        p2Judgments: []
    };
    renderOUPBoard();
}

function renderOUPBoard() {
    if (oupState.turnIndex >= 10) {
        showOUPSummary();
        return;
    }

    const isP1Turn = (oupState.turnIndex % 2 === 0);
    const activeJudge = isP1Turn ? 'p1' : 'p2';

    const internalListIndex = Math.floor(oupState.turnIndex / 2);

    const listToJudge = isP1Turn ? gameState.player2.draftedForP1 : gameState.player1.draftedForP2;
    const activeGameId = listToJudge[internalListIndex];
    const actualId = typeof activeGameId === 'object' && activeGameId !== null ? activeGameId.id : activeGameId;
    let game = masterGameLibrary.find(g => Number(g.id) === Number(actualId));

    if (!game) {
        game = { id: actualId, name: "Unknown Game", background_image: "" };
    }

    const titleEl = document.getElementById('oup-title');
    const subtEl = document.getElementById('oup-subtitle');

    if (myRoomData.isOnline) {
        if (myIdentity === activeJudge) {
            titleEl.innerText = "YOUR TURN TO JUDGE";
            subtEl.innerText = "Assign a rating to the game below.";
            titleEl.style.color = (myIdentity === 'p1') ? 'var(--neon-p1)' : 'var(--neon-p2)';
        } else {
            const partnerName = myRoomData.players.find(p => p.role === activeJudge).name;
            titleEl.innerText = `WAITING FOR ${partnerName.toUpperCase()}`;
            subtEl.innerText = "They are currently judging...";
            titleEl.style.color = (activeJudge === 'p1') ? 'var(--neon-p1)' : 'var(--neon-p2)';
        }
    } else {
        titleEl.innerText = `PLAYER ${isP1Turn ? '1' : '2'}: YOUR TURN`;
        subtEl.innerText = "Assign a rating to the game below.";
        titleEl.style.color = isP1Turn ? 'var(--neon-p1)' : 'var(--neon-p2)';
    }

    document.getElementById('oup-active-img').src = game.background_image || '';
    document.getElementById('oup-active-name').innerText = game.name;
    document.getElementById('oup-stamp-container').style.display = 'none';

    const activeCard = document.getElementById('oup-active-card');
    activeCard.style.border = `2px solid ${isP1Turn ? 'var(--neon-p1)' : 'var(--neon-p2)'}`;
    activeCard.style.boxShadow = `0 0 15px ${isP1Turn ? 'var(--neon-p1)' : 'var(--neon-p2)'}`;

    const btnU = document.getElementById('oup-btn-underrated');
    const btnP = document.getElementById('oup-btn-perfect');
    const btnO = document.getElementById('oup-btn-overrated');

    let isMyTurn = !myRoomData.isOnline || myIdentity === activeJudge;

    // Simplified: Reset listeners once, then assign if it's my turn
    [btnU, btnP, btnO].forEach(btn => {
        if (!btn) return;
        btn.style.opacity = isMyTurn ? '1' : '0.5';
        btn.style.cursor = isMyTurn ? 'pointer' : 'not-allowed';
        btn.style.pointerEvents = isMyTurn ? 'auto' : 'none'; // FIX: Re-enable clicking for the active player!
        btn.onclick = null;
    });

    if (isMyTurn) {
        btnU.onclick = () => assignOUPFate('underrated');
        btnP.onclick = () => assignOUPFate('perfect');
        btnO.onclick = () => assignOUPFate('overrated');
    }
}

function assignOUPFate(fate) {
    if (window.SFX) SFX.click();

    // FIX: Disable buttons immediately to prevent double-clicks
    const btnU = document.getElementById('oup-btn-underrated');
    const btnP = document.getElementById('oup-btn-perfect');
    const btnO = document.getElementById('oup-btn-overrated');
    if (btnU) btnU.style.pointerEvents = 'none';
    if (btnP) btnP.style.pointerEvents = 'none';
    if (btnO) btnO.style.pointerEvents = 'none';

    if (myRoomData.isOnline && socket) {
        socket.emit('hl-guess-sync', {
            roomId: myRoomData.roomId,
            isOUP: true,
            actor: myIdentity,
            decision: fate,
            index: oupState.turnIndex
        });
    }
    // FIX: Apply locally
    handleOUPDecisionSync({ actor: myRoomData.isOnline ? myIdentity : (oupState.turnIndex % 2 === 0 ? 'p1' : 'p2'), decision: fate, index: oupState.turnIndex });
}

function handleOUPDecisionSync(data) {
    if (window.SFX && data.actor !== myIdentity) SFX.correct();

    const stampContainer = document.getElementById('oup-stamp-container');
    stampContainer.style.display = 'flex';
    const stamp = document.getElementById('oup-stamp');

    if (data.decision === 'overrated') {
        stamp.innerText = "OVERRATED";
        stamp.style.border = "4px solid var(--incorrect)";
        stamp.style.color = "var(--incorrect)";
    } else if (data.decision === 'underrated') {
        stamp.innerText = "UNDERRATED";
        stamp.style.border = "4px solid var(--neon-p1)";
        stamp.style.color = "var(--neon-p1)";
    } else {
        stamp.innerText = "PERFECTLY RATED";
        stamp.style.border = "4px solid var(--correct)";
        stamp.style.color = "var(--correct)";
    }

    stamp.style.animation = 'none';
    void stamp.offsetWidth;
    stamp.style.animation = 'pop-in 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards';

    const isP1Turn = (data.index % 2 === 0);
    if (isP1Turn) {
        oupState.p1Judgments.push(data.decision);
    } else {
        oupState.p2Judgments.push(data.decision);
    }

    setTimeout(() => {
        oupState.turnIndex++;
        renderOUPBoard();
    }, 2500);
}

function showOUPSummary() {
    const titleEl = document.getElementById('oup-title');
    const subtEl = document.getElementById('oup-subtitle');
    titleEl.innerText = "FINAL RATINGS";
    subtEl.innerText = "How your competitor judged your choices";
    titleEl.style.color = "var(--text-main)";

    document.getElementById('oup-active-card').style.display = 'none';
    document.getElementById('oup-controls').style.display = 'none';

    const container = document.querySelector('#oup-phase .centered-grid');

    let summaryDiv = document.getElementById('oup-summary-div');
    if (!summaryDiv) {
        summaryDiv = document.createElement('div');
        summaryDiv.id = "oup-summary-div";
        summaryDiv.style.width = "100%";
        container.appendChild(summaryDiv);
    }
    summaryDiv.style.display = 'block';

    const p1Name = myRoomData.isOnline ? myRoomData.players.find(p => p.role === 'p1').name.toUpperCase() : "P1";
    const p2Name = myRoomData.isOnline ? myRoomData.players.find(p => p.role === 'p2').name.toUpperCase() : "P2";

    summaryDiv.innerHTML = `<div style="display:flex; flex-direction:column; gap: 40px; width: 100%;">
        <div style="display:flex; flex-direction:column; align-items:center;">
             <h3 class="neon-text" style="color:var(--neon-p1); margin-bottom:15px; text-transform:uppercase;">${p1Name}'S VERDICTS</h3>
             <div id="oup-p1-grid" style="display:flex; gap:15px; flex-wrap:wrap; justify-content:center;"></div>
        </div>
        <div style="display:flex; flex-direction:column; align-items:center;">
             <h3 class="neon-text" style="color:var(--neon-p2); margin-bottom:15px; text-transform:uppercase;">${p2Name}'S VERDICTS</h3>
             <div id="oup-p2-grid" style="display:flex; gap:15px; flex-wrap:wrap; justify-content:center;"></div>
        </div>
    </div>`;

    const drawGrid = (judgments, list, gridId) => {
        const grid = document.getElementById(gridId);
        list.forEach((gameId, i) => {
            const game = masterGameLibrary.find(g => Number(g.id) === Number(gameId));
            if (!game) return;
            const fate = judgments[i];
            let badgeColor = "var(--text-dim)";
            let fateTxt = "---";
            if (fate === 'overrated') { badgeColor = "var(--incorrect)"; fateTxt = "OVERRATED"; }
            if (fate === 'underrated') { badgeColor = "var(--neon-p1)"; fateTxt = "UNDERRATED"; }
            if (fate === 'perfect') { badgeColor = "var(--correct)"; fateTxt = "PERFECT"; }

            grid.innerHTML += `
               <div class="game-card" style="width:140px; height:200px; flex-direction:column; border: 2px solid ${badgeColor}; cursor:default;">
                   <img src="${game.background_image || ''}" style="width:100%; height:80px; object-fit:cover; border-radius:5px 5px 0 0;">
                   <h3 style="padding:5px; font-size:11px; text-align:center;">${game.name}</h3>
                   <div style="flex:1;"></div>
                   <div style="width:100%; padding: 5px; text-align:center; font-weight:bold; background:${badgeColor}; color:white; font-size:10px;">${fateTxt}</div>
               </div>
            `;
        });
    };

    drawGrid(oupState.p1Judgments, gameState.player2.draftedForP1, 'oup-p1-grid');
    drawGrid(oupState.p2Judgments, gameState.player1.draftedForP2, 'oup-p2-grid');

    const endRow = document.createElement('div');
    endRow.style.width = '100%';
    endRow.style.display = 'flex';
    endRow.style.justifyContent = 'center';
    endRow.style.marginTop = '30px';
    const mainBtn = document.createElement('button');
    mainBtn.className = 'glow-btn pink';
    mainBtn.innerText = 'MAIN MENU';
    mainBtn.onclick = () => {
        if (window.SFX) SFX.click();
        resetGameToMenu();
        // Custom reset for OUP phase UI
        document.getElementById('oup-active-card').style.display = 'flex';
        document.getElementById('oup-controls').style.display = 'flex';
        const sumDiv = document.getElementById('oup-summary-div');
        if (sumDiv) sumDiv.style.display = 'none';
    };
    endRow.appendChild(mainBtn);
    summaryDiv.appendChild(endRow);
}

// --- PRICE PARADOX (Buy, Wait for Sale, Skip) LOGIC ---
let ppState_ui = {
    turnIndex: 0,
    p1Judgments: [],
    p2Judgments: []
};

// GLOBAL PARADOX (Variant 2: Random 10) STATE
let ppGlobalMode = false;
let ppRandomIndex = 0;
let ppRandomGames = [];
let ppDecisions = { p1: null, p2: null };

function startPriceParadoxPhase() {
    console.log("Starting Price Paradox Phase (Tactical)...");
    ppGlobalMode = false;
    document.getElementById("draft-phase").style.display = "none";
    const ppPhase = document.getElementById("pp-phase");
    if (ppPhase) ppPhase.style.display = "flex";

    ppState_ui = {
        turnIndex: 0,
        p1Judgments: [],
        p2Judgments: []
    };
    renderPPBoard();
}

function startPPRandomPhase() {
    console.log("Starting Global Paradox Phase (Random 10)...");
    ppGlobalMode = true;
    ppRandomIndex = 0;
    ppDecisions = { p1: null, p2: null };

    // Clear any leftover summary elements to avoid UI stacking
    const sumDiv = document.getElementById("pp-summary-div");
    if (sumDiv) sumDiv.style.display = "none";
    document.getElementById("pp-active-card").style.display = "flex";
    document.getElementById("pp-controls").style.display = "flex";

    // Pick 10 random games from library for both
    if (!myRoomData.isOnline || amILeader) {
        ppRandomGames = shuffleArray([...masterGameLibrary]).slice(0, 10);
        if (myRoomData.isOnline) {
            socket.emit('hl-init-games', { // FIX: Changed from hl-start-game
                roomId: myRoomData.roomId,
                isPP: true,
                games: ppRandomGames
            });
        }
    }

    document.getElementById("draft-phase").style.display = "none";
    const ppPhase = document.getElementById("pp-phase");
    if (ppPhase) ppPhase.style.display = "flex";

    // GUEST GUARD: In online mode, the Guest only proceed if games are synced
    if (myRoomData.isOnline && !amILeader && (!ppRandomGames || ppRandomGames.length === 0)) {
        console.log("Guest is waiting for Global Paradox games to sync...");
        return;
    }

    renderPPBoard();
}

function renderPPBoard() {
    if (ppGlobalMode) {
        renderPPBoardGlobal();
    } else {
        renderPPBoardTactical();
    }
}

function renderPPBoardTactical() {
    if (ppState_ui.turnIndex >= 6) {
        showPPSummary();
        return;
    }

    const isP1Turn = (ppState_ui.turnIndex % 2 === 0);
    const activeJudgeRole = isP1Turn ? "p1" : "p2";

    const internalListIndex = Math.floor(ppState_ui.turnIndex / 2);
    const listToJudge = isP1Turn ? gameState.player2.draftedForP1 : gameState.player1.draftedForP2;
    const activeGameId = listToJudge[internalListIndex];
    const game = masterGameLibrary.find(g => Number(g.id) === Number(activeGameId));

    if (!game) {
        ppState_ui.turnIndex++;
        renderPPBoardTactical();
        return;
    }

    const titleEl = document.getElementById("pp-title");
    const subtEl = document.getElementById("pp-subtitle");
    let isMyTurn = !myRoomData.isOnline || (myIdentity === activeJudgeRole);

    if (myRoomData.isOnline) {
        if (isMyTurn) {
            titleEl.innerText = "VALUATION TIME";
            subtEl.innerText = "Is this game worth its full price?";
            titleEl.style.color = (myIdentity === "p1") ? "var(--neon-p1)" : "var(--neon-p2)";
        } else {
            const partnerName = getPlayerName(activeJudgeRole);
            titleEl.innerText = `WAITING FOR ${partnerName.toUpperCase()}`;
            subtEl.innerText = "They are considering the price tag...";
            titleEl.style.color = (activeJudgeRole === "p1") ? "var(--neon-p1)" : "var(--neon-p2)";
        }
    } else {
        titleEl.innerText = `PLAYER ${isP1Turn ? "1" : "2"}: YOUR DECISION`;
        subtEl.innerText = "Would you buy, wait, or skip?";
        titleEl.style.color = isP1Turn ? "var(--neon-p1)" : "var(--neon-p2)";
    }

    document.getElementById("pp-active-img").src = game.background_image || "";
    document.getElementById("pp-active-name").innerText = game.name;
    document.getElementById("pp-stamp-container").style.display = "none";

    const activeCard = document.getElementById("pp-active-card");
    activeCard.style.border = `2px solid ${isP1Turn ? "var(--neon-p1)" : "var(--neon-p2)"}`;
    activeCard.style.boxShadow = `0 0 15px ${isP1Turn ? "var(--neon-p1)" : "var(--neon-p2)"}`;

    setupPPControls(isMyTurn);
}

function renderPPBoardGlobal() {
    if (ppRandomIndex >= ppRandomGames.length) {
        showPPSummary();
        return;
    }

    const game = ppRandomGames[ppRandomIndex];
    const titleEl = document.getElementById("pp-title");
    const subtEl = document.getElementById("pp-subtitle");

    titleEl.innerText = `GLOBAL PARADOX: ${ppRandomIndex + 1}/10`;
    subtEl.innerText = "Hidden until both decide...";
    titleEl.style.color = "var(--text-main)";

    document.getElementById("pp-active-img").src = game.background_image || "";
    document.getElementById("pp-active-name").innerText = game.name;
    document.getElementById("pp-stamp-container").style.display = "none";

    const activeCard = document.getElementById("pp-active-card");
    activeCard.style.border = "2px solid var(--accent)";
    activeCard.style.boxShadow = "0 0 15px var(--accent-glow)";

    let isMyTurn = false;
    if (myRoomData.isOnline) {
        isMyTurn = ppDecisions[myIdentity] === null;
        if (!isMyTurn) {
            subtEl.innerText = "Waiting for other player...";
        }
    } else {
        // Local mode: Swap logic
        if (ppDecisions.p1 === null) {
            subtEl.innerText = `${getPlayerName('p1')}'S CHOICE`;
            isMyTurn = true;
        } else if (ppDecisions.p2 === null) {
            subtEl.innerText = `${getPlayerName('p2')}'S CHOICE`;
            isMyTurn = true;
        }
    }

    setupPPControls(isMyTurn);
}

function setupPPControls(isEnabled) {
    // BUG FIX: The old approach used cloneNode(true) + replaceChild() to strip
    // old listeners. This destroyed the DOM node mid-click, causing the browser
    // to lose the click event before it reached the new onclick handler.
    // AbortController cleanly detaches listeners without touching the DOM at all.
    if (ppControlsAbortController) ppControlsAbortController.abort();
    ppControlsAbortController = new AbortController();
    const { signal } = ppControlsAbortController;

    const btnB = document.getElementById('pp-btn-buy');
    const btnS = document.getElementById('pp-btn-sale');
    const btnK = document.getElementById('pp-btn-skip');

    [btnB, btnS, btnK].forEach(btn => {
        if (!btn) return;
        btn.style.opacity = isEnabled ? '1' : '0.5';
        btn.style.cursor = isEnabled ? 'pointer' : 'not-allowed';
        btn.disabled = !isEnabled;
    });

    if (isEnabled && btnB && btnS && btnK) {
        btnB.addEventListener('click', () => assignPPFate('buy'), { signal });
        btnS.addEventListener('click', () => assignPPFate('sale'), { signal });
        btnK.addEventListener('click', () => assignPPFate('skip'), { signal });
    }
}

function assignPPFate(fate) {
    if (window.SFX) SFX.click();

    // FIX: Disable buttons immediately to prevent double-clicks
    setupPPControls(false);

    const data = {
        actor: myRoomData.isOnline ? myIdentity : (ppGlobalMode ? (ppDecisions.p1 === null ? 'p1' : 'p2') : (ppState_ui.turnIndex % 2 === 0 ? 'p1' : 'p2')),
        decision: fate,
        index: ppGlobalMode ? ppRandomIndex : ppState_ui.turnIndex,
        isGlobal: ppGlobalMode
    };

    if (myRoomData.isOnline && socket) {
        socket.emit("hl-guess-sync", {
            roomId: myRoomData.roomId,
            isPP: true,
            ...data
        });
    }
    // FIX: Apply locally
    handlePPDecisionSync(data);
}

function handlePPDecisionSync(data) {
    if (ppGlobalMode) {
        handlePPGlobalSync(data);
    } else {
        handlePPTacticalSync(data);
    }
}

function handlePPTacticalSync(data) {
    if (window.SFX && data.actor !== myIdentity) SFX.correct();

    const stampContainer = document.getElementById("pp-stamp-container");
    stampContainer.style.display = "flex";
    const stamp = document.getElementById("pp-stamp");

    applyPPStampStyle(stamp, data.decision);

    stamp.style.animation = "none";
    void stamp.offsetWidth;
    stamp.style.animation = "pop-in 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards";

    if (data.index % 2 === 0) ppState_ui.p1Judgments.push(data.decision);
    else ppState_ui.p2Judgments.push(data.decision);

    setTimeout(() => {
        ppState_ui.turnIndex++;
        renderPPBoard();
    }, 2500);
}

function handlePPGlobalSync(data) {
    ppDecisions[data.actor] = data.decision;
    if (ppDecisions.p1 && ppDecisions.p2) {
        revealPPGlobalDecisions();
    } else {
        renderPPBoard();
    }
}

function revealPPGlobalDecisions() {
    const stampContainer = document.getElementById("pp-stamp-container");
    stampContainer.style.display = "flex";
    stampContainer.innerHTML = ""; // Clear for dual stamps
    stampContainer.style.transform = "none"; // Reset rotation for layout
    stampContainer.style.flexDirection = "column";
    stampContainer.style.gap = "10px";

    const createStamp = (role, decision) => {
        const div = document.createElement("div");
        div.style.fontFamily = "var(--font-head)";
        div.style.fontSize = "22px";
        div.style.fontWeight = "900";
        div.style.background = "rgba(0,0,0,0.8)";
        div.style.padding = "5px 15px";
        div.style.borderRadius = "8px";
        div.style.textTransform = "uppercase";
        div.style.border = "3px solid";

        const pName = getPlayerName(role);
        let color = "#fff";
        let text = "";
        if (decision === 'buy') { color = "#00ff64"; text = "BUY"; }
        if (decision === 'sale') { color = "#ffd700"; text = "SALE"; }
        if (decision === 'skip') { color = "#ff0050"; text = "SKIP"; }

        div.style.borderColor = color;
        div.style.color = color;
        div.innerHTML = `<span style="color:#fff; font-size:12px; display:block;">${pName}</span> ${text}`;
        div.style.animation = "pop-in 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards";
        return div;
    };

    stampContainer.appendChild(createStamp('p1', ppDecisions.p1));
    stampContainer.appendChild(createStamp('p2', ppDecisions.p2));

    if (window.SFX) SFX.correct();

    // Cache results for summary
    ppState_ui.p1Judgments.push(ppDecisions.p1);
    ppState_ui.p2Judgments.push(ppDecisions.p2);

    // Show countdown for NEXT game
    let nextCount = 4;
    const subt = document.getElementById("pp-subtitle");
    if (subt) {
        subt.style.color = "var(--text-dim)";
        subt.innerText = `NEXT GAME IN ${nextCount}...`;
    }

    const nextTimer = setInterval(() => {
        nextCount--;
        if (nextCount > 0) {
            if (subt) subt.innerText = `NEXT GAME IN ${nextCount}...`;
        } else {
            clearInterval(nextTimer);
            ppRandomIndex++;
            ppDecisions = { p1: null, p2: null };
            // Clean up stamp container for next turn
            stampContainer.innerHTML = "";
            renderPPBoard();
        }
    }, 1000);
}

function applyPPStampStyle(stamp, decision) {
    if (decision === 'buy') {
        stamp.innerText = "BUY IT";
        stamp.style.border = "4px solid #00ff64";
        stamp.style.color = "#00ff64";
    } else if (decision === 'sale') {
        stamp.innerText = "WAIT FOR SALE";
        stamp.style.border = "4px solid #ffd700";
        stamp.style.color = "#ffd700";
    } else {
        stamp.innerText = "SKIP IT";
        stamp.style.border = "4px solid #ff0050";
        stamp.style.color = "#ff0050";
    }
}

function showPPSummary() {
    const titleEl = document.getElementById("pp-title");
    const subtEl = document.getElementById("pp-subtitle");
    titleEl.innerText = "MARKET WRAP-UP";
    subtEl.innerText = "The final spending habits revealed";
    titleEl.style.color = "var(--text-main)";

    document.getElementById("pp-active-card").style.display = "none";
    document.getElementById("pp-controls").style.display = "none";

    const container = document.querySelector("#pp-phase .centered-grid");

    let summaryDiv = document.getElementById("pp-summary-div");
    if (!summaryDiv) {
        summaryDiv = document.createElement("div");
        summaryDiv.id = "pp-summary-div";
        summaryDiv.style.width = "100%";
        container.appendChild(summaryDiv);
    }
    summaryDiv.innerHTML = ""; // FULL CLEAR to prevent double-rendering during sync races
    summaryDiv.style.display = "block";

    const p1Name = getPlayerName("p1");
    const p2Name = getPlayerName("p2");

    summaryDiv.innerHTML = `<div style="display:flex; flex-direction:column; gap: 40px; width: 100%;">
        <div style="display:flex; flex-direction:column; align-items:center;">
             <h3 class="neon-text" style="color:var(--neon-p1); margin-bottom:15px; text-transform:uppercase;">${p1Name}'S DECISIONS</h3>
             <div id="pp-p1-grid" style="display:flex; gap:15px; flex-wrap:wrap; justify-content:center;"></div>
        </div>
        <div style="display:flex; flex-direction:column; align-items:center;">
             <h3 class="neon-text" style="color:var(--neon-p2); margin-bottom:15px; text-transform:uppercase;">${p2Name}'S DECISIONS</h3>
             <div id="pp-p2-grid" style="display:flex; gap:15px; flex-wrap:wrap; justify-content:center;"></div>
        </div>
    </div>`;

    const drawGrid = (judgments, list, gridId) => {
        const grid = document.getElementById(gridId);
        if (!list || list.length === 0) return;

        list.forEach((gameIdOrObj, i) => {
            const game = (typeof gameIdOrObj === 'object') ? gameIdOrObj : masterGameLibrary.find(g => Number(g.id) === Number(gameIdOrObj));
            if (!game) return;
            const decision = judgments[i];
            let badgeColor = "var(--text-dim)";
            let decisionTxt = "---";
            if (decision === 'buy') { badgeColor = "#00ff64"; decisionTxt = "BUY IT"; }
            if (decision === 'sale') { badgeColor = "#ffd700"; decisionTxt = "WAIT FOR SALE"; }
            if (decision === 'skip') { badgeColor = "#ff0050"; decisionTxt = "SKIP IT"; }

            grid.innerHTML += `
               <div class="game-card" style="width:140px; height:200px; flex-direction:column; border: 2px solid ${badgeColor}; cursor:default;">
                   <img src="${game.background_image || ""}" style="width:100%; height:80px; object-fit:cover; border-radius:5px 5px 0 0;">
                   <h3 style="padding:5px; font-size:11px; text-align:center;">${game.name}</h3>
                   <div style="flex:1;"></div>
                   <div style="width:100%; padding: 5px; text-align:center; font-weight:bold; background:${badgeColor}; color:white; font-size:10px;">${decisionTxt}</div>
               </div>
            `;
        });
    };

    if (ppGlobalMode) {
        drawGrid(ppState_ui.p1Judgments, ppRandomGames, 'pp-p1-grid');
        drawGrid(ppState_ui.p2Judgments, ppRandomGames, 'pp-p2-grid');
    } else {
        drawGrid(ppState_ui.p1Judgments, gameState.player2.draftedForP1, 'pp-p1-grid');
        drawGrid(ppState_ui.p2Judgments, gameState.player1.draftedForP2, 'pp-p2-grid');
    }

    const endRow = document.createElement("div");
    endRow.style.width = "100%";
    endRow.style.display = "flex";
    endRow.style.justifyContent = "center";
    endRow.style.marginTop = "30px";
    const mainBtn = document.createElement("button");
    mainBtn.className = "glow-btn pink";
    mainBtn.innerText = "MAIN MENU";
    mainBtn.onclick = () => {
        if (window.SFX) SFX.click();
        resetGameToMenu();
        document.getElementById("pp-active-card").style.display = "flex";
        document.getElementById("pp-controls").style.display = "flex";
        const sd = document.getElementById("pp-summary-div");
        if (sd) sd.style.display = "none";
    };
    endRow.appendChild(mainBtn);
    summaryDiv.appendChild(endRow);
}

