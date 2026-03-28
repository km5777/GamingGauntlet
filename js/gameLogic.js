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
    // 1. Reset Scores
    hlState.p1Score = 0;
    hlState.p2Score = 0;
    hlState.roundCount = 0;
    gameState.turn = "p1";

    // 2. Hide Menu, Show App
    document.getElementById('main-menu').style.display = 'none';
    document.getElementById('loading-screen').style.display = 'flex';

    // 3. We use the existing Random Scraper to get popular games
    currentVariant = 'random';
    loadGames().then(() => {
        // Once games are loaded, grab the first two
        hlState.currentStandardGame = masterGameLibrary.pop();
        hlState.nextGame = masterGameLibrary.pop();
        setupHLRound();
    });
}

function proceedHL() {
    hlState.roundCount++;

    // End Game after 20 rounds (10 turns each)
    if (hlState.roundCount >= 20) {
        let winnerMsg = "";
        const p1N = getPlayerName('p1');
        const p2N = getPlayerName('p2');

        if (hlState.p1Score > hlState.p2Score) winnerMsg = `${p1N} WINS!`;
        else if (hlState.p2Score > hlState.p1Score) winnerMsg = `${p2N} WINS!`;
        else winnerMsg = "IT'S A TIE!";

        showModal("GAME OVER", `${winnerMsg}\nFinal: ${p1N}: ${hlState.p1Score} | ${p2N}: ${hlState.p2Score}`);
        resetGameToMenu();
        return;
    }

    // Shift games
    hlState.currentStandardGame = hlState.nextGame;

    // Safety check for empty library
    if (masterGameLibrary.length === 0) {
        console.log("Master library empty, refilling for H/L...");
        masterGameLibrary = [...draftingPool].sort(() => Math.random() - 0.5);
    }
    hlState.nextGame = masterGameLibrary.pop();

    // Swap Turn
    gameState.turn = (gameState.turn === 'p1') ? 'p2' : 'p1';

    setupHLRound();
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