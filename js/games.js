const API_KEY = "62593b97a74e46aca2f4820ee2548f86";
let masterPool = []; // One massive bucket of thousands of famous games
let currentVariant = 'random';
let draftingPool = [];

async function loadGames() {
    // 1. Reset standard UI and show loading
    document.getElementById('main-menu').style.display = 'none';
    document.getElementById('loading-screen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';

    // Reset basic game states
    gameState.turn = "p1";
    gameState.player1.rerolls = 2;
    gameState.player2.rerolls = 2;
    hlState.roundCount = 0;
    hlState.p1Score = 0;
    hlState.p2Score = 0;

    // 2. THE FIX: CHECK FOR SEARCH MODE BEFORE FETCHING
    if (currentVariant === 'search' && gameState.phase === 'drafting') {
        document.getElementById('loading-screen').style.display = 'none';
        document.getElementById('app').style.display = 'block';
        document.getElementById('draft-phase').style.display = 'block';
        document.getElementById('hl-phase').style.display = 'none';
        document.getElementById('duel-phase').style.display = 'none';

        // Setup Search UI
        document.getElementById('search-container').style.display = 'block';
        document.getElementById('reroll-btn').style.display = 'none';
        document.getElementById('game-library').innerHTML = ''; // Clear old cards
        document.getElementById('leave-game-btn').style.display = 'block';

        masterGameLibrary = []; // Clear for new lookups
        updateDraftHeader();
        return; // STOP HERE - Do not fetch random games
    }

    // 3. RANDOM / HIGHER-LOWER FETCH LOGIC
    try {
        // Ensure search container is hidden for random modes
        document.getElementById('search-container').style.display = 'none';
        document.getElementById('reroll-btn').style.display = 'block';

        const pages = Array.from({ length: 12 }, () => Math.floor(Math.random() * 25) + 1);
        const requests = pages.map(page =>
            fetch(`https://api.rawg.io/api/games?key=${API_KEY}&page_size=40&page=${page}&ordering=-added&dates=1980-01-01,2026-12-31`)
                .then(res => res.json())
        );

        const allResults = await Promise.all(requests);
        let bigList = allResults.flatMap(data => data.results || []);

        masterGameLibrary = bigList.filter((game, index, self) =>
            game.background_image !== null &&
            game.added > 2500 &&
            index === self.findIndex((g) => g.id === game.id)
        );

        masterGameLibrary.sort(() => Math.random() - 0.5);
        draftingPool = [...masterGameLibrary];

        document.getElementById('loading-screen').style.display = 'none';
        document.getElementById('app').style.display = 'block';
        document.getElementById('leave-game-btn').style.display = 'block';

        if (gameState.phase === "higher_lower") {
            document.getElementById('draft-phase').style.display = 'none';
            document.getElementById('hl-phase').style.display = 'flex';
            document.getElementById('duel-phase').style.display = 'none';

            hlState.currentStandardGame = masterGameLibrary.pop();
            hlState.nextGame = masterGameLibrary.pop();
            setupHLRound();
        } else {
            document.getElementById('draft-phase').style.display = 'block';
            document.getElementById('hl-phase').style.display = 'none';
            document.getElementById('duel-phase').style.display = 'none';
            refreshLibraryUI();
            updateDraftHeader();
        }

    } catch (e) {
        console.error(e);
        showModal("ERROR", "API Failure.");
        resetGameToMenu();
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