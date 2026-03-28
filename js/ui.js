let countdown;

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
                document.getElementById('counter').innerText = `SELECTED: ${currentSelections.length} / 10`;
                document.getElementById('confirm-btn').disabled = (currentSelections.length !== 10);
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
    document.getElementById('counter').innerText = "SELECTED: 0 / 10";
    document.getElementById('confirm-btn').disabled = true;

    // Grab a FRESH 40 for Player 2 (if in Random mode)
    if (currentVariant === 'random') {
        refreshLibraryUI();
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
        const grid = document.getElementById(`${p}-grid`);
        if (!grid) return;
        grid.innerHTML = '';
        for (let i = 0; i < 5; i++) grid.innerHTML += `<div class="slot keep-slot" id="${p}-grid-keep-${i}"></div>`;
        for (let i = 0; i < 5; i++) grid.innerHTML += `<div class="slot kill-slot" id="${p}-grid-kill-${i}"></div>`;
    });
}

function showRevealPicker() {
    const container = document.getElementById('active-game-container');
    document.getElementById('action-btns').style.display = 'none';

    const attackerRole = gameState.turn; // 'p1' or 'p2'
    const opponentRole = (attackerRole === 'p1') ? 'p2' : 'p1';

    // Check if I am the one who should be picking
    const isMyTurnToPick = (myRoomData.isOnline) ? (myIdentity === attackerRole) : true;

    if (isMyTurnToPick) {
        const targetName = getPlayerName(opponentRole);
        document.getElementById('duel-status').innerText = `REVEAL A GAME FOR ${targetName}`;

        container.className = "centered-grid";
        container.innerHTML = '';

        let list = (attackerRole === 'p1') ? gameState.player1.draftedForP2 : gameState.player2.draftedForP1;

        list.forEach((gameId, index) => {
            const game = masterGameLibrary.find(g => g.id === gameId);
            const card = document.createElement('div');
            card.className = 'reveal-choice-card';
            card.style.opacity = "1";
            card.innerHTML = `<img src="${game.background_image}"><div class="reveal-card-label">${game.name}</div>`;

            card.onclick = () => {
                list.splice(index, 1);
                if (myRoomData.isOnline) {
                    socket.emit('reveal-game', { roomId: myRoomData.roomId, game: game });
                } else {
                    startDecisionTurn(game);
                }
            };
            container.appendChild(card);
        });
        startGlobalTimer(15, () => {
            // Only the person who is supposed to pick triggers the random choice
            if (isMyTurnToPick) {
                const idx = Math.floor(Math.random() * list.length);
                const game = masterGameLibrary.find(g => g.id === list[idx]);
                list.splice(idx, 1);

                if (myRoomData.isOnline && socket) {
                    socket.emit('reveal-game', { roomId: myRoomData.roomId, game: game });
                } else {
                    startDecisionTurn(game);
                }
            }
        });
    } else {
        // I am watching the opponent pick
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
            } else {
                handleChoice(forcedChoice, game);
            }
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
        // Only the defender sends this. The server will tell everyone the result.
        socket.emit('decision-made', { roomId: myRoomData.roomId, choice: choice, game: game });
    } else {
        // Local mode
        handleChoice(choice, game);
    }
}

// --- THE CORE FIX ---
function handleChoice(choice, game) {
    if (countdown) clearInterval(countdown);

    const attackerRole = gameState.turn;
    const defenderRole = (attackerRole === 'p1') ? 'p2' : 'p1';
    let defenderData = (attackerRole === 'p1') ? gameState.player2 : gameState.player1;

    // We trust 'choice' here because it was validated before being sent/called
    if (choice === 'keep') {
        defenderData.keeps.push(game);
        updateVisualGrid(defenderRole, 'keep', game, defenderData.keeps.length - 1);
    } else {
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
        slot.innerHTML = `<img src="${game.background_image}" style="animation: slamReveal 0.3s ease; width:100%; height:100%; object-fit:cover;">`;
    }
}

function showModal(title, message) {
    const modal = document.getElementById('custom-modal');
    document.getElementById('modal-title').innerText = title;
    document.getElementById('modal-message').innerText = message;
    modal.style.display = 'flex';

    // Dim music slightly for the modal
    const originalVol = music.volume;
    music.volume = originalVol * 0.5;

    document.getElementById('modal-close-btn').onclick = () => {
        modal.style.display = 'none';
        music.volume = originalVol; // Restore volume
    };
}


function resetGameToMenu() {
    gameState.phase = "drafting";
    gameState.turn = "p1";
    gameState.player1 = { draftedForP2: [], keeps: [], kills: [] };
    gameState.player2 = { draftedForP1: [], keeps: [], kills: [] };
    currentSelections = [];

    // ADDED NULL CHECKS FOR ALL UI UPDATES
    const counter = document.getElementById('counter');
    if (counter) counter.innerText = "SELECTED: 0 / 10";

    const confirmBtn = document.getElementById('confirm-btn');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.innerText = "CONFIRM DRAFT";
        confirmBtn.style.pointerEvents = "auto";
    }

    const indicator = document.getElementById('turn-indicator');
    if (indicator) indicator.innerText = "PLAYER 1: DRAFT 10 GAMES";

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
}

document.getElementById('confirm-btn').onclick = handleConfirm;

document.getElementById('open-games-btn').onclick = () => {
    document.getElementById('modal-game-selection').style.display = 'flex';
};

document.getElementById('open-online-btn').onclick = () => {
    // Start the socket connection only when the user wants to play online
    if (typeof connectMultiplayer === "function") connectMultiplayer();

    document.getElementById('modal-online-rooms').style.display = 'flex';
};
document.getElementById('mode-keep-kill').onclick = () => {
    closeModals();
    document.getElementById('modal-variant-selection').style.display = 'flex';
};

document.getElementById('variant-random').onclick = () => {
    currentVariant = 'random';
    closeModals();
    document.getElementById('modal-game-selection').style.display = 'flex';
    document.getElementById('sub-mode-selection').style.display = 'block';
};

document.getElementById('variant-search').onclick = () => {
    currentVariant = 'search';
    closeModals();
    document.getElementById('modal-game-selection').style.display = 'flex';
    document.getElementById('sub-mode-selection').style.display = 'block';
};

document.getElementById('play-local-btn').onclick = () => {
    myRoomData.isOnline = false;
    closeModals();
    loadGames(); // Starts existing local game
};

document.getElementById('play-online-btn').onclick = () => {
    if (!myRoomData.roomId) return showModal("ERROR", "Make or Join a room first!");
    if (myRoomData.players.length < 2) return showModal("ERROR", "Waiting for Player 2...");

    if (!amILeader) {
        showModal("ACCESS DENIED", "Only the Room Leader (👑) can start the game!");
        return;
    }

    // Send the variant selection to the server
    socket.emit('start-game-request', {
        roomId: myRoomData.roomId,
        variant: currentVariant
    });
};

function closeModals() {
    document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
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
        leaveModal.style.display = 'none';
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
        const currentPlayer = (gameState.turn === 'p1') ? gameState.player1 : gameState.player2;

        if (currentPlayer.rerolls > 0) {
            currentPlayer.rerolls--;

            // Clear current selections to prevent picking non-existent cards
            currentSelections = [];
            const counter = document.getElementById('counter');
            if (counter) counter.innerText = "SELECTED: 0 / 10";
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

    // Guaranteed Text (No more "...")
    if (!myRoomData.isOnline) {
        indicator.innerText = (gameState.turn === 'p1') ? "PLAYER 1: DRAFT 10 GAMES" : "PLAYER 2: DRAFT 10 GAMES";
    } else {
        const opponentName = getPlayerName(myIdentity === 'p1' ? 'p2' : 'p1');
        indicator.innerText = `DRAFTING FOR ${opponentName}`;
    }

    const currentPlayer = (gameState.turn === 'p1') ? gameState.player1 : gameState.player2;
    rrBtn.innerText = `REFRESH LIST (${currentPlayer.rerolls})`;
    rrBtn.disabled = (currentPlayer.rerolls <= 0);
}

// Update this in startPlayer2Draft and resetGameToMenu to reset the button text
function updateRerollButtonUI() {
    const currentPlayer = (gameState.turn === 'p1') ? gameState.player1 : gameState.player2;
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

        // Wait 250ms after the user stops typing to call the API
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
                    <img src="${game.background_image || ''}" onerror="this.src='https://via.placeholder.com/50x50?text=No+Img'">
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

function addGameFromSearch(game) {
    if (!masterGameLibrary.find(g => g.id === game.id)) masterGameLibrary.push(game);
    if (currentSelections.includes(game.id)) return showModal("ALREADY PICKED", "Game already in list.");
    if (currentSelections.length >= 10) return showModal("LIMIT REACHED", "You already have 10 games!");

    currentSelections.push(game.id);
    const card = document.createElement('div');
    card.className = 'game-card selected';
    card.innerHTML = `<img src="${game.background_image}"><h3>${game.name}</h3>`;

    card.onclick = () => {
        const idx = currentSelections.indexOf(game.id);
        if (idx > -1) {
            currentSelections.splice(idx, 1);
            card.remove();
            document.getElementById('counter').innerText = `SELECTED: ${currentSelections.length} / 10`;
            document.getElementById('confirm-btn').disabled = (currentSelections.length !== 10);
        }
    };

    document.getElementById('game-library').appendChild(card);
    document.getElementById('counter').innerText = `SELECTED: ${currentSelections.length} / 10`;
    document.getElementById('confirm-btn').disabled = (currentSelections.length !== 10);
}