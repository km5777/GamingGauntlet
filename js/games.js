// --- NSFW & PROFANITY FILTERS ---
const PROFANITY_LIST = [
    "fuck", "shit", "bitch", "cunt", "dick", "pussy", "asshole", "faggot", "fag", "dyke", "cock",
    "nigger", "nigga", "slut", "whore", "porn", "hentai", "sex", "rape", "incest", "pedophile",
    "cum", "blowjob", "tits", "boobs", "vagina", "penis", "masturbate", "adult", "pussy"
];

const EXPLICIT_SUBSTRINGS = ["hentai", "porn", "nsfw", "rule34", "r34", "nude", "nudity", "erotic"];

const NSFW_TAGS = [
    "nsfw", "hentai", "porn", "nudity", "sexual content", "erotic", "adult", "18+", "nsfw-content", "sexual"
];

function containsProfanity(text) {
    if (!text) return false;

    // 1. Convert to lowercase and handle basic leetspeak tricks
    let normalized = text.toLowerCase()
        .replace(/0/g, 'o')
        .replace(/1/g, 'i')
        .replace(/!/g, 'i')
        .replace(/3/g, 'e')
        .replace(/4/g, 'a')
        .replace(/@/g, 'a')
        .replace(/5/g, 's')
        .replace(/\$/g, 's');

    // 2. Strip all punctuation but KEEP spaces for word boundaries 
    let noPunctuation = normalized.replace(/[^\w\s]/g, '');

    // 3. SEVERE WORDS: Substring match (No boundaries).
    // If this sequence of letters appears ANYWHERE inside the string, it is blocked.
    // Moved slurs and undeniable profanity here so they can't be hidden inside other text.
    const SEVERE_WORDS = [
        "fuck", "bitch", "faggot", "porn", "hentai", "pedophile", "rule34", "r34",
        "masturbate", "blowjob", "incest", "vagina", "slut", "whore",
        "nigger", "nigga", "cunt", "asshole" // <-- Moved these from Boundary to Severe
    ];

    // 4. BOUNDARY WORDS: Must be distinct words.
    // We keep short words here to prevent the "Scunthorpe Problem" 
    // (e.g., blocking "class" because it has "ass", or "document" because it has "cum").
    const BOUNDARY_WORDS = [
        "shit", "shits", "shitty", "bullshit",
        "dick", "dicks", "dickhead",
        "pussy", "pussies",
        "rape", "raped", "rapist", "nude", "nudes", "nudity",
        "cum", "cums", "cumming",
        "penis", "penises",
        "ass", "asses",
        "tits", "titties", "boobs", "adult",
        "fag", "fags", "dyke", "dykes",
        "cock", "cocks", "sex", "sexy", "sexual"
    ];

    // HELPER: Generates a regex that catches repeated letters AND internal spaces.
    function buildRegex(word, requireBoundary) {
        const pattern = word.split('').map(char => char + '+').join('\\s*');
        return requireBoundary ? new RegExp(`\\b${pattern}\\b`, 'i') : new RegExp(pattern, 'i');
    }

    // Evaluate Severe Words (Boundary independent - catches "NIGGERGERERER")
    if (SEVERE_WORDS.some(word => buildRegex(word, false).test(noPunctuation))) return true;

    // Evaluate Contextual Words (Must be standalone words)
    if (BOUNDARY_WORDS.some(word => buildRegex(word, true).test(noPunctuation))) return true;

    return false;
}

function isGameNSFW(game) {
    if (!game) return false;
    if (containsProfanity(game.name)) return true;
    if (game.slug && containsProfanity(game.slug)) return true;

    const NSFW_TAGS = ["nsfw", "hentai", "porn", "nudity", "sexual", "erotic", "adult", "18+"];

    if (game.tags) {
        for (let tag of game.tags) {
            if (NSFW_TAGS.some(nsfw => tag.name.toLowerCase().includes(nsfw))) return true;
        }
    }
    if (game.genres) {
        for (let genre of game.genres) {
            if (NSFW_TAGS.some(nsfw => genre.name.toLowerCase().includes(nsfw))) return true;
        }
    }
    return false;
}

// --- ORIGINAL GAMES LOGIC ---
const API_KEY = "62593b97a74e46aca2f4820ee2548f86";
let masterGameLibrary = [];
let currentVariant = 'random';
let draftingPool = [];
let isGuestWaiting = false;

let gameHasStarted = false;
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
        socket.emit('request-library-sync', { roomId: myRoomData.roomId });
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
                .catch(err => ({ results: [] }))
        );

        const allResults = await Promise.all(requests);
        let bigList = allResults.flatMap(data => data.results || []);

        if (bigList.length === 0) {
            bigList = [
                { id: 1, name: "RAWG Error: Fallback 1", background_image: "", added: 3000, released: "2024-01-01" },
                { id: 2, name: "RAWG Error: Fallback 2", background_image: "", added: 3000, released: "2024-01-01" }
            ];
        }

        masterGameLibrary = bigList.filter((game, index, self) =>
            game.background_image &&
            game.released &&
            game.added > 2500 &&
            !isGameNSFW(game) && // <-- ADDED: Filter out inappropriate games
            index === self.findIndex((g) => g.id === game.id)
        ).map(game => ({
            id: game.id,
            name: game.name,
            background_image: game.background_image,
            released: game.released
        }));

        shuffleArray(masterGameLibrary);
        draftingPool = [...masterGameLibrary];

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
    if (gameHasStarted) return;
    gameHasStarted = true;

    if (guestSyncRetryInterval) {
        clearInterval(guestSyncRetryInterval);
        guestSyncRetryInterval = null;
    }

    if (typeof cgSDK !== 'undefined' && cgSDK) {
        cgSDK.game.gameplayStart();
        cgSDK.game.hideInviteButton();
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
            hlState.currentStandardGame = masterGameLibrary.pop();
            hlState.nextGame = masterGameLibrary.pop();
            gameState.turn = 'p1';

            if (myRoomData.isOnline) {
                socket.emit('hl-init-games', {
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
    if (typeof containsProfanity === 'function' && containsProfanity(query)) return []; // <-- ADDED: Reject bad searches

    try {
        const url = `https://api.rawg.io/api/games?key=${API_KEY}&search=${query}&page_size=10`;
        const resp = await fetch(url);
        if (!resp.ok) return [];
        const data = await resp.json();
        const results = data.results || [];

        // <-- ADDED: Filter out NSFW results dynamically on search
        return results.filter(game => !isGameNSFW(game));
    } catch (e) {
        return [];
    }
}

function refreshLibraryUI() {
    if (draftingPool.length < 40) {
        console.log("Refilling drafting pool from master library...");
        draftingPool = [...masterGameLibrary];
        shuffleArray(draftingPool);
    }
    const displayBatch = draftingPool.splice(0, 40);
    renderGameLibrary(displayBatch);
}

const startBtn = document.getElementById('start-game-btn');
if (startBtn) {
    startBtn.onclick = () => {
        if (typeof startMusic === "function") startMusic();
        if (!myRoomData.isOnline) {
            startBtn.innerText = "INITIALIZING ARENA...";
            setTimeout(() => {
                loadGames();
            }, 600);
        }
    };
}