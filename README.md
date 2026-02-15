# O,No Online - Multiplayer Card Game

Online multiplayer version of the O,No card game with real-time gameplay using WebSockets.

## Features

- 🌐 **Online Multiplayer** - Play against real players in real-time
- 🤖 **Offline Mode** - Play against computer AI
- 📱 **Mobile Optimized** - Works great on iPad and mobile devices
- ⚡ **Real-time Updates** - Instant game state synchronization
- 🎮 **Custom Rules** - Stacking, Jump-In, and special 0/7 rules

## Tech Stack

- **Backend**: Node.js, Express, Socket.IO
- **Frontend**: HTML5, CSS3, JavaScript
- **Deployment**: Render

## Local Development

### Prerequisites

- Node.js 14+ installed

### Installation

1. Install dependencies:

```bash
npm install
```

1. Start the server:

```bash
npm start
```

1. Open your browser to:

```
http://localhost:3000
```

For development with auto-reload:

```bash
npm run dev
```

## Deploying to Render

### Step 1: Prepare Your Repository

1. Create a new GitHub repository
1. Push all files to the repository:

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin <your-repo-url>
git push -u origin main
```

### Step 2: Deploy on Render

1. Go to [render.com](https://render.com) and sign up/login
1. Click **“New +”** → **“Web Service”**
1. Connect your GitHub repository
1. Configure the service:
- **Name**: `ono-game-online` (or your preferred name)
- **Environment**: `Node`
- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Instance Type**: `Free` (or your choice)
1. Click **“Create Web Service”**
1. Wait for deployment (usually 2-5 minutes)
1. Your game will be live at: `https://your-app-name.onrender.com`

### Step 3: Access Your Game

- **Online Mode**: Go to `https://your-app-name.onrender.com`
- **Share the link** with friends to play online!

## How to Play

### Online Mode

1. Enter your name
1. Click “Find Match”
1. Wait for an opponent
1. Play begins automatically when matched!

### Game Controls

- **Tap a card** to play it
- **Tap the deck** to draw a card
- **Tap O,NO! button** when you have 2 or 1 cards left

### Rules

- Match color or number with the top discard card
- Special cards:
  - **Skip**: Skip opponent’s turn
  - **Reverse**: Reverse direction (acts like Skip in 2-player)
  - **+2**: Opponent draws 2 cards
  - **Wild**: Choose any color
  - **Wild +4**: Choose color, opponent draws 4

### Optional Game Rules (Configurable in Lobby Settings)

- **+2/+4 Stacking**: Stack draw cards to pass the penalty to the next player
- **0 & 7 Swap**: Playing a 0 or 7 swaps hands with an opponent
- **4 & 8 Special**: 4 skips opponent, 8 reverses direction
- **Jump-In**: Play out of turn with an exact match (same color and number)
- **Draw Until Match**: Keep drawing cards until a playable card is found (default: enabled). When disabled, draw only one card per turn

## File Structure

```
├── server.js              # Node.js server with Socket.IO
├── package.json           # Dependencies
├── public/
│   ├── index.html        # Online multiplayer frontend
│   └── offline.html      # Offline vs computer mode
└── README.md             # This file
```

## Troubleshooting

### Game won’t connect online

- Check if Render service is running
- Verify the URL is correct
- Check browser console for errors

### Cards not appearing

- Hard refresh the page (Ctrl+Shift+R or Cmd+Shift+R)
- Clear browser cache
- Try a different browser

### Opponent disconnected

- They may have closed their browser
- Network issues
- Start a new match

## Environment Variables (Optional)

You can set these in Render dashboard:

- `PORT` - Server port (default: 3000, Render sets this automatically)
- `NODE_ENV` - Set to `production` for production mode

## Support

For issues or questions, create an issue in the GitHub repository.

## License

MIT License - Feel free to use and modify!
