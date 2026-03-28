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

const SERVER_URL = "https://gaminggauntlet.onrender.com";

function connectMultiplayer() {
    if (socket && socket.connected) return;

    socket = io(SERVER_URL);

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

    // (Keep your existing socket.on('init-online-game'), 'update-draft-status', etc... right below here)
    socket.on('init-online-game', () => {
        closeModals();
        document.getElementById('main-menu').style.display = 'none';
        document.getElementById('app').style.display = 'block';
        document.getElementById('leave-game-btn').style.display = 'block';

        loadGames();

        // Refresh the header again after a short delay to ensure names are loaded
        setTimeout(() => {
            updateDraftHeader();
        }, 1000);
    });

    socket.on('update-draft-status', (players) => {
        if (!myRoomData.isOnline) return;
        const readyCount = players.filter(p => p.ready).length;
        document.getElementById('turn-indicator').innerText = `WAITING (${readyCount}/2 READY)`;
    });

    socket.on('start-duel-phase', () => {
        if (!myRoomData.isOnline) return;
        gameState.phase = "keep_kill";
        startKeepKillPhase();
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
    socket.emit('create-room', name);
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
    leaveBtn.onclick = () => {
        if (socket && myRoomData.roomId) {
            socket.emit('leave-room', myRoomData.roomId); // Tell server we left
        }
        resetLocalRoomState(); // Reset our local UI back to the Join/Create screen
    };
}