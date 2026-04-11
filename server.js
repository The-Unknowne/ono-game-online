const express  = require('express');
const http     = require('http');
const socketIO = require('socket.io');
const path     = require('path');
const { PlayerPresenceManager, PlayerState } = require('./public/js/playerPresence.js');

const app    = express();
const server = http.createServer(app);
const io     = socketIO(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
const PORT   = process.env.PORT || 3000;

/* -- STATIC FILES ---------------------------------------- */
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (_, res) => res.json({ status: 'ok', rooms: rooms.size, lobbies: Object.keys(lobbies).length }));
app.get('*', (req, res) => req.url.includes('.')
    ? res.status(404).send('File not found')
    : res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* -- STORAGE ---------------------------------------- */
const rooms   = new Map();
const lobbies = {};
const lobbyPresenceManagers = new Map();
const rematchQueues = new Map(); // roomId -> { players, settings, votes: Set, total }

// Rejoin registry: persistentId -> { roomId, playerName, expiresAt, rejoinTimer }
// Persists for 5 minutes after disconnect so a page-refresh can reconnect
const rejoinRegistry = new Map();

const REJOIN_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function registerRejoin(persistentId, roomId, playerName) {
    // Clear any existing timer for this player
    const existing = rejoinRegistry.get(persistentId);
    if (existing && existing.rejoinTimer) clearTimeout(existing.rejoinTimer);

    const timer = setTimeout(() => {
        rejoinRegistry.delete(persistentId);
        console.log(`[Rejoin] Entry expired for ${playerName} (${persistentId})`);
    }, REJOIN_WINDOW_MS);

    rejoinRegistry.set(persistentId, { roomId, playerName, expiresAt: Date.now() + REJOIN_WINDOW_MS, rejoinTimer: timer });
    console.log(`[Rejoin] Registered ${playerName} (${persistentId}) for room ${roomId} — 5 min window`);
}

function clearRejoin(persistentId) {
    const entry = rejoinRegistry.get(persistentId);
    if (entry && entry.rejoinTimer) clearTimeout(entry.rejoinTimer);
    rejoinRegistry.delete(persistentId);
}

/* -- GAME ROOM ---------------------------------------- */
class GameRoom {
    constructor(roomId, players, settings) {
        this.roomId           = roomId;
        // players array now carries persistentId
        this.players          = players.map(p => ({
            id:           p.id,
            persistentId: p.persistentId || p.id,  // stable across reconnects
            name:         p.name,
            hand:         [],
            calledUno:    false
        }));
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
        this.pendingPeek      = null;
        this._lastSwapEvent   = null;
        this.knockedOut       = [];   // player ids eliminated in mercy mode
        this.pendingRoulette  = null;
        this.glitchSpectators  = [];
        this.glitchScrambled   = [];
        this.glitchTotalDraws  = 0;
    }

    isMercy() { return this.settings.gameMode === 'mercy'; }
    isGlitch() { return this.settings.gameMode === 'glitch'; }

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
        if (this.isGlitch()) {
            for (let i = 0; i < 2; i++) {
                this.deck.push({ color: 'wild', value: 'RandDraw',     type: 'wild', glitch: true });
                this.deck.push({ color: 'wild', value: 'PopupAd',      type: 'wild', glitch: true });
                this.deck.push({ color: 'wild', value: 'PeekHand',     type: 'wild', glitch: true });
                this.deck.push({ color: 'wild', value: 'ScrambleCard', type: 'wild', glitch: true });
            }
            this.deck.push({ color: 'wild', value: 'GlitchedOut', type: 'wild', glitch: true, rare: true });
            this.shuffleDeck();
            const goIdx = this.deck.findIndex(d => d.value === 'GlitchedOut');
            if (goIdx !== -1) {
                const [go] = this.deck.splice(goIdx, 1);
                const pos  = Math.floor(this.deck.length * 0.12);
                this.deck.splice(pos, 0, go);
            }
        }
        if (this.isMercy()) {
            for (let i = 0; i < 2; i++) {
                this.deck.push({ color: 'wild', value: 'Wild+6',        type: 'wild' });
                this.deck.push({ color: 'wild', value: 'Wild+10',       type: 'wild' });
                this.deck.push({ color: 'wild', value: 'DiscardAll',    type: 'wild' });
                this.deck.push({ color: 'wild', value: 'WildReverseD4', type: 'wild' });
                this.deck.push({ color: 'wild', value: 'SkipAll',       type: 'wild' });
                this.deck.push({ color: 'wild', value: 'Roulette',      type: 'wild' });
            }
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
                isYou: i === index, isCurrent: i === cur, calledUno: p.calledUno,
                knockedOut: this.knockedOut.includes(p.id)
            })),
            knockedOut:        this.knockedOut,
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
            hasDrawnThisTurn:  this.hasDrawnThisTurn,
            // Send back persistentId so client can confirm their stable ID
            persistentId:      this.players[index]?.persistentId || null,
            glitchSpectators:  this.glitchSpectators || [],
            isSpectator:       (this.glitchSpectators || []).includes(this.players[index]?.id),
            glitchScrambled:   this.isGlitchScrambledFor(this.players[index]?.id),
            isEliminated:      (this.glitchSpectators||[]).includes(this.players[index]?.id)
        };
    }

    canPlayCard(card, playerId = null) {
        if (!card) return false;
        const mercy = this.isMercy();
        const stacking = this.settings.allowStacking || mercy;

        if (stacking && this.stackedDrawCount > 0) {
            if (mercy) {
                const DRAW_VALUES = { '+2': 2, 'Wild+4': 4, 'WildReverseD4': 4, 'Wild+6': 6, 'Wild+10': 10 };
                const cardVal = DRAW_VALUES[card.value];
                if (!cardVal) return false;
                const topCard = this.discardPile.at(-1);
                const topVal  = topCard ? (DRAW_VALUES[topCard.value] || 0) : 0;
                return cardVal >= topVal;
            }
            return (this.currentValue === '+2'     && card.value === '+2') ||
                   (this.currentValue === 'Wild+4' && card.value === 'Wild+4');
        }

        if (card.type === 'wild') {
            if (card.value === 'Wild+4' && !mercy && playerId) {
                const player = this.players.find(p => p.id === playerId);
                if (player) {
                    const hasColor = player.hand.some(c => c !== card && c.color === this.currentColor);
                    if (hasColor) return false;
                }
            }
            return true;
        }
        return card.color === this.currentColor || card.value === this.currentValue;
    }

    playCard(playerId, cardIndex, chosenColor) {
        this._lastSwapEvent = null;
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1) return { success: false, error: 'Player not found' };

        const player = this.players[playerIndex];
        const card   = player.hand[cardIndex];
        if (!card) return { success: false, error: 'Invalid card' };
        if ((this.glitchSpectators||[]).includes(playerId)) return { success: false, error: 'You are a spectator' };

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

        if (!this.canPlayCard(card, playerId)) return { success: false, error: "Can't play that card" };

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
        if (effectResult === 'needPeekTarget') {
            return { success: true, needPeekTarget: true, winner: null, drawAnimation: null };
        }

        this.checkUnoAfterPlay(playerIndex);

        const PENALTY = { '+2': 2, 'Wild+4': 4, '+12': 12, 'WildReverseD4': 4, 'Wild+6': 6, 'Wild+10': 10 };
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

        let newlyKnocked = [];
        if (this.isMercy()) newlyKnocked = this.checkMercyKnockouts();

        let winner = null;
        if (player.hand.length === 0) {
            winner = playerIndex;
        } else {
            const active = this.activePlayers();
            if (active.length === 1) {
                winner = this.players.findIndex(p => p.id === active[0].id);
            } else if (active.length === 0) {
                winner = playerIndex;
            }
        }

        return {
            success:       true,
            winner,
            swapHappened:  this._lastSwapEvent || null,
            drawAnimation,
            newlyKnocked
        };
    }

    handleCardEffect(card, playerIndex) {
        const player  = this.players[playerIndex];
        const mercy   = this.isMercy();
        const stacking = this.settings.allowStacking || mercy;
        switch (card.value) {
            case 'Skip':
                this.skipNextPlayer();
                break;

            case 'Reverse':
                this.direction *= -1;
                if (this.players.length === 2) {
                    this.hasDrawnThisTurn = false;
                } else {
                    this.advanceTurn();
                }
                break;

            case '+2':
                if (stacking) { this.stackedDrawCount += 2; this.advanceTurn(); }
                else { this.drawCards(this.getNextPlayerIndex(), 2); this.skipNextPlayer(); }
                break;

            case 'Wild+4':
                if (stacking) { this.stackedDrawCount += 4; this.advanceTurn(); }
                else { this.drawCards(this.getNextPlayerIndex(), 4); this.skipNextPlayer(); }
                break;

            case 'Wild+6':
                if (stacking) { this.stackedDrawCount += 6; this.advanceTurn(); }
                else { this.drawCards(this.getNextPlayerIndex(), 6); this.skipNextPlayer(); }
                break;

            case 'Wild+10':
                if (stacking) { this.stackedDrawCount += 10; this.advanceTurn(); }
                else { this.drawCards(this.getNextPlayerIndex(), 10); this.skipNextPlayer(); }
                break;

            case 'DiscardAll': {
                const chosenCol = this.currentColor;
                const before = player.hand.length;
                player.hand = player.hand.filter(c => c.color !== chosenCol);
                const removed = before - player.hand.length;
                this._discardAllRemoved = removed;
                this.advanceTurn();
                break;
            }

            case 'WildReverseD4':
                this.direction *= -1;
                if (stacking) { this.stackedDrawCount += 4; this.advanceTurn(); }
                else { this.drawCards(this.getNextPlayerIndex(), 4); this.skipNextPlayer(); }
                break;

            case 'SkipAll':
                this.hasDrawnThisTurn = false;
                break;

            case 'Roulette': {
                const targetColor = this.currentColor;
                const nextIdx = this.getNextPlayerIndex(playerIndex);
                let drawn = 0;
                let found = false;
                while (drawn < 50 && !found) {
                    this.drawCards(nextIdx, 1);
                    drawn++;
                    const lastCard = this.players[nextIdx].hand.at(-1);
                    if (lastCard && (lastCard.color === targetColor || lastCard.type === 'wild')) found = true;
                }
                if (mercy) this.checkMercyKnockouts();
                this.skipNextPlayer();
                break;
            }

            case '0':
                if (this.settings.allowSpecial07 || this.isMercy()) {
                    if (player.hand.length === 0) { this.advanceTurn(); break; }
                    const active0 = this.activePlayers();
                    if (active0.length > 1) {
                        const savedHands = active0.map(p => p.hand);
                        if (this.direction === 1) {
                            active0[0].hand = savedHands[savedHands.length - 1];
                            for (let i = 1; i < active0.length; i++) active0[i].hand = savedHands[i - 1];
                        } else {
                            active0[active0.length - 1].hand = savedHands[0];
                            for (let i = 0; i < active0.length - 1; i++) active0[i].hand = savedHands[i + 1];
                        }
                        active0.forEach(p => { p.calledUno = false; });
                        this._lastSwapEvent = { type: '0', rotateAll: true };
                    }
                }
                this.advanceTurn();
                break;

            case '7':
                if (this.settings.allowSpecial07 || this.isMercy()) {
                    if (player.hand.length === 0) { this.advanceTurn(); break; }
                    this.pendingSwap7 = { playerId: player.id };
                    return 'needSwapTarget';
                }
                this.advanceTurn();
                break;

            case '+12':
                this.drawCards(this.getNextPlayerIndex(playerIndex), 12);
                this.skipNextPlayer();
                break;

            case 'RandDraw': {
                const n = Math.floor(Math.random() * 10) + 1;
                const nextIdx = this.getNextPlayerIndex(playerIndex);
                this.drawCards(nextIdx, n);
                this.skipNextPlayer();
                this._glitchRandDrawCount = n;
                break;
            }

            case 'PopupAd': {
                const popupTargetIdx = this.getNextPlayerIndex(playerIndex);
                const popupTargetId  = this.players[popupTargetIdx]?.id;
                this._glitchPopupAdTargetId = popupTargetId;
                this._glitchPopupAdCount    = Math.floor(Math.random() * 11) + 5;
                this.advanceTurn();
                break;
            }

            case 'PeekHand': {
                this.pendingPeek = { playerId: player.id };
                return 'needPeekTarget';
            }

            case 'ScrambleCard': {
                const nextP = this.players[this.getNextPlayerIndex(playerIndex)];
                if (nextP) {
                    this.glitchScrambled = (this.glitchScrambled||[]).filter(e => e.playerId !== nextP.id);
                    this.glitchScrambled.push({ playerId: nextP.id, expiresAt: Date.now() + 90000 });
                    this._glitchScrambleTargetId = nextP.id;
                }
                this.advanceTurn();
                break;
            }

            case 'GlitchedOut': {
                const nextSpectIdx = this.getNextPlayerIndex(playerIndex);
                const nextSpectId  = this.players[nextSpectIdx]?.id;
                this._glitchedOutTargetId = nextSpectId;
                if (nextSpectId && !(this.glitchSpectators||[]).includes(nextSpectId)) {
                    this.glitchSpectators = [...(this.glitchSpectators||[]), nextSpectId];
                }
                if (nextSpectIdx !== -1) this.players[nextSpectIdx].hand = [];
                this.advanceTurn();
                break;
            }

            default:
                this.advanceTurn();
        }
    }

    isGlitchScrambledFor(playerId) {
        if (!playerId) return false;
        const now = Date.now();
        this.glitchScrambled = (this.glitchScrambled||[]).filter(e => e.expiresAt > now);
        return (this.glitchScrambled||[]).some(e => e.playerId === playerId);
    }

    skipNextPlayer()  { this.advanceTurn(); this.advanceTurn(); }

    advanceTurn() {
        this.currentPlayer    = this.getNextPlayerIndex();
        this.hasDrawnThisTurn = false;
    }

    getNextPlayerIndex(fromIndex = null) {
        const index = fromIndex !== null ? fromIndex : this.currentPlayer;
        let next = (index + this.direction + this.players.length) % this.players.length;
        let guard = 0;
        while (this.isEliminated(this.players[next]?.id) && guard++ < this.players.length) {
            next = (next + this.direction + this.players.length) % this.players.length;
        }
        return next;
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

    choosePeekTarget(playerId, targetId) {
        if (!this.pendingPeek)                        return { success: false, error: 'No peek pending' };
        if (this.pendingPeek.playerId !== playerId)   return { success: false, error: 'Not your peek' };
        const ti = this.players.findIndex(p => p.id === targetId);
        if (ti === -1) return { success: false, error: 'Target player not found' };
        const targetHand = this.players[ti].hand;
        const targetName = this.players[ti].name;
        this.pendingPeek = null;
        this.advanceTurn();
        return { success: true, hand: targetHand, playerName: targetName };
    }

    drawCards(playerIndex, count) {
        const hand = this.players[playerIndex].hand;
        for (let i = 0; i < count; i++) {
            if (this.deck.length === 0) this.reshuffleDeck();
            if (this.deck.length === 0) break;
            if (this.isGlitch()) this.glitchTotalDraws++;
            let topCard = this.deck[this.deck.length - 1];
            if (topCard && topCard.value === 'GlitchedOut') {
                if (this.glitchTotalDraws < 85 && this.deck.length > 1) {
                    const go = this.deck.pop();
                    const insertAt = Math.floor(Math.random() * Math.max(1, this.deck.length - 10));
                    this.deck.splice(insertAt, 0, go);
                }
            }
            hand.push(this.deck.pop());
        }
    }

    drawCard(playerId) {
        const pi = this.players.findIndex(p => p.id === playerId);
        if ((this.glitchSpectators||[]).includes(playerId)) return { success: false, error: 'You are a spectator' };
        if (pi === -1 || pi !== this.currentPlayer) return { success: false, error: 'Not your turn' };
        if (this.hasDrawnThisTurn)                  return { success: false, error: 'You can only draw once per turn' };

        if (this.stackedDrawCount > 0) {
            const count = this.stackedDrawCount;
            this.drawCards(pi, count);
            this.stackedDrawCount = 0;
            this.players[pi].calledUno = false;
            this.advanceTurn();
            if (this.isMercy()) this.checkMercyKnockouts();
            return { success: true, drewStacked: true, stackCount: count };
        }

        if (this.isGlitch() && this.stackedDrawCount === 0) {
            const n = Math.floor(Math.random() * 10) + 1;
            this.drawCards(pi, n);
            this.players[pi].calledUno = false;
            this.hasDrawnThisTurn = true;
            const lastCard = this.players[pi].hand.at(-1);
            if (lastCard && lastCard.value === 'GlitchedOut') {
                this.players[pi].hand.pop();
                this._glitchedOutDrawnBy = this.players[pi].id;
            }
            this.advanceTurn();
            return { success: true, cardsDrawn: n, glitchRandDraw: true };
        }

        if (this.isMercy()) {
            let drawn = 0;
            let canPlay = false;
            do {
                this.drawCards(pi, 1);
                drawn++;
                canPlay = this.canPlayCard(this.players[pi].hand.at(-1));
            } while (!canPlay && this.deck.length > 0 && drawn < 50);
            this.hasDrawnThisTurn = true;
            if (this.players[pi].hand.length > 1) this.players[pi].calledUno = false;
            this.checkMercyKnockouts();
            return { success: true, canPlayDrawn: canPlay, cardsDrawn: drawn };
        }

        this.hasDrawnThisTurn = true;
        this.drawCards(pi, 1);
        const drawnCard = this.players[pi].hand.at(-1);
        const canPlay   = drawnCard ? this.canPlayCard(drawnCard) : false;
        if (!canPlay) this.advanceTurn();
        if (this.players[pi].hand.length > 1) this.players[pi].calledUno = false;
        return { success: true, canPlayDrawn: canPlay, cardsDrawn: 1 };
    }

    checkMercyKnockouts() {
        if (!this.isMercy()) return [];
        const newlyKnocked = [];
        this.players.forEach(p => {
            if (!this.isEliminated(p.id) && p.hand.length >= 25) {
                this.knockedOut.push(p.id);
                newlyKnocked.push({ id: p.id, name: p.name });
                p.hand = [];
            }
        });
        if (this.isEliminated(this.players[this.currentPlayer]?.id)) {
            let guard = 0;
            while (this.isEliminated(this.players[this.currentPlayer]?.id) && guard++ < this.players.length) {
                this.advanceTurn();
            }
        }
        return newlyKnocked;
    }

    isEliminated(playerId) {
        if (!playerId) return false;
        return this.knockedOut.includes(playerId) || (this.glitchSpectators || []).includes(playerId);
    }

    activePlayers() {
        return this.players.filter(p => !this.isEliminated(p.id));
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

/* -- HELPERS ---------------------------------------- */
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

/* -- SOCKET.IO ---------------------------------------- */
io.on('connection', socket => {
    console.log('Connected:', socket.id);

    // ── NEW: Client announces its persistent ID immediately on connect ──
    socket.on('announcePersistentId', ({ persistentId }) => {
        socket._persistentId = persistentId;

        // Auto-attempt rejoin if this persistentId has a pending entry
        const entry = rejoinRegistry.get(persistentId);
        if (entry) {
            const room = rooms.get(entry.roomId);
            if (room && room.gameStarted) {
                const pi = room.players.findIndex(p => p.persistentId === persistentId);
                if (pi !== -1) {
                    console.log(`[Rejoin] Auto-rejoining ${entry.playerName} via persistentId`);
                    // Let client know it can rejoin
                    socket.emit('canRejoin', {
                        roomId:     entry.roomId,
                        playerName: entry.playerName
                    });
                }
            } else {
                // Game is gone — clean up
                clearRejoin(persistentId);
            }
        }
    });

    socket.on('requestLobbies', () => broadcastLobbyList());

    socket.on('createLobby', ({ lobbyName, playerName, settings, isPrivate, passcode, persistentId }) => {
        const id = `lobby_${Date.now()}`;
        const pm = new PlayerPresenceManager(2, { heartbeatInterval: 5000, reconnectTimeout: 60000 });
        lobbyPresenceManagers.set(id, pm);
        pm.addPlayer(socket.id, playerName, PlayerState.LOBBY);
        lobbies[id] = {
            id, name: lobbyName, settings, minPlayers: 2,
            players:   [{ id: socket.id, persistentId: persistentId || socket.id, name: playerName, ready: false }],
            isPrivate: !!isPrivate,
            passcode:  isPrivate ? (passcode || '') : null
        };
        socket.join(id);
        socket.emit('lobbyCreated', { roomId: id, lobbyName, settings, players: lobbies[id].players, minPlayers: 2, isPrivate: lobbies[id].isPrivate });
        broadcastLobbyList();
    });

    socket.on('joinLobby', ({ lobbyId, playerName, passcode, persistentId }) => {
        const lobby = lobbies[lobbyId];
        if (!lobby) return;
        if (lobby.players.some(p => p.id === socket.id))       { socket.emit('error', 'You are already in this lobby'); return; }
        if (lobby.players.length >= lobby.settings.maxPlayers) { socket.emit('error', 'Lobby is full'); return; }
        if (lobby.isPrivate && passcode !== lobby.passcode)     { socket.emit('error', '🔒 Wrong passcode. Try again.'); return; }
        const pm = lobbyPresenceManagers.get(lobbyId);
        if (pm) pm.addPlayer(socket.id, playerName, PlayerState.LOBBY);
        lobby.players.push({ id: socket.id, persistentId: persistentId || socket.id, name: playerName, ready: false });
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
        const pm = lobbyPresenceManagers.get(roomId);
        if (pm) pm.setPlayerReady(socket.id, ready);
        io.to(roomId).emit('lobbyUpdate', { roomId, players: lobby.players });

        const minPlayers = lobby.minPlayers || 2;
        if (lobby.players.length < minPlayers) {
            if (lobby.players.every(p => p.ready))
                io.to(roomId).emit('error', `Need at least ${minPlayers} players to start (currently ${lobby.players.length})`);
            return;
        }
        if (!lobby.players.every(p => p.ready)) return;

        const connected = lobby.players.filter(p => !!io.sockets.sockets.get(p.id));
        if (connected.length !== lobby.players.length) {
            lobby.players = connected;
            io.to(roomId).emit('lobbyUpdate', { roomId, players: lobby.players });
            io.to(roomId).emit('error', 'Some players disconnected before game start. Please ready up again.');
            return;
        }
        // finalPresenceCheck intentionally removed — the heartbeat/presence system
        // only runs during games, not in the lobby, so it always reports players
        // as 'not responding' and silently blocks every game start.

        console.log(`[Server] Starting game in lobby ${roomId} with ${lobby.players.length} players`);
        const room = new GameRoom(roomId, lobby.players, lobby.settings);
        rooms.set(roomId, room);
        room.createDeck();
        room.dealCards(room.settings.startingCards || 7);
        room.gameStarted = true;

        // Register each player's persistentId in the rejoin registry
        room.players.forEach(p => {
            registerRejoin(p.persistentId, roomId, p.name);
        });

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
                    io.to(roomId).emit('playerTimeout', { playerId: timedOutPlayer.id, playerName: timedOutPlayer.name, message: `${timedOutPlayer.name} has been removed from the game.` });
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

        if (result.needPeekTarget) {
            socket.emit('choosePeekTarget', { opponents: room.players.filter(p => p.id !== socket.id && !(room.glitchSpectators||[]).includes(p.id)).map(p => ({ id: p.id, name: p.name })) });
            broadcastGameState(room);
            return;
        }

        if (result.drawAnimation) io.to(roomId).emit('drawAnimation', result.drawAnimation);

        if (room._discardAllRemoved !== undefined && room._discardAllRemoved !== null) {
            const playerName = room.players.find(p => p.id === socket.id)?.name;
            io.to(roomId).emit('discardAllAnnounce', { playerName, color: room.currentColor, removed: room._discardAllRemoved });
            room._discardAllRemoved = null;
        }

        if (room._glitchPopupAdTargetId) {
            io.to(room._glitchPopupAdTargetId).emit('glitchPopupAd', { count: room._glitchPopupAdCount });
            io.to(roomId).emit('glitchPopupAdAnnounce', { targetName: room.players.find(p=>p.id===room._glitchPopupAdTargetId)?.name, count: room._glitchPopupAdCount });
            room._glitchPopupAdTargetId = null; room._glitchPopupAdCount = null;
        }
        if (room._glitchRandDrawCount) {
            io.to(roomId).emit('glitchRandDraw', { count: room._glitchRandDrawCount, victimId: room.players.find(p=>p.id!==socket.id)?.id });
            room._glitchRandDrawCount = null;
        }
        if (room._glitchScrambleTargetId) {
            io.to(room._glitchScrambleTargetId).emit('glitchScramble', { duration: 90000 });
            io.to(roomId).emit('glitchScrambleAnnounce', { targetId: room._glitchScrambleTargetId, targetName: room.players.find(p=>p.id===room._glitchScrambleTargetId)?.name });
            room._glitchScrambleTargetId = null;
        }
        if (room._glitchedOutTargetId) {
            io.to(room._glitchedOutTargetId).emit('glitchedOut');
            io.to(roomId).emit('glitchedOutAnnounce', { targetId: room._glitchedOutTargetId, targetName: room.players.find(p=>p.id===room._glitchedOutTargetId)?.name });
            room._glitchedOutTargetId = null;
            const aliveAfterGO = room.activePlayers();
            if (aliveAfterGO.length <= 1) {
                const winnerPlayer = aliveAfterGO[0] || room.players[0];
                const scores = room.players.map(p => {
                    const score = p.hand.reduce((sum, c) => c.type==='wild' ? sum-1 : c.type==='action' ? sum-2 : sum-3, 0);
                    return { name: p.name, id: p.id, score, hand: p.hand };
                });
                io.to(roomId).emit('gameOver', { winner: winnerPlayer.name, winnerId: winnerPlayer.id, scores, reason: 'last-standing' });
                room.players.forEach(p => clearRejoin(p.persistentId));
                rematchQueues.set(roomId, { players: room.players.map(p=>({id:p.id,name:p.name})), settings: room.settings, votes: new Set(), total: room.players.length });
                setTimeout(() => rematchQueues.delete(roomId), 60000);
                rooms.delete(roomId);
                return;
            }
        }
        if (result.newlyKnocked && result.newlyKnocked.length > 0) {
            result.newlyKnocked.forEach(p => io.to(roomId).emit('playerKnockedOut', { playerId: p.id, playerName: p.name }));
            const aliveAfterKnock = room.activePlayers();
            if (aliveAfterKnock.length <= 1) {
                const winnerPlayer = aliveAfterKnock[0] || room.players[0];
                const scores = room.players.map(p => {
                    const score = p.hand.reduce((sum, c) => c.type==='wild' ? sum-1 : c.type==='action' ? sum-2 : sum-3, 0);
                    return { name: p.name, id: p.id, score, hand: p.hand };
                });
                io.to(roomId).emit('gameOver', { winner: winnerPlayer.name, winnerId: winnerPlayer.id, scores, reason: 'last-standing' });
                room.players.forEach(p => clearRejoin(p.persistentId));
                rematchQueues.set(roomId, { players: room.players.map(p=>({id:p.id,name:p.name})), settings: room.settings, votes: new Set(), total: room.players.length });
                setTimeout(() => rematchQueues.delete(roomId), 60000);
                rooms.delete(roomId);
                return;
            }
        }
        if (result.swapHappened) {
            io.to(roomId).emit('swapHappened', result.swapHappened);
            if (result.swapHappened.unoTransfer) io.to(roomId).emit('unoTransfer', { playerName: result.swapHappened.unoTransfer });
        }

        broadcastGameState(room);

        if (result.winner !== null) {
            const scores = room.players.map(p => {
                if (p.hand.length === 0) return { name: p.name, id: p.id, score: 0, hand: [] };
                const score = p.hand.reduce((sum, card) => {
                    if (card.type === 'wild')   return sum - 1;
                    if (card.type === 'action') return sum - 2;
                    return sum - 3;
                }, 0);
                return { name: p.name, id: p.id, score, hand: p.hand };
            });
            const sorted = [...scores].sort((a, b) => b.score - a.score);
            io.to(roomId).emit('gameOver', { winner: room.players[result.winner].name, winnerId: room.players[result.winner].id, scores: sorted });
            // Game over — clear rejoin entries
            room.players.forEach(p => clearRejoin(p.persistentId));
            rematchQueues.set(roomId, { players: room.players.map(p => ({ id: p.id, name: p.name })), settings: room.settings, votes: new Set(), total: room.players.length });
            setTimeout(() => rematchQueues.delete(roomId), 60000);
            rooms.delete(roomId);
        }
    });

    socket.on('drawCard', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (!room || !room.gameStarted) return;
        const result = room.drawCard(socket.id);
        if (!result.success) { socket.emit('error', result.error); return; }

        if (room._glitchedOutDrawnBy) {
            const victim = room.players.find(p => p.id === room._glitchedOutDrawnBy);
            room._glitchedOutDrawnBy = null;
            if (victim) {
                if (!(room.glitchSpectators||[]).includes(victim.id)) {
                    room.glitchSpectators = [...(room.glitchSpectators||[]), victim.id];
                    victim.hand = [];
                }
                io.to(victim.id).emit('glitchedOutDrawn');
                io.to(roomId).emit('glitchedOutAnnounce', { targetId: victim.id, targetName: victim.name, drawn: true });
                const alive = room.players.filter(p => !(room.glitchSpectators||[]).includes(p.id));
                if (alive.length === 1) {
                    const scores = room.players.map(p => {
                        const score = p.hand.reduce((sum, c) => { if (c.type==='wild') return sum-1; if (c.type==='action') return sum-2; return sum-3; }, 0);
                        return { name: p.name, id: p.id, score, hand: p.hand };
                    });
                    io.to(roomId).emit('gameOver', { winner: alive[0].name, winnerId: alive[0].id, scores, reason: 'glitched-out' });
                    room.players.forEach(p => clearRejoin(p.persistentId));
                    rematchQueues.set(roomId, { players: room.players.map(p=>({id:p.id,name:p.name})), settings: room.settings, votes: new Set(), total: room.players.length });
                    setTimeout(() => rematchQueues.delete(roomId), 60000);
                    rooms.delete(roomId);
                    return;
                }
            }
        }

        if (result.drewStacked) {
            const p = room.players.find(p => p.id === socket.id);
            io.to(roomId).emit('drawAnimation', { victimId: socket.id, victimName: p?.name, playerId: null, count: result.stackCount, cardValue: 'stack' });
        }
        if (room.isMercy && room.isMercy()) {
            const knocked = room.checkMercyKnockouts();
            knocked.forEach(p => io.to(roomId).emit('playerKnockedOut', { playerId: p.id, playerName: p.name }));
            const active = room.activePlayers();
            if (active.length === 1) {
                const scores = room.players.map(p => {
                    const score = p.hand.reduce((sum, card) => { if (card.type==='wild') return sum-1; if (card.type==='action') return sum-2; return sum-3; }, 0);
                    return { name: p.name, id: p.id, score, hand: p.hand };
                });
                io.to(roomId).emit('gameOver', { winner: active[0].name, winnerId: active[0].id, scores, reason: 'last-standing' });
                room.players.forEach(p => clearRejoin(p.persistentId));
                rematchQueues.set(roomId, { players: room.players.map(p=>({id:p.id,name:p.name})), settings: room.settings, votes: new Set(), total: room.players.length });
                setTimeout(() => rematchQueues.delete(roomId), 60000);
                rooms.delete(roomId);
                return;
            }
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

    socket.on('choosePeekTarget', ({ roomId, targetId }) => {
        const room = rooms.get(roomId);
        if (!room || !room.gameStarted) return;
        const result = room.choosePeekTarget(socket.id, targetId);
        if (!result.success) { socket.emit('error', result.error); return; }
        socket.emit('glitchPeek', { hand: result.hand, playerName: result.playerName });
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

    socket.on('adSkipTurn', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (!room || !room.gameStarted) return;
        const pi = room.players.findIndex(p => p.id === socket.id);
        if (pi === -1 || pi !== room.currentPlayer) return;
        room.advanceTurn();
        io.to(roomId).emit('adTurnSkipped', { playerName: room.players[pi].name });
        broadcastGameState(room);
    });

    socket.on('leaveLobby', ({ roomId }) => cleanupPlayerFromLobby(socket.id, roomId));

    // ── REJOIN GAME (by persistentId) ──────────────────────────────────
    socket.on('rejoinGame', ({ roomId, persistentId }) => {
        if (!persistentId) { socket.emit('rejoinFailed', { reason: 'No persistent ID provided.' }); return; }
        const room = rooms.get(roomId);
        if (!room || !room.gameStarted) {
            clearRejoin(persistentId);
            socket.emit('rejoinFailed', { reason: 'Game not found or already ended.' });
            return;
        }
        const pi = room.players.findIndex(p => p.persistentId === persistentId);
        if (pi === -1) {
            socket.emit('rejoinFailed', { reason: 'Player not found in this game.' });
            return;
        }
        const oldId          = room.players[pi].id;
        const rejoinedName   = room.players[pi].name;

        // 1. Update the socket ID BEFORE joining the room so getGameState uses the right ID
        room.players[pi].id = socket.id;

        // 2. Join the socket room so this socket can receive broadcasts
        socket.join(roomId);

        // 3. CRITICAL FIX: Tell the PresenceManager about the new socket ID.
        //    Without this, the PM still has the OLD (dead) socket ID marked as
        //    DISCONNECTED, its 60-second countdown keeps running, and when it
        //    fires 'player-timeout' it ends the game for everyone.
        const pm = lobbyPresenceManagers.get(roomId);
        if (pm) {
            // Clear the old (dead) socket entry so its countdown timer is cancelled
            // then re-register under the new socket ID as fully active
            try { pm.onPlayerDisconnect(oldId); } catch(e) {}
            pm.addPlayer(socket.id, rejoinedName, PlayerState.IN_GAME);
        }

        // 4. Refresh rejoin window in case they drop again
        clearRejoin(persistentId);
        registerRejoin(persistentId, roomId, rejoinedName);

        // 5. Send the rejoined player their own game state FIRST (restores their hand, turn, etc.)
        socket.emit('gameRejoined', room.getGameState(socket.id));

        // 6. Broadcast a fresh gameState to ALL OTHER players so they see the updated
        //    player list (new socket ID, correct card counts, correct current turn).
        //    This also unblocks them from playing cards.
        room.players.forEach(p => {
            if (p.id !== socket.id) {
                io.to(p.id).emit('gameState', room.getGameState(p.id));
            }
        });

        // 7. Finally notify everyone (AFTER the rejoined player has their state) that
        //    the player reconnected — this is just an informational toast/message.
        io.to(roomId).emit('playerRejoined', { playerName: rejoinedName });

        console.log(`[Rejoin] ${rejoinedName} rejoined room ${roomId} (${oldId} -> ${socket.id})`);
    });

    socket.on('rematchVote', ({ roomId }) => {
        const q = rematchQueues.get(roomId);
        if (!q) { socket.emit('error', 'Rematch expired or not found'); return; }
        if (!q.players.some(p => p.id === socket.id)) return;
        q.votes.add(socket.id);
        const voterName = q.players.find(p => p.id === socket.id)?.name;
        q.players.forEach(p => io.to(p.id).emit('rematchVoteUpdate', { votes: q.votes.size, total: q.total, voterName, voterId: socket.id }));
        if (q.votes.size >= q.total) {
            rematchQueues.delete(roomId);
            const connected = q.players.filter(p => !!io.sockets.sockets.get(p.id));
            if (connected.length < q.total) {
                const missing = q.players.filter(p => !io.sockets.sockets.get(p.id)).map(p => p.name).join(', ');
                q.players.filter(p => io.sockets.sockets.get(p.id)).forEach(p => io.to(p.id).emit('rematchCancelled', { reason: `${missing} disconnected. Can't start rematch.` }));
                return;
            }
            const room = new GameRoom(roomId, q.players, q.settings);
            rooms.set(roomId, room);
            room.createDeck();
            room.dealCards(room.settings.startingCards || 7);
            room.gameStarted = true;
            room.players.forEach(p => registerRejoin(p.persistentId, roomId, p.name));
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
        q.players.forEach(p => io.to(p.id).emit('rematchCancelled', { reason: `${decliner?.name || 'A player'} declined the rematch.` }));
    });

    socket.on('heartbeat', ({ roomId }) => {
        const pm = lobbyPresenceManagers.get(roomId);
        if (pm) pm.receiveHeartbeat(socket.id);
    });

    socket.on('disconnect', () => {
        console.log('Disconnected:', socket.id);
        Object.keys(lobbies).forEach(id => cleanupPlayerFromLobby(socket.id, id));

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
            // Keep the room alive — the rejoin registry already has the 5-min window
            // Just notify other players about the disconnect
            const pm = lobbyPresenceManagers.get(roomId);
            if (pm) {
                pm.onPlayerDisconnect(socket.id);
                room.players.filter(p => p.id !== socket.id).forEach(p =>
                    io.to(p.id).emit('playerDisconnected', {
                        playerId:         socket.id,
                        playerName:       player.name,
                        reconnectTimeout: REJOIN_WINDOW_MS
                    })
                );
            } else {
                // No presence manager — still notify and keep room alive for 5 min
                room.players.filter(p => p.id !== socket.id).forEach(p =>
                    io.to(p.id).emit('playerDisconnected', {
                        playerId:         socket.id,
                        playerName:       player.name,
                        reconnectTimeout: REJOIN_WINDOW_MS
                    })
                );
            }
        });

        broadcastLobbyList();
    });
});

/* -- START ---------------------------------------- */
server.listen(PORT, () => console.log(`O,No server running on port ${PORT}`));
