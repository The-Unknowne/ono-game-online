const express = require(‘express’);
const http = require(‘http’);
const socketIO = require(‘socket.io’);
const path = require(‘path’);

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
cors: {
origin: “*”,
methods: [“GET”, “POST”]
}
});

const PORT = process.env.PORT || 3000;

// Serve static files from public directory
app.use(express.static(path.join(__dirname, ‘public’)));

// Serve index.html for root route
app.get(’/’, (req, res) => {
res.sendFile(path.join(__dirname, ‘public’, ‘index.html’));
});

// Health check endpoint
app.get(’/health’, (req, res) => {
res.json({
status: ‘ok’,
rooms: rooms.size,
waiting: waitingPlayers.length
});
});

// Fallback for any other routes
app.get(’*’, (req, res) => {
// If requesting a file that doesn’t exist, send index
if (!req.url.includes(’.’)) {
res.sendFile(path.join(__dirname, ‘public’, ‘index.html’));
} else {
res.status(404).send(‘File not found’);
}
});

// Game rooms storage
const rooms = new Map();
const waitingPlayers = [];

// Game state management
class GameRoom {
constructor(roomId, player1, player2) {
this.roomId = roomId;
this.players = [
{ id: player1.id, name: player1.name, hand: [], calledUno: false },
{ id: player2.id, name: player2.name, hand: [], calledUno: false }
];
this.deck = [];
this.discardPile = [];
this.currentPlayer = 0;
this.currentColor = null;
this.currentValue = null;
this.direction = 1;
this.stackedDrawCount = 0;
this.settings = {
allowStacking: false,
allowSpecial07: false,
allowJumpIn: false
};
this.gameStarted = false;
}

```
createDeck() {
    const COLORS = ['red', 'blue', 'green', 'yellow'];
    const NUMBERS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    const ACTIONS = ['Skip', 'Reverse', '+2'];
    
    this.deck = [];
    
    COLORS.forEach(color => {
        this.deck.push({ color, value: '0', type: 'number' });
        
        for (let i = 0; i < 2; i++) {
            NUMBERS.slice(1).forEach(num => {
                this.deck.push({ color, value: num, type: 'number' });
            });
            
            ACTIONS.forEach(action => {
                this.deck.push({ color, value: action, type: 'action' });
            });
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

dealCards(cardsPerPlayer = 7) {
    this.players.forEach(player => {
        player.hand = [];
        for (let i = 0; i < cardsPerPlayer; i++) {
            if (this.deck.length > 0) {
                player.hand.push(this.deck.pop());
            }
        }
    });

    let startCard;
    do {
        if (this.deck.length === 0) {
            this.createDeck();
        }
        startCard = this.deck.pop();
    } while (startCard.type !== 'number');

    this.discardPile = [startCard];
    this.currentColor = startCard.color;
    this.currentValue = startCard.value;
}

getGameState(playerId) {
    const playerIndex = this.players.findIndex(p => p.id === playerId);
    const opponentIndex = playerIndex === 0 ? 1 : 0;
    
    return {
        roomId: this.roomId,
        yourHand: this.players[playerIndex].hand,
        yourName: this.players[playerIndex].name,
        opponentName: this.players[opponentIndex].name,
        opponentCardCount: this.players[opponentIndex].hand.length,
        discardPile: this.discardPile[this.discardPile.length - 1],
        currentColor: this.currentColor,
        currentValue: this.currentValue,
        currentPlayer: this.currentPlayer,
        isYourTurn: this.currentPlayer === playerIndex,
        deckCount: this.deck.length,
        stackedDrawCount: this.stackedDrawCount,
        settings: this.settings
    };
}
```

}

io.on(‘connection’, (socket) => {
console.log(‘New player connected:’, socket.id);

```
socket.on('findGame', (playerName) => {
    console.log(`${playerName} (${socket.id}) looking for game...`);
    
    if (waitingPlayers.length > 0) {
        // Match with waiting player
        const opponent = waitingPlayers.shift();
        const roomId = `room_${Date.now()}`;
        
        const room = new GameRoom(
            roomId,
            { id: opponent.id, name: opponent.name },
            { id: socket.id, name: playerName }
        );
        
        rooms.set(roomId, room);
        
        socket.join(roomId);
        opponent.socket.join(roomId);
        
        socket.emit('gameFound', { roomId, opponentName: opponent.name });
        opponent.socket.emit('gameFound', { roomId, opponentName: playerName });
        
        console.log(`Game created: ${roomId}`);
    } else {
        // Add to waiting list
        waitingPlayers.push({ id: socket.id, name: playerName, socket });
        socket.emit('waiting');
        console.log(`${playerName} added to waiting list`);
    }
});

socket.on('startGame', ({ roomId, settings }) => {
    const room = rooms.get(roomId);
    if (room && !room.gameStarted) {
        room.settings = settings;
        room.createDeck();
        room.dealCards(settings.startingCards || 7);
        room.gameStarted = true;
        
        // Send game state to both players
        room.players.forEach((player, index) => {
            const playerSocket = io.sockets.sockets.get(player.id);
            if (playerSocket) {
                playerSocket.emit('gameStarted', room.getGameState(player.id));
            }
        });
        
        console.log(`Game started in room ${roomId}`);
    }
});

socket.on('playCard', ({ roomId, cardIndex, chosenColor }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex === -1) return;

    const player = room.players[playerIndex];
    const card = player.hand[cardIndex];
    
    if (!card) return;

    // Remove card from hand and add to discard pile
    player.hand.splice(cardIndex, 1);
    room.discardPile.push(card);

    // Update current color and value
    if (card.type === 'wild') {
        room.currentColor = chosenColor;
        room.currentValue = card.value;
    } else {
        room.currentColor = card.color;
        room.currentValue = card.value;
    }

    // Handle card effects
    handleCardEffect(room, card, playerIndex);

    // Check win condition
    if (player.hand.length === 0) {
        io.to(roomId).emit('gameOver', { 
            winner: player.name,
            winnerId: player.id
        });
        rooms.delete(roomId);
        return;
    }

    // Send updated game state
    broadcastGameState(room);
});

socket.on('drawCard', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex === -1 || room.currentPlayer !== playerIndex) return;

    const player = room.players[playerIndex];

    // Handle stacked draws
    if (room.settings.allowStacking && room.stackedDrawCount > 0) {
        for (let i = 0; i < room.stackedDrawCount; i++) {
            if (room.deck.length === 0) reshuffleDeck(room);
            if (room.deck.length > 0) {
                player.hand.push(room.deck.pop());
            }
        }
        room.stackedDrawCount = 0;
        room.currentPlayer = room.currentPlayer === 0 ? 1 : 0;
    } else {
        // Regular draw
        if (room.deck.length === 0) reshuffleDeck(room);
        if (room.deck.length > 0) {
            player.hand.push(room.deck.pop());
        }
        room.currentPlayer = room.currentPlayer === 0 ? 1 : 0;
    }

    broadcastGameState(room);
});

socket.on('callUno', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== -1) {
        room.players[playerIndex].calledUno = true;
        io.to(roomId).emit('unoCalled', { 
            playerName: room.players[playerIndex].name 
        });
    }
});

socket.on('cancelSearch', () => {
    const index = waitingPlayers.findIndex(p => p.id === socket.id);
    if (index !== -1) {
        waitingPlayers.splice(index, 1);
        console.log(`Player ${socket.id} cancelled search`);
    }
});

socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    
    // Remove from waiting list
    const waitingIndex = waitingPlayers.findIndex(p => p.id === socket.id);
    if (waitingIndex !== -1) {
        waitingPlayers.splice(waitingIndex, 1);
    }

    // Handle disconnection in active games
    rooms.forEach((room, roomId) => {
        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
            const opponentIndex = playerIndex === 0 ? 1 : 0;
            const opponentSocket = io.sockets.sockets.get(room.players[opponentIndex].id);
            if (opponentSocket) {
                opponentSocket.emit('opponentDisconnected');
            }
            rooms.delete(roomId);
            console.log(`Room ${roomId} deleted due to disconnect`);
        }
    });
});
```

});

function handleCardEffect(room, card, playerIndex) {
const opponentIndex = playerIndex === 0 ? 1 : 0;

```
switch(card.value) {
    case '0':
        if (room.settings.allowSpecial07) {
            const temp = room.players[playerIndex].hand;
            room.players[playerIndex].hand = room.players[opponentIndex].hand;
            room.players[opponentIndex].hand = temp;
        } else {
            room.currentPlayer = opponentIndex;
        }
        break;

    case '7':
        if (room.settings.allowSpecial07) {
            const temp = room.players[playerIndex].hand;
            room.players[playerIndex].hand = room.players[opponentIndex].hand;
            room.players[opponentIndex].hand = temp;
        } else {
            room.currentPlayer = opponentIndex;
        }
        break;

    case 'Skip':
        // Current player goes again
        break;

    case 'Reverse':
        room.direction *= -1;
        // In 2-player, acts like skip
        break;

    case '+2':
        if (room.settings.allowStacking) {
            room.stackedDrawCount += 2;
            room.currentPlayer = opponentIndex;
        } else {
            for (let i = 0; i < 2; i++) {
                if (room.deck.length === 0) reshuffleDeck(room);
                if (room.deck.length > 0) {
                    room.players[opponentIndex].hand.push(room.deck.pop());
                }
            }
        }
        break;

    case 'Wild+4':
        if (room.settings.allowStacking) {
            room.stackedDrawCount += 4;
            room.currentPlayer = opponentIndex;
        } else {
            for (let i = 0; i < 4; i++) {
                if (room.deck.length === 0) reshuffleDeck(room);
                if (room.deck.length > 0) {
                    room.players[opponentIndex].hand.push(room.deck.pop());
                }
            }
        }
        break;

    default:
        room.currentPlayer = opponentIndex;
}
```

}

function reshuffleDeck(room) {
if (room.discardPile.length <= 1) return;

```
const topCard = room.discardPile.pop();
room.deck = [...room.discardPile];
room.discardPile = [topCard];

for (let i = room.deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]];
}
```

}

function broadcastGameState(room) {
room.players.forEach(player => {
const playerSocket = io.sockets.sockets.get(player.id);
if (playerSocket) {
playerSocket.emit(‘gameState’, room.getGameState(player.id));
}
});
}

server.listen(PORT, () => {
console.log(`O,No server running on port ${PORT}`);
});
