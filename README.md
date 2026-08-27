# Facebook Comment Explorer

**A bookmarklet that expands every comment and reply on a Facebook post, then lets you actually search them.**

Facebook shows about ten comments at a time, hides replies behind *"View 4 replies"*, and truncates
long ones behind *"See more"*. So <kbd>Ctrl</kbd>+<kbd>F</kbd> searches the handful you can see and
misses the several hundred you can't. This loads all of them, then opens a panel with search, thread
filtering, sorting and CSV/JSON export.

### ➡️ [Install it — drag the button to your bookmarks bar](https://roeibh.github.io/facebook-comment-explorer/)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![No dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)
![Single file](https://img.shields.io/badge/build-single%20file-blue)

![The Comment Explorer panel open beside a Facebook post, searching for the word "friday" with matches highlighted](https://roeibh.github.io/facebook-comment-explorer/screenshot.png)

## What it does

- **Loads everything.** Switches the sort to *All comments* (the default *Most relevant* silently
  hides some), keeps the comment list scrolling so Facebook streams the rest in, and clicks every
  reply expander and *See more* until nothing new arrives.
- **Search that works.** `"quoted phrase"`, `-exclude` and `@author`, with matches highlighted.
  Any language, including right-to-left text.
- **Whole threads.** Replies are nested under the correct parent, up to three levels deep. Click
  *"4 replies"* to read one conversation on its own.
- **Jump to a comment.** Click a result and the real comment scrolls into view and flashes, so you
  can reply or react.
- **Export.** JSON, CSV or plain text — of the *filtered* set, so you can search and export only
  the matches.
- **Sort** by page order, newest, oldest, most reactions, or longest.

Roughly 10 comments a second; a 450-comment post takes about 40 seconds.

## Install

1. Open the [install page](https://roeibh.github.io/facebook-comment-explorer/) and drag the button
   to your bookmarks bar.
2. Or make a bookmark manually and paste the contents of
   [bookmarklet.txt](https://roeibh.github.io/facebook-comment-explorer/bookmarklet.txt)
   as its URL.

Bookmarks bar hidden? <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>
(<kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> on macOS).

Tested in desktop Chrome. Other desktop Chromium browsers should work; Firefox and Safari remain
unverified. Mobile browsers are unsupported because running a bookmarklet on facebook.com is
impractical on iOS and Android.

## Use

Open any Facebook post — group, Page or profile — and click the bookmark. Clicking it again toggles
the panel.

| Type this | To find |
|---|---|
| `pizza friday` | comments containing both words, in any order |
| `"pizza friday"` | that exact phrase |
| `pizza -friday` | pizza, but not where friday also appears |
| `@sarah` | only comments by someone whose name contains "sarah" |
| `@sarah pizza` | comments by Sarah that mention pizza |

<kbd>/</kbd> focuses the search box. <kbd>Esc</kbd> steps out of a thread or clears the search
before it closes the panel. Drag the panel's left edge to resize it.

Each exported comment carries its id, author and profile URL, text, timestamp, reaction count,
whether it is a reply, who it replied to, and a permalink. CSV is UTF-8 with a BOM so non-Latin
text opens correctly in Excel.

## How it works

Facebook's comment UI is more hostile than it looks. The notes below are the things that actually
cost time — worth reading before you fork this.

**Comments lazy-load on an inner scroll container, not the window.** `window.scrollTo` does
nothing. You have to find the scrollable ancestor of the comment list and pin it to the bottom;
comments then stream in at roughly ten a second.

**There are two hidden copies of every comment in the DOM.** The duplicate has zero width and
height, so everything is filtered on visibility and deduped by id. Worse, walking up from the
*first* `[role="article"]` in document order often lands you inside the hidden copy, whose
ancestors are the wrong scroll container — which looks exactly like "Facebook stopped sending
comments".

**Comment ids come in two incompatible flavours.** Group posts use numeric ids and put a reply's
own id in `reply_comment_id`, with `comment_id` pointing at the *thread root* — so keying on
`comment_id` silently collapses every reply into its parent. Profile and Page posts use a base64
blob (`comment:<post>_<comment>`) that is already unique per reply, with no `reply_comment_id`
at all.

**`comment_id` appears on several links per comment** — the avatar, the author and the timestamp.
Only the timestamp one is the comment's permalink; on profile posts the first two point at the
commenter's profile.

**Nesting is not in the markup.** Depth is conveyed by avatar indentation. Deriving the top-level
baseline from the *most common* indentation breaks as soon as a few large threads are expanded and
replies outnumber their parents. The reliable signal is `aria-label`, which reads
`"Reply by X to Y's comment"` on both layouts; indentation is only needed to distinguish a reply
from a reply-to-a-reply, since Facebook renders the third level at a single indent.

**Facebook paces the comment stream** and throttles a session that has pulled a lot recently. The
panel reports what it actually got against the post's own counter — "Loaded 84 of ~470" — and the
↻ button resumes rather than starting over.

## Privacy

Everything runs in your browser, on a page you already have open and are already logged into. No
server, no analytics, no account, nothing uploaded. Exports are generated locally by your browser.
The whole tool is one readable file: [`src/fb-comment-explorer.js`](src/fb-comment-explorer.js).

A bookmarklet has no background process and no permissions — nothing runs until you click it.

## Development

```bash
npm install
npm run build     # minifies src/ into dist/ and injects it into docs/index.html
```

`src/fb-comment-explorer.js` is the only source file. `build.mjs` minifies it, percent-encodes it
into a `javascript:` URL, and writes `dist/bookmarklet.txt` plus the install page. Nothing generated
is committed &mdash; the Pages workflow rebuilds the site, the bookmarklet and the images on every
push, so they can never go stale.

Facebook changes its markup regularly. If it stops working, [open an
issue](https://github.com/roeibh/facebook-comment-explorer/issues) saying whether the post was a
group, Page or profile post — the two layouts fail differently.

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with, endorsed by, or connected to Meta Platforms, Inc. "Facebook" is a trademark of
Meta Platforms, Inc.
