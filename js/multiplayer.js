// ─── MULTIPLAYER CORE ────────────────────────────────────────────────────────

let socket = null;
let myIdentity = null;
let amILeader = false;

// Tracks whether we are in an active room / online game
let myRoomData = {
    roomId: null,
    playerName: null,
    isOnline: false,
    players: []
};

/**
 * phaseTransitionLock: Prevents double-fire of phase-starting events.
 * Render.com's free tier can reconnect mid-game and retransmit buffered
 * socket events, causing start-duel-phase to fire twice and wiping state.
 */
let phaseTransitionLock = false;

/**
 * hasReceivedStartDuel: One-shot guard — once start-duel-phase fires,
 * ignore any duplicate. Reset when a new game starts.
 */
let hasReceivedStartDuel = false;

const SERVER_URL = "https://gaminggauntlet.onrender.com";

// ─── CONNECTION BANNER ───────────────────────────────────────────────────────

/**
 * Shows a slim, non-blocking banner at the top of the screen.
 * Auto-dismisses after 4 seconds.
 * @param {string} message
 * @param {'warning'|'error'|'success'} type
 */
function showConnectionBanner(message, type) {
    let banner = document.getElementById('connection-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'connection-banner';
        banner.style.cssText = [
            'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9999',
            'padding:10px 20px', 'text-align:center',
            'font-family:var(--font-head,monospace)', 'font-size:13px',
            'font-weight:700', 'letter-spacing:1px', 'text-transform:uppercase',
            'transition:opacity 0.5s ease', 'opacity:0'
        ].join(';');
        document.body.appendChild(banner);
    }

    const palette = {
        warning: { bg: '#b8860b', text: '#fff' },
        error:   { bg: '#8b0000', text: '#fff' },
        success: { bg: '#1a5c2a', text: '#afffbe' }
    };
    const c = palette[type] || palette.warning;
    banner.style.backgroundColor = c.bg;
    banner.style.color = c.text;
    banner.innerText = message;
    banner.style.opacity = '1';

    clearTimeout(banner._hideTimer);
    banner._hideTimer = setTimeout(() => { banner.style.opacity = '0'; }, 4000);
}

// ─── CONNECT ─────────────────────────────────────────────────────────────────

function connectMultiplayer() {
    if (socket && socket.connected) return;

    socket = io(SERVER_URL, {
        transports: ['polling', 'websocket'],
        upgrade: true
    });

    // ── Connection lifecycle ───────────────────────────────────────────────

    socket.on('disconnect', (reason) => {
        // Only warn during active gameplay — lobby drops are less alarming
        if (myRoomData.isOnline) {
            showConnectionBanner('CONNECTION LOST — RECONNECTING...', 'warning');
        }
    });

    socket.on('reconnect', () => {
        if (myRoomData.isOnline && myRoomData.roomId) {
            // The server has lost the room — we cannot recover gracefully
            showConnectionBanner('RECONNECTED — Session lost. Returning to menu.', 'error');
            setTimeout(() => {
                resetLocalRoomState();
                if (typeof resetGameToMenu === 'function') resetGameToMenu();
            }, 2500);
        } else {
            showConnectionBanner('RECONNECTED!', 'success');
        }
    });

    socket.on('reconnect_failed', () => {
        if (typeof showModal === 'function') {
            showModal('CONNECTION FAILED', 'Could not reach the server. Please refresh the page.');
        }
    });

    // ── Lobby events ───────────────────────────────────────────────────────

    socket.on('room-created', (data) => {
        if (window.SFX) SFX.roomCreate();
        myIdentity = 'p1';
        amILeader = true;
        myRoomData.roomId = data.roomId;
        myRoomData.playerName = data.name;
        myRoomData.isOnline = true;
        myRoomData.players = [{ id: socket.id, name: data.name, isLeader: true, role: 'p1', ready: false }];
        renderLobby(data.roomId, myRoomData.players);
    });

    socket.on('identity-assigned', (data) => {
        myIdentity = data.role;
        amILeader = data.isLeader;
        myRoomData.isOnline = true;
    });

    // Universal room updater — handles joins, leaves, kicks, leadership changes
    socket.on('room-updated', (data) => {
        const isJoin  = data.players.length > myRoomData.players.length;
        const isLeave = data.players.length < myRoomData.players.length;
        if (isJoin  && window.SFX) SFX.playerJoin();
        if (isLeave && window.SFX) SFX.playerLeave();

        myRoomData.players = data.players;
        myRoomData.roomId  = data.roomId;

        // Re-evaluate leadership in case the old leader left
        const me = data.players.find(p => p.id === socket.id);
        if (me) {
            amILeader  = me.isLeader;
            myIdentity = me.role;
        }

        renderLobby(data.roomId, data.players);

        // Handle mid-game abandonment: if a player leaves during a game
        const appDiv = document.getElementById('app');
        if (appDiv && appDiv.style.display === 'block' && data.players.length < 2) {
            if (typeof countdown !== 'undefined') clearInterval(countdown);
            if (typeof showModal === 'function') showModal('MATCH ABORTED', 'The opponent has left the match.');
            resetGameToMenu();
        }
    });

    socket.on('kicked', () => {
        resetLocalRoomState();
        if (typeof showModal === 'function') showModal('REMOVED', 'You were kicked from the lobby by the Room Leader.');
    });

    // ── Game start ─────────────────────────────────────────────────────────

    socket.on('init-online-game', (data) => {
        // Reset all transition guards for the new round
        phaseTransitionLock   = false;
        hasReceivedStartDuel  = false;

        closeModals();

        currentVariant = data.variant;
        gameState.phase = data.phase;
        if (data.limit) draftLimit = data.limit;
        if (data.categoryText) ccState.category = data.categoryText;

        currentSelections = [];
        if (typeof isGuestWaiting !== 'undefined') isGuestWaiting = false;

        document.getElementById('main-menu').style.display = 'none';
        document.getElementById('app').style.display = 'block';
        document.getElementById('leave-game-btn').style.display = 'block';

        if (gameState.phase === 'higher_lower') {
            initHigherLower();
        } else {
            loadGames();
        }
    });

    // ── Library sync ───────────────────────────────────────────────────────

    socket.on('send-library-to-guest', () => {
        if (amILeader) {
            if (typeof masterGameLibrary !== 'undefined' && masterGameLibrary.length > 0) {
                socket.emit('sync-library', {
                    roomId: myRoomData.roomId,
                    library: masterGameLibrary,
                    pool: draftingPool,
                    ccCategory: ccState.category,
                    kcuPhaseBypass: gameState.phase
                });
            } else {
                window.isGuestWaiting = true;
            }
        }
    });

    socket.on('init-library', (data) => {
        masterGameLibrary = data.library;
        draftingPool = data.pool;
        if (data.ccCategory) ccState.category = data.ccCategory;
        if (data.kcuPhaseBypass) {
            gameState.phase = data.kcuPhaseBypass;
            if (data.kcuPhaseBypass === 'keep_cut_upgrade') draftLimit = 3;
            else if (data.kcuPhaseBypass === 'oup') draftLimit = 5;
        }

        // Fisher-Yates shuffle for the guest's pool
        for (let i = draftingPool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [draftingPool[i], draftingPool[j]] = [draftingPool[j], draftingPool[i]];
        }

        finalizeGameStart();
    });

    // ── Higher/Lower sync ──────────────────────────────────────────────────

    socket.on('hl-init-games', (data) => {
        if (data.isPP) {
            // Re-used for Global Paradox sync
            ppRandomGames = data.games;
            if (!amILeader) {
                document.getElementById('draft-phase').style.display = 'none';
                startPPRandomPhase();
            }
            return;
        }

        hlState.currentStandardGame = data.std;
        hlState.nextGame = data.next;
        gameState.turn = data.turn || 'p1';
        setupHLRound();
    });

    socket.on('hl-receive-next', (data) => {
        // Only the guest shifts games; the leader already did it in proceedHL()
        if (!amILeader) {
            if (data.std) hlState.currentStandardGame = data.std;
            if (data.nextGame) hlState.nextGame = data.nextGame;
            if (data.turn) gameState.turn = data.turn;
            if (typeof data.round   !== 'undefined') hlState.roundCount = data.round;
            if (typeof data.p1Score !== 'undefined') hlState.p1Score = data.p1Score;
            if (typeof data.p2Score !== 'undefined') hlState.p2Score = data.p2Score;

            if (data.isGameOver) {
                const winner = (data.p1Score > data.p2Score) ? getPlayerName('p1') : getPlayerName('p2');
                showModal('GAME OVER', `${winner} WINS!`);
                resetGameToMenu();
                return;
            }
            setupHLRound();
        } else {
            // Leader just mirrors the turn to avoid visual drift
            if (data.turn) gameState.turn = data.turn;
        }
    });

    // Multi-purpose sync: H/L guess reveals, CC reveals, OUP decisions, PP decisions
    socket.on('hl-sync-reveal', (data) => {

        // ── Category Clash reveal (hijacked route) ─────────────────────────
        if (data.isCCReveal) {
            const game = masterGameLibrary.find(g => Number(g.id) === Number(data.gameId));
            if (!game) return;
            if (typeof ccRevealGameVisual === 'function') ccRevealGameVisual(data.role, data.index, game);
            if (data.role === 'p1') {
                ccState.revealTurn = 'p2';
            } else {
                ccState.revealTurn = 'p1';
                ccState.revealIndex--;
            }
            if (typeof updateCCPlayerControls === 'function') updateCCPlayerControls();
            return;
        }

        // ── OUP decision (hijacked route) ──────────────────────────────────
        if (data.isOUP) {
            // Index guard: drop duplicate/retransmitted events
            if (typeof oupState !== 'undefined' && data.index !== oupState.turnIndex) return;
            if (typeof handleOUPDecisionSync === 'function') handleOUPDecisionSync(data);
            return;
        }

        // ── Price Paradox decision (hijacked route) ────────────────────────
        if (data.isPP) {
            // Index guard: drop duplicate/retransmitted events
            const expectedIdx = (typeof ppGlobalMode !== 'undefined' && ppGlobalMode)
                ? (typeof ppRandomIndex !== 'undefined' ? ppRandomIndex : -1)
                : (typeof ppState_ui   !== 'undefined' ? ppState_ui.turnIndex : -1);
            if (data.index !== expectedIdx) return;
            if (typeof handlePPDecisionSync === 'function') handlePPDecisionSync(data);
            return;
        }

        // ── Standard H/L guess reveal ──────────────────────────────────────
        hlState.p1Score = data.score1;
        hlState.p2Score = data.score2;

        const p1ScoreElem = document.getElementById('hl-p1-score');
        const p2ScoreElem = document.getElementById('hl-p2-score');
        if (p1ScoreElem) p1ScoreElem.innerText = data.score1;
        if (p2ScoreElem) p2ScoreElem.innerText = data.score2;

        const badge = document.getElementById('hl-next-year');
        if (badge) {
            badge.innerText = data.nextYear;
            badge.classList.remove('hidden');
        }

        const hlnc = document.getElementById('hl-next-card');
        if (hlnc) hlnc.classList.add(data.isCorrect ? 'correct' : 'incorrect');

        // Only play SFX if it was NOT our turn (we played it ourselves in makeHLGuess)
        if (myIdentity !== gameState.turn && window.SFX) {
            if (data.isCorrect) SFX.correct();
            else SFX.incorrect();
        }

        setTimeout(() => {
            if (hlnc) hlnc.classList.remove('correct', 'incorrect');
            if (badge) badge.classList.add('hidden');
            // Only the spectator calls proceedHL — the guesser already calls it
            if (data.guesser && myIdentity !== data.guesser) {
                proceedHL();
            }
        }, 2000);
    });

    // ── Draft status ───────────────────────────────────────────────────────

    socket.on('update-draft-status', (players) => {
        if (!myRoomData.isOnline) return;

        const p1 = players.find(p => p.role === 'p1');
        const p2 = players.find(p => p.role === 'p2');
        if (!p1 || !p2) return;

        const myReady     = myIdentity === 'p1' ? p1.ready : p2.ready;
        const theirReady  = myIdentity === 'p1' ? p2.ready : p1.ready;

        if (myReady && !theirReady) {
            document.getElementById('turn-indicator').innerText = 'WAITING FOR FRIEND...';
        }
    });

    // ── Duel phase start ───────────────────────────────────────────────────

    socket.on('start-duel-phase', (data) => {
        if (!myRoomData.isOnline) return;

        // Guard: prevent double-fire from Render.com reconnect retransmissions
        if (phaseTransitionLock || hasReceivedStartDuel) return;
        phaseTransitionLock  = true;
        hasReceivedStartDuel = true;
        // Release the lock after the transition has had time to complete
        setTimeout(() => { phaseTransitionLock = false; }, 5000);

        try {
            if (data && data.p1Draft) {
                data.p1Draft.forEach(g => {
                    if (!masterGameLibrary.find(m => Number(m.id) === Number(g.id))) masterGameLibrary.push(g);
                });
                gameState.player1.draftedForP2 = data.p1Draft.map(g => Number(g.id));
            }
            if (data && data.p2Draft) {
                data.p2Draft.forEach(g => {
                    if (!masterGameLibrary.find(m => Number(m.id) === Number(g.id))) masterGameLibrary.push(g);
                });
                gameState.player2.draftedForP1 = data.p2Draft.map(g => Number(g.id));
            }
        } catch (e) {
            console.error('Payload sync error:', e);
        }

        // Route to the correct game phase
        switch (gameState.phase) {
            case 'blind_ranking':    startBlindRankingPhase();    break;
            case 'category_clash':   startCategoryClashPhase();   break;
            case 'keep_cut_upgrade': startKeepCutUpgradePhase();  break;
            case 'oup':              startOUPPhase();              break;
            case 'price_paradox':    startPriceParadoxPhase();     break;
            default:
                gameState.phase = 'keep_kill';
                startKeepKillPhase();
        }
    });

    // ── Blind Ranking / KCU opponent placement ────────────────────────────

    socket.on('br-opponent-placed', (data) => {
        if (!myRoomData.isOnline) return;

        if (data.isKCU) {
            if (data.role === 'p1') {
                kcuState.p1Choices = data.choices;
                kcuState.p1Locked  = true;
            } else {
                kcuState.p2Choices = data.choices;
                kcuState.p2Locked  = true;
            }
            if (typeof checkKCUFinished === 'function') checkKCUFinished();
            return;
        }

        if (typeof updateBRSlot !== 'function') return;
        const game = masterGameLibrary.find(g => Number(g.id) === Number(data.gameId));
        if (game) {
            const ranking = data.role === 'p1' ? brState.p1Ranking : brState.p2Ranking;
            ranking[data.slotIndex] = game;
            updateBRSlot(data.role, data.slotIndex, game);
            if (typeof checkBRFinished === 'function') checkBRFinished();
        }
    });

    // ── Keep/Kill: opponent revealed and decided ───────────────────────────

    socket.on('opponent-revealed', (game) => {
        if (!myRoomData.isOnline) return;
        // Sync the local list to stay consistent for the next turn
        const list = (gameState.turn === 'p1')
            ? gameState.player1.draftedForP2
            : gameState.player2.draftedForP1;
        const idx = list.indexOf(Number(game.id));
        if (idx > -1) list.splice(idx, 1);
        startDecisionTurn(game);
    });

    socket.on('opponent-decided', (data) => {
        if (myRoomData.isOnline) handleChoice(data.choice, data.game);
    });

    // ── Error passthrough ─────────────────────────────────────────────────

    socket.on('error', (msg) => {
        if (typeof showModal === 'function') showModal('SERVER ERROR', msg);
    });

    // ── Category Clash: obsoleted direct relay (now routed via hl-guess-sync)
    socket.on('cc-reveal-sync', () => { /* no-op — kept for forward compat */ });
}

// ─── ROOM STATE RESET ────────────────────────────────────────────────────────

function resetLocalRoomState() {
    // Reset all transition guards
    phaseTransitionLock  = false;
    hasReceivedStartDuel = false;

    myRoomData = {
        roomId: null,
        playerName: null,
        isOnline: false,
        players: []
    };
    amILeader  = false;
    myIdentity = null;

    // Restore the Join/Create lobby UI
    const entryArea = document.getElementById('room-entry-area');
    const lobbyArea = document.getElementById('room-lobby-area');
    const namesList = document.getElementById('player-names-list');
    const keyDisplay = document.getElementById('lobby-key-display');

    if (entryArea) entryArea.style.display = 'block';
    if (lobbyArea) lobbyArea.style.display = 'none';
    if (namesList) namesList.innerHTML = '';
    if (keyDisplay) keyDisplay.innerText = '---';
}

// ─── LOBBY UI RENDERING ──────────────────────────────────────────────────────

function renderLobby(roomId, players) {
    document.getElementById('room-entry-area').style.display = 'none';
    document.getElementById('room-lobby-area').style.display = 'block';
    document.getElementById('lobby-key-display').innerText = roomId;

    const list = document.getElementById('player-names-list');
    list.innerHTML = '';

    players.forEach(p => {
        const li = document.createElement('li');
        li.className = 'lobby-player-row';

        const isMe = (p.id === socket.id);
        let nameHTML = p.isLeader ? '👑 ' : '';
        nameHTML += p.name.toUpperCase();
        if (isMe) nameHTML += ' (YOU)';

        const nameSpan = document.createElement('span');
        nameSpan.innerHTML = nameHTML;
        nameSpan.style.color      = (p.role === 'p1') ? 'var(--neon-p1)' : 'var(--neon-p2)';
        nameSpan.style.fontSize   = '18px';
        nameSpan.style.fontWeight = '900';
        li.appendChild(nameSpan);

        // Kick button — only the leader can see it, and only for others
        if (amILeader && !isMe) {
            const kickBtn = document.createElement('button');
            kickBtn.className = 'kick-btn';
            kickBtn.innerText = 'KICK';
            kickBtn.onclick = () => {
                if (socket) socket.emit('kick-player', { roomId, targetId: p.id });
            };
            li.appendChild(kickBtn);
        }

        list.appendChild(li);
    });

    // Status text
    const statusEl = document.getElementById('lobby-status-text');
    if (statusEl) {
        if (players.length === 2) {
            statusEl.innerText = amILeader ? 'READY TO START' : 'WAITING FOR LEADER...';
            statusEl.classList.remove('status-pulse');
            statusEl.style.color = 'var(--neon-p1)';
        } else {
            statusEl.innerText = 'Waiting for opponent...';
            statusEl.classList.add('status-pulse');
            statusEl.style.color = 'var(--accent)';
        }
    }
}

// ─── LOBBY BUTTON HANDLERS ───────────────────────────────────────────────────

document.getElementById('create-room-btn').onclick = () => {
    connectMultiplayer();
    const name = document.getElementById('player-name-input').value.trim();
    if (!name) return showModal('ERROR', 'Enter a name first!');

    if (socket && socket.connected) {
        socket.emit('create-room', name);
    } else {
        const btn = document.getElementById('create-room-btn');
        const origText = btn.innerText;
        btn.innerText  = 'CONNECTING...';
        btn.disabled   = true;

        setTimeout(() => {
            btn.innerText = origText;
            btn.disabled  = false;

            if (!socket || !socket.connected) {
                let timeLeft = 15;
                showModal('SERVER OFFLINE', `The server is waking up. Please try again in ${timeLeft} seconds.`);
                const interval = setInterval(() => {
                    const titleNode = document.getElementById('modal-title');
                    if (!titleNode || titleNode.innerText !== 'SERVER OFFLINE') {
                        clearInterval(interval);
                        return;
                    }
                    timeLeft--;
                    if (timeLeft > 0) {
                        document.getElementById('modal-message').innerText =
                            `The server is waking up. Please try again in ${timeLeft} seconds.`;
                    } else {
                        clearInterval(interval);
                        document.getElementById('custom-modal').style.display = 'none';
                    }
                }, 1000);
            } else {
                socket.emit('create-room', name);
            }
        }, 2000);
    }
};

document.getElementById('join-room-btn').onclick = () => {
    connectMultiplayer();
    const name = document.getElementById('player-name-input').value.trim();
    const room = document.getElementById('join-room-input').value.trim().toUpperCase();
    if (!name || !room) return showModal('ERROR', 'Name and Room Key required!');
    socket.emit('join-room', { roomId: room, name });
};

// Leave lobby button
const leaveBtn = document.getElementById('leave-room-btn');
if (leaveBtn) {
    const doLeave = (e) => {
        if (e && e.type === 'touchstart') e.preventDefault();
        if (socket && myRoomData.roomId) {
            socket.emit('leave-room', myRoomData.roomId);
        }
        resetLocalRoomState();
    };
    leaveBtn.onclick = doLeave;
    leaveBtn.addEventListener('touchstart', doLeave, { passive: false });
}