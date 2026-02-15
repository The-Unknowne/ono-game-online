const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

/* =======================
   STATIC FILES & ROUTES
======================= */

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        rooms: rooms.size,
        lobbies: Object.keys(lobbies).length
    });
});

app.get('*', (req, res) => {
    if (!req.url.includes('.')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        res.status(404).send('File not found');
    }
});

/* =======================
   GAME STORAGE
======================= */

const rooms = new Map();
const lobbies = {};

/* =======================
   GAME ROOM CLASS
======================= */

class GameRoom {
    constructor(roomId, players, settings) {
        this.roomId = roomId;
        this.players = players.map(p => ({
            id: p.id,
            name: p.name,
            hand: [],
            calledUno: false
        }));
        this.deck = [];
        this.discardPile = [];
        this.currentPlayer = 0;
        this.currentColor = null;
        this.currentValue = null;
        this.direction = 1;
        this.stackedDrawCount = 0;
        this.settings = settings || {};
        this.gameStarted = false;
    }

    createDeck() {
        const COLORS = ['red', 'blue', 'green', 'yellow'];
        const NUMBERS = ['0','1','2','3','4','5','6','7','8','9'];
        const ACTIONS = ['Skip', 'Reverse', '+2'];

        this.deck = [];

        COLORS.forEach(color => {
            this.deck.push({ color, value: '0', type: 'number' });

            for (let i = 0; i < 2; i++) {
                NUMBERS.slice(1).forEach(n =>
                    this.deck.push({ color, value: n, type: 'number' })
                );
                ACTIONS.forEach(a =>
                    this.deck.push({ color, value: a, type: 'action' })
                );
            }
        });

        for (let i = 0; i < 4; i++) {
            this.deck.push({ color: 'wild', value: 'Wild', type: 'wild' });
            this.deck.push({ color: 'wild', value: 'Wild+4', type: 'wild' });
        }

        this.shuffleDeck();
    }

    shuffleDeck() {
        for (let i = this.deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
        }
    }

    dealCards(count = 7) {
        this.players.forEach(p => {
            p.hand = [];
            for (let i = 0; i < count; i++) {
                p.hand.push(this.deck.pop());
            }
        });

        let start;
        do {
            start = this.deck.pop();
        } while (start.type !== 'number');

        this.discardPile = [start];
        this.currentColor = start.color;
        this.currentValue = start.value;
    }

    getGameState(playerId) {
        const index = this.players.findIndex(p => p.id === playerId);
        const currentPlayerIndex = this.currentPlayer;
        const currentPlayerName = this.players[currentPlayerIndex]?.name || 'Unknown';
        
        return {
            roomId: this.roomId,
            yourHand: this.players[index].hand,
            yourName: this.players[index].name,
            opponents: this.players.filter((_, i) => i !== index).map(p => ({
                name: p.name,
                cardCount: p.hand.length
            })),
            currentPlayer: this.currentPlayer,
            currentPlayerName: currentPlayerName,
            isYourTurn: index === this.currentPlayer,
            discardPile: this.discardPile.at(-1),
            currentColor: this.currentColor,
            currentValue: this.currentValue,
            deckCount: this.deck.length,
            settings: this.settings,
            stackedDrawCount: this.stackedDrawCount
        };
    }

    canPlayCard(card) {
        if (!card) return false;
        if (card.type === 'wild') return true;
        
        if (this.settings.allowStacking && this.stackedDrawCount > 0) {
            if (this.currentValue === '+2' && card.value === '+2') return true;
            if (this.currentValue === 'Wild+4' && card.value === 'Wild+4') return true;
            return false;
        }
        
        return card.color === this.currentColor || card.value === this.currentValue;
    }

    playCard(playerId, cardIndex, chosenColor) {
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1 || playerIndex !== this.currentPlayer) {
            return { success: false, error: 'Not your turn' };
        }

        const player = this.players[playerIndex];
        const card = player.hand[cardIndex];
        
        if (!card) {
            return { success: false, error: 'Invalid card' };
        }

        if (!this.canPlayCard(card)) {
            return { success: false, error: "Can't play that card" };
        }

        // Remove card from player's hand
        player.hand.splice(cardIndex, 1);
        this.discardPile.push(card);

        // Handle wild cards
        if (card.type === 'wild') {
            this.currentColor = chosenColor || 'red';
            this.currentValue = card.value;
            
            if (card.value === 'Wild+4') {
                if (this.settings.allowStacking) {
                    this.stackedDrawCount += 4;
                } else {
                    this.drawCards(this.getNextPlayerIndex(), 4);
                }
            }
        } else {
            this.currentColor = card.color;
            this.currentValue = card.value;
        }

        // Handle special cards
        this.handleCardEffect(card, playerIndex);

        return { success: true, winner: player.hand.length === 0 ? playerIndex : null };
    }

    handleCardEffect(card, playerIndex) {
        switch(card.value) {
            case 'Skip':
                this.skipNextPlayer();
                break;
                
            case 'Reverse':
                this.direction *= -1;
                if (this.players.length === 2) {
                    // In 2-player, Reverse acts like Skip
                    this.skipNextPlayer();
                } else {
                    this.advanceTurn();
                }
                break;
                
            case '+2':
                if (this.settings.allowStacking) {
                    this.stackedDrawCount += 2;
                    this.advanceTurn();
                } else {
                    this.drawCards(this.getNextPlayerIndex(), 2);
                    this.skipNextPlayer();
                }
                break;
                
            case 'Wild+4':
                if (this.settings.allowStacking) {
                    this.advanceTurn();
                } else {
                    this.skipNextPlayer();
                }
                break;
                
            case '0':
            case '7':
                if (this.settings.allowSpecial07 && this.players.length === 2) {
                    this.swapHands(playerIndex);
                }
                this.advanceTurn();
                break;
                
            default:
                // Regular card or wild
                this.advanceTurn();
        }
    }

    skipNextPlayer() {
        // Advance turn twice to skip the next player
        this.advanceTurn();
        this.advanceTurn();
    }

    swapHands(playerIndex) {
        // Swap hands with next player (respecting direction)
        const nextPlayerIndex = this.getNextPlayerIndex(playerIndex);
        const temp = this.players[playerIndex].hand;
        this.players[playerIndex].hand = this.players[nextPlayerIndex].hand;
        this.players[nextPlayerIndex].hand = temp;
    }

    getNextPlayerIndex(fromIndex = null) {
        const index = fromIndex !== null ? fromIndex : this.currentPlayer;
        return (index + this.direction + this.players.length) % this.players.length;
    }

    advanceTurn() {
        this.currentPlayer = this.getNextPlayerIndex();
        
        // Handle stacked draws
        if (this.stackedDrawCount > 0) {
            const stackableCard = this.players[this.currentPlayer].hand.find(card => 
                (this.currentValue === '+2' && card.value === '+2') ||
                (this.currentValue === 'Wild+4' && card.value === 'Wild+4')
            );
            
            if (!stackableCard) {
                // Player can't stack, must draw
                this.drawCards(this.currentPlayer, this.stackedDrawCount);
                this.stackedDrawCount = 0;
                this.advanceTurn();
            }
        }
    }

    drawCards(playerIndex, count) {
        const player = this.players[playerIndex];
        for (let i = 0; i < count; i++) {
            if (this.deck.length === 0) {
                this.reshuffleDeck();
            }
            if (this.deck.length > 0) {
                player.hand.push(this.deck.pop());
            }
        }
    }

    drawCard(playerId) {
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1 || playerIndex !== this.currentPlayer) {
            return { success: false, error: 'Not your turn' };
        }

        if (this.stackedDrawCount > 0) {
            this.drawCards(playerIndex, this.stackedDrawCount);
            this.stackedDrawCount = 0;
            this.advanceTurn();
            return { success: true, drewStacked: true };
        }

        this.drawCards(playerIndex, 1);
        
        // Check if drawn card can be played immediately
        const playerHand = this.players[playerIndex].hand;
        const drawnCard = playerHand[playerHand.length - 1];
        const canPlay = this.canPlayCard(drawnCard);
        
        if (!canPlay) {
            this.advanceTurn();
        }
        
        return { success: true, canPlayDrawn: canPlay };
    }

    reshuffleDeck() {
        if (this.discardPile.length <= 1) return;
        
        const topCard = this.discardPile.pop();
        this.deck = [...this.discardPile];
        this.discardPile = [topCard];
        this.shuffleDeck();
    }
}

/* =======================
   SOCKET.IO
======================= */

io.on('connection', socket => {
    console.log('Connected:', socket.id);

    socket.on('requestLobbies', () => {
        socket.emit('lobbyList', Object.values(lobbies));
    });

    socket.on('createLobby', ({ lobbyName, playerName, settings }) => {
        const id = `lobby_${Date.now()}`;
        lobbies[id] = {
            id,
            name: lobbyName,
            settings,
            players: [{ id: socket.id, name: playerName, ready: false }]
        };
        socket.join(id);
        socket.emit('lobbyCreated', {
            roomId: id,
            lobbyName: lobbyName,
            settings: settings,
            players: lobbies[id].players
        });
        broadcastLobbyList();
    });

    socket.on('joinLobby', ({ lobbyId, playerName }) => {
        const lobby = lobbies[lobbyId];
        if (!lobby) return;

        lobby.players.push({ id: socket.id, name: playerName, ready: false });
        socket.join(lobbyId);
        socket.emit('lobbyJoined', {
            roomId: lobbyId,
            lobbyName: lobby.name,
            settings: lobby.settings,
            players: lobby.players
        });
        io.to(lobbyId).emit('lobbyUpdate', { roomId: lobbyId, players: lobby.players });
        broadcastLobbyList();
    });

    socket.on('playerReady', ({ roomId, ready }) => {
        const lobby = lobbies[roomId];
        if (!lobby) return;

        const player = lobby.players.find(p => p.id === socket.id);
        if (player) player.ready = ready;

        // Send lobby update to all players in the lobby
        io.to(roomId).emit('lobbyUpdate', { roomId: roomId, players: lobby.players });

        if (lobby.players.length >= 2 && lobby.players.every(p => p.ready)) {
            const room = new GameRoom(roomId, lobby.players, lobby.settings);
            rooms.set(roomId, room);
            room.createDeck();
            room.dealCards();
            room.gameStarted = true;

            room.players.forEach(p => {
                io.to(p.id).emit('gameStarted', room.getGameState(p.id));
            });

            delete lobbies[roomId];
            broadcastLobbyList();
        }
    });

    socket.on('playCard', ({ roomId, cardIndex, chosenColor }) => {
        const room = rooms.get(roomId);
        if (!room || !room.gameStarted) return;

        const result = room.playCard(socket.id, cardIndex, chosenColor);
        
        if (!result.success) {
            socket.emit('error', result.error);
            return;
        }

        // Broadcast updated game state to all players
        room.players.forEach(p => {
            io.to(p.id).emit('gameState', room.getGameState(p.id));
        });

        // Check for winner
        if (result.winner !== null) {
            const winnerName = room.players[result.winner].name;
            io.to(roomId).emit('gameOver', { winner: winnerName });
            rooms.delete(roomId);
        }
    });

    socket.on('drawCard', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (!room || !room.gameStarted) return;

        const result = room.drawCard(socket.id);
        
        if (!result.success) {
            socket.emit('error', result.error);
            return;
        }

        // Broadcast updated game state to all players
        room.players.forEach(p => {
            io.to(p.id).emit('gameState', room.getGameState(p.id));
        });
    });

    socket.on('disconnect', () => {
        Object.keys(lobbies).forEach(id => {
            lobbies[id].players = lobbies[id].players.filter(p => p.id !== socket.id);
            if (lobbies[id].players.length === 0) delete lobbies[id];
        });
        broadcastLobbyList();
    });
});

/* =======================
   HELPERS
======================= */

function broadcastLobbyList() {
    io.emit('lobbyList', Object.values(lobbies));
}

/* =======================
   START SERVER
======================= */

server.listen(PORT, () => {
    console.log(`O,No server running on port ${PORT}`);
});
