const API_KEY = "62593b97a74e46aca2f4820ee2548f86";
let masterGameLibrary = []; // One massive bucket of thousands of famous games
let currentVariant = 'random';
let draftingPool = [];
let isGuestWaiting = false;

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

async function loadGames() {
    document.getElementById('main-menu').style.display = 'none';
    document.getElementById('loading-screen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';

    if (myRoomData.isOnline && !amILeader) {
        document.querySelector('.loading-text').innerText = "WAITING FOR LEADER TO SYNC...";
        // TELL THE LEADER: "I am here and ready for the library!"
        socket.emit('request-library-sync', { roomId: myRoomData.roomId });
        return;
    }

    try {
        const pages = Array.from({ length: 6 }, () => Math.floor(Math.random() * 25) + 1);
        const requests = pages.map(page =>
            fetch(`https://api.rawg.io/api/games?key=${API_KEY}&page_size=40&page=${page}&ordering=-added&dates=1980-01-01,2026-12-31`)
                .then(res => {
                    if (!res.ok) return { results: [] };
                    return res.json().catch(() => ({ results: [] }));
                })
        );

        const allResults = await Promise.all(requests);
        let bigList = allResults.flatMap(data => data.results || []);

        masterGameLibrary = bigList.filter((game, index, self) =>
            game.background_image !== null && game.added > 2500 &&
            index === self.findIndex((g) => g.id === game.id)
        ).map(game => ({
            id: game.id,
            name: game.name,
            background_image: game.background_image,
            released: game.released || null
        }));

        shuffleArray(masterGameLibrary);
        draftingPool = [...masterGameLibrary];

        // If local, start now. If online, we wait for P2 to ask 
        if (!myRoomData.isOnline) {
            finalizeGameStart();
        } else {
            if (amILeader && isGuestWaiting) {
                socket.emit('sync-library', {
                    roomId: myRoomData.roomId,
                    library: masterGameLibrary,
                    pool: draftingPool
                });
                isGuestWaiting = false;
            }
            document.querySelector('.loading-text').innerText = "WAITING FOR FRIEND TO JOIN...";
        }

    } catch (e) {
        console.error(e);
        resetGameToMenu();
    }
}

function finalizeGameStart() {
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';

    const counter = document.getElementById('counter');
    if (counter) counter.innerText = `SELECTED: 0 / ${draftLimit}`;

    if (gameState.phase === "higher_lower") {
        document.getElementById('draft-phase').style.display = 'none';
        document.getElementById('hl-phase').style.display = 'flex';

        if (!myRoomData.isOnline || amILeader) {
            // Leader generates the first round
            hlState.currentStandardGame = masterGameLibrary.pop();
            hlState.nextGame = masterGameLibrary.pop();
            gameState.turn = 'p1';

            if (myRoomData.isOnline) {
                socket.emit('hl-start-game', {
                    roomId: myRoomData.roomId,
                    std: hlState.currentStandardGame,
                    next: hlState.nextGame,
                    turn: gameState.turn
                });
            }
            setupHLRound();
        }
    } else {
        // Drafting Mode (Keep/Kill)
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
    if (draftingPool.length < 80) {
        console.log("Refilling drafting pool from master library...");
        draftingPool = [...masterGameLibrary];
        shuffleArray(draftingPool);
    }

    // Grab 80 from the drafting pool
    const displayBatch = draftingPool.splice(0, 80);
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