# CourseDeck Lite (iPad PWA Guide)

CourseDeck Lite is an offline-first Progressive Web App (PWA) designed to run on tablets (especially iPads) and mobile browsers. It pairs with your main desktop CourseDeck installation to let you read lessons, study formulas, take notes, and run AI prompts anywhere—even when completely disconnected from your computer and Wi-Fi.

---

## 1. How It Works

CourseDeck follows a **Hub & Satellite** architecture:

```
┌─────────────────────────────────┐                 ┌─────────────────────────────────┐
│     Desktop (Mac / Windows)     │                 │        iPad (Safari PWA)        │
│       The "Authoring Hub"       │                 │        The "Study Deck"         │
├─────────────────────────────────┤                 ├─────────────────────────────────┤
│ • Ingestion of MHTML/PDF/ZIP    │                 │ • 100% Offline Reading          │
│ • Local file storage & backups  │  Local Wi-Fi    │ • Local IndexedDB Cache         │
│ • Course structure & formatting │ ──────────────> │ • Full-screen PWA interface     │
│ • Server on port 3182           │ <────────────── │ • Touch & math rendering (KaTeX)│
└─────────────────────────────────┘   Manual Push   │ • Notes & bookmarks sync        │
                                                    │ • Direct client-side AI         │
                                                    └─────────────────────────────────┘
```

1. **Desktop is the Authoring Hub:** All heavy course ingestion, document generation, and file management happen on your computer.
2. **iPad is the Study Deck:** You pull your courses onto the iPad once over local Wi-Fi. From then on, the iPad stores all lesson texts, summaries, cheatsheets, and tests in local browser storage (`IndexedDB`).
3. **Manual Two-Way Sync:** Any notes, bookmarks, or reading positions you record on your iPad can be pushed back to your computer with a single tap whenever you're back on your home network.

---

## 2. First-Time Setup (2 Steps)

### Step 1: Open the PWA on your iPad
1. On your computer CourseDeck app, click the **Tablet icon** in the top header (or navigate to **Settings → General → Connect iPad**).
2. Point your iPad camera at the **QR Code** (or navigate to `https://mindflowgo.github.io/coursedeck/` in Safari).
3. In iPad Safari, tap the **Share** button &rarr; **Add to Home Screen**.
4. Launch **CourseDeck** from your iPad Home Screen.

### Step 2: Download & AirDrop Your Study Bundle
1. In the Mac app's Tablet modal, click **Download Study Bundle (.json)**.
2. Right-click the downloaded `coursedeck-bundle.json` and select **Share → AirDrop → your iPad** (or save to iCloud Drive).
3. On your iPad, tap **Import Study Bundle (.json)** and select the file.
4. All your courses, lessons, cheatsheets, and prompts are loaded into local iPad storage (`IndexedDB`) and work 100% offline.

---

## 3. Install as a Native Full-Screen App (PWA)

To make CourseDeck feel like a native app and enable seamless offline launching:

1. In iPad Safari, tap the **Share** button (the square icon with an upward-pointing arrow at the top right of Safari).
2. Scroll down the share sheet and tap **Add to Home Screen**.
3. Confirm the name ("CourseDeck") and tap **Add**.
4. A CourseDeck icon will appear on your iPad home screen.

Opening the app from your home screen gives you:
- **Zero URL Bar:** Full-screen experience without Safari's tabs or navigation bar.
- **Instant Launch:** The Service Worker loads the app shell in milliseconds, even in Airplane Mode.
- **iPad Multitasking:** Supports Split View and Slide Over alongside note-taking apps.

---

## 4. Studying Offline

Once your courses are downloaded, you can disconnect from Wi-Fi or go into Airplane Mode:

- **Browse Units & Lessons:** All course manifests, units, and lesson texts are saved locally.
- **Math & Diagram Rendering:** KaTeX math equations, syntax highlighting, and formatting work completely offline.
- **Summaries & Cheatsheets:** All generated tabs present on your desktop at the time of sync are available immediately.
- **Reading Position Tracking:** As you scroll, your reading position is saved locally so you can pick up where you left off.

---

## 5. Taking Notes & Syncing Back to Desktop

When studying on your iPad, you can create checkpoint notes, bookmarks, and highlight sections:

1. **Creating Checkpoint Notes:** Tap anywhere in the text or scroll area to leave a post-it style note or bookmark.
2. **Local Storage:** These changes are immediately saved to your iPad's local database and added to your **Pending Push** queue.
3. **The Sync Indicator:**
   - When you are offline, the header displays `Offline` and shows `N pending push`.
   - When you reconnect to your home Wi-Fi and your computer is awake, the header pill automatically turns green (`Mac Connected`).
4. **Pushing Changes Back:**
   - Tap the orange **↑ Push (N)** button in the header.
   - Your notes and reading positions are sent to your computer and saved directly to your desktop files (`checkpoint.json`).
5. **Re-Syncing from Desktop:**
   - If you added new courses or generated new tabs on your computer, tap **↓ Sync** in the header.
   - *Safety Guard:* If you have unpushed changes on your iPad, CourseDeck will prompt you to push your changes first so you don't accidentally overwrite your notes.

---

## 6. Offline AI Generation

If you checked **"Include AI settings & keys"** during the initial sync:

- Your active AI provider URL and API key (e.g. OpenAI, Google Gemini, OpenRouter) are stored securely in your iPad's local browser storage.
- When running an AI prompt, pop quiz, or study question on your iPad:
  - If connected to your Mac, the request proxies through your desktop server as usual.
  - If disconnected or on the go, your iPad uses standard browser `fetch()` to communicate **directly with the AI provider**.
  - All responses are saved to your iPad's local storage.

---

## 7. Troubleshooting & FAQ

### Safari says "Server cannot be found" or times out
- Verify both devices are on the exact same Wi-Fi network (ensure one is not on a "Guest" network that isolates clients).
- If the `.local` Bonjour address fails, try using the direct IP address (e.g. `http://192.168.1.50:3182`).
- Check if your Mac's firewall is blocking incoming connections on port `3182`.

### Does clearing Safari browser history delete my courses?
- Clearing Safari's website data for CourseDeck *will* remove the local IndexedDB cache.
- If this happens, simply reconnect to your desktop Wi-Fi, open the site, and tap **Download Courses** again.

### Can I ingest new courses (upload ZIP/MHTML) on the iPad?
- No. Ingestion, MHTML unpacking, and table repairs require Bun/Node file operations and remain desktop-only. Ingest new courses on your computer first, then tap **↓ Sync** on your iPad.

---

## 8. Technical File Reference

- **Server Configuration:** [`server/index.ts`](file:///Users/fil/Code/ilc-study-tool/server/index.ts) (LAN binding & CORS)
- **Sync Endpoints:** [`app/src/lib/server/api.ts`](file:///Users/fil/Code/ilc-study-tool/app/src/lib/server/api.ts) (`/api/sync/bundle`, `/api/sync/push`, `/api/pairing/info`)
- **IndexedDB Storage:** [`app/src/lib/storage/clientStore.ts`](file:///Users/fil/Code/ilc-study-tool/app/src/lib/storage/clientStore.ts)
- **Reactive Sync Store:** [`app/src/lib/syncState.svelte.ts`](file:///Users/fil/Code/ilc-study-tool/app/src/lib/syncState.svelte.ts)
- **Direct Client AI:** [`app/src/lib/llmClient.ts`](file:///Users/fil/Code/ilc-study-tool/app/src/lib/llmClient.ts)
- **Service Worker & Manifest:** [`app/static/sw.js`](file:///Users/fil/Code/ilc-study-tool/app/static/sw.js), [`app/static/manifest.json`](file:///Users/fil/Code/ilc-study-tool/app/static/manifest.json)
