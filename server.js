const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());

const http = require('http').createServer(app);

const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        allowedHeaders: ["*"]
    }
});

app.get('/', (req, res) => {
    res.send('SERVER IS AWAKE');
});

let rooms = {};

// ─── HELPERS ────────────────────────────────────────────────────────────────

/**
 * Remove a player from a room and reassign leadership if needed.
 * Returns the updated room, or null if the room was destroyed.
 */
function removePlayerFromRoom(socketId, roomId) {
    const room = rooms[roomId];
    if (!room) return null;

    room.players = room.players.filter(p => p.id !== socketId);

    if (room.players.length === 0) {
        delete rooms[roomId];
        return null;
    }

    // If the leader left, promote the next player
    if (!room.players[0].isLeader) {
        room.players[0].isLeader = true;
        room.players[0].role = 'p1';
    }
    return room;
}

/**
 * Security guard for all relay events.
 * Ensures:
 *   1. The room exists
 *   2. There are exactly 2 players (game is live)
 *   3. The emitter is actually a member of the room
 *
 * This prevents ghost players (disconnected + reconnected sockets) from
 * driving the state machine after their session is gone.
 */
function validateRelay(data, socket) {
    if (!data || !data.roomId) return false;
    const room = rooms[data.roomId];
    if (!room) return false;
    if (room.players.length < 2) return false;
    return room.players.some(p => p.id === socket.id);
}

// ─── CONNECTION HANDLER ──────────────────────────────────────────────────────

io.on('connection', (socket) => {

    // ── Lobby ──────────────────────────────────────────────────────────────

    socket.on('create-room', (name) => {
        const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomId] = {
            players: [{ id: socket.id, name: name, role: 'p1', isLeader: true, ready: false }]
        };
        socket.join(roomId);
        socket.emit('room-created', { roomId, name, role: 'p1', isLeader: true });
    });

    socket.on('join-room', (data) => {
        const room = rooms[data.roomId];
        if (room && room.players.length === 1) {
            const newPlayer = { id: socket.id, name: data.name, role: 'p2', isLeader: false, ready: false };
            room.players.push(newPlayer);
            socket.join(data.roomId);
            io.to(data.roomId).emit('room-updated', { roomId: data.roomId, players: room.players });
            socket.emit('identity-assigned', { role: 'p2', isLeader: false });
        } else {
            socket.emit('error', 'Room is full or room key is invalid.');
        }
    });

    socket.on('leave-room', (roomId) => {
        socket.leave(roomId);
        const updatedRoom = removePlayerFromRoom(socket.id, roomId);
        if (updatedRoom) {
            io.to(roomId).emit('room-updated', { roomId, players: updatedRoom.players });
        }
    });

    socket.on('kick-player', (data) => {
        const room = rooms[data.roomId];
        // Only the leader (first player) can kick
        if (room && room.players.length > 0 && room.players[0].id === socket.id) {
            const targetSocket = io.sockets.sockets.get(data.targetId);
            if (targetSocket) {
                targetSocket.leave(data.roomId);
                targetSocket.emit('kicked');
            }
            const updatedRoom = removePlayerFromRoom(data.targetId, data.roomId);
            if (updatedRoom) {
                io.to(data.roomId).emit('room-updated', { roomId: data.roomId, players: updatedRoom.players });
            }
        }
    });

    // ── Game Start ─────────────────────────────────────────────────────────

    socket.on('start-game-request', (data) => {
        const room = rooms[data.roomId];
        // Only the leader can start
        if (room && room.players[0].id === socket.id) {
            room.players.forEach(p => {
                p.ready = false;
                p.draftList = [];
            });
            io.to(data.roomId).emit('init-online-game', {
                variant: data.variant,
                phase: data.phase,
                limit: data.limit,
                categoryText: data.categoryText
            });
        }
    });

    // ── Library Sync ───────────────────────────────────────────────────────

    // Guest requests the game library from the Leader
    socket.on('request-library-sync', (data) => {
        socket.to(data.roomId).emit('send-library-to-guest');
    });

    // Leader sends the library to everyone in the room
    socket.on('sync-library', (data) => {
        io.to(data.roomId).emit('init-library', data);
    });

    // ── Draft Phase ────────────────────────────────────────────────────────

    socket.on('player-ready-draft', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;

        const player = room.players.find(pl => pl.id === socket.id);
        if (player) {
            player.ready = true;
            player.draftList = data.draftList || [];
        }

        io.to(data.roomId).emit('update-draft-status', room.players);

        // When both players are ready, send both draft lists to everyone
        if (room.players.every(pl => pl.ready)) {
            const p1 = room.players.find(pl => pl.role === 'p1');
            const p2 = room.players.find(pl => pl.role === 'p2');
            io.to(data.roomId).emit('start-duel-phase', {
                p1Draft: p1 ? p1.draftList : [],
                p2Draft: p2 ? p2.draftList : []
            });
        }
    });

    // ── Game Relay Events (all validated) ──────────────────────────────────

    // Higher/Lower: Leader syncs initial games to guest
    socket.on('hl-start-game', (data) => {
        if (!validateRelay(data, socket)) return;
        io.to(data.roomId).emit('hl-init-games', data);
    });

    // Higher/Lower: Leader syncs next round to guest
    socket.on('hl-next-game-sync', (data) => {
        if (!validateRelay(data, socket)) return;
        io.to(data.roomId).emit('hl-receive-next', data);
    });

    // Multi-purpose sync event (H/L guesses, CC reveals, OUP decisions, PP decisions)
    socket.on('hl-guess-sync', (data) => {
        if (!validateRelay(data, socket)) return;
        io.to(data.roomId).emit('hl-sync-reveal', data);
    });

    // Higher/Lower: Sync turn swap
    socket.on('hl-next-round', (data) => {
        if (!validateRelay(data, socket)) return;
        io.to(data.roomId).emit('hl-do-next-round');
    });

    // Higher/Lower: Guest requests state resync from Leader
    socket.on('hl-request-resync', (data) => {
        if (!validateRelay(data, socket)) return;
        socket.to(data.roomId).emit('hl-resync-request');
    });

    // Keep/Kill: Attacker reveals a game to the defender
    socket.on('reveal-game', (data) => {
        if (!validateRelay(data, socket)) return;
        io.to(data.roomId).emit('opponent-revealed', data.game);
    });

    // Keep/Kill: Defender submits Keep or Kill decision
    socket.on('decision-made', (data) => {
        if (!validateRelay(data, socket)) return;
        io.to(data.roomId).emit('opponent-decided', data);
    });

    // Blind Ranking / Keep-Cut-Upgrade: A player places a game in a slot
    socket.on('br-place-game', (data) => {
        if (!validateRelay(data, socket)) return;
        socket.to(data.roomId).emit('br-opponent-placed', data);
    });

    // Category Clash: Obsoleted fallback relay (hijacked via hl-guess-sync)
    socket.on('cc-reveal', (data) => {
        if (!validateRelay(data, socket)) return;
        io.to(data.roomId).emit('cc-reveal-sync', data);
    });

    // ── Disconnect ─────────────────────────────────────────────────────────

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            if (room && room.players.some(p => p.id === socket.id)) {
                const updatedRoom = removePlayerFromRoom(socket.id, roomId);
                if (updatedRoom) {
                    io.to(roomId).emit('room-updated', { roomId, players: updatedRoom.players });
                }
                break; // A player can only be in one room
            }
        }
    });

});

// ─── START SERVER ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`GamingGauntlet server running on port ${PORT}`));