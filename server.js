const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

let rooms = {};

io.on('connection', (socket) => {
    // CREATE
    socket.on('create-room', (name) => {
        const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomId] = {
            players: [{ id: socket.id, name: name, role: 'p1', isLeader: true, ready: false }]
        };
        socket.join(roomId);
        socket.emit('room-created', { roomId, name, role: 'p1', isLeader: true });
    });

    // JOIN
    socket.on('join-room', (data) => {
        const room = rooms[data.roomId];
        if (room && room.players.length === 1) { // Ensure only 1 person is there
            const newPlayer = {
                id: socket.id,
                name: data.name,
                role: 'p2',
                isLeader: false,
                ready: false
            };
            room.players.push(newPlayer);
            socket.join(data.roomId);

            // Send the FULL, CORRECT player list to everyone in the room
            io.to(data.roomId).emit('player-joined', {
                roomId: data.roomId,
                players: room.players
            });

            // Tell the joiner specifically they are P2
            socket.emit('identity-assigned', { role: 'p2', isLeader: false });
        } else {
            socket.emit('error', 'Room is full or key is invalid.');
        }
    });

    socket.on('reveal-game', (data) => {
        // io.to sends to EVERYONE in the room, keeping them in sync
        io.to(data.roomId).emit('opponent-revealed', data.game);
    });

    socket.on('decision-made', (data) => {
        io.to(data.roomId).emit('opponent-decided', data);
    });


    // START
    socket.on('start-game-request', (roomId) => {
        const room = rooms[roomId];
        if (room && room.players[0].id === socket.id) {
            io.to(roomId).emit('init-online-game');
        }
    });

    // SYNC DRAFT
    socket.on('player-ready-draft', (data) => {
        const room = rooms[data.roomId];
        if (room) {
            const p = room.players.find(pl => pl.id === socket.id);
            if (p) p.ready = true;
            io.to(data.roomId).emit('update-draft-status', room.players);
            if (room.players.every(pl => pl.ready)) {
                io.to(data.roomId).emit('start-duel-phase');
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));