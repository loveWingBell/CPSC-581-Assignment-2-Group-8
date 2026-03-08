(rn it's just a todo list, will be changed when everything is applied)
# DONE

### Phase 1 — Get Two Screens Talking (WebRTC)
### Phase 2 — Canvas Overlay
### Phase 3 — Stuck Detection (kinda, only detects face and not undo or mouse)
### Phase 4 — Voice + Queue (still need to check queue + make it so the text can be edited)
### Phase 5 — Marco-Polo (only humming right now)

# WIP

### Phase 6 — Sticky Notes + Playback
- A sticky note is just a Canvas element anchored to `{x, y}` coordinates (screen space for UI elements, or a stored position for 3D space).
- For 3D space anchoring, the simplest approach: when the expert drops the note, store the `{x, y}` as a percentage of the viewport dimensions so it scales if the window resizes.
- Playback is just re-running the recorded stream of `{x, y, timestamp}` cursor events through the canvas at the original speed, with the expert's voice audio playing simultaneously.


# WHAT'S LEFT

### Phase 7 — Novice Stamp
- After playback ends, show three buttons: "Worked," "Still confused," + mic for re-recording.
- Send the response back through the data channel or write it to Firestore.

# BASIC ALGORITHM OVERVIEW
**1. Smarter Stuck Detection**
Instead of eye/mouse tracking alone, require multiple signals before triggering: idle cursor for X seconds + repeated undo actions + time-on-task exceeding a threshold. A small, unobtrusive pulsing icon appears in the corner of the viewport — no interruption, no modal. The novice chooses to engage it when ready.

**2. Novice Initiates on Their Terms**
Novice clicks the ambient indicator. A minimal overlay appears: a mic button and a text field. They describe their problem via voice or type. If voice, a transcription preview appears immediately so they can correct Blender-specific vocabulary ("subdivision surface," "UV unwrap") before sending.

**3. Request Enters the Queue**
The confirmed request is sent to the expert's system. If no expert is live, it enters an async queue — other novices who solved a similar problem can also respond, building a community knowledge layer over time. The novice sees a "your request was sent" ambient indicator and can keep working.

**4. Expert Responds with an Expressive Ghost Cursor**
The expert records their guidance inside their own Blender viewport. Their cursor isn't just a pointer — it can hesitate, circle an area ambiguously, or tap rapidly on a target to say *this one, here.* The cursor carries nonverbal weight. The expert layers a voice note on top. Crucially, every cursor position during recording is automatically tagged as either `world_space` or `ui_element` — so the system always knows whether the expert is pointing at something in the 3D scene or at a button, menu, or panel in Blender's flat UI.

**5. Novice Receives the Note + Begins Marco-Polo**
A soft chime signals the note has arrived. The novice says **"Marco"** — the system responds **"Polo"**, but *how* depends on where the note is anchored:

- If the target is in **3D world space**, Polo uses spatial audio, directionally anchored to the note's position in the viewport. A continuous ambient hum runs between responses, shifting in pitch as the novice moves their cursor — closer raises the tone, further lowers it. As they get closer, haptic feedback on the touchpad begins to pulse softly. When nearly there, sonar-ring animations radiate outward from the target area in world space.

- If the target is a **UI element** — a button, menu, or panel — spatial audio breaks down and the metaphor shifts. Instead, a directional glow bleeds in from the edge of the viewport pointing toward the relevant panel, with the ambient hum replaced by a screen-edge pulse that intensifies as the novice's cursor moves toward the correct region of the interface. Navigation becomes visual rather than auditory, which is more appropriate for flat UI space.

**6. The Arrival Ritual**
When the novice reaches the target, the experience closes with a small physical beat — but again adapted to context:

- In **3D space**, the sonar pulses converge inward, the cursor settles, and a soft chime plays.
- On a **UI element**, sonar rings radiate outward from the button or menu item itself in screen space, like a ripple on still water, followed by the same soft chime.

Same emotional moment, appropriate to the surface.

**7. The Sticky Note Deploys**
The note appears anchored to whatever the expert tagged — again in one of two modes:

- In **3D space**, it behaves like a physical post-it in the scene, rotating subtly with the camera and maintaining spatial context relative to the object it refers to.
- On a **UI element**, it pins directly to that button or panel like a tooltip, following it if the user resizes or rearranges the interface.

A single note can transition between both modes mid-playback — guiding the novice to a menu first, then back into the viewport, with the anchoring switching automatically based on the recorded tags.

The novice can:
- **Play it** — expert voice plays, expert ghost cursor replays their recorded movement expressively through whichever space it was recorded in
- **Cancel it** — dismiss without playing

**8. Novice Leaves a Stamp**
After the guidance plays, the novice can leave a short voice or button response: *"This worked," "Still confused here,"* or a quick re-recording of where they're still stuck. This closes the empathy loop for the expert and builds a corpus of what guidance actually lands.

**9. Resume**
The note fades, the ambient indicator returns to idle, and the novice continues their work with no forced context switch.
