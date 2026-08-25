# Live TV Display

## Runtime flow

The TV remains subscribed to festival configuration, people, events and results. When TV Control is sent in Results sequence mode, it resolves the saved programme IDs into an in-memory presentation queue in the saved order. This ensures the selected programmes—not every published result—are shown. Other display modes leave the result queue inactive.

Each queued result runs through a full-screen scene sequence: a six-second programme-name and details introduction, Third–Second–First position reveals, then a final podium with Second on the left, First in the centre and Third on the right. Every selected result runs through this sequence in order, then the display returns directly to its normal dashboard. A small badge reports the current result number and batch size.

Dashboard HTML is updated only when its content hash changes and no live scene is active. This avoids the old five-second complete-grid repaint. The clock updates independently, while a self-adjusting media timer rotates announcements, uploaded photo slides and muted playlist video URLs.

## Admin controls

TV Display Settings controls the live title and ticker, multi-line announcements, and the result interruption policy. Programme, winner reveal, final podium and media holds use fixed readable defaults, so operators do not need to configure seconds for individual scenes. `Immediate` starts the selected queue at once, while `After current media` waits for the default media interval. A results sequence plays only the programmes selected in TV Control and in the selected order; Video only, Media wall and Dashboard auto do not start a result queue.

Administrators can continue to control background colour/image/video and independently enable Results, Leaderboard, Announcements and Media. Photo uploads and a list of video URLs form the rotating media playlist.

## Remaining production enhancements

The implemented queue is local to each open TV browser. A durable server-managed queue, remote pause/next/replay commands, per-display profiles, heartbeat/online monitoring, resumable video uploads, scheduled playlist windows and cross-TV acknowledgement would require dedicated Firestore collections and an authenticated TV-device model. They are not required for the current single-display live-result workflow, but are the recommended next phase for multiple independently controlled screens.

## YouTube and Shorts playback

Both the full-screen background video field and rotating playlist accept direct MP4/WebM URLs, standard YouTube watch URLs, `youtu.be` share URLs, YouTube Shorts URLs, existing embed URLs and YouTube live URLs. YouTube sources are normalized to privacy-compatible embed playback parameters with autoplay, mute, inline playback and—on the background—looping. The TV switches cleanly between its native `<video>` element and a dedicated non-interactive YouTube background iframe without resetting the active source on every Firestore render. Playlist YouTube/Shorts items use an iframe scene; direct files continue to use native video.

For the requested single-screen deployment, the live queue, sequential winner reveal, final team count-up, announcements, photo/video rotation, direct video and YouTube/Shorts playback now cover the functional TV scope. The only operational dependency is that the YouTube owner must allow embedding and the display device/network must permit YouTube; browser autoplay is handled by always starting embedded playback muted.

## Settings refresh and manual video control

The Admin refresh issue was a form-hydration exception: `publicLines()` already returns a newline-delimited string, but announcements and playlist videos called `.join()` on that string. Rendering stopped at that point even though Firestore had saved the configuration and the TV could read it. The extra `.join()` calls are removed, so every TV field is restored after refresh.

`Play Videos` is the single manual master switch for both the background video and playlist videos. Turning it off removes/pauses native and YouTube sources while photos and announcements can continue. A newly published result always calls the video suspension routine before its reveal scene; after the complete result batch and team-points animation, the normal dashboard render resumes videos only when the switch remains on.
