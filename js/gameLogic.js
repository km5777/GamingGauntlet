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
    if (hlState.roundCount >= 20) {
        const winner = hlState.p1Score > hlState.p2Score ? getPlayerName('p1') : getPlayerName('p2');
        showModal("GAME OVER", `${winner} WINS!`);
        resetGameToMenu();
        return;
    }

    gameState.turn = (gameState.turn === 'p1') ? 'p2' : 'p1';

    // Only Leader (or local) updates the game state. Guest waits for the socket signal.
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
    }
}

function setupHLRound() {
    document.getElementById('hl-phase').style.display = 'flex';

    // FIX NAMES: Update the scoreboard labels using the new IDs
    const p1Name = getPlayerName('p1');
    const p2Name = getPlayerName('p2');
    document.getElementById('hl-p1-label').innerHTML = `${p1Name}: <span id="hl-p1-score">${hlState.p1Score}</span>`;
    document.getElementById('hl-p2-label').innerHTML = `${p2Name}: <span id="hl-p2-score">${hlState.p2Score}</span>`;

    // Set the Turn Header to the actual player name
    const activePlayerName = getPlayerName(gameState.turn);
    document.getElementById('hl-turn-indicator').innerText = `${activePlayerName}'S TURN`;

    document.getElementById('hl-round-num').innerText = hlState.roundCount + 1;
    document.getElementById('hl-next-card').classList.remove('correct', 'incorrect');

    // Standard Game UI
    const stdYear = hlState.currentStandardGame.released.split('-')[0];
    document.getElementById('hl-standard-year').innerText = stdYear;
    document.getElementById('hl-standard-name').innerText = hlState.currentStandardGame.name;
    document.getElementById('hl-standard-img').src = hlState.currentStandardGame.background_image;

    // Next Game UI
    document.getElementById('hl-next-name').innerText = hlState.nextGame.name;
    document.getElementById('hl-next-img').src = hlState.nextGame.background_image;
    document.getElementById('hl-next-year').classList.add('hidden');

    const isMyTurn = (myRoomData.isOnline) ? (myIdentity === gameState.turn) : true;
    document.getElementById('hl-controls').style.display = isMyTurn ? 'flex' : 'none';
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