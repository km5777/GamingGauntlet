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

    // Use the online URL instead of localhost
    socket = io(SERVER_URL);

    // --- LOBBY EVENTS ---

    // When YOU create a room
    socket.on('room-created', (data) => {
        myIdentity = 'p1';
        amILeader = true;
        myRoomData.roomId = data.roomId;
        myRoomData.playerName = data.name;
        myRoomData.isOnline = true; // Now the game knows to use online logic
        myRoomData.players = [{ id: socket.id, name: data.name, isLeader: true, role: 'p1', ready: false }];
        renderLobby(data.roomId, myRoomData.players);
    });

    // When YOU join an existing room
    socket.on('identity-assigned', (data) => {
        myIdentity = data.role;
        amILeader = data.isLeader;
        myRoomData.isOnline = true; // Now the game knows to use online logic
    });

    // When ANYONE joins the room (including you)
    socket.on('player-joined', (data) => {
        myRoomData.players = data.players;
        myRoomData.roomId = data.roomId;
        renderLobby(data.roomId, data.players);
    });

    // --- GAME FLOW EVENTS ---

    // When the leader starts the game
    socket.on('init-online-game', () => {
        closeModals();
        document.getElementById('main-menu').style.display = 'none';
        document.getElementById('app').style.display = 'block';

        loadGames();

        // Force Names and HUD update after a split second
        setTimeout(() => {
            const p1Name = getPlayerName('p1');
            const p2Name = getPlayerName('p2');

            // Update corner grids
            const p1HUD = document.querySelector('.p1-hud h3');
            const p2HUD = document.querySelector('.p2-hud h3');
            if (p1HUD) p1HUD.innerText = p1Name + " STATUS";
            if (p2HUD) p2HUD.innerText = p2Name + " STATUS";

            // Update top turn indicator
            const opponent = (myIdentity === 'p1') ? p2Name : p1Name;
            document.getElementById('turn-indicator').innerText = `DRAFTING FOR ${opponent}`;
        }, 200);
    });

    // When a player finishes drafting
    socket.on('update-draft-status', (players) => {
        if (!myRoomData.isOnline) return;
        const readyCount = players.filter(p => p.ready).length;
        document.getElementById('turn-indicator').innerText = `WAITING (${readyCount}/2 READY)`;
    });

    // When both finish drafting
    socket.on('start-duel-phase', () => {
        if (!myRoomData.isOnline) return;
        gameState.phase = "keep_kill";
        startKeepKillPhase();
    });

    // When opponent reveals a game
    socket.on('opponent-revealed', (game) => {
        if (!myRoomData.isOnline) return;
        startDecisionTurn(game);
    });

    // When opponent makes a Keep/Kill choice
    socket.on('opponent-decided', (data) => {
        if (!myRoomData.isOnline) return;
        handleChoice(data.choice, data.game);
    });

    // Error handling
    socket.on('error', (msg) => {
        showModal("SERVER ERROR", msg);
    });
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
        const isMe = (p.id === socket.id);

        let nameHTML = p.isLeader ? '👑 ' : '';
        nameHTML += p.name.toUpperCase();
        if (isMe) nameHTML += " (YOU)";

        li.innerHTML = nameHTML;
        li.style.color = (p.role === 'p1') ? 'var(--neon-p1)' : 'var(--neon-p2)';
        li.style.margin = "10px 0";
        li.style.fontSize = "22px";
        li.style.fontWeight = "900";
        list.appendChild(li);
    });

    socket.on('connect', () => {
        console.log("Connected to server!");
    });

    socket.on('connect_error', () => {
        showModal("SERVER WAKING UP", "The free server is currently sleeping. Please wait about 60 seconds and try again!");
    });

    if (players.length === 2) {
        document.getElementById('lobby-status-text').innerText = amILeader ? "READY TO START" : "WAITING FOR LEADER...";
    }
}

// --- BUTTON INTERACTIONS ---

// Create Room Button
document.getElementById('create-room-btn').onclick = () => {
    connectMultiplayer(); // Ensure socket is connected
    const name = document.getElementById('player-name-input').value;
    if (!name) return showModal("ERROR", "Enter a name first!");
    socket.emit('create-room', name);
};

// Join Room Button
document.getElementById('join-room-btn').onclick = () => {
    connectMultiplayer(); // Ensure socket is connected
    const name = document.getElementById('player-name-input').value;
    const room = document.getElementById('join-room-input').value.toUpperCase();
    if (!name || !room) return showModal("ERROR", "Name and Room Key required!");
    socket.emit('join-room', { roomId: room, name: name });
};