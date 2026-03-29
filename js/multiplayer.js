// --- MULTIPLAYER CORE ---
let socket = null;
let myIdentity = null;
let amILeader = false;

// This object tracks if we are actually in a room or playing locally
let myRoomData = {
    roomId: null,
    playerName: null,
    isOnline: false,
    players: []
};

// Change to localhost so our recent local server edits actually take effect instead of pointing to the stale render deployment
const SERVER_URL = "http://localhost:3000";

function connectMultiplayer() {
    if (socket && socket.connected) return;

    socket = io(SERVER_URL, {
        transports: ['polling', 'websocket'],
        upgrade: true
    })

    // When YOU create a room
    socket.on('room-created', (data) => {
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


    // --- NEW: Universal Room Updater (Handles Joins, Leaves, Kicks, Leadership changes) ---
    socket.on('room-updated', (data) => {
        myRoomData.players = data.players;
        myRoomData.roomId = data.roomId;

        // Re-evaluate leadership in case the old leader left
        const me = data.players.find(p => p.id === socket.id);
        if (me) {
            amILeader = me.isLeader;
            myIdentity = me.role;
        }

        renderLobby(data.roomId, data.players);

        // --- NEW: HANDLE MID-GAME ABANDONMENT ---
        const appDiv = document.getElementById('app');
        if (appDiv && appDiv.style.display === 'block') {
            // If we are actively in a game, and player count drops below 2
            if (data.players.length < 2) {
                // Stop timers
                if (typeof countdown !== 'undefined') clearInterval(countdown);

                showModal("MATCH ABORTED", "The opponent has left the match.");
                resetGameToMenu(); // Kick the remaining player back to menu
            }
        }
    });

    // --- NEW: Handled getting Kicked ---
    socket.on('kicked', () => {
        resetLocalRoomState();
        showModal("REMOVED", "You were kicked from the lobby by the Room Leader.");
    });

    socket.on('init-online-game', (data) => {
        closeModals();
        currentVariant = data.variant;
        gameState.phase = data.phase; // higher_lower, drafting, blind_ranking
        if (data.limit) draftLimit = data.limit;
        
        currentSelections = []; // Guaranteed clean state for draft arrays
        if (typeof isGuestWaiting !== 'undefined') isGuestWaiting = false;

        document.getElementById('main-menu').style.display = 'none';
        document.getElementById('app').style.display = 'block';
        document.getElementById('leave-game-btn').style.display = 'block';

        if (gameState.phase === 'higher_lower') {
            initHigherLower(); // Both players start H/L
        } else {
            loadGames(); // Both players start Keep/Kill
        }
    });

    socket.on('send-library-to-guest', () => {
        if (amILeader) {
            if (typeof masterGameLibrary !== 'undefined' && masterGameLibrary.length > 0) {
                socket.emit('sync-library', {
                    roomId: myRoomData.roomId,
                    library: masterGameLibrary,
                    pool: draftingPool
                });
            } else {
                if (typeof isGuestWaiting !== 'undefined') {
                    isGuestWaiting = true;
                } else {
                    window.isGuestWaiting = true;
                }
            }
        }
    });

    // 2. Guest receives the library
    socket.on('init-library', (data) => {
        masterGameLibrary = data.library;
        draftingPool = data.pool;
        
        // Proper Fisher-Yates shuffle for the guest
        for (let i = draftingPool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [draftingPool[i], draftingPool[j]] = [draftingPool[j], draftingPool[i]];
        }
        
        finalizeGameStart();
    });

    // 3. Everyone receives the start games
    socket.on('hl-init-games', (data) => {
        console.log("Sync data received from leader:", data);
        // Force the data into the variables
        hlState.currentStandardGame = data.std;
        hlState.nextGame = data.next;
        gameState.turn = data.turn || 'p1';

        // Now tell the UI to draw
        setupHLRound();
    });

    socket.on('hl-receive-next', (data) => {
        console.log("Next round data received:", data);
        
        // ONLY the guest shifts the games. The Leader already shifted them in proceedHL.
        if (!amILeader) {
            if (data.std) hlState.currentStandardGame = data.std;
            if (data.nextGame) hlState.nextGame = data.nextGame;
            
            // STRICTLY overwrite guest state so it never falls out of sync
            if (data.turn) gameState.turn = data.turn;
            if (typeof data.round !== 'undefined') hlState.roundCount = data.round;
            if (typeof data.p1Score !== 'undefined') hlState.p1Score = data.p1Score;
            if (typeof data.p2Score !== 'undefined') hlState.p2Score = data.p2Score;
            
            setupHLRound();
        } else {
            // Leader just syncs the turn to avoid any potential visual mismatches
            if (data.turn) gameState.turn = data.turn;
        }
    });

    // 4. Update Reveal Sync to handle turn swaps properly
    socket.on('hl-sync-reveal', (data) => {
        hlState.p1Score = data.score1;
        hlState.p2Score = data.score2;

        // Use correct labels
        const p1ScoreElem = document.getElementById('hl-p1-score');
        const p2ScoreElem = document.getElementById('hl-p2-score');
        if (p1ScoreElem) p1ScoreElem.innerText = data.score1;
        if (p2ScoreElem) p2ScoreElem.innerText = data.score2;

        const badge = document.getElementById('hl-next-year');
        if (badge) {
            badge.innerText = data.nextYear;
            badge.classList.remove('hidden');
        }

        document.getElementById('hl-next-card').classList.add(data.isCorrect ? 'correct' : 'incorrect');

        // Only the spectator moves to the next round (the player triggers it themselves)
        if (myIdentity !== gameState.turn) {
            setTimeout(() => proceedHL(), 2000);
        }
    });

    socket.on('update-draft-status', (players) => {
        if (!myRoomData.isOnline) return;

        const p1 = players.find(p => p.role === 'p1');
        const p2 = players.find(p => p.role === 'p2');

        if (!p1 || !p2) return;

        if (myIdentity === 'p1' && p1.ready && !p2.ready) {
            document.getElementById('turn-indicator').innerText = "WAITING FOR FRIEND...";
        }
        else if (myIdentity === 'p2' && p2.ready && !p1.ready) {
            document.getElementById('turn-indicator').innerText = "WAITING FOR FRIEND...";
        }
    });





    socket.on('start-duel-phase', (data) => {
        if (!myRoomData.isOnline) return;
        
        try {
            if (data && data.p1Draft) {
                data.p1Draft.forEach(g => { if (!masterGameLibrary.find(m => Number(m.id) === Number(g.id))) masterGameLibrary.push(g); });
                gameState.player1.draftedForP2 = data.p1Draft.map(g => Number(g.id));
            }
            if (data && data.p2Draft) {
                data.p2Draft.forEach(g => { if (!masterGameLibrary.find(m => Number(m.id) === Number(g.id))) masterGameLibrary.push(g); });
                gameState.player2.draftedForP1 = data.p2Draft.map(g => Number(g.id));
            }
        } catch (e) {
            console.error("Payload synchronization error bypassed: ", e);
        }

        if (gameState.phase === 'blind_ranking') {
            startBlindRankingPhase();
        } else {
            gameState.phase = "keep_kill";
            startKeepKillPhase();
        }
    });

    socket.on('br-opponent-placed', (data) => {
        if (!myRoomData.isOnline || typeof updateBRSlot !== 'function') return;
        const game = masterGameLibrary.find(g => Number(g.id) === Number(data.gameId));
        if (game) {
            let ranking = data.role === 'p1' ? brState.p1Ranking : brState.p2Ranking;
            ranking[data.slotIndex] = game;
            updateBRSlot(data.role, data.slotIndex, game);
            if (typeof checkBRFinished === 'function') checkBRFinished();
        }
    });

    socket.on('opponent-revealed', (game) => { if (myRoomData.isOnline) startDecisionTurn(game); });
    socket.on('opponent-decided', (data) => { if (myRoomData.isOnline) handleChoice(data.choice, data.game); });
    socket.on('error', (msg) => showModal("SERVER ERROR", msg));
}

// --- LOBBY UI RENDERING ---
function resetLocalRoomState() {
    myRoomData = {
        roomId: null,
        playerName: null,
        isOnline: false,
        players: []
    };
    amILeader = false;
    myIdentity = null;

    // Visually swap back to the Join/Create screen
    document.getElementById('room-entry-area').style.display = 'block';
    document.getElementById('room-lobby-area').style.display = 'none';
    document.getElementById('player-names-list').innerHTML = '';
    document.getElementById('lobby-key-display').innerText = '---';
}

// --- LOBBY UI RENDERING ---
function renderLobby(roomId, players) {
    document.getElementById('room-entry-area').style.display = 'none';
    document.getElementById('room-lobby-area').style.display = 'block';
    document.getElementById('lobby-key-display').innerText = roomId;

    const list = document.getElementById('player-names-list');
    list.innerHTML = '';

    players.forEach(p => {
        const li = document.createElement('li');
        li.className = 'lobby-player-row'; // New class from our CSS

        const isMe = (p.id === socket.id);

        let nameHTML = p.isLeader ? '👑 ' : '';
        nameHTML += p.name.toUpperCase();
        if (isMe) nameHTML += " (YOU)";

        // Create the name span
        const nameSpan = document.createElement('span');
        nameSpan.innerHTML = nameHTML;
        nameSpan.style.color = (p.role === 'p1') ? 'var(--neon-p1)' : 'var(--neon-p2)';
        nameSpan.style.fontSize = "18px";
        nameSpan.style.fontWeight = "900";
        li.appendChild(nameSpan);

        // --- NEW: Add KICK button if I am the leader and this is not me ---
        if (amILeader && !isMe) {
            const kickBtn = document.createElement('button');
            kickBtn.className = 'kick-btn';
            kickBtn.innerText = 'KICK';
            kickBtn.onclick = () => {
                if (socket) {
                    socket.emit('kick-player', { roomId: roomId, targetId: p.id });
                }
            };
            li.appendChild(kickBtn);
        }

        list.appendChild(li);
    });

    // Update Status Text
    if (players.length === 2) {
        document.getElementById('lobby-status-text').innerText = amILeader ? "READY TO START" : "WAITING FOR LEADER...";
        document.getElementById('lobby-status-text').classList.remove('status-pulse');
        document.getElementById('lobby-status-text').style.color = 'var(--neon-p1)';
    } else {
        document.getElementById('lobby-status-text').innerText = "Waiting for opponent...";
        document.getElementById('lobby-status-text').classList.add('status-pulse');
        document.getElementById('lobby-status-text').style.color = 'var(--accent)';
    }
}

// --- BUTTON INTERACTIONS ---

// Create Room Button
document.getElementById('create-room-btn').onclick = () => {
    connectMultiplayer();
    const name = document.getElementById('player-name-input').value;
    if (!name) return showModal("ERROR", "Enter a name first!");

    if (socket && socket.connected) {
        socket.emit('create-room', name);
    } else {
        const btn = document.getElementById('create-room-btn');
        const origText = btn.innerText;
        btn.innerText = "CONNECTING...";
        btn.disabled = true;

        setTimeout(() => {
            btn.innerText = origText;
            btn.disabled = false;
            if (!socket || !socket.connected) {
                let timeLeft = 15;
                showModal("SERVER OFFLINE", `The server is offline or waking up. Please try again in ${timeLeft} seconds.`);
                const interval = setInterval(() => {
                    const titleNode = document.getElementById('modal-title');
                    if (!titleNode || titleNode.innerText !== "SERVER OFFLINE") {
                        clearInterval(interval);
                        return;
                    }
                    timeLeft--;
                    if (timeLeft > 0) {
                        document.getElementById('modal-message').innerText = `The server is offline or waking up. Please try again in ${timeLeft} seconds.`;
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

// Join Room Button
document.getElementById('join-room-btn').onclick = () => {
    connectMultiplayer();
    const name = document.getElementById('player-name-input').value;
    const room = document.getElementById('join-room-input').value.toUpperCase();
    if (!name || !room) return showModal("ERROR", "Name and Room Key required!");
    socket.emit('join-room', { roomId: room, name: name });
};

// --- NEW: LEAVE ROOM BUTTON LOGIC ---
const leaveBtn = document.getElementById('leave-room-btn');
if (leaveBtn) {
    const doLeave = (e) => {
        if (e && e.type === 'touchstart') e.preventDefault();
        if (socket && myRoomData.roomId) {
            socket.emit('leave-room', myRoomData.roomId); // Tell server we left
        }
        resetLocalRoomState(); // Reset our local UI back to the Join/Create screen
    };
    leaveBtn.onclick = doLeave;
    leaveBtn.addEventListener('touchstart', doLeave, { passive: false });
}