# Project 8

A website + app counterpart that allows for experts to share
their knowledge of CAD tools to novices through an interactive sharing platform.

## Features

- **Screen share** to allow for the novice to share their screen with the expert
-  **Video call** creates an environment that is "personal" reflecting one-on-one tutoring
-  **Sticky notes** allows for the expert to share their thoughts through sticky notes that are stored on a seperate canvas for later viewing. A voice over of the expert plays as well as their ghost cursor providing direct feedback and support to the novice.
-  **Ghost cursor** creates a trail of the expert's mouse to help guide the novice
-  **Confusion detection** tracks the facial expressions of the novice to determine if a user is stuck on a certain problem or not
-  **Audio recognition** to "play" the Marco Polo game to find the right tool or functionality needed to fix the problem
-  **Spatial audio** to enhance the Marco Polo experience 
## Project Structure

- [electron/overlay.html](electron/overlay.html) — Main UI composition and functionality. 
- [electron/main.js](electron/main.js) — Main set up of electron.
- [electron/preload.js](electron/preload.js) — Bridge between the html and main electron.
- [src/components/VideoCall.jsx](src/components/VideoCall.jsx) — Video call functionality set up.
- [src/index.css](src/index.css) — Tailwind entry point.

## Getting Started

### 1) Install dependencies

```
npm install
```

### 2) Run the project (expert side)

```
npm run dev
```

Then open the URL shown in your terminal (usually http://localhost:5173).

### 1) Install dependencies

```
npm install
```

### 2) Run the project (novice side)

```
npm run electron
```

