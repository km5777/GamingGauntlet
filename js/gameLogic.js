// The Master Game State
let gameState = {
    phase: "drafting",
    turn: "p1",
    player1: {
        draftedForP2: [],
        keeps: [],
        kills: [],
        rerolls: 2 // Player 1's rerolls
    },
    player2: {
        draftedForP1: [],
        keeps: [],
        kills: [],
        rerolls: 2 // Player 2's rerolls
    }
};

let currentSelections = [];

function toggleGameSelection(gameId) {
    const index = currentSelections.indexOf(gameId);
    if (index > -1) {
        currentSelections.splice(index, 1);
        return true;
    } else if (currentSelections.length < 10) {
        currentSelections.push(gameId);
        return true;
    }
    showModal("LIMIT REACHED", "You already picked 10!");
    return false;
}

function handleConfirm() {
    if (myRoomData && myRoomData.isOnline) {
        if (myIdentity === 'p1') gameState.player1.draftedForP2 = [...currentSelections];
        else gameState.player2.draftedForP1 = [...currentSelections];

        document.getElementById('confirm-btn').disabled = true;
        document.getElementById('confirm-btn').innerText = "WAITING...";

        // ADD THIS CHECK: Only emit if socket exists
        if (socket) {
            socket.emit('player-ready-draft', { roomId: myRoomData.roomId });
        }
    } else {
        // ... (Keep your existing local swap logic)
        if (gameState.player1.draftedForP2.length === 0) {
            gameState.player1.draftedForP2 = [...currentSelections];
            currentSelections = [];
            startPlayer2Draft();
            document.getElementById('confirm-btn').innerText = "CONFIRM DRAFT";
        } else {
            gameState.player2.draftedForP1 = [...currentSelections];
            gameState.phase = "keep_kill";
            startKeepKillPhase();
        }
    }
}