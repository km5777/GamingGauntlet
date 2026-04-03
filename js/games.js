const API_KEY = "62593b97a74e46aca2f4820ee2548f86";
let masterGameLibrary = [];
let currentVariant = 'random';
let draftingPool = [];
let isGuestWaiting = false;

/**
 * gameHasStarted — one-shot guard for finalizeGameStart().
 * Prevents double-init if both the 'always broadcast' and 'on-demand'
 * library sync paths deliver init-library to the same player.
 * Reset in resetGameToMenu() via the gameLogic or directly here.
 */
let gameHasStarted = false;

/**
 * guestSyncRetryInterval — repeating timer on the guest side.
 * Re-sends request-library-sync every 3 seconds until the library arrives.
 */
let guestSyncRetryInterval = null;

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
        document.querySelector('.loading-text').innerText = 'WAITING FOR LEADER TO SYNC...';

        // Send the initial request
        socket.emit('request-library-sync', { roomId: myRoomData.roomId });

        // Retry every 3 seconds in case the first request was dropped
        // (Render.com free tier can drop socket events during wake-up).
        // The interval is cancelled inside the init-library handler.
        if (guestSyncRetryInterval) clearInterval(guestSyncRetryInterval);
        guestSyncRetryInterval = setInterval(() => {
            if (!myRoomData.isOnline || gameHasStarted) {
                clearInterval(guestSyncRetryInterval);
                return;
            }
            socket.emit('request-library-sync', { roomId: myRoomData.roomId });
        }, 3000);
        return;
    }

    try {
        const pages = Array.from({ length: 10 }, () => Math.floor(Math.random() * 25) + 1);
        const requests = pages.map(page =>
            fetch(`https://api.rawg.io/api/games?key=${API_KEY}&page_size=40&page=${page}&ordering=-added&dates=1980-01-01,2026-12-31`)
                .then(res => {
                    if (!res.ok) return { results: [] };
                    return res.json().catch(() => ({ results: [] }));
                })
                .catch(err => ({ results: [] })) // Prevent fetch network errors from crashing Promises
        );

        const allResults = await Promise.all(requests);
        let bigList = allResults.flatMap(data => data.results || []);

        if (bigList.length === 0) {
            bigList = [
                { id: 1, name: "RAWG Error: Fallback 1", background_image: "", added: 3000, released: "2024-01-01" },
                { id: 2, name: "RAWG Error: Fallback 2", background_image: "", added: 3000, released: "2024-01-01" },
                { id: 3, name: "RAWG Error: Fallback 3", background_image: "", added: 3000, released: "2024-01-01" },
                { id: 4, name: "RAWG Error: Fallback 4", background_image: "", added: 3000, released: "2024-01-01" },
                { id: 5, name: "RAWG Error: Fallback 5", background_image: "", added: 3000, released: "2024-01-01" },
                { id: 6, name: "RAWG Error: Fallback 6", background_image: "", added: 3000, released: "2024-01-01" },
                { id: 7, name: "RAWG Error: Fallback 7", background_image: "", added: 3000, released: "2024-01-01" },
                { id: 8, name: "RAWG Error: Fallback 8", background_image: "", added: 3000, released: "2024-01-01" },
                { id: 9, name: "RAWG Error: Fallback 9", background_image: "", added: 3000, released: "2024-01-01" },
                { id: 10, name: "RAWG Error: Fallback 10", background_image: "", added: 3000, released: "2024-01-01" }
            ];
        }

        masterGameLibrary = bigList.filter((game, index, self) =>
            game.background_image &&
            game.released && // FIX: Strictly reject games without release dates
            game.added > 2500 &&
            index === self.findIndex((g) => g.id === game.id)
        ).map(game => ({
            id: game.id,
            name: game.name,
            background_image: game.background_image,
            released: game.released
        }));

        shuffleArray(masterGameLibrary);
        draftingPool = [...masterGameLibrary];

        // ── Online leader: always broadcast library the moment it's ready ──
        // Removed the `isGuestWaiting` gate — leader now proactively sends
        // so the guest doesn't have to perfectly time its request-library-sync.
        if (!myRoomData.isOnline) {
            finalizeGameStart();
        } else if (amILeader) {
            socket.emit('init-library', {
                roomId: myRoomData.roomId,
                library: masterGameLibrary,
                pool: draftingPool,
                ccCategory: ccState.category,
                kcuPhaseBypass: gameState.phase
            });
            isGuestWaiting = false;
            document.querySelector('.loading-text').innerText = 'WAITING FOR FRIEND TO JOIN...';
        }

    } catch (e) {
        console.error(e);
        resetGameToMenu();
    }
}

function finalizeGameStart() {
    // Guard: prevent double-init if both the proactive broadcast and the
    // on-demand sync-library both deliver init-library to the same player.
    if (gameHasStarted) return;
    gameHasStarted = true;

    // Cancel guest retry loop if still running
    if (guestSyncRetryInterval) {
        clearInterval(guestSyncRetryInterval);
        guestSyncRetryInterval = null;
    }

    // CrazyGames: The match has officially started
    if (window.CrazyGames && window.CrazyGames.SDK) {
        window.CrazyGames.SDK.game.gameplayStart();
        window.CrazyGames.SDK.game.hideInviteButton();
    }

    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';

    const leaveBtn = document.getElementById('leave-game-btn');
    if (leaveBtn) leaveBtn.style.display = 'block';

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
                socket.emit('hl-init-games', { // FIX: Changed from hl-start-game
                    roomId: myRoomData.roomId,
                    std: hlState.currentStandardGame,
                    next: hlState.nextGame,
                    turn: gameState.turn
                });
            }
            setupHLRound();
        }
    } else if (gameState.phase === "price_paradox" && currentVariant === "random_10") {
        document.getElementById('draft-phase').style.display = 'none';
        startPPRandomPhase();
        return;
    } else {
        // Drafting Mode (Keep/Kill)
        document.getElementById('draft-phase').style.display = 'block';
        document.getElementById('hl-phase').style.display = 'none';
        if (currentVariant === 'search') {
            document.getElementById('search-container').style.display = 'block';
            document.getElementById('reroll-btn').style.display = 'none';
            document.getElementById('game-library').innerHTML = '';
            if (gameState.phase === 'category_clash') {
                renderCCDraftGrid();
            }
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
        const url = `https://api.rawg.io/api/games?key=${API_KEY}&search=${query}&page_size=10`;
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
        draftingPool = [...masterGameLibrary];
        shuffleArray(draftingPool);
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