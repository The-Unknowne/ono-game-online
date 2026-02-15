# Player Presence System Documentation

## Overview

The Player Presence System is a comprehensive solution for tracking player connections, managing disconnections, and ensuring game integrity in the O,No online multiplayer card game. The system enforces a minimum of 3 players to start a game and provides robust handling of connection issues.

## Key Features

### 1. Minimum Player Requirement
- **3 players minimum** required to start any game
- Clear visual indicators showing player count (e.g., "1/3 Players")
- Prominent warning banner when below minimum threshold
- Ready button only appears when minimum players are present

### 2. Heartbeat Mechanism
- Client sends heartbeat every **5 seconds**
- Server monitors for missed heartbeats
- Allows 2 missed heartbeats before marking as disconnected (10 seconds total)
- Automatic reconnection detection

### 3. Disconnect Handling
- **60-second grace period** for reconnection
- Visual notification overlay with countdown timer
- Remaining players are notified immediately
- Game state preserved during grace period

### 4. Player States
The system tracks players through various states:
- `JOINING` - Player is entering the lobby
- `LOBBY` - Player is in the lobby
- `READY` - Player has marked themselves ready
- `IN_GAME` - Player is actively playing
- `DISCONNECTED` - Connection lost (within grace period)
- `TIMEOUT` - Failed to reconnect within grace period
- `RECONNECTING` - Player is attempting to rejoin

### 5. Reconnection Support
- Players can reconnect within 60 seconds
- Game state is preserved
- Previous player state is restored (READY, IN_GAME, etc.)
- Automatic cleanup of disconnect timers

### 6. Game State Management
- Game ends if less than 3 players remain after timeout
- Remaining players notified of permanent disconnections
- Clean resource management and memory cleanup

## Technical Architecture

### Server-Side Components

#### PlayerPresenceManager Class
Located in: `public/js/playerPresence.js`

**Key Methods:**
```javascript
- addPlayer(playerId, playerName, state)
- removePlayer(playerId)
- setPlayerReady(playerId, isReady)
- allPlayersReady()
- canStartGame()
- startHeartbeat()
- receiveHeartbeat(playerId)
- onPlayerDisconnect(playerId)
- onPlayerReconnect(playerId)
```

**Configuration:**
```javascript
new PlayerPresenceManager(3, {
    heartbeatInterval: 5000,    // 5 seconds
    reconnectTimeout: 60000     // 60 seconds
});
```

#### Server Integration
Located in: `server.js`

- Presence manager created for each lobby
- Heartbeat handler processes client pings
- Disconnect handler with timeout management
- Game start validation with presence check

### Client-Side Components

#### Heartbeat System
Located in: `public/index.html`

- Automatic heartbeat starts when joining lobby
- Sends ping every 5 seconds
- Stops when leaving lobby or game ends
- Race condition prevention with roomId management

#### UI Components

**Minimum Player Warning:**
```html
<div class="min-players-warning">
    ⚠️ Need at least 3 players to start the game!
    (Currently 1 / 3)
</div>
```

**Disconnect Notification:**
```html
<div id="disconnectNotification" class="disconnect-notification">
    Player disconnected. Waiting for reconnection...
    <span class="reconnect-timer">Grace period: 60 seconds</span>
</div>
```

**Player Status Indicators:**
- Ready badges (✓ Ready / ⏳ Not Ready)
- Host badge (👑 Host)
- Connection status indicators
- Empty player slots

## API & Events

### Socket.IO Events

#### Client → Server
- `heartbeat` - Regular ping with roomId
- `playerReady` - Ready status update
- `createLobby` - Create new lobby with settings
- `joinLobby` - Join existing lobby

#### Server → Client
- `lobbyCreated` - Lobby created successfully
- `lobbyJoined` - Successfully joined lobby
- `lobbyUpdate` - Player list updated
- `playerDisconnected` - Player connection lost
- `playerTimeout` - Player failed to reconnect
- `gameEnded` - Game ended due to disconnections
- `gameStarted` - Game starting with all players

### Presence Manager Events

Internal event system for tracking:
- `player-joined`
- `player-ready`
- `player-unready`
- `all-players-ready`
- `player-disconnected`
- `player-reconnected`
- `player-timeout`
- `player-state-changed`

## Configuration

All timeout values are configurable:

```javascript
// Server-side (server.js)
const presenceManager = new PlayerPresenceManager(3, {
    heartbeatInterval: 5000,      // Milliseconds between heartbeats
    reconnectTimeout: 60000       // Grace period for reconnection
});

// Client-side (index.html)
const heartbeatInterval = setInterval(() => {
    socket.emit('heartbeat', { roomId });
}, 5000);
```

## User Experience

### Lobby Waiting State (< 3 players)
1. Shows "Waiting for more players to join... (1/3)"
2. Displays minimum player warning banner
3. Ready button is hidden
4. Players can see lobby settings and rules

### Lobby Ready State (≥ 3 players)
1. Ready button becomes visible
2. Players can mark themselves ready
3. Status bar shows ready count (e.g., "2/3 ready")
4. Game starts when all players ready and present

### Disconnect State
1. Notification appears at top of screen
2. Countdown timer shows remaining grace period
3. Game pauses (optional configuration)
4. Other players can continue or wait

### Timeout State
1. Notification updates to show player removal
2. Game continues if ≥ 3 players remain
3. Game ends if < 3 players remain
4. Clean resource cleanup

## Testing Scenarios

### Manual Testing Checklist
- [ ] Create lobby with 1 player - verify warning shows
- [ ] Add 2nd player - verify warning persists
- [ ] Add 3rd player - verify warning disappears, ready button appears
- [ ] All players mark ready - verify game starts
- [ ] Disconnect 1 player during game - verify notification shows
- [ ] Reconnect within 60 seconds - verify game resumes
- [ ] Let player timeout - verify handling (end or continue)
- [ ] Test with 4, 5, 6+ players

### Automated Testing
Currently relies on manual testing. Future improvements:
- Unit tests for PlayerPresenceManager
- Integration tests for socket events
- E2E tests for full user flow

## Security Considerations

✅ **CodeQL Scan: 0 Vulnerabilities**

- No sensitive data in heartbeat messages
- Proper validation of player presence
- Resource cleanup prevents memory leaks
- Rate limiting on heartbeat messages (every 5 seconds)
- Timeout handlers properly cleaned up

## Logging & Debugging

Console logging is extensive for debugging:

```javascript
[PlayerPresence] Initialized with minPlayers=3, heartbeat=5000ms, reconnectTimeout=60000ms
[PlayerPresence] Added player TestUser (socketId) with state LOBBY
[PlayerPresence] Player TestUser state: LOBBY -> READY
[PlayerPresence] Player TestUser disconnected
[PlayerPresence] Player TestUser reconnected
[PlayerPresence] Player TestUser timed out
[Client] Starting heartbeat
[Client] Stopping heartbeat
[Server] Starting game in lobby lobby_xxx with 3 players
```

## Performance Considerations

- **Heartbeat overhead:** 1 message per player every 5 seconds
- **Memory usage:** O(n) where n = number of players
- **Cleanup:** Automatic on player removal or timeout
- **Scalability:** Designed for 2-8 players per lobby

## Future Enhancements

### Potential Improvements
1. **Configurable pause on disconnect** - Make game pause optional
2. **AI player replacement** - Convert disconnected to bot
3. **Card redistribution** - Redistribute cards on player removal
4. **Reconnection tokens** - Use tokens for reliable reconnection
5. **Network quality indicators** - Show latency/connection strength
6. **Spectator mode** - Allow timed-out players to spectate
7. **Custom minimum players** - Let lobby host configure minimum

### Known Limitations
1. No persistent session storage (uses in-memory only)
2. Reconnection relies on same socket connection
3. No cross-lobby presence tracking
4. Limited to single-server deployment

## Troubleshooting

### Common Issues

**Players stuck in "Not Ready" state**
- Check browser console for socket errors
- Verify heartbeat is sending (look for logs)
- Clear browser cache and refresh

**Game won't start despite all players ready**
- Check server logs for presence check failures
- Verify all players have active socket connections
- Ensure minimum 3 players in lobby

**Disconnect notifications persist**
- Check if player actually reconnected
- Verify timeout handler is working
- Look for JavaScript errors in console

**Heartbeat not working**
- Verify roomId is set correctly
- Check if heartbeat interval is running
- Look for network connectivity issues

## Migration Notes

### Upgrading from Previous Version

This system changes the minimum player requirement from **2 to 3 players**. If you need to maintain 2-player games:

1. Change minimum in server.js:
```javascript
const presenceManager = new PlayerPresenceManager(2, {...});
```

2. Update client-side references to minPlayers

3. Test thoroughly with 2-player scenarios

## Support

For issues or questions about the player presence system:
1. Check server logs for presence manager messages
2. Check browser console for client-side errors
3. Verify network connectivity between client and server
4. Review this documentation for configuration options

## License

This feature is part of the O,No Online project and follows the same MIT License.
