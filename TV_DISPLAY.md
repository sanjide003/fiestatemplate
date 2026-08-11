# Live TV Display

## Runtime flow

The TV remains subscribed to festival configuration, people, events and results. Its result listener now detects only newly published result documents after the initial snapshot and adds them to an in-memory presentation queue. Results published together are absorbed into the active batch instead of rebuilding or flashing the entire dashboard.

Each queued result runs through a full-screen scene sequence: publication intro, reverse-order position reveals, winner/team names and awarded points. After every result in the batch has been shown, the previous team totals animate to the new totals and the ranked leaderboard remains on screen for the configured hold period. The display then returns to its normal dashboard. A small badge reports the current result number and batch size.

Dashboard HTML is updated only when its content hash changes and no live scene is active. This avoids the old five-second complete-grid repaint. The clock updates independently, while a self-adjusting media timer rotates announcements, uploaded photo slides and muted playlist video URLs.

## Admin controls

TV Display Settings controls the live title and ticker; multi-line announcements; result hold, winner reveal, leaderboard hold and media rotation durations; and the result interruption policy. `Immediate` starts a fresh queue at once, while `After current media` waits for the configured media interval. Results arriving while a sequence is running join that same batch before the final team-points animation.

Administrators can continue to control background colour/image/video and independently enable Results, Leaderboard, Announcements and Media. Photo uploads and a list of video URLs form the rotating media playlist.

## Remaining production enhancements

The implemented queue is local to each open TV browser. A durable server-managed queue, remote pause/next/replay commands, per-display profiles, heartbeat/online monitoring, resumable video uploads, scheduled playlist windows and cross-TV acknowledgement would require dedicated Firestore collections and an authenticated TV-device model. They are not required for the current single-display live-result workflow, but are the recommended next phase for multiple independently controlled screens.

## YouTube and Shorts playback

Both the full-screen background video field and rotating playlist accept direct MP4/WebM URLs, standard YouTube watch URLs, `youtu.be` share URLs, YouTube Shorts URLs, existing embed URLs and YouTube live URLs. YouTube sources are normalized to privacy-compatible embed playback parameters with autoplay, mute, inline playback and—on the background—looping. The TV switches cleanly between its native `<video>` element and a dedicated non-interactive YouTube background iframe without resetting the active source on every Firestore render. Playlist YouTube/Shorts items use an iframe scene; direct files continue to use native video.

For the requested single-screen deployment, the live queue, sequential winner reveal, final team count-up, announcements, photo/video rotation, direct video and YouTube/Shorts playback now cover the functional TV scope. The only operational dependency is that the YouTube owner must allow embedding and the display device/network must permit YouTube; browser autoplay is handled by always starting embedded playback muted.

## Settings refresh and manual video control

The Admin refresh issue was a form-hydration exception: `publicLines()` already returns a newline-delimited string, but announcements and playlist videos called `.join()` on that string. Rendering stopped at that point even though Firestore had saved the configuration and the TV could read it. The extra `.join()` calls are removed, so every TV field is restored after refresh.

`Play Videos` is the single manual master switch for both the background video and playlist videos. Turning it off removes/pauses native and YouTube sources while photos and announcements can continue. A newly published result always calls the video suspension routine before its reveal scene; after the complete result batch and team-points animation, the normal dashboard render resumes videos only when the switch remains on.
