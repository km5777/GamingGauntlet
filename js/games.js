const API_KEY = "62593b97a74e46aca2f4820ee2548f86";
let masterPool = []; // One massive bucket of thousands of famous games

async function loadGames() {
    document.getElementById('main-menu').style.display = 'none';
    document.getElementById('loading-screen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';

    try {
        // Fetching 12 random pages from the Top 500 (Potential pool of 20,000+ games)
        // Platform 7 = Nintendo Switch, 4 = PC, 187 = PS5, 1 = Xbox
        const pages = Array.from({ length: 12 }, () => Math.floor(Math.random() * 25) + 1);
        const requests = pages.map(page =>
            fetch(`https://api.rawg.io/api/games?key=${API_KEY}&page_size=40&page=${page}&ordering=-added&dates=1980-01-01,2026-12-31`)
                .then(res => res.json())
        );

        const allResults = await Promise.all(requests);
        let bigList = allResults.flatMap(data => data.results || []);

        // --- THE STRICT FAMOUS FILTER ---
        masterPool = bigList.filter((game, index, self) =>
            game.background_image !== null &&
            game.added > 2500 && // ONLY games with 2500+ "Added" (Famous Titles)
            index === self.findIndex((g) => g.id === game.id)
        );

        // Shuffle the whole bucket
        masterPool.sort(() => Math.random() - 0.5);

        console.log(`Master Pool Ready: ${masterPool.length} Famous Titles Loaded.`);

        // Setup Match State
        gameState.turn = "p1";
        gameState.player1.rerolls = 2;
        gameState.player2.rerolls = 2;

        document.getElementById('loading-screen').style.display = 'none';
        document.getElementById('app').style.display = 'block';
        document.getElementById('leave-game-btn').style.display = 'block';

        // Directly grab first batch for P1
        refreshLibraryUI();
        updateDraftHeader();

    } catch (e) {
        console.error(e);
        showModal("CONNECTION ERROR", "RAWG is slow. Try again!");
    }
}

function refreshLibraryUI() {
    if (masterPool.length < 40) {
        showModal("POOL EMPTY", "No more games left in the arena!");
        return;
    }

    // 1. Grab 40 games from the top of the master pool
    const displayBatch = masterPool.splice(0, 40);

    // 2. These 40 are now REMOVED from the masterPool. 
    // Neither player will ever see them again in this match.
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