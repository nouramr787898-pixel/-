AI Meeting Platform - GitHub ready flat project

All project files are intentionally in the repository root (no source folders).

IMPORTANT:
GitHub stores the code, but GitHub Pages cannot run the Node.js server required for WebRTC signaling and AI summarization.
To run the full site, connect this GitHub repository to a Node.js hosting service (for example Render) and use:
Build command: npm install
Start command: npm start
Environment variable: OPENAI_API_KEY=your key
Optional: SUMMARY_MODEL=gpt-6-luna

The host creates a meeting link. Participants join with camera/mic. The host browser records the mixed meeting audio for the summary flow. When the host clicks End & Summarize, the recording is uploaded to the server, transcribed, and summarized.

Production note: This MVP uses peer-to-peer WebRTC mesh with public STUN. For large or highly reliable meetings, add a TURN server or migrate media to an SFU.
