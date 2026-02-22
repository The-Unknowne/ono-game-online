const express  = require('express');
const http     = require('http');
const socketIO = require('socket.io');
const path     = require('path');
const { PlayerPresenceManager, PlayerState } = require('./public/js/playerPresence.js');

const app    = express();
const server = http.createServer(app);
const io     = socketIO(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
const PORT   = process.env.PORT || 3000;

/* ── STATIC FILES ─────────────────────────────────────────── */
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (_, res) => res.json({ status: 'ok', rooms: rooms.size, lobbies: Object.keys(lobbies).length }));
app.get('*', (req, res) => req.url.includes('.')
    ? res.status(404).send('File not found')
    : res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ── STORAGE ──────────────────────────────────────────────── */
const rooms   = new Map();
const lobbies = {};
const lobbyPresenceManagers = new Map();
const rematchQueues = new Map(); // roomId -> { players, settings, votes: Set, total }

/* ── GAME ROOM ────────────────────────────────────────────── */
class GameRoom {
    constructor(roomId, players, settings) {
        this.roomId           = roomId;
        this.players          = players.map(p => ({ id: p.id, name: p.name, hand: [], calledUno: false }));
        this.deck             = [];
        this.discardPile      = [];
        this.currentPlayer    = 0;
        this.currentColor     = null;
        this.currentValue     = null;
        this.direction        = 1;
        this.stackedDrawCount = 0;
        this.hasDrawnThisTurn = false;
        this.settings         = settings || {};
        this.gameStarted      = false;
        this.pendingSwap7     = null;
        this._lastSwapEvent   = null;
    }

    createDeck() {
        const COLORS  = ['red', 'blue', 'green', 'yellow'];
        const NUMBERS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
        const ACTIONS = ['Skip', 'Reverse', '+2'];
        this.deck = [];
        for (const color of COLORS) {
            this.deck.push({ color, value: '0', type: 'number' });
            for (let i = 0; i < 2; i++) {
                for (const n of NUMBERS.slice(1)) this.deck.push({ color, value: n, type: 'number' });
                for (const a of ACTIONS)           this.deck.push({ color, value: a, type: 'action' });
            }
        }
        for (let i = 0; i < 4; i++) {
            this.deck.push({ color: 'wild', value: 'Wild',   type: 'wild' });
            this.deck.push({ color: 'wild', value: 'Wild+4', type: 'wild' });
        }
        if (this.settings.allowPlus12) {
            this.deck.push({ color: 'wild', value: '+12', type: 'wild' });
            this.deck.push({ color: 'wild', value: '+12', type: 'wild' });
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
        for (const p of this.players) {
            p.hand = [];
            for (let i = 0; i < count; i++) p.hand.push(this.deck.pop());
        }
        let start;
        do { start = this.deck.pop(); } while (start.type !== 'number');
        this.discardPile  = [start];
        this.currentColor = start.color;
        this.currentValue = start.value;
    }

    getGameState(playerId) {
        const index = this.players.findIndex(p => p.id === playerId);
        const cur   = this.currentPlayer;
        return {
            roomId:            this.roomId,
            yourHand:          this.players[index].hand,
            yourName:          this.players[index].name,
            yourIndex:         index,
            allPlayers:        this.players.map((p, i) => ({
                id: p.id, name: p.name, cardCount: p.hand.length,
                isYou: i === index, isCurrent: i === cur, calledUno: p.calledUno
            })),
            currentPlayer:     cur,
            currentPlayerName: this.players[cur]?.name || 'Unknown',
            isYourTurn:        index === cur,
            discardPile:       this.discardPile.at(-1),
            currentColor:      this.currentColor,
            currentValue:      this.currentValue,
            deckCount:         this.deck.length,
            direction:         this.direction,
            settings:          this.settings,
            stackedDrawCount:  this.stackedDrawCount,
            hasDrawnThisTurn:  this.hasDrawnThisTurn
        };
    }

    canPlayCard(card) {
        if (!card) return false;
        if (this.settings.allowStacking && this.stackedDrawCount > 0) {
            return (this.currentValue === '+2'     && card.value === '+2') ||
                   (this.currentValue === 'Wild+4' && card.value === 'Wild+4');
        }
        return card.type === 'wild' || card.color === this.currentColor || card.value === this.currentValue;
    }

    playCard(playerId, cardIndex, chosenColor) {
        this._lastSwapEvent = null;
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1) return { success: false, error: 'Player not found' };

        const player = this.players[playerIndex];
        const card   = player.hand[cardIndex];
        if (!card) return { success: false, error: 'Invalid card' };

        if (playerIndex !== this.currentPlayer) {
            const { allowJumpIn } = this.settings;
            const isJumpIn = allowJumpIn && (
                card.value === 'Wild+4' ||
                (card.value === '+2' && card.color === this.currentColor) ||
                (card.type === 'number' && card.color === this.currentColor && card.value === this.currentValue)
            );
            if (!isJumpIn) return { success: false, error: 'Not your turn' };
            this.currentPlayer = playerIndex;
        }

        if (!this.canPlayCard(card)) return { success: false, error: "Can't play that card" };

        player.hand.splice(cardIndex, 1);
        this.discardPile.push(card);
        if (card.type === 'wild') {
            this.currentColor = chosenColor || 'red';
            this.currentValue = card.value;
        } else {
            this.currentColor = card.color;
            this.currentValue = card.value;
        }

        const effectResult = this.handleCardEffect(card, playerIndex);
        if (effectResult === 'needSwapTarget') {
            return { success: true, needSwapTarget: true, winner: null, drawAnimation: null };
        }

        this.checkUnoAfterPlay(playerIndex);

        const PENALTY = { '+2': 2, 'Wild+4': 4, '+12': 12 };
        let drawAnimation = null;
        if (PENALTY[card.value]) {
            const nextIdx = this.getNextPlayerIndex(playerIndex);
            drawAnimation = {
                victimId:   this.players[nextIdx]?.id,
                victimName: this.players[nextIdx]?.name,
                playerId:   player.id,
                playerName: player.name,
                count:      PENALTY[card.value],
                cardValue:  card.value,
                stacking:   card.value !== '+12' && !!this.settings.allowStacking
            };
        }

        return {
            success:      true,
            winner:       player.hand.length === 0 ? playerIndex : null,
            swapHappened: this._lastSwapEvent || null,
            drawAnimation
        };
    }

    handleCardEffect(card, playerIndex) {
        switch (card.value) {
            case 'Skip':
                this.skipNextPlayer();
                break;

            case 'Reverse':
                this.direction *= -1;
                if (this.players.length === 2) {
                    // In 2-player, Reverse acts like Skip: current player plays again.
                    // Just reset hasDrawnThisTurn without advancing.
                    this.hasDrawnThisTurn = false;
                } else {
                    this.advanceTurn();
                }
                break;

            case '+2':
                if (this.settings.allowStacking) { this.stackedDrawCount += 2; this.advanceTurn(); }
                else { this.drawCards(this.getNextPlayerIndex(), 2); this.skipNextPlayer(); }
                break;

            case 'Wild+4':
                if (this.settings.allowStacking) { this.stackedDrawCount += 4; this.advanceTurn(); }
                else { this.drawCards(this.getNextPlayerIndex(), 4); this.skipNextPlayer(); }
                break;

            case '0':
                if (this.settings.allowSpecial07) {
                    const nextIdx = this.getNextPlayerIndex(playerIndex);
                    this.swapHands(playerIndex, nextIdx);
                    this.players[playerIndex].calledUno = false;
                    this.players[nextIdx].calledUno     = false;
                    this._lastSwapEvent = {
                        swapperName: this.players[playerIndex].name,
                        targetName:  this.players[nextIdx].name,
                        type: '0',
                        unoTransfer: this.players[nextIdx].hand.length     === 1 ? this.players[nextIdx].name
                                   : this.players[playerIndex].hand.length === 1 ? this.players[playerIndex].name
                                   : undefined
                    };
                }
                this.advanceTurn();
                break;

            case '7':
                if (this.settings.allowSpecial07) {
                    this.pendingSwap7 = { playerId: this.players[playerIndex].id };
                    return 'needSwapTarget';
                }
                this.advanceTurn();
                break;

            case '+12':
                this.drawCards(this.getNextPlayerIndex(playerIndex), 12);
                this.skipNextPlayer();
                break;

            default:
                this.advanceTurn();
        }
    }

    skipNextPlayer()  { this.advanceTurn(); this.advanceTurn(); }

    advanceTurn() {
        this.currentPlayer    = this.getNextPlayerIndex();
        this.hasDrawnThisTurn = false;
    }

    getNextPlayerIndex(fromIndex = null) {
        const index = fromIndex !== null ? fromIndex : this.currentPlayer;
        return (index + this.direction + this.players.length) % this.players.length;
    }

    swapHands(a, b) {
        [this.players[a].hand, this.players[b].hand] = [this.players[b].hand, this.players[a].hand];
    }

    chooseSwapTarget(playerId, targetId) {
        if (!this.pendingSwap7)                      return { success: false, error: 'No swap pending' };
        if (this.pendingSwap7.playerId !== playerId)  return { success: false, error: 'Not your swap' };
        const pi = this.players.findIndex(p => p.id === playerId);
        const ti = this.players.findIndex(p => p.id === targetId);
        if (pi === -1 || ti === -1) return { success: false, error: 'Player not found' };
        if (pi === ti)              return { success: false, error: 'Cannot swap with yourself' };
        this.swapHands(pi, ti);
        this.pendingSwap7 = null;
        this.advanceTurn();
        return { success: true, swapperName: this.players[pi].name, targetName: this.players[ti].name };
    }

    drawCards(playerIndex, count) {
        const hand = this.players[playerIndex].hand;
        for (let i = 0; i < count; i++) {
            if (this.deck.length === 0) this.reshuffleDeck();
            if (this.deck.length > 0)   hand.push(this.deck.pop());
        }
    }

    drawCard(playerId) {
        const pi = this.players.findIndex(p => p.id === playerId);
        if (pi === -1 || pi !== this.currentPlayer) return { success: false, error: 'Not your turn' };
        if (this.hasDrawnThisTurn)                  return { success: false, error: 'You can only draw once per turn' };

        if (this.stackedDrawCount > 0) {
            const count = this.stackedDrawCount;
            this.drawCards(pi, count);
            this.stackedDrawCount = 0;
            this.players[pi].calledUno = false;
            this.advanceTurn();
            return { success: true, drewStacked: true, stackCount: count };
        }

        this.hasDrawnThisTurn = true;
        this.drawCards(pi, 1);
        const drawnCard = this.players[pi].hand.at(-1);
        const canPlay   = drawnCard ? this.canPlayCard(drawnCard) : false;
        if (!canPlay) this.advanceTurn();
        if (this.players[pi].hand.length > 1) this.players[pi].calledUno = false;
        return { success: true, canPlayDrawn: canPlay, cardsDrawn: 1 };
    }

    callUno(playerId) {
        const player = this.players.find(p => p.id === playerId);
        if (!player)                  return { success: false, error: 'Player not found' };
        if (player.hand.length !== 1) return { success: false, error: 'Can only call O,No when you have 1 card' };
        player.calledUno = true;
        return { success: true, playerName: player.name };
    }

    catchUnoViolation(catcherId, caughtId) {
        const ci  = this.players.findIndex(p => p.id === catcherId);
        const cui = this.players.findIndex(p => p.id === caughtId);
        if (ci === -1 || cui === -1) return { success: false, error: 'Player not found' };
        const caught = this.players[cui];
        if (caught.hand.length !== 1 || caught.calledUno) return { success: false, error: 'No O,no violation detected' };
        this.drawCards(cui, 2);
        caught.calledUno = false;
        return { success: true, catcherName: this.players[ci].name, caughtName: caught.name, penaltyApplied: true };
    }

    checkUnoAfterPlay(playerIndex) {
        if (this.players[playerIndex].hand.length !== 1) this.players[playerIndex].calledUno = false;
    }

    reshuffleDeck() {
        if (this.discardPile.length <= 1) return;
        const top = this.discardPile.pop();
        this.deck = [...this.discardPile];
        this.discardPile = [top];
        this.shuffleDeck();
    }
}

/* ── HELPERS ──────────────────────────────────────────────── */
function broadcastGameState(room) {
    room.players.forEach(p => io.to(p.id).emit('gameState', room.getGameState(p.id)));
}

function cleanupPlayerFromLobby(socketId, roomId) {
    const lobby = lobbies[roomId];
    if (!lobby || !lobby.players.some(p => p.id === socketId)) return;
    lobby.players = lobby.players.filter(p => p.id !== socketId);
    if (lobby.players.length === 0) {
        delete lobbies[roomId];
        const pm = lobbyPresenceManagers.get(roomId);
        if (pm) { pm.destroy(); lobbyPresenceManagers.delete(roomId); }
        console.log(`Lobby ${roomId} deleted (all players left)`);
    } else {
        io.to(roomId).emit('lobbyUpdate', { roomId, players: lobby.players });
    }
    broadcastLobbyList();
}

function broadcastLobbyList() {
    io.emit('lobbyList', Object.values(lobbies).map(l => ({
        id: l.id, name: l.name, settings: l.settings,
        players: l.players.length, minPlayers: l.minPlayers, isPrivate: l.isPrivate
    })));
}

/* ── SOCKET.IO ────────────────────────────────────────────── */
io.on('connection', socket => {
    console.log('Connected:', socket.id);

    socket.on('requestLobbies', () => broadcastLobbyList());

    socket.on('createLobby', ({ lobbyName, playerName, settings, isPrivate, passcode }) => {
        const id = `lobby_${Date.now()}`;
        const pm = new PlayerPresenceManager(2, { heartbeatInterval: 5000, reconnectTimeout: 60000 });
        lobbyPresenceManagers.set(id, pm);
        pm.addPlayer(socket.id, playerName, PlayerState.LOBBY);
        lobbies[id] = {
            id, name: lobbyName, settings, minPlayers: 2,
            players:   [{ id: socket.id, name: playerName, ready: false }],
            isPrivate: !!isPrivate,
            passcode:  isPrivate ? (passcode || '') : null
        };
        socket.join(id);
        socket.emit('lobbyCreated', { roomId: id, lobbyName, settings, players: lobbies[id].players, minPlayers: 2, isPrivate: lobbies[id].isPrivate });
        broadcastLobbyList();
    });

    socket.on('joinLobby', ({ lobbyId, playerName, passcode }) => {
        const lobby = lobbies[lobbyId];
        if (!lobby) return;
        if (lobby.players.some(p => p.id === socket.id))       { socket.emit('error', 'You are already in this lobby'); return; }
        if (lobby.players.length >= lobby.settings.maxPlayers) { socket.emit('error', 'Lobby is full'); return; }
        if (lobby.isPrivate && passcode !== lobby.passcode)     { socket.emit('error', '🔒 Wrong passcode. Try again.'); return; }
        const pm = lobbyPresenceManagers.get(lobbyId);
        if (pm) pm.addPlayer(socket.id, playerName, PlayerState.LOBBY);
        lobby.players.push({ id: socket.id, name: playerName, ready: false });
        socket.join(lobbyId);
        socket.emit('lobbyJoined', { roomId: lobbyId, lobbyName: lobby.name, settings: lobby.settings, players: lobby.players, minPlayers: lobby.minPlayers || 2, isPrivate: lobby.isPrivate });
        io.to(lobbyId).emit('lobbyUpdate', { roomId: lobbyId, players: lobby.players });
        broadcastLobbyList();
    });

    socket.on('playerReady', ({ roomId, ready }) => {
        const lobby = lobbies[roomId];
        if (!lobby) return;
        const player = lobby.players.find(p => p.id === socket.id);
        if (player) player.ready = ready;
        const pm         = lobbyPresenceManagers.get(roomId);
        if (pm) pm.setPlayerReady(socket.id, ready);
        io.to(roomId).emit('lobbyUpdate', { roomId, players: lobby.players });

        const minPlayers = lobby.minPlayers || 2;
        if (lobby.players.length < minPlayers) {
            if (lobby.players.every(p => p.ready))
                io.to(roomId).emit('error', `Need at least ${minPlayers} players to start (currently ${lobby.players.length})`);
            return;
        }
        if (!lobby.players.every(p => p.ready)) return;

        // All ready — verify connections
        const connected = lobby.players.filter(p => !!io.sockets.sockets.get(p.id));
        if (connected.length !== lobby.players.length) {
            lobby.players = connected;
            io.to(roomId).emit('lobbyUpdate', { roomId, players: lobby.players });
            io.to(roomId).emit('error', 'Some players disconnected before game start. Please ready up again.');
            return;
        }
        if (pm) {
            const check = pm.finalPresenceCheck();
            if (!check.success) {
                const names = check.missingPlayers.map(p => p.name).join(', ');
                io.to(roomId).emit('error', `Cannot start: Players not responding: ${names}`);
                console.log(`[Server] Game start prevented - missing players: ${names}`);
                return;
            }
        }

        console.log(`[Server] Starting game in lobby ${roomId} with ${lobby.players.length} players`);
        const room = new GameRoom(roomId, lobby.players, lobby.settings);
        rooms.set(roomId, room);
        room.createDeck();
        room.dealCards(room.settings.startingCards || 7);
        room.gameStarted = true;

        if (pm) {
            lobby.players.forEach(p => pm.updatePlayerState(p.id, PlayerState.IN_GAME));
            pm.startHeartbeat();
            pm.on('player-timeout', timedOutPlayer => {
                const r = rooms.get(roomId);
                if (!r) return;
                const active = r.players.filter(p => {
                    const ps = pm.getPlayer(p.id);
                    return ps && ps.state !== PlayerState.TIMEOUT && ps.state !== PlayerState.DISCONNECTED;
                });
                if (active.length < minPlayers) {
                    io.to(roomId).emit('gameEnded', { reason: 'Not enough players remaining', message: `${timedOutPlayer.name} disconnected and did not reconnect in time.` });
                    rooms.delete(roomId); pm.destroy(); lobbyPresenceManagers.delete(roomId);
                } else {
                    io.to(roomId).emit('playerTimeout', { playerId: timedOutPlayer.id, playerName: timedOutPlayer.name, message: `${timedOutPlayer.name} has been removed from the game due to disconnection.` });
                }
            });
        }

        room.players.forEach(p => io.to(p.id).emit('gameStarted', room.getGameState(p.id)));
        delete lobbies[roomId];
        broadcastLobbyList();
    });

    socket.on('playCard', ({ roomId, cardIndex, chosenColor }) => {
        const room = rooms.get(roomId);
        if (!room || !room.gameStarted) return;
        const result = room.playCard(socket.id, cardIndex, chosenColor);
        if (!result.success) { socket.emit('error', result.error); return; }

        if (result.needSwapTarget) {
            socket.emit('chooseSwapTarget', { opponents: room.players.filter(p => p.id !== socket.id).map(p => ({ id: p.id, name: p.name })) });
            broadcastGameState(room);
            return;
        }

        if (result.drawAnimation) io.to(roomId).emit('drawAnimation', result.drawAnimation);
        if (result.swapHappened) {
            io.to(roomId).emit('swapHappened', result.swapHappened);
            if (result.swapHappened.unoTransfer)
                io.to(roomId).emit('unoTransfer', { playerName: result.swapHappened.unoTransfer });
        }

        broadcastGameState(room);

        if (result.winner !== null) {
            // Calculate scores: winner gets 0, others scored by remaining hand
            // Normal card = -3, Action/Draw card = -2, Wild = -1
            const scores = room.players.map(p => {
                if (p.hand.length === 0) return { name: p.name, id: p.id, score: 0, hand: [] };
                const score = p.hand.reduce((sum, card) => {
                    if (card.type === 'wild')   return sum - 1;
                    if (card.type === 'action') return sum - 2;
                    return sum - 3;
                }, 0);
                return { name: p.name, id: p.id, score, hand: p.hand };
            });
            // Sort by score descending (least negative = best = winner first)
            const sorted = [...scores].sort((a, b) => b.score - a.score);
            io.to(roomId).emit('gameOver', {
                winner: room.players[result.winner].name,
                winnerId: room.players[result.winner].id,
                scores: sorted
            });

            // Store rematch queue so players can vote to play again
            rematchQueues.set(roomId, {
                players:  room.players.map(p => ({ id: p.id, name: p.name })),
                settings: room.settings,
                votes:    new Set(),
                total:    room.players.length
            });
            // Auto-expire rematch queue after 60s
            setTimeout(() => rematchQueues.delete(roomId), 60000);

            rooms.delete(roomId);
        }
    });

    socket.on('drawCard', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (!room || !room.gameStarted) return;
        const result = room.drawCard(socket.id);
        if (!result.success) { socket.emit('error', result.error); return; }

        if (result.drewStacked) {
            const p = room.players.find(p => p.id === socket.id);
            io.to(roomId).emit('drawAnimation', { victimId: socket.id, victimName: p?.name, playerId: null, count: result.stackCount, cardValue: 'stack' });
        }

        room.players.forEach(p => {
            const state = room.getGameState(p.id);
            if (result.cardsDrawn) state.lastDrawInfo = { cardsDrawn: result.cardsDrawn, playerId: socket.id };
            io.to(p.id).emit('gameState', state);
        });
    });

    socket.on('chooseSwapTarget', ({ roomId, targetId }) => {
        const room = rooms.get(roomId);
        if (!room || !room.gameStarted) return;
        const result = room.chooseSwapTarget(socket.id, targetId);
        if (!result.success) { socket.emit('error', result.error); return; }
        io.to(roomId).emit('swapHappened', { swapperName: result.swapperName, targetName: result.targetName, type: '7' });
        broadcastGameState(room);
    });

    socket.on('callUno', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (!room || !room.gameStarted) return;
        const result = room.callUno(socket.id);
        if (result.success) {
            io.to(roomId).emit('playerCalledUno', { playerName: result.playerName, message: `${result.playerName} called O,No!` });
            broadcastGameState(room);
        }
    });

    socket.on('catchUno', ({ roomId, caughtPlayerId }) => {
        const room = rooms.get(roomId);
        if (!room || !room.gameStarted) return;
        const result = room.catchUnoViolation(socket.id, caughtPlayerId);
        if (result.success && result.penaltyApplied) {
            io.to(roomId).emit('unoPenalty', { catcherName: result.catcherName, caughtName: result.caughtName, message: `${result.catcherName} caught ${result.caughtName}! ${result.caughtName} draws 2 penalty cards!` });
            broadcastGameState(room);
        } else if (!result.success) {
            socket.emit('error', result.error);
        }
    });

    socket.on('leaveLobby', ({ roomId }) => cleanupPlayerFromLobby(socket.id, roomId));

    socket.on('rematchVote', ({ roomId }) => {
        const q = rematchQueues.get(roomId);
        if (!q) { socket.emit('error', 'Rematch expired or not found'); return; }
        if (!q.players.some(p => p.id === socket.id)) return;

        q.votes.add(socket.id);

        // Broadcast updated vote count to all players in this rematch
        const voterName = q.players.find(p => p.id === socket.id)?.name;
        q.players.forEach(p => {
            io.to(p.id).emit('rematchVoteUpdate', {
                votes: q.votes.size,
                total: q.total,
                voterName
            });
        });

        // All voted — start rematch
        if (q.votes.size >= q.total) {
            rematchQueues.delete(roomId);

            // Verify all sockets still connected
            const connected = q.players.filter(p => !!io.sockets.sockets.get(p.id));
            if (connected.length < q.total) {
                const missing = q.players.filter(p => !io.sockets.sockets.get(p.id)).map(p => p.name).join(', ');
                q.players.filter(p => io.sockets.sockets.get(p.id))
                    .forEach(p => io.to(p.id).emit('rematchCancelled', { reason: `${missing} disconnected. Can't start rematch.` }));
                return;
            }

            console.log(`[Server] Starting rematch in room ${roomId}`);
            const room = new GameRoom(roomId, q.players, q.settings);
            rooms.set(roomId, room);
            room.createDeck();
            room.dealCards(room.settings.startingCards || 7);
            room.gameStarted = true;

            // Re-join all players to the socket room
            q.players.forEach(p => {
                const s = io.sockets.sockets.get(p.id);
                if (s) s.join(roomId);
                io.to(p.id).emit('gameStarted', room.getGameState(p.id));
            });
        }
    });

    socket.on('rematchDecline', ({ roomId }) => {
        const q = rematchQueues.get(roomId);
        if (!q) return;
        const decliner = q.players.find(p => p.id === socket.id);
        rematchQueues.delete(roomId);
        q.players.forEach(p => {
            io.to(p.id).emit('rematchCancelled', {
                reason: `${decliner?.name || 'A player'} declined the rematch.`
            });
        });
    });

    socket.on('heartbeat', ({ roomId }) => {
        const pm = lobbyPresenceManagers.get(roomId);
        if (pm) pm.receiveHeartbeat(socket.id);
    });

    socket.on('disconnect', () => {
        console.log('Disconnected:', socket.id);
        Object.keys(lobbies).forEach(id => cleanupPlayerFromLobby(socket.id, id));

        // Cancel any pending rematch this player was part of
        rematchQueues.forEach((q, rid) => {
            if (q.players.some(p => p.id === socket.id)) {
                const decliner = q.players.find(p => p.id === socket.id);
                rematchQueues.delete(rid);
                q.players.filter(p => p.id !== socket.id).forEach(p => {
                    io.to(p.id).emit('rematchCancelled', { reason: `${decliner?.name || 'A player'} disconnected. Rematch cancelled.` });
                });
            }
        });
        rooms.forEach((room, roomId) => {
            const player = room.players.find(p => p.id === socket.id);
            if (!player) return;
            const pm = lobbyPresenceManagers.get(roomId);
            if (pm) {
                pm.onPlayerDisconnect(socket.id);
                room.players
                    .filter(p => p.id !== socket.id)
                    .forEach(p => io.to(p.id).emit('playerDisconnected', { playerId: socket.id, playerName: player.name, reconnectTimeout: pm.reconnectTimeout }));
            }
        });
        broadcastLobbyList();
    });
});

/* ── START ────────────────────────────────────────────────── */
server.listen(PORT, () => console.log(`O,No server running on port ${PORT}`));
