# Marco Polo — Expertise Sharing System for Blender
## CPSC-581-Assignment-2-Group-8

- **Novice** runs the Electron desktop app on Windows with Blender open
- **Expert** joins from any modern browser (Chrome recommended)
- Guidance arrives through sound and peripheral visuals so the novice keeps their eyes on their own screen

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Windows** | 10 or 11 | The overlay uses a Win32 API call to track the Blender window. macOS is not supported. |
| **Node.js** | 18 or later | [nodejs.org](https://nodejs.org) — install the LTS version |
| **Blender** | Any | [blender.org](https://www.blender.org) — must be running before you start a session |
| **A webcam** | — | Required on the novice machine for stuck detection |
| **Headphones** | — | Required on the novice machine for spatial audio guidance |
| **A Firebase project** | — | Free Spark plan is enough — see setup below |
| **An OpenAI API key** | — | Used for voice transcription and the Marco keyword detector |

---
## How to Run it

### 1 — Firebase Setup

The app uses Firebase Firestore only for WebRTC signalling (exchanging connection offers between novice and expert). It does not store any user data beyond the call session.

The Firebase information is included in the Dropbox submission. Copy them and create a new `.env` file in the next section.

### 2 — Installation

Clone or download the repo, then open a terminal in the project root.

```bash
# Install all dependencies (React, Electron, Vite, etc.)
npm install
```

---

### 3 — Environment Variables

Copy the example file and fill it in:

```bash
# Windows (Command Prompt)
copy .env.example .env

# Windows (PowerShell)
Copy-Item .env.example .env
```

Open `.env` in any text editor and fill in your values:

```env
VITE_FIREBASE_API_KEY="AIza..."
VITE_FIREBASE_AUTH_DOMAIN="your-project.firebaseapp.com"
VITE_FIREBASE_PROJECT_ID="your-project-id"
VITE_FIREBASE_STORAGE_BUCKET="your-project.appspot.com"
VITE_FIREBASE_MESSAGING_SENDER_ID="123456789"
VITE_FIREBASE_APP_ID="1:123456789:web:abc123"

VITE_OPENAI_API_KEY="sk-..."
```

> `.env` is already in `.gitignore` — it will never be committed.

---

### 4 — Running the App

For the novice, both the Vite dev server and the Electron window need to be running at the same time. The easiest way is:

```bash
npm run dev:all
```

Alternatively, run them in two separate terminals:

```bash
# Terminal 1
npm run dev

# Terminal 2
npm run electron
```

The **expert** would only need to run

```bash
npm run dev
```

---

## How to Use It

### Overview

```
Novice (Electron app)  ←── WebRTC ──→  Expert (browser)
       ↑                                      ↑
  Overlay sits above Blender         Watches novice screen,
  Ghost cursor appears here          places sticky notes
```

---

### Step-by-step: Starting a Session

#### On the Novice machine (Electron app)

1. **Open Blender first.** The overlay tracks Blender's window position — it needs to be running before you share the screen.

2. In the Marco Polo app, click **1. Share My Screen (Novice)**.

3. A list of open windows appears. Click **Blender** (or whichever window you want to share).
   - The app starts capturing that window and shows a preview.

4. Click **2. Create Call (Novice)**.
   - A **Call ID** appears at the top of the log panel (e.g. `abc123xyz`).
   - Share this Call ID with the expert — paste it in a chat message, read it out loud, whatever.

5. Once the expert joins, the app transitions into overlay mode:
   - The Marco Polo window becomes invisible (opacity 0) and Blender comes to the front.
   - A transparent overlay now sits on top of Blender. You can keep working normally.

#### On the Expert machine (browser)

1. Open **Chrome** (or any Chromium browser) and navigate to:
   ```
   http://localhost:5173
   ```
   > If the novice and expert are on different machines, the expert needs to open the hosted URL or you need to expose the Vite dev server. For a local demo, both can run on the same machine.

2. Paste the Call ID into the **Enter Call ID** field and click **3. Join Call (Expert)**.

3. The novice's Blender screen appears as a live video stream.

---

### Novice Overlay Controls

Once in session, a minimal transparent overlay sits above Blender. Everything else is Blender, working normally.

| Element | Location | What it does |
|---|---|---|
| **Having Trouble? button** | Bottom-left corner | Appears when the stuck detector fires. Click to open the help request panel. |
| **Help panel** | Bottom-left | Type or record a voice message describing where you're stuck. Hit Send. |
| **Sticky note pins** | Wherever the expert placed them | Small orange dots on screen. Move your cursor near one to reveal it, then click to open the note player. |
| **Note player** | Floats near the note pin | Play/pause, rewind, dismiss. After the first full playthrough a feedback prompt appears. |
| **End Call button** | Bottom-right corner | Appears when the curosr hovers over it. Ends the session and returns to the main app window. |

#### The Marco Polo interaction

When the expert places a sticky note, a textbok appears saying *"Say Marco near a note."*

1. Move your cursor somewhere near where you think the note might be.
2. Say **"Marco"** out loud (mic must be on — it activates automatically when the session starts).
3. The system responds with a spatial audio ping ("Polo") from the direction of the note. The sound is louder and higher-pitched when your cursor is close; softer and lower when you're far away.
4. Keep saying "Marco" and moving your cursor until the sound centres and the note pin highlights.
5. Click the pin to open and play the expert's voice explanation.

> **Note:** There is a 1–2 second delay on Marco detection because audio is sent to the OpenAI Whisper API for transcription. This is a known limitation — see the section below.

---

### Expert Controls

#### Ghost cursor

Move your mouse over the novice's video stream and a red crosshair cursor appears on their screen in real time.

Use the **Cursor mode** toggle to switch between:
- 🌐 **World Space** — you're pointing at something in the 3D viewport (geometry, objects)
- 🖥 **UI Element** — you're pointing at a menu, button, or panel in Blender's interface

#### Placing a sticky note

1. Click **📌 Drop Note**. The video gets a dashed orange border and the cursor becomes a crosshair.
2. Click anywhere on the video to mark the target position. A note composer panel appears.
3. Type your explanation in the text field, and/or click **🎙 Record Voice Note** to record audio.
4. Click **✓ Place Note**. The note appears on the novice's overlay at that position.

#### Feedback from novice

After the novice plays your note, they can stamp it:
- ✅ Worked! 
- 😕 Still confused
- 🎤 Re-record my question

The response appears in your log panel.

#### Dismissed notes history

A collapsible **📋 Dismissed Notes** panel appears once the novice dismisses any notes, so you can track what guidance has been acknowledged.

---

## 6 — Known Limitations

**Marco Polo detection delay (1–3 seconds)**  
Voice is sent to the OpenAI Whisper API in 2-second segments, so there is inherent latency. It works best if you say "Marco" clearly and wait a moment before moving your cursor. Sometimes it doesn't even fire at all.

**Windows only**  
The overlay tracks the Blender window using a PowerShell Win32 API call. This is not implemented for macOS or Linux.

**Stuck detection is face-only**  
The Teachable Machine model detects a "stuck" facial expression via webcam. The original plan included cursor idle time and undo counts as additional signals, but only face tracking was implemented. The threshold (75% confidence) can cause occasional false positives.

**Edge glow for UI Element mode is not implemented**  
When the expert tags a position as a UI Element, the World Space audio ping is suppressed but no screen-edge visual glow appears yet. The tag is transmitted but not acted on visually.

**Sonar rings are inconsistent**  
The concentric ring animation that should pulse from the note pin when the cursor is very close does not appear reliably after the note player panel has been opened and closed.

**Firebase rules expire**  
The test-mode Firestore rules in `firestore.rules` expire on **April 5, 2026**. After that date, all reads and writes will be denied. Update the expiry date and redeploy with `firebase deploy --only firestore:rules` if you need to run the app after that.

---

## Project Structure

```
├── electron/
│   ├── main.js          — Electron main process: windows, IPC, cursor polling
│   ├── preload.js       — Exposes safe IPC bridge to renderer
│   └── overlay.html     — Transparent overlay window (vanilla JS, not React)
├── src/
│   ├── components/
│   │   └── VideoCall.jsx — Main UI: WebRTC, note composer, Marco detection
│   ├── hooks/
│   │   └── useStuckDetector.js — Teachable Machine webcam loop
│   ├── App.jsx
│   └── main.jsx
├── firebase.config.js   — Firestore initialisation (reads from .env)
├── .env.example         — Template — copy to .env and fill in
└── vite.config.js
```
