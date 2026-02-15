/**
 * Player Presence Management System
 * Handles player tracking, heartbeat monitoring, and reconnection logic
 */

// Player connection states
const PlayerState = {
    JOINING: 'JOINING',
    LOBBY: 'LOBBY',
    READY: 'READY',
    IN_GAME: 'IN_GAME',
    DISCONNECTED: 'DISCONNECTED',
    TIMEOUT: 'TIMEOUT',
    RECONNECTING: 'RECONNECTING'
};

class PlayerPresenceManager {
    constructor(minPlayers = 3, options = {}) {
        this.players = new Map(); // playerId -> player data
        this.minPlayers = minPlayers;
        this.heartbeatInterval = options.heartbeatInterval || 5000; // 5 seconds
        this.reconnectTimeout = options.reconnectTimeout || 60000; // 60 seconds
        this.heartbeatTimer = null;
        this.disconnectTimers = new Map(); // playerId -> timeout handle
        this.lastHeartbeat = new Map(); // playerId -> timestamp
        this.eventCallbacks = new Map(); // event name -> callback function
        
        console.log(`[PlayerPresence] Initialized with minPlayers=${minPlayers}, heartbeat=${this.heartbeatInterval}ms, reconnectTimeout=${this.reconnectTimeout}ms`);
    }

    /**
     * Register event callback
     * @param {string} event - Event name
     * @param {function} callback - Callback function
     */
    on(event, callback) {
        this.eventCallbacks.set(event, callback);
    }

    /**
     * Emit event
     * @param {string} event - Event name
     * @param {any} data - Event data
     */
    emit(event, data) {
        const callback = this.eventCallbacks.get(event);
        if (callback) {
            callback(data);
        }
    }

    /**
     * Add or update player
     * @param {string} playerId - Socket ID
     * @param {string} playerName - Player name
     * @param {string} state - Initial state (default: JOINING)
     */
    addPlayer(playerId, playerName, state = PlayerState.JOINING) {
        const player = {
            id: playerId,
            name: playerName,
            state: state,
            ready: false,
            joinedAt: Date.now(),
            lastSeen: Date.now()
        };
        
        this.players.set(playerId, player);
        this.lastHeartbeat.set(playerId, Date.now());
        
        console.log(`[PlayerPresence] Added player ${playerName} (${playerId}) with state ${state}`);
        this.emit('player-joined', player);
        
        return player;
    }

    /**
     * Remove player
     * @param {string} playerId - Socket ID
     */
    removePlayer(playerId) {
        const player = this.players.get(playerId);
        if (player) {
            console.log(`[PlayerPresence] Removed player ${player.name} (${playerId})`);
            this.players.delete(playerId);
            this.lastHeartbeat.delete(playerId);
            this.clearDisconnectTimer(playerId);
            this.emit('player-removed', player);
        }
    }

    /**
     * Get player by ID
     * @param {string} playerId - Socket ID
     * @returns {object|null} Player data or null
     */
    getPlayer(playerId) {
        return this.players.get(playerId) || null;
    }

    /**
     * Get all players
     * @returns {Array} Array of player objects
     */
    getAllPlayers() {
        return Array.from(this.players.values());
    }

    /**
     * Get players by state
     * @param {string} state - Player state
     * @returns {Array} Array of player objects
     */
    getPlayersByState(state) {
        return this.getAllPlayers().filter(p => p.state === state);
    }

    /**
     * Update player state
     * @param {string} playerId - Socket ID
     * @param {string} newState - New state
     */
    updatePlayerState(playerId, newState) {
        const player = this.players.get(playerId);
        if (player) {
            const oldState = player.state;
            player.state = newState;
            console.log(`[PlayerPresence] Player ${player.name} state: ${oldState} -> ${newState}`);
            this.emit('player-state-changed', { player, oldState, newState });
        }
    }

    /**
     * Set player ready status
     * @param {string} playerId - Socket ID
     * @param {boolean} isReady - Ready status
     */
    setPlayerReady(playerId, isReady) {
        const player = this.players.get(playerId);
        if (player) {
            player.ready = isReady;
            console.log(`[PlayerPresence] Player ${player.name} ready: ${isReady}`);
            
            if (isReady) {
                this.updatePlayerState(playerId, PlayerState.READY);
                this.emit('player-ready', player);
            } else {
                this.updatePlayerState(playerId, PlayerState.LOBBY);
                this.emit('player-unready', player);
            }
            
            // Check if all players are ready
            if (this.allPlayersReady()) {
                this.emit('all-players-ready', this.getAllPlayers());
            }
        }
    }

    /**
     * Check if all players are ready
     * @returns {boolean} True if all players ready and minimum met
     */
    allPlayersReady() {
        const players = this.getAllPlayers();
        return players.length >= this.minPlayers && 
               players.every(p => p.ready);
    }

    /**
     * Check if can start game (minimum players and all ready)
     * @returns {boolean} True if game can start
     */
    canStartGame() {
        const players = this.getAllPlayers();
        const connectedPlayers = players.filter(p => 
            p.state !== PlayerState.DISCONNECTED && 
            p.state !== PlayerState.TIMEOUT
        );
        
        const result = connectedPlayers.length >= this.minPlayers && 
               connectedPlayers.every(p => p.ready);
        
        console.log(`[PlayerPresence] canStartGame: ${result} (connected=${connectedPlayers.length}, min=${this.minPlayers}, allReady=${connectedPlayers.every(p => p.ready)})`);
        return result;
    }

    /**
     * Perform final presence check before game start
     * @returns {object} { success: boolean, missingPlayers: Array }
     */
    finalPresenceCheck() {
        const players = this.getAllPlayers();
        const missingPlayers = [];
        
        for (const player of players) {
            // Check if player hasn't sent heartbeat recently (within 2x interval)
            const timeSinceHeartbeat = Date.now() - this.lastHeartbeat.get(player.id);
            if (timeSinceHeartbeat > this.heartbeatInterval * 2) {
                missingPlayers.push(player);
            }
        }
        
        const success = missingPlayers.length === 0;
        console.log(`[PlayerPresence] Final presence check: ${success ? 'PASSED' : 'FAILED'} (missing: ${missingPlayers.map(p => p.name).join(', ')})`);
        
        return { success, missingPlayers };
    }

    /**
     * Start heartbeat monitoring
     */
    startHeartbeat() {
        if (this.heartbeatTimer) {
            this.stopHeartbeat();
        }
        
        console.log('[PlayerPresence] Starting heartbeat monitoring');
        this.heartbeatTimer = setInterval(() => {
            this.checkHeartbeats();
        }, this.heartbeatInterval);
        
        this.emit('heartbeat-started', { interval: this.heartbeatInterval });
    }

    /**
     * Stop heartbeat monitoring
     */
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            console.log('[PlayerPresence] Stopping heartbeat monitoring');
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
            this.emit('heartbeat-stopped', {});
        }
    }

    /**
     * Check all player heartbeats
     */
    checkHeartbeats() {
        const now = Date.now();
        const timeout = this.heartbeatInterval * 2; // Allow 2 missed heartbeats
        
        for (const [playerId, lastBeat] of this.lastHeartbeat.entries()) {
            const timeSince = now - lastBeat;
            const player = this.players.get(playerId);
            
            if (!player) continue;
            
            // Only check players that should be sending heartbeats
            if (player.state === PlayerState.IN_GAME || 
                player.state === PlayerState.READY ||
                player.state === PlayerState.LOBBY) {
                
                if (timeSince > timeout && player.state !== PlayerState.DISCONNECTED) {
                    console.log(`[PlayerPresence] Player ${player.name} missed heartbeat (${timeSince}ms > ${timeout}ms)`);
                    this.onPlayerDisconnect(playerId);
                }
            }
        }
    }

    /**
     * Receive heartbeat from player
     * @param {string} playerId - Socket ID
     */
    receiveHeartbeat(playerId) {
        const player = this.players.get(playerId);
        if (player) {
            this.lastHeartbeat.set(playerId, Date.now());
            player.lastSeen = Date.now();
            
            // If player was disconnected and sent heartbeat, they're reconnecting
            if (player.state === PlayerState.DISCONNECTED) {
                this.onPlayerReconnect(playerId);
            }
        }
    }

    /**
     * Handle player disconnection
     * @param {string} playerId - Socket ID
     */
    onPlayerDisconnect(playerId) {
        const player = this.players.get(playerId);
        if (!player) return;
        
        console.log(`[PlayerPresence] Player ${player.name} disconnected`);
        player.state = PlayerState.DISCONNECTED;
        player.disconnectedAt = Date.now();
        
        this.emit('player-disconnected', player);
        
        // Start reconnection timeout
        this.startDisconnectTimer(playerId);
    }

    /**
     * Handle player reconnection
     * @param {string} playerId - Socket ID
     */
    onPlayerReconnect(playerId) {
        const player = this.players.get(playerId);
        if (!player) return;
        
        console.log(`[PlayerPresence] Player ${player.name} reconnected`);
        this.clearDisconnectTimer(playerId);
        
        // Restore previous state (before disconnection)
        const newState = player.ready ? PlayerState.READY : 
                        (player.state === PlayerState.IN_GAME ? PlayerState.IN_GAME : PlayerState.LOBBY);
        player.state = newState;
        player.reconnectedAt = Date.now();
        
        this.emit('player-reconnected', player);
    }

    /**
     * Start disconnect timer for player
     * @param {string} playerId - Socket ID
     */
    startDisconnectTimer(playerId) {
        this.clearDisconnectTimer(playerId);
        
        const timer = setTimeout(() => {
            this.onPlayerTimeout(playerId);
        }, this.reconnectTimeout);
        
        this.disconnectTimers.set(playerId, timer);
        console.log(`[PlayerPresence] Started disconnect timer for player ${playerId} (${this.reconnectTimeout}ms)`);
    }

    /**
     * Clear disconnect timer for player
     * @param {string} playerId - Socket ID
     */
    clearDisconnectTimer(playerId) {
        const timer = this.disconnectTimers.get(playerId);
        if (timer) {
            clearTimeout(timer);
            this.disconnectTimers.delete(playerId);
            console.log(`[PlayerPresence] Cleared disconnect timer for player ${playerId}`);
        }
    }

    /**
     * Handle player timeout (failed to reconnect)
     * @param {string} playerId - Socket ID
     */
    onPlayerTimeout(playerId) {
        const player = this.players.get(playerId);
        if (!player) return;
        
        console.log(`[PlayerPresence] Player ${player.name} timed out`);
        player.state = PlayerState.TIMEOUT;
        player.timedOutAt = Date.now();
        
        this.emit('player-timeout', player);
    }

    /**
     * Handle missing player during game
     * @param {string} playerId - Socket ID
     * @returns {object} Action to take { action: 'wait'|'remove'|'end' }
     */
    handleMissingPlayer(playerId) {
        const player = this.players.get(playerId);
        if (!player) {
            return { action: 'remove' };
        }
        
        if (player.state === PlayerState.DISCONNECTED) {
            // Within grace period, wait for reconnection
            return { action: 'wait', player };
        } else if (player.state === PlayerState.TIMEOUT) {
            // Timeout expired, need to handle
            const remainingPlayers = this.getAllPlayers().filter(p => 
                p.state !== PlayerState.TIMEOUT && 
                p.state !== PlayerState.DISCONNECTED
            );
            
            if (remainingPlayers.length < this.minPlayers) {
                // Not enough players, end game
                return { action: 'end', player, reason: 'Not enough players' };
            } else {
                // Remove player, continue game
                return { action: 'remove', player };
            }
        }
        
        return { action: 'wait', player };
    }

    /**
     * Get presence status summary
     * @returns {object} Summary of player presence
     */
    getPresenceStatus() {
        const players = this.getAllPlayers();
        const byState = {};
        
        for (const state of Object.values(PlayerState)) {
            byState[state] = players.filter(p => p.state === state).length;
        }
        
        return {
            total: players.length,
            byState,
            allReady: this.allPlayersReady(),
            canStart: this.canStartGame(),
            minPlayers: this.minPlayers
        };
    }

    /**
     * Reset all player states (for testing)
     */
    reset() {
        console.log('[PlayerPresence] Resetting all state');
        this.stopHeartbeat();
        
        // Clear all disconnect timers
        for (const timer of this.disconnectTimers.values()) {
            clearTimeout(timer);
        }
        
        this.players.clear();
        this.lastHeartbeat.clear();
        this.disconnectTimers.clear();
    }

    /**
     * Cleanup resources
     */
    destroy() {
        console.log('[PlayerPresence] Destroying instance');
        this.reset();
        this.eventCallbacks.clear();
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PlayerPresenceManager, PlayerState };
}
