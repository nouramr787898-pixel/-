AI Meeting - Dark Simple v3
===========================
Files are intentionally flat (no folders).

Changes in v3:
- Simple black interface with clear white text.
- Clear Copy Meeting Link button.
- Host approval/rejection before a guest enters.
- Participant list with mic/camera state.
- Improved WebRTC negotiation and ICE candidate handling.
- STUN + demo TURN fallback to improve audio/video connectivity across different networks.
- If the browser blocks remote audio autoplay, a clear "تشغيل الصوت" button appears on the participant tile.
- AI transcription and summary after host ends the meeting.

Deploy:
1) Upload all files to the root of your GitHub repository.
2) Railway auto-deploys after the commit.
3) Keep OPENAI_API_KEY in Railway Variables, never in GitHub.

Production note:
The included TURN fallback is intended for MVP/testing. For a production service, use your own managed TURN/SFU (for example LiveKit Cloud) for reliability and scale.
