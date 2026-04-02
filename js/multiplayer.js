// ─── MULTIPLAYER CORE ────────────────────────────────────────────────────────

let peer = null;
let currentConn = null;
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
 * Socket Shim: Mimics Socket.io API so existing game logic calls don't break.
 */
const socket = {
    connected: false,
    handlers: {},
    on(event, callback) {
        if (!this.handlers[event]) this.handlers[event] = [];
        this.handlers[event].push(callback);
    },
    _lastEmitWasLocal: false,
    emit(event, data) {
        this._lastEmitWasLocal = true;

        // --- MULTIPLAYER TRANSLATION LAYER ---
        // Redirect generic actions to their corresponding "Opponent" handlers
        // so the original game logic doesn't have to be refactored.
        if (currentConn && currentConn.open) {
            currentConn.send({ type: event, payload: data });
        }

        // Host-side mirror: some events need to be handled locally by the leader
        // to mimic the server's behavior of broadcasting back to the sender.
        if (amILeader && [
            'start-game-request',
            'hl-start-game',
            'player-ready-draft',
            'request-library-sync',
            'hl-request-resync',
            'init-online-game',
            'start-duel-phase',
            'room-updated',
            'update-draft-status',
            'hl-init-games',
            'hl-next-game-sync',
            'sync-library',
            'init-library'
        ].includes(event)) {
            this._isMirroring = true;
            setTimeout(() => {
                this._trigger(event, data);
                this._isMirroring = false;
            }, 0);
        }
    },
    _isMirroring: false,
    _trigger(event, data) {
        if (this.handlers[event]) {
            this.handlers[event].forEach(cb => cb(data));
        }
    }
};

let phaseTransitionLock = false;
let hasReceivedStartDuel = false;
let hlSyncWatchdog = null;

// ─── CONNECTION BANNER ───────────────────────────────────────────────────────

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
        error: { bg: '#8b0000', text: '#fff' },
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

// ─── HL SYNC WATCHDOG ────────────────────────────────────────────────────────

function startHLWatchdog() {
    clearTimeout(hlSyncWatchdog);
    if (!myRoomData.isOnline) return;
    hlSyncWatchdog = setTimeout(() => {
        if (myRoomData.isOnline && myRoomData.roomId && currentConn && currentConn.open) {
            console.warn('[HL] Sync watchdog fired — requesting resync from leader');
            showConnectionBanner('SYNC LOST — REQUESTING RESYNC...', 'warning');
            socket.emit('hl-request-resync', { roomId: myRoomData.roomId });
        }
    }, 6000);
}

function clearHLWatchdog() {
    clearTimeout(hlSyncWatchdog);
    hlSyncWatchdog = null;
}

// ─── CONNECT ─────────────────────────────────────────────────────────────────

function connectMultiplayer() {
    if (peer) return;
    // Peer is initialized on-demand via create/join buttons.
}

/**
 * Initialize the Peer object.
 * @param {string} [id] - Optional ID for the host.
 */
function initPeer(id, callback) {
    if (peer) {
        if (callback) callback();
        return;
    }

    peer = new Peer(id, {
        debug: 1 // Only log errors
    });

    peer.on('open', (myId) => {
        console.log('[PeerJS] My peer ID is: ' + myId);
        if (callback) callback(myId);
    });

    peer.on('error', (err) => {
        console.error('[PeerJS] Error:', err);
        if (typeof setLobbyLoading === 'function') setLobbyLoading(false);
        if (err.type === 'unavailable-id') {
            showModal('ERROR', 'That room key is already in use. Try again.');
        } else if (err.type === 'peer-unavailable') {
            showModal('ERROR', 'Room not found. Check the key.');
        } else {
            showModal('PEER ERROR', err.type);
        }
        resetLocalRoomState();
    });

    // --- HOST ONLY: Incoming connections ---
    peer.on('connection', (conn) => {
        if (currentConn) {
            conn.close(); // Only 2 players allowed
            return;
        }
        setupConnection(conn);
    });
}

function setupConnection(conn) {
    currentConn = conn;
    socket.connected = true;

    conn.on('open', () => {
        console.log('[PeerJS] Connection opened with:', conn.peer);

        if (amILeader) {
            // Host: Send current room state to the guest
            socket.emit('identity-assigned', { role: 'p2', isLeader: false });
            socket.emit('room-updated', { roomId: myRoomData.roomId, players: myRoomData.players });
        } else {
            // Guest: Tell the host who I am
            socket.emit('guest-join', { name: myRoomData.playerName });
        }
    });

    conn.on('data', (data) => {
        socket._lastEmitWasLocal = false;
        // Route incoming data to the socket shim
        if (data && data.type) {
            socket._trigger(data.type, data.payload);
        }
    });

    conn.on('close', () => {
        console.log('[PeerJS] Connection closed.');
        handleDisconnect();
    });

    conn.on('error', (err) => {
        console.error('[PeerJS] Conn Error:', err);
        handleDisconnect();
    });
}

function handleDisconnect() {
    socket.connected = false;
    currentConn = null;

    if (myRoomData.isOnline && myRoomData.roomId) {
        const appDiv = document.getElementById('app');
        const gameIsActive = appDiv && appDiv.style.display === 'block';

        if (gameIsActive) {
            if (typeof countdown !== 'undefined') clearInterval(countdown);
            showModal('MATCH ABORTED', 'The connection to the opponent was lost.');
            resetGameToMenu();
        } else {
            showConnectionBanner('OPPONENT LEFT', 'warning');
            resetLocalRoomState();
        }
    }
}

function registerMultiplayerEvents() {

    // ── Interaction Bridges (Map user actions to game logic) ──
    // These convert "I did X" packets into "My opponent did X" for the receiver.
    socket.on('reveal-game', (data) => socket._trigger('opponent-revealed', data.game || data));
    socket.on('decision-made', (data) => socket._trigger('opponent-decided', data));
    socket.on('br-place-game', (data) => socket._trigger('br-opponent-placed', data));
    socket.on('hl-guess-sync', (data) => socket._trigger('hl-sync-reveal', data));

    // ── Guest Join (Host only) ──
    socket.on('guest-join', (data) => {
        if (!amILeader) return;
        if (myRoomData.players.length >= 2) return;

        const guestPlayer = {
            id: currentConn.peer,
            name: data.name,
            role: 'p2',
            isLeader: false,
            ready: false
        };
        myRoomData.players.push(guestPlayer);

        if (window.SFX) SFX.playerJoin();
        socket.emit('room-updated', { roomId: myRoomData.roomId, players: myRoomData.players });
        renderLobby(myRoomData.roomId, myRoomData.players);
    });

    // ── Start Game Request (Host only) ──
    socket.on('start-game-request', (data) => {
        if (!amILeader) return;
        myRoomData.players.forEach(p => { p.ready = false; p.draftList = []; });
        socket.emit('init-online-game', {
            variant: data.variant,
            phase: data.phase,
            limit: data.limit,
            categoryText: data.categoryText
        });
    });

    // ── Player Ready Draft (Host only) ──
    socket.on('player-ready-draft', (data) => {
        if (!amILeader) return;

        // Determine if this came from the Host (local) or Guest (remote)
        const player = myRoomData.players.find(p => p.role === data.role);

        if (player) {
            player.ready = true;
            player.draftList = data.draftList || [];
        }

        socket.emit('update-draft-status', myRoomData.players);

        if (myRoomData.players.every(pl => pl.ready)) {
            const p1 = myRoomData.players.find(pl => pl.role === 'p1');
            const p2 = myRoomData.players.find(pl => pl.role === 'p2');
            socket.emit('start-duel-phase', {
                p1Draft: p1 ? p1.draftList : [],
                p2Draft: p2 ? p2.draftList : []
            });
        }
    });

    // ── Request Library Sync (Host only) ──
    socket.on('request-library-sync', () => {
        if (!amILeader) return;
        // This is triggered when the guest joins and asks for the library
        // We reuse the existing send-library-to-guest logic
        socket._trigger('send-library-to-guest');
    });

    // ── Universal Room Updater ──
    socket.on('room-updated', (data) => {
        if (amILeader) return; // Host already updated their own state

        const isJoin = data.players.length > myRoomData.players.length;
        if (isJoin && window.SFX) SFX.playerJoin();

        myRoomData.players = data.players;
        renderLobby(data.roomId, data.players);
    });

    socket.on('identity-assigned', (data) => {
        myIdentity = data.role;
        amILeader = data.isLeader;
        myRoomData.isOnline = true;
    });

    socket.on('leave-room', () => {
        if (myRoomData.isOnline) {
            showConnectionBanner('OPPONENT LEFT', 'warning');
            resetLocalRoomState();
        }
    });

    socket.on('kicked', () => {
        resetLocalRoomState();
        showModal('REMOVED', 'You were kicked from the lobby by the Room Leader.');
    });

    // ── Game Start ──
    socket.on('init-online-game', (data) => {
        phaseTransitionLock = false;
        hasReceivedStartDuel = false;
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

    // ── Library Sync ──
    socket.on('send-library-to-guest', () => {
        if (!amILeader) return;
        if (typeof masterGameLibrary !== 'undefined' && masterGameLibrary.length > 0) {
            socket.emit('init-library', {
                library: masterGameLibrary,
                pool: draftingPool,
                ccCategory: ccState.category,
                kcuPhaseBypass: gameState.phase
            });
        }
    });

    socket.on('init-library', (data) => {
        if (gameHasStarted) return;
        masterGameLibrary = data.library;
        draftingPool = data.pool;
        if (data.ccCategory) ccState.category = data.ccCategory;
        if (data.kcuPhaseBypass) {
            gameState.phase = data.kcuPhaseBypass;
            if (data.kcuPhaseBypass === 'keep_cut_upgrade') draftLimit = 3;
            else if (data.kcuPhaseBypass === 'oup') draftLimit = 5;
        }

        // Shuffle for the guest
        for (let i = draftingPool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [draftingPool[i], draftingPool[j]] = [draftingPool[j], draftingPool[i]];
        }
        finalizeGameStart();
    });

    // ── Higher/Lower sync ──
    socket.on('hl-init-games', (data) => {
        if (data.isPP) {
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

    socket.on('hl-next-game-sync', (data) => {
        clearHLWatchdog();
        if (!amILeader) {
            if (data.std) hlState.currentStandardGame = data.std;
            if (data.nextGame) hlState.nextGame = data.nextGame;
            if (data.turn) gameState.turn = data.turn;
            if (typeof data.round !== 'undefined') hlState.roundCount = data.round;
            if (typeof data.p1Score !== 'undefined') hlState.p1Score = data.p1Score;
            if (typeof data.p2Score !== 'undefined') hlState.p2Score = data.p2Score;

            if (data.isGameOver) {
                const winner = (data.p1Score > data.p2Score) ? getPlayerName('p1') : getPlayerName('p2');
                showModal('GAME OVER', `${winner} WINS!`);
                resetGameToMenu();
                return;
            }
            setupHLRound();
        } else if (data.turn) {
            gameState.turn = data.turn;
        }
    });

    socket.on('hl-sync-reveal', (data) => {
        // CC Reveal
        if (data.isCCReveal) {
            const actualId = typeof data.gameId === 'object' && data.gameId !== null ? data.gameId.id : data.gameId;
            let game = masterGameLibrary.find(g => Number(g.id) === Number(actualId));
            if (!game) game = { id: actualId, name: "Unknown Game", background_image: "" }; // Fallback to prevent crash

            if (typeof ccRevealGameVisual === 'function') ccRevealGameVisual(data.role, data.index, game);
            if (data.role === 'p1') ccState.revealTurn = 'p2';
            else { ccState.revealTurn = 'p1'; ccState.revealIndex--; }
            if (typeof updateCCPlayerControls === 'function') updateCCPlayerControls();
            return;
        }
        // OUP decision
        if (data.isOUP) {
            if (typeof oupState !== 'undefined' && data.index !== oupState.turnIndex) return;
            if (typeof handleOUPDecisionSync === 'function') handleOUPDecisionSync(data);
            return;
        }
        // PP decision
        if (data.isPP) {
            const expectedIdx = (typeof ppGlobalMode !== 'undefined' && ppGlobalMode)
                ? (typeof ppRandomIndex !== 'undefined' ? ppRandomIndex : -1)
                : (typeof ppState_ui !== 'undefined' ? ppState_ui.turnIndex : -1);
            if (data.index !== expectedIdx) return;
            if (typeof handlePPDecisionSync === 'function') handlePPDecisionSync(data);
            return;
        }

        // Standard HL guess
        hlState.p1Score = data.score1; hlState.p2Score = data.score2;
        const p1ScoreElem = document.getElementById('hl-p1-score');
        const p2ScoreElem = document.getElementById('hl-p2-score');
        if (p1ScoreElem) p1ScoreElem.innerText = data.score1;
        if (p2ScoreElem) p2ScoreElem.innerText = data.score2;

        const badge = document.getElementById('hl-next-year');
        if (badge) { badge.innerText = data.nextYear; badge.classList.remove('hidden'); }
        const hlnc = document.getElementById('hl-next-card');
        if (hlnc) hlnc.classList.add(data.isCorrect ? 'correct' : 'incorrect');

        if (myIdentity !== gameState.turn && window.SFX) {
            if (data.isCorrect) SFX.correct(); else SFX.incorrect();
        }

        setTimeout(() => {
            if (hlnc) hlnc.classList.remove('correct', 'incorrect');
            if (badge) badge.classList.add('hidden');
            if (data.guesser && myIdentity !== data.guesser) {
                if (amILeader) proceedHL(); else startHLWatchdog();
            }
        }, 2000);
    });

    socket.on('hl-resync-request', () => {
        if (!amILeader) return;
        socket.emit('hl-next-game-sync', {
            std: hlState.currentStandardGame,
            nextGame: hlState.nextGame,
            turn: gameState.turn,
            round: hlState.roundCount,
            p1Score: hlState.p1Score,
            p2Score: hlState.p2Score
        });
    });

    // ── Draft Status ──
    socket.on('update-draft-status', (players) => {
        if (!myRoomData.isOnline) return;
        const p1 = players.find(p => p.role === 'p1');
        const p2 = players.find(p => p.role === 'p2');
        if (!p1 || !p2) return;
        const myReady = myIdentity === 'p1' ? p1.ready : p2.ready;
        const theirReady = myIdentity === 'p1' ? p2.ready : p1.ready;
        if (myReady && !theirReady) {
            document.getElementById('turn-indicator').innerText = 'WAITING FOR FRIEND...';
        }
    });

    // ── Internal Player-Ready (Shim for Host logic) ──
    socket.on('player-ready-internal', (data) => {
        if (!amILeader) return;
        const player = myRoomData.players.find(pl => pl.role === data.role);
        if (player) {
            player.ready = true;
            player.draftList = data.draftList || [];
        }
        socket.emit('update-draft-status', myRoomData.players);
        if (myRoomData.players.every(pl => pl.ready)) {
            const p1 = myRoomData.players.find(pl => pl.role === 'p1');
            const p2 = myRoomData.players.find(pl => pl.role === 'p2');
            socket.emit('start-duel-phase', {
                p1Draft: p1 ? p1.draftList : [],
                p2Draft: p2 ? p2.draftList : []
            });
        }
    });

    socket.on('start-duel-phase', (data) => {
        if (!myRoomData.isOnline) return;
        if (phaseTransitionLock || hasReceivedStartDuel) return;
        phaseTransitionLock = true;
        hasReceivedStartDuel = true;
        setTimeout(() => { phaseTransitionLock = false; }, 5000);

        try {
            if (data.p1Draft) {
                data.p1Draft.forEach(g => {
                    if (!masterGameLibrary.find(m => Number(m.id) === Number(g.id))) masterGameLibrary.push(g);
                });
                gameState.player1.draftedForP2 = data.p1Draft.map(g => Number(g.id));
            }
            if (data.p2Draft) {
                data.p2Draft.forEach(g => {
                    if (!masterGameLibrary.find(m => Number(m.id) === Number(g.id))) masterGameLibrary.push(g);
                });
                gameState.player2.draftedForP1 = data.p2Draft.map(g => Number(g.id));
            }
        } catch (e) { console.error('Payload sync error:', e); }

        switch (gameState.phase) {
            case 'blind_ranking': startBlindRankingPhase(); break;
            case 'category_clash': startCategoryClashPhase(); break;
            case 'keep_cut_upgrade': startKeepCutUpgradePhase(); break;
            case 'oup': startOUPPhase(); break;
            case 'price_paradox': startPriceParadoxPhase(); break;
            default: gameState.phase = 'keep_kill'; startKeepKillPhase();
        }
    });

    socket.on('br-opponent-placed', (data) => {
        if (data.isKCU) {
            if (data.role === 'p1') { kcuState.p1Choices = data.choices; kcuState.p1Locked = true; }
            else { kcuState.p2Choices = data.choices; kcuState.p2Locked = true; }
            if (typeof checkKCUFinished === 'function') checkKCUFinished();
            return;
        }
        const game = masterGameLibrary.find(g => Number(g.id) === Number(data.gameId));
        if (game) {
            const ranking = data.role === 'p1' ? brState.p1Ranking : brState.p2Ranking;
            ranking[data.slotIndex] = game;
            updateBRSlot(data.role, data.slotIndex, game);
            if (typeof checkBRFinished === 'function') checkBRFinished();
        }
    });

    socket.on('opponent-revealed', (game) => {
        const list = (gameState.turn === 'p1') ? gameState.player1.draftedForP2 : gameState.player2.draftedForP1;
        const idx = list.indexOf(Number(game.id));
        if (idx > -1) list.splice(idx, 1);
        startDecisionTurn(game);
    });

    socket.on('opponent-decided', (data) => {
        handleChoice(data.choice, data.game);
    });
}

// ─── ROOM STATE RESET ────────────────────────────────────────────────────────

function resetLocalRoomState() {
    setLobbyLoading(false);
    phaseTransitionLock = false;
    hasReceivedStartDuel = false;
    clearHLWatchdog();

    if (currentConn && currentConn.open) {
        // Send a final explicit'leave' if possible
        try {
            currentConn.send({ type: 'leave-room', payload: {} });
            currentConn.close();
        } catch (e) { }
    }

    // Delay destruction to allow final packets to clear
    setTimeout(() => {
        if (peer) {
            peer.destroy();
            peer = null;
        }
    }, 200);

    myRoomData = {
        roomId: null,
        playerName: null,
        isOnline: false,
        players: []
    };
    amILeader = false;
    myIdentity = null;
    socket.connected = false;

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

        const isMe = (p.id === (peer ? peer.id : null) || p.role === myIdentity);
        let nameHTML = p.isLeader ? '👑 ' : '';
        nameHTML += p.name.toUpperCase();
        if (isMe) nameHTML += ' (YOU)';

        const nameSpan = document.createElement('span');
        nameSpan.innerHTML = nameHTML;
        nameSpan.style.color = (p.role === 'p1') ? 'var(--neon-p1)' : 'var(--neon-p2)';
        nameSpan.style.fontSize = '18px';
        nameSpan.style.fontWeight = '900';
        li.appendChild(nameSpan);

        if (amILeader && !isMe) {
            const kickBtn = document.createElement('button');
            kickBtn.className = 'kick-btn';
            kickBtn.innerText = 'KICK';
            kickBtn.onclick = () => {
                socket.emit('kicked');
                setTimeout(() => { if (currentConn) currentConn.close(); }, 100);
            };
            li.appendChild(kickBtn);
        }
        list.appendChild(li);
    });

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

const leaveBtn = document.getElementById('leave-room-btn');
if (leaveBtn) {
    leaveBtn.onclick = () => resetLocalRoomState();
}

function setLobbyLoading(isLoading) {
    const createBtn = document.getElementById('create-room-btn');
    const joinBtn = document.getElementById('join-room-btn');
    if (createBtn) {
        createBtn.innerText = isLoading ? 'CONNECTING...' : 'CREATE ROOM';
        createBtn.disabled = isLoading;
    }
    if (joinBtn) {
        joinBtn.innerText = isLoading ? 'JOINING...' : 'JOIN';
        joinBtn.disabled = isLoading;
    }
}

document.getElementById('create-room-btn').onclick = () => {
    const name = document.getElementById('player-name-input').value.trim();
    if (!name) return showModal('ERROR', 'Enter a name first!');

    setLobbyLoading(true);
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    const peerId = 'GG-' + roomId;

    initPeer(peerId, (id) => {
        if (!id) return;
        if (window.SFX) SFX.roomCreate();
        myIdentity = 'p1';
        amILeader = true;
        myRoomData.roomId = roomId;
        myRoomData.playerName = name;
        myRoomData.isOnline = true;
        myRoomData.players = [{ id: id, name: name, isLeader: true, role: 'p1', ready: false }];

        registerMultiplayerEvents();
        renderLobby(roomId, myRoomData.players);
    });
};

document.getElementById('join-room-btn').onclick = () => {
    const name = document.getElementById('player-name-input').value.trim();
    const room = document.getElementById('join-room-input').value.trim().toUpperCase();
    if (!name || !room) return showModal('ERROR', 'Name and Room Key required!');

    setLobbyLoading(true);
    myRoomData.playerName = name;
    myRoomData.roomId = room;

    initPeer(null, (id) => {
        if (!id) return;
        const conn = peer.connect('GG-' + room);
        amILeader = false;
        myIdentity = 'p2';
        registerMultiplayerEvents();
        setupConnection(conn);
    });
};

// ─── START-GAME-REQUEST OVERRIDE ───
// We need to override the logic that usually hits the server.
socket.on('start-game-request-internal', (data) => {
    if (!amILeader) return;
    myRoomData.players.forEach(p => { p.ready = false; p.draftList = []; });
    socket.emit('init-online-game', {
        variant: data.variant,
        phase: data.phase,
        limit: data.limit,
        categoryText: data.categoryText
    });
});