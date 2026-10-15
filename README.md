# MeetMind AI — MVP

A browser-based meeting MVP with shareable rooms, audio/video controls, screen sharing (via LiveKit UI), and automatic AI meeting summaries when the host ends the meeting.

## Core flow

1. Host creates a meeting and receives a shareable URL.
2. Participants join in the browser.
3. LiveKit handles realtime audio/video.
4. The host browser creates an audio mix of subscribed meeting audio tracks and records it.
5. When the host clicks **End & Summarize**, the audio is uploaded to the server.
6. OpenAI transcription converts speech to text.
7. The transcript is summarized into overview, key points, decisions, action items, and follow-ups.

## Setup

Requirements: Node.js 20+.

### 1. Install

```bash
npm install
npm run install:all
```

### 2. Environment files

Copy:

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
```

Fill in your LiveKit Cloud credentials and OpenAI API key in `server/.env`.

### 3. Run

```bash
npm run dev
```

Frontend: http://localhost:5173
Backend: http://localhost:8787

## Important MVP note

The current MVP records the mixed meeting audio in the host's browser. This is suitable for prototyping and small meetings. For production reliability (host closes the tab, large meetings, server-side recording), replace browser recording with LiveKit Egress/server-side recording and process the completed recording from a webhook.

Always show participants a clear recording/transcription notice and obtain any consent required in your jurisdiction or organization.
