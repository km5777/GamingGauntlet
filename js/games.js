const API_KEY = "62593b97a74e46aca2f4820ee2548f86";
let masterPool = []; // One massive bucket of thousands of famous games
let currentVariant = 'random';
let draftingPool = [];

async function loadGames() {
    document.getElementById('main-menu').style.display = 'none';
    document.getElementById('loading-screen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';

    // If Online and NOT Leader, stop here. Wait for the socket to send data.
    if (myRoomData.isOnline && !amILeader) {
        document.querySelector('.loading-text').innerText = "WAITING FOR LEADER TO SYNC ARENA...";
        return;
    }

    // SEARCH MODE (Special Case)
    if (currentVariant === 'search' && gameState.phase === 'drafting') {
        finalizeGameStart([], []); // Search doesn't need a library fetch
        return;
    }

    try {
        const pages = Array.from({ length: 6 }, () => Math.floor(Math.random() * 25) + 1);
        const requests = pages.map(page =>
            fetch(`https://api.rawg.io/api/games?key=${API_KEY}&page_size=40&page=${page}&ordering=-added&dates=1980-01-01,2026-12-31`)
                .then(res => res.json())
        );

        const allResults = await Promise.all(requests);
        let bigList = allResults.flatMap(data => data.results || []);

        masterGameLibrary = bigList.filter((game, index, self) =>
            game.background_image !== null && game.added > 2500 &&
            index === self.findIndex((g) => g.id === game.id)
        );

        masterGameLibrary.sort(() => Math.random() - 0.5);
        draftingPool = [...masterGameLibrary];

        // SYNC TO FRIEND
        if (myRoomData.isOnline && amILeader) {
            socket.emit('sync-library', {
                roomId: myRoomData.roomId,
                library: masterGameLibrary,
                pool: draftingPool
            });
        }

        finalizeGameStart();

    } catch (e) {
        console.error(e);
        showModal("ERROR", "API Failure.");
        resetGameToMenu();
    }
}

function finalizeGameStart() {
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    document.getElementById('leave-game-btn').style.display = 'block';

    if (gameState.phase === "higher_lower") {
        document.getElementById('draft-phase').style.display = 'none';
        document.getElementById('hl-phase').style.display = 'flex';

        // Only Leader (or local player) picks the starting games
        if (!myRoomData.isOnline || amILeader) {
            hlState.currentStandardGame = masterGameLibrary.pop();
            hlState.nextGame = masterGameLibrary.pop();

            // Tell the friend exactly which two games we start with
            if (myRoomData.isOnline) {
                socket.emit('hl-start-game', {
                    roomId: myRoomData.roomId,
                    std: hlState.currentStandardGame,
                    next: hlState.nextGame
                });
            }
            setupHLRound();
        }
    } else {
        // Keep/Kill Logic
        document.getElementById('draft-phase').style.display = 'block';
        document.getElementById('hl-phase').style.display = 'none';
        if (currentVariant === 'search') {
            document.getElementById('search-container').style.display = 'block';
            document.getElementById('reroll-btn').style.display = 'none';
            document.getElementById('game-library').innerHTML = '';
        } else {
            document.getElementById('search-container').style.display = 'none';
            document.getElementById('reroll-btn').style.display = 'block';
            refreshLibraryUI();
        }
        updateDraftHeader();
    }
}

async function searchRAWG(query) {
    if (query.length < 3) return [];
    try {
        // Added &search_precise=true to make results more relevant
        const url = `https://api.rawg.io/api/games?key=${API_KEY}&search=${query}&page_size=10&search_precise=true`;
        const resp = await fetch(url);
        if (!resp.ok) return [];
        const data = await resp.json();
        return data.results || [];
    } catch (e) {
        return [];
    }
}

function refreshLibraryUI() {
    // THE FIX: If the pool gets low, refill it from the master library
    if (draftingPool.length < 40) {
        console.log("Refilling drafting pool from master library...");
        draftingPool = [...masterGameLibrary].sort(() => Math.random() - 0.5);
    }

    // Grab 40 from the drafting pool
    const displayBatch = draftingPool.splice(0, 40);
    renderGameLibrary(displayBatch);
}

const startBtn = document.getElementById('start-game-btn');
if (startBtn) {
    startBtn.onclick = () => {
        if (typeof startMusic === "function") startMusic();

        // ONLY change text if we are NOT in the online lobby
        if (!myRoomData.isOnline) {
            startBtn.innerText = "INITIALIZING ARENA...";
            setTimeout(() => {
                loadGames();
            }, 600);
        }
    };
}