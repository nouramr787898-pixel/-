AI Meeting Platform - Dark v4

Changes in this version:
- Participants panel now has an X close button.
- A clear Participants button reopens the panel at any time.
- Fixed WebRTC offer collision: only existing participants initiate to a newly approved participant.
- Improved remote audio/video playback and connection status display.
- Added ICE restart/renegotiation when a peer connection fails.
- Improved microphone constraints (echo cancellation, noise suppression, auto gain control).
- Join approval/rejection, link sharing, participant list and AI summary remain enabled.

Deployment:
Upload all files in this folder to the ROOT of the same GitHub repository and commit.
Railway should redeploy automatically.
Keep OPENAI_API_KEY only in Railway Variables, never in GitHub.

Important production note:
WebRTC across different mobile/Wi-Fi networks requires a reliable TURN service. The project includes public STUN/TURN fallback for testing, but for dependable production calls you should configure a private TURN service or LiveKit/Twilio/Cloudflare Calls.
