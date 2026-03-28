let gameState = {
    phase: "drafting",
    turn: "p1",
    player1: { draftedForP2: [], keeps: [], kills: [], rerolls: 2 },
    player2: { draftedForP1: [], keeps: [], kills: [], rerolls: 2 }
};

let hlState = {
    p1Score: 0, p2Score: 0,
    currentStandardGame: null, nextGame: null,
    roundCount: 0
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

function initHigherLower() {
    // Just reset variables and show loading
    hlState.p1Score = 0;
    hlState.p2Score = 0;
    hlState.roundCount = 0;
    gameState.turn = "p1";

    document.getElementById('main-menu').style.display = 'none';
    document.getElementById('loading-screen').style.display = 'flex';

    // loadGames will handle the actual game start once data arrives
    loadGames();
}

function proceedHL() {
    hlState.roundCount++;

    // Check for end of game
    if (hlState.roundCount >= 20) {
        const winner = hlState.p1Score > hlState.p2Score ? getPlayerName('p1') : getPlayerName('p2');
        showModal("GAME OVER", `${winner} WINS!`);
        resetGameToMenu();
        return;
    }

    // Swap logical turn
    gameState.turn = (gameState.turn === 'p1') ? 'p2' : 'p1';

    // AUTHORITY: Only Leader (or local) picks the next game. 
    // Guest MUST NOT run .pop() or they will get a different game.
    if (!myRoomData.isOnline || amILeader) {
        hlState.currentStandardGame = hlState.nextGame;
        hlState.nextGame = masterGameLibrary.pop();

        if (myRoomData.isOnline) {
            socket.emit('hl-next-game-sync', {
                roomId: myRoomData.roomId,
                nextGame: hlState.nextGame
            });
        }
        setupHLRound();
    } else {
        // Guest just waits. 'hl-receive-next' in multiplayer.js will call setupHLRound.
        console.log("Guest waiting for next game sync...");
    }
}


function handleConfirm() {
    if (myRoomData.isOnline) {
        if (myIdentity === 'p1') gameState.player1.draftedForP2 = [...currentSelections];
        else gameState.player2.draftedForP1 = [...currentSelections];

        document.getElementById('confirm-btn').disabled = true;
        document.getElementById('confirm-btn').innerText = "WAITING...";

        socket.emit('player-ready-draft', { roomId: myRoomData.roomId });
    } else {
        // Local Mode Logic
        if (gameState.turn === 'p1') {
            gameState.player1.draftedForP2 = [...currentSelections];
            startPlayer2Draft();
        } else {
            gameState.player2.draftedForP1 = [...currentSelections];
            startKeepKillPhase();
        }
    }
}