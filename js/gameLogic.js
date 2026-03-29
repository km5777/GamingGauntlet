let gameState = {
    phase: "drafting",
    turn: "p1",
    player1: { draftedForP2: [], draftedForP1: [], keeps: [], kills: [], rerolls: 2 },
    player2: { draftedForP1: [], draftedForP2: [], keeps: [], kills: [], rerolls: 2 }
};

let hlState = {
    p1Score: 0, p2Score: 0,
    currentStandardGame: null, nextGame: null,
    roundCount: 0
};

let brState = {
    p1Pool: [], p2Pool: [],
    p1Ranking: [], p2Ranking: [],
    p1CurrentGame: null, p2CurrentGame: null
};

let ccState = {
    category: "",
    revealTurn: "p1",
    revealIndex: 4 // 4 to 0 (Rank 5 to Rank 1)
};

let ppState = {
    p1Choices: [], 
    p2Choices: [],
    roundIndex: 0
};

let draftLimit = 10;
let currentSelections = [];

function toggleGameSelection(gameId) {
    const index = currentSelections.indexOf(gameId);
    if (index > -1) {
        currentSelections.splice(index, 1);
        return true;
    } else if (currentSelections.length < draftLimit) {
        currentSelections.push(gameId);
        return true;
    }
    showModal("LIMIT REACHED", `You already picked ${draftLimit}!`);
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

    if (hlState.roundCount >= 20) {
        const winner = hlState.p1Score > hlState.p2Score ? getPlayerName('p1') : getPlayerName('p2');
        showModal("GAME OVER", `${winner} WINS!`);
        resetGameToMenu();
        return;
    }

    // Move turn forward
    const nextTurn = (gameState.turn === 'p1') ? 'p2' : 'p1';

    if (!myRoomData.isOnline || amILeader) {
        // Leader decides the next game
        hlState.currentStandardGame = hlState.nextGame;
        hlState.nextGame = masterGameLibrary.pop();
        gameState.turn = nextTurn;

        if (myRoomData.isOnline) {
            socket.emit('hl-next-game-sync', {
                roomId: myRoomData.roomId,
                std: hlState.currentStandardGame,
                nextGame: hlState.nextGame,
                turn: gameState.turn,
                round: hlState.roundCount,
                p1Score: hlState.p1Score,
                p2Score: hlState.p2Score
            });
        }
        setupHLRound();
    }
}


function handleConfirm() {
    if (myRoomData.isOnline) {
        if (myIdentity === 'p1') gameState.player1.draftedForP2 = [...currentSelections];
        else gameState.player2.draftedForP1 = [...currentSelections];

        document.getElementById('confirm-btn').disabled = true;
        document.getElementById('confirm-btn').innerText = "WAITING...";
        socket.emit('player-ready-draft', { 
            roomId: myRoomData.roomId,
            draftList: currentSelections.map(id => {
                let g = masterGameLibrary.find(x => Number(x.id) === Number(id));
                return g ? { id: Number(g.id), name: g.name, background_image: g.background_image } : null;
            }).filter(g => g !== null)
        });
    } else {
        // Local Mode Logic
        if (gameState.turn === 'p1') {
            gameState.player1.draftedForP2 = [...currentSelections];
            startPlayer2Draft();
        } else {
            gameState.player2.draftedForP1 = [...currentSelections];
            if (gameState.phase === 'blind_ranking') {
                startBlindRankingPhase();
            } else if (gameState.phase === 'category_clash') {
                startCategoryClashPhase();
            } else if (gameState.phase === 'keep_cut_upgrade') {
                startKeepCutUpgradePhase();
            } else if (gameState.phase === 'oup') {
                startOUPPhase();
            } else if (gameState.phase === 'price_paradox') {
                startPriceParadoxPhase();
            } else {
                startKeepKillPhase();
            }
        }
    }
}