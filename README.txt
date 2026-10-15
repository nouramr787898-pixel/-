AI Meeting v5

Main fixes:
- Host approval is completed server-side in one step.
- Accepted guest automatically opens the meeting UI.
- One visible video tile per participant appears immediately.
- 2 participants = split screen, 3/4 participants = 2x2 grid.
- New guest alone initiates WebRTC offers, preventing offer collisions.
- Remote audio autoplay fallback button added.
- ICE restart/reconnection logic added.
- Optional TURN variables supported for reliable calls across different networks.

Railway variables:
OPENAI_API_KEY=...

Optional/recommended for production media reliability:
TURN_URLS=...
TURN_USERNAME=...
TURN_CREDENTIAL=...

Start command:
npm start
