const express = require('express');
const cors = require('cors'); // Import this
const app = express();

// Use this to allow the header on the base express app
app.use(cors());

const http = require('http').createServer(app);

// Use this for the Socket.io connection
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        allowedHeaders: ["*"]
    }
});

// Add a "Ping" route to check if the server is awake
app.get('/', (req, res) => {
    res.send('SERVER IS AWAKE');
});

let rooms = {};

// Helper: Safely remove a player and reassign leadership if necessary
function removePlayerFromRoom(socketId, roomId) {
    const room = rooms[roomId];
    if (!room) return null;

    room.players = room.players.filter(p => p.id !== socketId);

    if (room.players.length === 0) {
        delete rooms[roomId]; // Room is empty, destroy it
        return null;
    } else {
        // If the leader left, make the remaining person the leader
        if (!room.players[0].isLeader) {
            room.players[0].isLeader = true;
            room.players[0].role = 'p1';
        }
        return room;
    }
}

io.on('connection', (socket) => {

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

            // Use 'room-updated' to sync the room state for everyone
            io.to(data.roomId).emit('room-updated', { roomId: data.roomId, players: room.players });
            socket.emit('identity-assigned', { role: 'p2', isLeader: false });
        } else {
            socket.emit('error', 'Room is full or key is invalid.');
        }
    });

    // Guest asks the Leader for the game data
    socket.on('request-library-sync', (data) => {
        socket.to(data.roomId).emit('send-library-to-guest');
    });

    // Leader sends the library specifically to the guest who asked
    socket.on('sync-library', (data) => {
        io.to(data.roomId).emit('init-library', data);
    });

    // Sync the Higher/Lower Start
    socket.on('hl-start-game', (data) => {
        // data contains { roomId, std, next, turn }
        io.to(data.roomId).emit('hl-init-games', data);
    });

    // Relay for the next round
    socket.on('hl-next-game-sync', (data) => {
        io.to(data.roomId).emit('hl-receive-next', data);
    });

    socket.on('start-game-request', (data) => {
        const room = rooms[data.roomId];
        if (room && room.players[0].id === socket.id) {
            // Broadcast start signal to everyone
            io.to(data.roomId).emit('init-online-game', {
                variant: data.variant,
                phase: data.phase,
                limit: data.limit
            });
        }
    });

    // --- NEW: KICK & LEAVE LOGIC ---
    socket.on('leave-room', (roomId) => {
        socket.leave(roomId);
        const updatedRoom = removePlayerFromRoom(socket.id, roomId);
        if (updatedRoom) {
            io.to(roomId).emit('room-updated', { roomId: roomId, players: updatedRoom.players });
        }
    });


    socket.on('player-ready-draft', (data) => {
        const room = rooms[data.roomId];
        if (room) {
            const p = room.players.find(pl => pl.id === socket.id);
            if (p) {
                p.ready = true;
                p.draftList = data.draftList || []; 
            }
            io.to(data.roomId).emit('update-draft-status', room.players);
            if (room.players.every(pl => pl.ready)) {
                // Send both draft lists to everyone
                io.to(data.roomId).emit('start-duel-phase', {
                    p1Draft: room.players.find(pl => pl.role === 'p1').draftList || [],
                    p2Draft: room.players.find(pl => pl.role === 'p2').draftList || []
                });
            }
        }
    });

    // 2. Sync Higher/Lower Guesses (Ensures both see the reveal and swap)
    socket.on('hl-guess-sync', (data) => {
        // Broadcast the choice result to both players so borders and years sync
        io.to(data.roomId).emit('hl-sync-reveal', data);
    });

    socket.on('reveal-game', (data) => io.to(data.roomId).emit('opponent-revealed', data.game));
    socket.on('decision-made', (data) => io.to(data.roomId).emit('opponent-decided', data));

    // 3. Sync Higher/Lower Turn Swaps
    socket.on('hl-next-round', (data) => {
        io.to(data.roomId).emit('hl-do-next-round');
    });

    socket.on('br-place-game', (data) => {
        socket.to(data.roomId).emit('br-opponent-placed', data);
    });

    socket.on('kick-player', (data) => {
        const room = rooms[data.roomId];
        // Security check: Only leader can kick
        if (room && room.players.length > 0 && room.players[0].id === socket.id) {
            const targetSocket = io.sockets.sockets.get(data.targetId);
            if (targetSocket) {
                targetSocket.leave(data.roomId);
                targetSocket.emit('kicked'); // Tell the kicked player
            }
            const updatedRoom = removePlayerFromRoom(data.targetId, data.roomId);
            if (updatedRoom) {
                io.to(data.roomId).emit('room-updated', { roomId: data.roomId, players: updatedRoom.players });
            }
        }
    });

    // Handle unexpected disconnects (closing tab)
    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            if (room.players.some(p => p.id === socket.id)) {
                const updatedRoom = removePlayerFromRoom(socket.id, roomId);
                if (updatedRoom) {
                    io.to(roomId).emit('room-updated', { roomId, players: updatedRoom.players });
                }
            }
        }
    });

});


const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));