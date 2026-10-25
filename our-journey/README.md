# Our Journey 💕

A private photo & video slideshow app for iPhone that tells the story of us.
It's a web app you add to the Home Screen: it opens full-screen like a normal app
and works offline. You don't need the App Store, a Mac or Xcode.

## What it does

- **Play our story**: a full-screen slideshow with slow pan and zoom on photos and crossfades.
  Videos play inside it, a title card opens each year ("2021 · Our 3rd year"),
  and the show ends on a "days together" card.
- **Background music**: pick a song file. The music pauses while a video with sound plays.
- **Timeline** grouped by year, with "1st year together", "2nd year together" and so on.
- **Days-together counter** since the day it all began.
- **On this day**: shows a memory from this date in an earlier year.
- **Captions, favorites, editable dates**: tap any photo. "Play from here" starts the show at that photo.
- The capture date is read from each photo and video automatically, so they line up in order.
- **Private**: everything you add stays on the phone. Nothing is uploaded.

Slideshow gestures: swipe left or right to go to the next or previous slide, tap to show the controls,
swipe down to close.

## Put it on her iPhone

The app needs to be hosted on an HTTPS address once. Any free static host works:

1. **Netlify Drop** (easiest): go to <https://app.netlify.com/drop> and drag the `our-journey`
   folder onto the page. You get a link like `https://something.netlify.app`.
   *(Alternatives: GitHub Pages, Cloudflare Pages, Vercel.)*
2. On her iPhone, open that link in **Safari**.
3. Tap **Share → Add to Home Screen → Add**.
4. Open **Our Journey** from the Home Screen, then tap **Add** to pick photos and videos, and
   **Settings** to enter your names and the day you met.

> Add photos from the Home Screen app, not from a Safari tab. iOS keeps storage for
> Home Screen apps but may clear a website's storage after a few weeks without visits.

## Optional: preload memories as a surprise

To have the app already full of memories when she opens it:

1. Create a `media/` folder inside `our-journey/` and put photos and videos in it.
2. Copy `memories.example.json` to `memories.json` and list each file with its date and caption.
3. Upload the folder again.

⚠️ Files you upload this way are **reachable by anyone who has the link**. Use a hard-to-guess
site name, and don't commit personal photos to a public GitHub repo. The Add button
(on-device storage) is the most private option.

## Tips

- Music: iOS lets you choose files from the **Files** app only. Songs from Apple Music are protected
  and can't be selected, so save an MP3 or M4A to Files first.
- Keep a backup: your originals stay in the Photos app. This app holds its own copy.
- Test locally: `python3 -m http.server` in this folder, then open <http://localhost:8000>.
