const API_KEY = "62593b97a74e46aca2f4820ee2548f86";
let p1Library = [];
let p2Library = [];
let masterGameLibrary = [];

async function loadGames() {
    document.getElementById('main-menu').style.display = 'none';
    document.getElementById('loading-screen').style.display = 'flex';

    try {
        // To keep games "Well Known", we only look at the first 10 pages 
        // of the most popular games in the database.
        const randomPage1 = Math.floor(Math.random() * 10) + 1;
        const randomPage2 = Math.floor(Math.random() * 10) + 1;

        // Fixed URL: added /games? and used &ordering=-added to get famous titles
        const url1 = `https://api.rawg.io/api/games?key=${API_KEY}&page_size=40&page=${randomPage1}&metacritic=80,100&ordering=-added`;
        const url2 = `https://api.rawg.io/api/games?key=${API_KEY}&page_size=40&page=${randomPage2}&metacritic=80,100&ordering=-added`;

        const [response1, response2] = await Promise.all([fetch(url1), fetch(url2)]);

        if (!response1.ok || !response2.ok) throw new Error("API Limit or Error");
        const data1 = await response1.json();
        const data2 = await response2.json();

        // 1. Combine all results
        let combinedResults = [...data1.results, ...data2.results];

        // 2. Remove duplicates
        masterGameLibrary = combinedResults.filter((game, index, self) =>
            index === self.findIndex((g) => g.id === game.id)
        );

        // 3. Shuffle
        masterGameLibrary.sort(() => Math.random() - 0.5);

        // 4. DYNAMIC SLICE: Give P1 the first half, P2 the second half
        const half = Math.floor(masterGameLibrary.length / 2);
        p1Library = masterGameLibrary.slice(0, half);
        p2Library = masterGameLibrary.slice(half);

        console.log(`P1 has ${p1Library.length} games, P2 has ${p2Library.length} games`);

        document.getElementById('loading-screen').style.display = 'none';
        document.getElementById('app').style.display = 'block';

        renderGameLibrary(p1Library);

        // Header fix for Local Mode
        if (!myRoomData.isOnline) {
            document.getElementById('turn-indicator').innerText = "PLAYER 1: DRAFT 10 GAMES";
        }

    } catch (e) {
        console.error(e);
        showModal("API ERROR", "The game database is currently unavailable. Try again in a moment.");
    }
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