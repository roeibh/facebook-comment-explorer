/*! FB Comment Explorer - expand every comment & reply on a Facebook post, then search them. */
/*
  INSTALL
    Bookmarks bar -> right-click -> Add page...
    Name: FB Comments      URL: paste the contents of dist/bookmarklet.txt
    (Chrome hides the bookmarks bar by default: Ctrl/Cmd+Shift+B)

    Easier: https://roeibh.github.io/facebook-comment-explorer/ has a button you
    can drag straight onto the bookmarks bar.

  USE
    Open any Facebook post (permalink, group post, or the post opened in its modal)
    and click the bookmarklet. It will:
      1. switch the comment sort to "All comments" (the default "Most relevant" hides some)
      2. keep the comment list scrolled to the bottom so Facebook streams the rest in
      3. click every "View N replies" / "View more replies" / "See more"
      4. stop once nothing new has arrived for ~12 seconds, then open the search panel

    Roughly 10 comments/second; a 450-comment post takes about 40 seconds.
    "Stop" halts expansion early and keeps whatever has loaded.

    The status line shows progress against the post's own comment counter
    ("120 of ~469"). Facebook drip-feeds comments and throttles sessions that ask
    for a lot in a short window, so a run can stall short of the total; the script
    retries up to four times while each round still returns something. If it still
    finishes short it says so - press the circular arrow to pick up where it left
    off, or give it a minute and try again.

  PANEL
    type to search   space = AND, "quoted phrase", -exclude, @author
    click a row      scrolls to that comment on the page and flashes it
    "N replies"      filters to just that thread; the blue "back to All comments"
                     bar returns, as does clicking the same link again, or Esc
    highlight        outlines every match in the real page
    JSON / CSV       downloads the current (filtered) result set
    Copy text        current result set as indented plain text
    the circular arrow rescans (use after Facebook loads more on its own)
    Esc closes, / focuses the search box, drag the left edge to resize
    Clicking the bookmarklet again on the same page toggles the panel.

  NOTES
    Everything runs locally in your browser - nothing is uploaded anywhere.
    Comment text is read from the rendered page, so it captures exactly what
    Facebook showed you, including replies nested two levels deep.

    Works on both of Facebook's comment layouts. Group posts use numeric comment
    ids and put a reply's own id in reply_comment_id; profile/page posts use a
    base64 id and no reply_comment_id, and hang comment_id off the commenter's
    profile link as well as the timestamp. Nesting comes from the aria-label
    ("Reply by X to Y's comment") with avatar indentation only used for depth.
*/
(function () {
  'use strict';

  var NS = '__fbCommentExplorer__';
  if (window[NS]) { window[NS].toggle(); return; }

  /* ------------------------------------------------------------------ utils */
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var T = function (el) { return ((el && (el.innerText || el.textContent)) || '').trim(); };
  var vis = function (el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  var rxEsc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  var arr = function (x) { return Array.prototype.slice.call(x); };
  var mode = function (list) {
    var c = {}, best = null, n = -1;
    list.forEach(function (v) { c[v] = (c[v] || 0) + 1; if (c[v] > n) { n = c[v]; best = v; } });
    return best === null ? null : Number(best);
  };
  var num = function (s) {
    var m = String(s).replace(/,/g, '').match(/^([\d.]+)\s*([KkMm])?$/);
    if (!m) return 0;
    var v = parseFloat(m[1]);
    if (/k/i.test(m[2] || '')) v *= 1000;
    if (/m/i.test(m[2] || '')) v *= 1000000;
    return Math.round(v);
  };

  /* -------------------------------------------------------------- scrolling */
  // Facebook renders the post in an inner scroll container, not the window - AND it
  // keeps a hidden duplicate copy of the comment tree. Walking up from a hidden
  // article finds the wrong container, so always start from a VISIBLE one.
  function firstArticle(fromEnd) {
    var arts = document.querySelectorAll('div[role="article"][aria-label]');
    if (fromEnd) { for (var i = arts.length - 1; i >= 0; i--) if (vis(arts[i])) return arts[i]; }
    else { for (var j = 0; j < arts.length; j++) if (vis(arts[j])) return arts[j]; }
    return null;
  }

  function scroller() {
    var p = firstArticle(false);
    while (p && p !== document.body) {
      var cs = getComputedStyle(p);
      if (/auto|scroll/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 20) return p;
      p = p.parentElement;
    }
    return null;
  }
  function scrollPos() { var s = scroller(); return { el: s, y: s ? s.scrollTop : window.scrollY }; }
  function scrollTo(p) { if (p.el && p.el.isConnected) p.el.scrollTop = p.y; else window.scrollTo(0, p.y); }

  // Scrolling the last real comment into view moves whatever container actually
  // holds it - no ancestor guessing needed. The container nudge is a belt-and-braces
  // pass for the load sentinel that sits below the final comment.
  function toBottom() {
    var last = firstArticle(true);
    if (last) { try { last.scrollIntoView({ block: 'end' }); } catch (e) { last.scrollIntoView(false); } }
    var s = scroller();
    if (s) s.scrollTop = s.scrollHeight;
    else if (!last) window.scrollTo(0, document.documentElement.scrollHeight);
  }

  /* --------------------------------------------------------------- expander */
  var EXPAND = [
    /^view\s+(all\s+)?[\d,]+\s+repl(y|ies)$/i,
    /^view\s+more\s+repl(y|ies)$/i,
    /^view\s+[\d,]+\s+more\s+repl(y|ies)$/i,
    /^view\s+(more|previous)\s+comments$/i,
    /^view\s+[\d,]+\s+more\s+comments?$/i,
    /^[\d,]+\s+repl(y|ies)$/i,
    /^see\s+more$/i,
    /^show\s+more\s+comments$/i,
    /^הצג(ו|י)?\s+(את\s+)?(כל\s+)?[\d,]*\s*(ה)?(תגובות|תשובות)/,
    /^הצג(ו|י)?\s+(עוד|תגובות\s+קודמות)/,
    /^[\d,]+\s+(תגובות|תשובות)$/,
    /^(ראה|ראי|קרא|קראי)\s+עוד$/,
    /^הצג\s+עוד$/
  ];
  // Never click these - "More" is the ... options menu, the rest are actions.
  var SKIP = /^(more|like|reply|share|follow|edited|comment|see translation|translate|see less|hide)$/i;

  function expanders(clicked) {
    return arr(document.querySelectorAll('[role="button"]')).filter(function (b) {
      if (clicked.has(b)) return false;
      if (b.getAttribute('aria-haspopup')) return false;          // dropdown/menu triggers
      if (b.closest('[role="navigation"],[role="banner"],[role="complementary"]')) return false;
      var t = (b.textContent || '').replace(/\s+/g, ' ').trim();  // textContent: no layout flush
      if (!t || t.length > 60 || SKIP.test(t)) return false;
      if (!EXPAND.some(function (r) { return r.test(t); })) return false;
      return vis(b);
    });
  }

  // Every comment carries comment_id on several links: the avatar, the author, and
  // the timestamp. Only the timestamp one is the comment's permalink - on profile
  // posts the first two point at the COMMENTER'S PROFILE. Take the last link with a
  // usable label; that is the timestamp in both the group and profile layouts.
  function permalink(el) {
    var ls = el.querySelectorAll('a[href*="comment_id"]');
    if (!ls.length) return null;
    for (var i = ls.length - 1; i >= 0; i--) {
      var t = T(ls[i]);
      if (t && t.length <= 30) return ls[i];
    }
    return ls[ls.length - 1];
  }

  // Ids come in two flavours. Group posts: numeric, and a reply's OWN id is in
  // reply_comment_id while its comment_id is the thread root. Profile posts: a
  // base64 blob (comment:<post>_<comment>) that is already unique per reply, with
  // no reply_comment_id at all. Never assume digits, and never key on comment_id
  // alone - that collapses every reply in a group thread into its parent.
  function idsOf(link) {
    var id = null, root = null;
    try {
      var u = new URL(link.href);
      root = u.searchParams.get('comment_id');
      id = u.searchParams.get('reply_comment_id');
    } catch (e) {
      var a = link.href.match(/[?&]comment_id=([^&#]+)/);
      var b = link.href.match(/[?&]reply_comment_id=([^&#]+)/);
      root = a ? decodeURIComponent(a[1]) : null;
      id = b ? decodeURIComponent(b[1]) : null;
    }
    return { id: id || root, root: root };
  }

  function countComments() {
    var n = 0, seen = {};
    var arts = document.querySelectorAll('div[role="article"]');
    for (var i = 0; i < arts.length; i++) {
      if (!vis(arts[i])) continue;
      var l = permalink(arts[i]);
      if (!l) continue;
      var id = idsOf(l).id;
      if (id && !seen[id]) { seen[id] = 1; n++; }
    }
    return n;
  }

  // Switch the comment sort to "All comments" - the default "Most relevant"
  // silently hides a chunk of the thread.
  var SORT_LABEL = /^(most relevant|newest|all comments|top comments|הרלוונטיות ביותר|החדשות ביותר|כל התגובות)$/i;
  var SORT_ALL = /^(all comments|כל התגובות)$/i;
  async function sortAllComments() {
    var btn = arr(document.querySelectorAll('[role="button"]')).filter(function (b) {
      return vis(b) && SORT_LABEL.test(T(b));
    })[0];
    if (!btn) return 'no sort control';
    if (SORT_ALL.test(T(btn))) return 'already all comments';
    btn.click();
    await sleep(900);
    var item = arr(document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]'))
      .filter(function (m) { return SORT_ALL.test(T(m).split('\n')[0]); })[0];
    if (!item) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return 'sort menu item not found';
    }
    item.click();
    await sleep(2600);
    return 'sorted by all comments';
  }

  // The post's own comment counter, so we can tell "done" from "Facebook stopped sending".
  function postCommentCount() {
    var bs = document.querySelectorAll('[role="button"][aria-label]');
    for (var i = 0; i < bs.length; i++) {
      if (!/comment|תגוב/i.test(bs[i].getAttribute('aria-label') || '')) continue;
      var t = (bs[i].textContent || '').trim();
      if (/^[\d,.]+\s*[KkMm]?$/.test(t) && vis(bs[i])) return num(t);
    }
    return null;
  }

  // A spinner at or below the last comment means more is still on the way.
  function loading() {
    var last = firstArticle(true);
    if (!last) return false;
    var y = last.getBoundingClientRect().top;
    var ps = document.querySelectorAll('[role="progressbar"]');
    for (var i = 0; i < ps.length; i++) {
      if (vis(ps[i]) && ps[i].getBoundingClientRect().top >= y) return true;
    }
    return false;
  }

  async function expandAll(opts) {
    var onTick = opts.onTick || function () {};
    var stop = opts.stop || function () { return false; };
    var maxMs = opts.maxMs || 480000;
    var patience = opts.patience || 14;     // ~12s of total quiet before we call it done
    var quietCap = opts.quietCap || 40;     // a stuck spinner must not stall us forever
    var t0 = Date.now();
    var home = scrollPos();
    var clicked = new WeakSet();
    var idle = 0, pass = 0, clicks = 0, quiet = 0;

    if (opts.sortAll) {
      onTick({ phase: 'sort', pass: 0, clicks: 0, count: countComments() });
      await sortAllComments();
      await sleep(1500);
    }

    while (idle < patience && pass < 1200 && !stop() && Date.now() - t0 < maxMs) {
      var before = countComments();
      var btns = expanders(clicked);
      var did = 0;
      for (var i = 0; i < btns.length; i++) {
        if (stop()) break;
        clicked.add(btns[i]);
        try { btns[i].click(); clicks++; did++; } catch (e) {}
        if (did % 10 === 0) await sleep(120);
      }
      toBottom();
      await sleep(did ? 900 : 800);
      var after = countComments();
      // Only count a pass as idle when nothing was clicked and nothing arrived. A
      // spinner buys extra patience, but only up to quietCap passes.
      if (!did && after <= before) {
        quiet++;
        if (!loading() || quiet > quietCap) idle++;
      } else { idle = 0; quiet = 0; }
      pass++;
      onTick({ phase: 'expand', pass: pass, clicks: clicks, count: after, idle: idle, patience: patience });
    }
    scrollTo(home);
    return { clicks: clicks, count: countComments() };
  }

  /* -------------------------------------------------------------- extractor */
  function bodyText(el) {
    var c = arr(el.querySelectorAll('[dir="auto"]')).filter(function (d) {
      return !d.closest('a') && !d.closest('[role="button"]');
    });
    c = c.filter(function (d) {
      return !c.some(function (o) { return o !== d && o.contains(d); });
    });
    var t = c.map(function (d) { return d.innerText; }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (t) return t;
    var im = el.querySelector('img[alt]:not([alt=""]), image[alt]:not([alt=""])');
    var alt = im && im.getAttribute('alt');
    return alt ? '[' + alt.trim().slice(0, 120) + ']' : '[sticker / photo / GIF]';
  }

  function cleanUrl(href) {
    try {
      var u = new URL(href), keep = new URLSearchParams();
      ['comment_id', 'reply_comment_id'].forEach(function (k) {
        var v = u.searchParams.get(k);
        if (v) keep.set(k, v);                 // set() re-encodes base64 padding safely
      });
      var qs = keep.toString();
      return u.origin + u.pathname + (qs ? '?' + qs : '');
    } catch (e) { return href; }
  }

  var UNIT = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 };
  var SHORT = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 };
  function ageSeconds(aria, short) {
    var t = (aria || '').toLowerCase();
    if (/a few seconds ago|just now|לפני רגע/.test(t)) return 5;
    var m = t.match(/(?:about\s+)?(an?|[\d,]+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
    if (m) {
      var n = /^an?$/.test(m[1]) ? 1 : parseInt(m[1].replace(/,/g, ''), 10);
      return n * UNIT[m[2]];
    }
    var s = (short || '').trim().match(/^(\d+)\s*([smhdwy])$/i);
    if (s) return parseInt(s[1], 10) * SHORT[s[2].toLowerCase()];
    var d = Date.parse((aria || '').replace(/^comment by\s+/i, ''));
    if (!isNaN(d)) return Math.max(0, (Date.now() - d) / 1000);
    return null;
  }

  // Nesting is expressed as avatar indentation. Cluster the offsets, then measure
  // each comment's distance (in clusters) from the TOP-LEVEL one. The baseline must
  // come from comments known to be top level - taking the most common offset overall
  // is wrong, because expanding a few big threads makes replies outnumber parents
  // and silently flips the whole scale.
  function levelScale(lefts, tops) {
    var vals = lefts.filter(function (x) { return x !== null; });
    if (!vals.length) return null;
    var centers = [];
    vals.slice().sort(function (a, b) { return a - b; }).forEach(function (v) {
      var last = centers[centers.length - 1];
      if (last && Math.abs(last.sum / last.n - v) <= 15) { last.sum += v; last.n++; }
      else centers.push({ sum: v, n: 1 });
    });
    var mid = centers.map(function (c) { return c.sum / c.n; });
    var known = [];
    for (var k = 0; k < lefts.length; k++) if (tops && tops[k] && lefts[k] !== null) known.push(lefts[k]);
    var base = known.length ? mode(known) : vals[0];   // fallback: the first comment
    var baseIdx = 0, best = Infinity;
    mid.forEach(function (m, i) { var d = Math.abs(m - base); if (d < best) { best = d; baseIdx = i; } });
    return function (left) {
      if (left === null) return 0;
      var idx = 0, b = Infinity;
      mid.forEach(function (m, i) { var d = Math.abs(m - left); if (d < b) { b = d; idx = i; } });
      return Math.abs(idx - baseIdx);          // works for LTR and RTL indentation
    };
  }

  function collect() {
    var raw = [], seen = {};
    var arts = document.querySelectorAll('div[role="article"]');
    for (var i = 0; i < arts.length; i++) {
      var a = arts[i];
      if (!vis(a)) continue;                                   // drops FB's hidden duplicate tree
      var link = permalink(a);
      if (!link) continue;
      var ids = idsOf(link);
      if (!ids.id || seen[ids.id]) continue;
      seen[ids.id] = 1;
      raw.push({ el: a, link: link, id: ids.id, root: ids.root });
    }

    // Avatar indentation carries the depth; the aria-label decides what is top level.
    var lefts = raw.map(function (o) {
      var av = o.el.querySelector('image, img');
      return av ? Math.round(av.getBoundingClientRect().left) : null;
    });
    var tops = raw.map(function (o) {
      return /^comment by/i.test(o.el.getAttribute('aria-label') || '');
    });
    var levelOf = levelScale(lefts, tops);

    var out = [], stack = [];
    raw.forEach(function (o, i) {
      var el = o.el;
      var aria0 = el.getAttribute('aria-label') || '';
      var level = levelOf ? levelOf(lefts[i]) : 0;
      // Facebook labels replies outright ("Reply by X to Y's comment") on both the
      // group and profile layouts, so that beats indentation for level 0 vs 1;
      // indentation is only needed to tell a reply from a reply-to-a-reply.
      if (/^reply by/i.test(aria0)) { if (!level) level = 1; }
      else if (/^comment by/i.test(aria0)) level = 0;
      var isReply = level > 0;
      var up = level > 0 ? stack[level - 1] : null;
      // Facebook flattens third-level replies to a single indent, so DOM position
      // only identifies the branch. The aria-label names the exact person replied
      // to - resolve that back to the nearest preceding comment by that author.
      var ariaParent = (aria0.match(/\bto\s+(.+?)'s\s+(?:comment|reply)/i) || [])[1] || '';
      if (ariaParent) {
        for (var q = out.length - 1; q >= 0; q--) {
          if (out[q].author === ariaParent) { up = out[q]; break; }
        }
      }

      var author = '', authorUrl = '';
      var links = el.querySelectorAll('a');
      for (var j = 0; j < links.length; j++) {
        if (links[j] === o.link) continue;
        var lt = T(links[j]);
        if (lt) { author = lt; authorUrl = links[j].href; break; }
      }
      var aria = aria0;
      if (!author) {
        author = aria.replace(/^(comment|reply) by\s+/i, '')
                     .replace(/\s+(a few seconds|about a minute|an?\s+\w+|[\d,]+\s+\w+)\s+ago$/i, '').trim();
      }

      var likes = 0;
      var btns = el.querySelectorAll('[role="button"]');
      for (var k = 0; k < btns.length; k++) {
        var bt = T(btns[k]);
        if (/^[\d,]+(\.\d+)?\s*[KkMm]?$/.test(bt)) { likes = num(bt); break; }
      }

      var short = T(o.link);
      var item = {
        id: o.id,
        el: el,
        author: author,
        authorUrl: authorUrl,
        text: bodyText(el),
        time: short,
        timeFull: aria.replace(/^(comment|reply) by\s+/i, '')
                      .replace(new RegExp('^' + rxEsc(author) + '\\s*', 'i'), '')
                      .replace(/^to\s+/i, '').trim(),
        age: ageSeconds(aria, short),
        likes: likes,
        level: level,
        isReply: isReply,
        parent: up ? up.author : ariaParent,
        parentId: up ? up.id : '',
        // Thread root comes from the DOM stack, not the URL: profile-post ids carry
        // no parent, and stack[0] is right in both layouts.
        thread: level > 0 ? (stack[0] ? stack[0].id : (o.root || o.id)) : o.id,
        url: cleanUrl(o.link.href),
        order: out.length
      };
      stack[level] = item;
      stack.length = level + 1;
      out.push(item);
    });
    return out;
  }

  /* ------------------------------------------------------------ query parse */
  function parseQuery(q) {
    var inc = [], exc = [], who = [];
    var re = /"([^"]+)"|(\S+)/g, m;
    while ((m = re.exec(q))) {
      var tok = m[1] !== undefined ? m[1] : m[2];
      if (!tok) continue;
      if (tok[0] === '@' && tok.length > 1) who.push(tok.slice(1).toLowerCase());
      else if (tok[0] === '-' && tok.length > 1) exc.push(tok.slice(1).toLowerCase());
      else inc.push(tok.toLowerCase());
    }
    return { inc: inc, exc: exc, who: who };
  }
  function matches(c, Q) {
    var hay = (c.author + '\n' + c.text).toLowerCase();
    for (var i = 0; i < Q.inc.length; i++) if (hay.indexOf(Q.inc[i]) < 0) return false;
    for (var j = 0; j < Q.exc.length; j++) if (hay.indexOf(Q.exc[j]) >= 0) return false;
    if (Q.who.length) {
      var a = c.author.toLowerCase();
      if (!Q.who.some(function (w) { return a.indexOf(w) >= 0; })) return false;
    }
    return true;
  }

  /* --------------------------------------------------------------------- UI */
  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
    '.wrap{position:fixed;top:0;right:0;height:100vh;width:var(--w,440px);display:flex;flex-direction:column;',
    'background:#fff;color:#1c1e21;border-left:1px solid #d0d3d8;box-shadow:-8px 0 28px rgba(0,0,0,.18);z-index:2147483647}',
    '.grip{position:fixed;top:0;right:var(--w,440px);width:6px;height:100vh;cursor:col-resize;z-index:2147483647}',
    '.grip:hover{background:#1877f2}',
    '.hd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #e4e6eb;flex:0 0 auto}',
    '.ttl{font-weight:700;font-size:14px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.cnt{font-weight:400;color:#65676b}',
    'button{font-size:12px;border:1px solid #ccd0d5;background:#f0f2f5;color:#1c1e21;border-radius:6px;padding:5px 9px;cursor:pointer;line-height:1.2}',
    'button:hover{background:#e4e6eb}',
    'button.i{padding:4px 8px;font-size:14px;min-width:28px}',
    '.bar{padding:8px 12px;border-bottom:1px solid #f0f2f5;flex:0 0 auto}',
    '.row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
    'input.q{width:100%;padding:8px 10px;border:1px solid #ccd0d5;border-radius:8px;font-size:14px;background:#f7f8fa;color:inherit;outline:none}',
    'input.q:focus{border-color:#1877f2;background:#fff}',
    'select{font-size:12px;padding:4px 6px;border-radius:6px;border:1px solid #ccd0d5;background:#f7f8fa;color:inherit}',
    'label.mk{font-size:12px;color:#65676b;display:flex;align-items:center;gap:4px;cursor:pointer}',
    '.stat{padding:6px 12px;font-size:12px;color:#65676b;border-bottom:1px solid #f0f2f5;display:flex;align-items:center;gap:8px;min-height:30px}',
    '.stat b{color:#1877f2}',
    '.list{flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain}',
    '.it{padding:9px 12px;border-bottom:1px solid #f0f2f5;cursor:pointer}',
    '.it:hover{background:#f5f6f7}',
    '.it.rep{border-left:3px solid #e4e6eb}',
    '.th{color:#1877f2;cursor:pointer;border-bottom:1px dotted currentColor}',
    '.crumb{display:none;align-items:center;gap:8px;padding:7px 12px;background:#e7f0fd;',
    'border-bottom:1px solid #d3e3fd;font-size:12px;color:#1877f2;flex:0 0 auto}',
    '.crumb.on{display:flex}',
    '.crumbtxt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}',
    'button.back{background:#1877f2;color:#fff;border-color:#1877f2;font-weight:600;white-space:nowrap}',
    'button.back:hover{background:#166fe0}',
    '.meta{display:flex;gap:8px;align-items:baseline;font-size:12px;margin-bottom:3px;flex-wrap:wrap}',
    '.au{font-weight:600;color:#050505}',
    '.tm,.lk,.re{color:#65676b}',
    '.re{font-style:italic}',
    '.tx{font-size:13px;line-height:1.4;white-space:pre-wrap;word-break:break-word}',
    'mark{background:#ffe27a;color:inherit;border-radius:2px;padding:0 1px}',
    '.ft{display:flex;gap:6px;align-items:center;padding:8px 12px;border-top:1px solid #e4e6eb;flex:0 0 auto;flex-wrap:wrap}',
    '.sp{flex:1}',
    '.hint{font-size:11px;color:#8a8d91}',
    '.empty{padding:24px 12px;text-align:center;color:#8a8d91;font-size:13px}',
    '@media (prefers-color-scheme:dark){',
    '.wrap{background:#242526;color:#e4e6eb;border-left-color:#3a3b3c}',
    '.hd,.ft{border-color:#3a3b3c}.bar,.stat,.it{border-color:#3a3b3c}',
    'button{background:#3a3b3c;color:#e4e6eb;border-color:#4a4b4c}button:hover{background:#4e4f50}',
    'input.q,select{background:#3a3b3c;color:#e4e6eb;border-color:#4a4b4c}input.q:focus{background:#18191a}',
    '.au{color:#e4e6eb}.it:hover{background:#3a3b3c}.it.rep{border-left-color:#4a4b4c}',
    'mark{background:#8a6d00;color:#fff}',
    '.crumb{background:#263951;border-bottom-color:#31465e;color:#8ab4f8}}'
  ].join('');

  var host = document.createElement('div');
  host.id = 'fb-comment-explorer';
  var shadow = host.attachShadow({ mode: 'open' });
  try {
    var sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
  } catch (e) {
    var st = document.createElement('style');
    st.textContent = CSS;
    shadow.appendChild(st);
  }

  var root = document.createElement('div');
  root.innerHTML =
    '<div class="grip"></div><div class="wrap">' +
    '<div class="hd"><div class="ttl">Comment Explorer <span class="cnt"></span></div>' +
    '<button class="i" data-act="rescan" title="Expand more &amp; rescan">&#8635;</button>' +
    '<button class="i" data-act="close" title="Close (Esc)">&#215;</button></div>' +
    '<div class="bar"><input class="q" type="search" placeholder="Search comments…"></div>' +
    '<div class="bar row">' +
    '<select class="lvl"><option value="">All levels</option><option value="top">Top-level only</option><option value="rep">Replies only</option></select>' +
    '<select class="srt"><option value="page">Page order</option><option value="new">Newest</option><option value="old">Oldest</option><option value="likes">Most liked</option><option value="len">Longest</option></select>' +
    '<label class="mk"><input type="checkbox" class="hl">highlight on page</label></div>' +
    '<div class="crumb"></div><div class="stat"></div><div class="list"></div>' +
    '<div class="ft"><button data-act="json">JSON</button><button data-act="csv">CSV</button>' +
    '<button data-act="copy">Copy text</button><span class="sp"></span>' +
    '<span class="hint">"phrase" · -exclude · @author</span></div></div>';
  while (root.firstChild) shadow.appendChild(root.firstChild);
  (document.body || document.documentElement).appendChild(host);

  var $ = function (s) { return shadow.querySelector(s); };
  var elWrap = $('.wrap'), elGrip = $('.grip'), elList = $('.list'), elStat = $('.stat'),
      elCnt = $('.cnt'), elQ = $('.q'), elLvl = $('.lvl'), elSrt = $('.srt'), elHl = $('.hl'),
      elCrumb = $('.crumb');

  /* ------------------------------------------------------------ panel state */
  var DATA = [], VIEW = [], stopFlag = false, busy = false, marked = [], threadOnly = null, replyCount = {};

  function setWidth(w) {
    w = Math.max(320, Math.min(window.innerWidth - 120, w));
    elWrap.style.setProperty('--w', w + 'px');
    elGrip.style.right = w + 'px';
  }
  setWidth(440);
  (function () {
    var dragging = false;
    elGrip.addEventListener('mousedown', function (e) { dragging = true; e.preventDefault(); });
    window.addEventListener('mousemove', function (e) { if (dragging) setWidth(window.innerWidth - e.clientX); });
    window.addEventListener('mouseup', function () { dragging = false; });
  })();

  function status(html, withStop) {
    elStat.textContent = '';
    var s = document.createElement('span');
    s.innerHTML = html;
    elStat.appendChild(s);
    if (withStop) {
      var b = document.createElement('button');
      b.textContent = 'Stop';
      b.addEventListener('click', function () { stopFlag = true; b.textContent = 'Stopping…'; });
      elStat.appendChild(b);
    }
  }

  function clearMarks() {
    marked.forEach(function (el) { el.style.outline = ''; el.style.background = ''; });
    marked = [];
  }
  function applyMarks(list) {
    clearMarks();
    if (!elHl.checked) return;
    list.slice(0, 400).forEach(function (c) {
      if (!c.el || !c.el.isConnected) return;
      c.el.style.outline = '2px solid #ffb800';
      c.el.style.background = 'rgba(255,226,122,.22)';
      marked.push(c.el);
    });
  }

  function hiliteInto(node, text, terms) {
    if (!terms.length) { node.textContent = text; return; }
    var re = new RegExp('(' + terms.map(rxEsc).join('|') + ')', 'gi');
    var parts = text.split(re);
    parts.forEach(function (p, i) {
      if (!p) return;
      if (i % 2) { var m = document.createElement('mark'); m.textContent = p; node.appendChild(m); }
      else node.appendChild(document.createTextNode(p));
    });
  }

  function indexThreads() {
    replyCount = {};
    DATA.forEach(function (c) { if (c.isReply) replyCount[c.thread] = (replyCount[c.thread] || 0) + 1; });
  }

  function exitThread() { threadOnly = null; render(); }

  function updateCrumb() {
    elCrumb.textContent = '';
    if (!threadOnly) { elCrumb.className = 'crumb'; return; }
    elCrumb.className = 'crumb on';
    var back = document.createElement('button');
    back.className = 'back';
    back.textContent = '← All comments';
    back.addEventListener('click', exitThread);
    elCrumb.appendChild(back);
    var root = null;
    for (var i = 0; i < DATA.length; i++) {
      if (DATA[i].thread === threadOnly && !DATA[i].isReply) { root = DATA[i]; break; }
    }
    var n = replyCount[threadOnly] || 0;
    var lbl = document.createElement('span');
    lbl.className = 'crumbtxt';
    lbl.dir = 'auto';
    lbl.textContent = 'Thread' + (root ? ' by ' + root.author : '') + ' · ' + n + ' repl' + (n === 1 ? 'y' : 'ies');
    elCrumb.appendChild(lbl);
  }

  function render() {
    var Q = parseQuery(elQ.value.trim());
    var lvl = elLvl.value;
    var list = DATA.filter(function (c) {
      if (threadOnly && c.thread !== threadOnly) return false;
      if (lvl === 'top' && c.isReply) return false;
      if (lvl === 'rep' && !c.isReply) return false;
      return matches(c, Q);
    });
    var s = elSrt.value;
    if (s === 'new') list = list.slice().sort(function (a, b) { return (a.age === null) - (b.age === null) || a.age - b.age; });
    else if (s === 'old') list = list.slice().sort(function (a, b) { return (a.age === null) - (b.age === null) || b.age - a.age; });
    else if (s === 'likes') list = list.slice().sort(function (a, b) { return b.likes - a.likes; });
    else if (s === 'len') list = list.slice().sort(function (a, b) { return b.text.length - a.text.length; });
    VIEW = list;

    var terms = Q.inc.concat(Q.who);
    elList.textContent = '';
    if (!list.length) {
      var e = document.createElement('div');
      e.className = 'empty';
      e.textContent = DATA.length ? 'No comments match.' : 'Nothing collected yet.';
      elList.appendChild(e);
    }
    var frag = document.createDocumentFragment();
    list.forEach(function (c, i) {
      var it = document.createElement('div');
      it.className = 'it' + (c.isReply ? ' rep' : '');
      it.dataset.i = i;
      if (c.level) it.style.paddingLeft = (12 + c.level * 18) + 'px';
      var meta = document.createElement('div');
      meta.className = 'meta';
      var au = document.createElement('span'); au.className = 'au'; au.dir = 'auto';
      hiliteInto(au, c.author, terms); meta.appendChild(au);
      var tm = document.createElement('span'); tm.className = 'tm'; tm.textContent = c.time || ''; meta.appendChild(tm);
      if (c.likes) { var lk = document.createElement('span'); lk.className = 'lk'; lk.textContent = '♥ ' + c.likes; meta.appendChild(lk); }
      if (c.isReply && c.parent) {
        var re = document.createElement('span'); re.className = 're'; re.dir = 'auto';
        re.textContent = '↳ ' + c.parent; meta.appendChild(re);
      }
      if (!c.isReply && replyCount[c.thread]) {
        var th = document.createElement('span'); th.className = 'th'; th.dataset.th = c.thread;
        th.textContent = replyCount[c.thread] + ' repl' + (replyCount[c.thread] > 1 ? 'ies' : 'y');
        meta.appendChild(th);
      }
      it.appendChild(meta);
      var tx = document.createElement('div'); tx.className = 'tx'; tx.dir = 'auto';
      hiliteInto(tx, c.text, terms);
      it.appendChild(tx);
      frag.appendChild(it);
    });
    elList.appendChild(frag);
    elList.scrollTop = 0;

    var reps = list.filter(function (c) { return c.isReply; }).length;
    elCnt.textContent = list.length === DATA.length
      ? '(' + DATA.length + ')'
      : '(' + list.length + ' of ' + DATA.length + ')';
    updateCrumb();
    if (!busy) status(list.length + ' shown &middot; ' + (list.length - reps) + ' top-level, ' + reps + ' replies');
    applyMarks(list);
  }

  function jump(c) {
    if (!c.el || !c.el.isConnected) { status('That comment is no longer in the page - rescan.'); return; }
    c.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    var o = c.el.style.outline, b = c.el.style.background;
    c.el.style.outline = '3px solid #1877f2';
    c.el.style.background = 'rgba(24,119,242,.14)';
    setTimeout(function () { c.el.style.outline = o; c.el.style.background = b; }, 2200);
  }

  elList.addEventListener('click', function (e) {
    var th = e.target.closest && e.target.closest('.th');
    if (th) {
      threadOnly = threadOnly === th.dataset.th ? null : th.dataset.th;
      elLvl.value = '';
      render();
      return;
    }
    var it = e.target.closest && e.target.closest('.it');
    if (it) jump(VIEW[+it.dataset.i]);
  });

  var deb;
  elQ.addEventListener('input', function () { clearTimeout(deb); deb = setTimeout(render, 110); });
  elLvl.addEventListener('change', render);
  elSrt.addEventListener('change', render);
  elHl.addEventListener('change', render);

  /* ------------------------------------------------------------ export bits */
  function download(name, mime, text) {
    var url = URL.createObjectURL(new Blob([text], { type: mime }));
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function plain(list) {
    return list.map(function (c) {
      return (c.isReply ? '    ↳ ' : '') + c.author + '  (' + (c.time || '') + (c.likes ? ', ♥' + c.likes : '') + ')\n' +
        c.text.split('\n').map(function (l) { return (c.isReply ? '      ' : '  ') + l; }).join('\n');
    }).join('\n\n');
  }
  function csv(list) {
    var q = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
    var head = ['id', 'author', 'level', 'reply_to', 'time', 'likes', 'text', 'url'];
    // Leading BOM so Excel opens Hebrew/Arabic/accented text as UTF-8.
    return '﻿' + [head.join(',')].concat(list.map(function (c) {
      return [c.id, c.author, c.isReply ? 'reply' : 'top', c.parent, c.timeFull || c.time, c.likes, c.text, c.url].map(q).join(',');
    })).join('\r\n');
  }
  function json(list) {
    return JSON.stringify({
      source: location.href,
      capturedAt: new Date().toISOString(),
      total: list.length,
      comments: list.map(function (c) {
        return { id: c.id, author: c.author, authorUrl: c.authorUrl, text: c.text, time: c.timeFull || c.time,
                 secondsAgo: c.age, likes: c.likes, isReply: c.isReply, replyTo: c.parent, replyToId: c.parentId, url: c.url };
      })
    }, null, 2);
  }

  /* --------------------------------------------------------------- controls */
  shadow.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-act]');
    if (!b) return;
    var act = b.dataset.act;
    if (act === 'close') api.close();
    else if (act === 'rescan') run(false);
    else if (act === 'json') download('fb-comments.json', 'application/json', json(VIEW));
    else if (act === 'csv') download('fb-comments.csv', 'text/csv', csv(VIEW));
    else if (act === 'copy') {
      navigator.clipboard.writeText(plain(VIEW))
        .then(function () { status('Copied ' + VIEW.length + ' comments to the clipboard.'); })
        .catch(function () { status('Clipboard blocked - use JSON or CSV instead.'); });
    }
  });

  function onKey(e) {
    var t = e.composedPath ? e.composedPath()[0] : e.target;
    var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (e.key === 'Escape' && host.isConnected && shadow.contains(t)) {
      if (threadOnly || elQ.value) {          // back out one step at a time
        e.preventDefault(); e.stopPropagation();
        threadOnly = null; elQ.value = ''; render();
      } else api.close();
      return;
    }
    if (e.key === '/' && !typing) { e.preventDefault(); elQ.focus(); elQ.select(); }
  }
  document.addEventListener('keydown', onKey, true);

  /* ------------------------------------------------------------------- main */
  async function run(withSort) {
    if (busy) return;
    busy = true; stopFlag = false;
    status('Expanding comments&hellip;', true);
    var t0 = Date.now();
    var target = postCommentCount();
    var round = 0, prev = -1;

    // Facebook drip-feeds comments and will throttle a session that asks a lot. One
    // pass can therefore stall well short of the real total, so keep going for as
    // long as each extra round is still bringing something back.
    while (round < 4 && !stopFlag) {
      await expandAll({
        sortAll: !!withSort && round === 0,
        stop: function () { return stopFlag; },
        onTick: function (p) {
          status(p.phase === 'sort'
            ? 'Switching sort to <b>All comments</b>&hellip;'
            : 'Expanding&hellip; <b>' + p.count + '</b>' + (target ? ' of ~' + target : '') +
              ' comments, ' + p.clicks + ' expanded' +
              (p.idle ? ' &middot; settling ' + p.idle + '/' + p.patience : ''), true);
        }
      });
      round++;
      var got = countComments();
      if (stopFlag || !target || got >= target * 0.95 || got <= prev) break;
      prev = got;
      status('Facebook is pacing us &mdash; <b>' + got + '</b> of ~' + target + ', waiting&hellip;', true);
      await sleep(2500);
    }

    DATA = collect();
    indexThreads();
    busy = false;
    render();
    var secs = Math.round((Date.now() - t0) / 1000);
    var short = target && DATA.length < target * 0.95;
    status('Loaded <b>' + DATA.length + '</b>' + (target ? ' of ~' + target : '') +
           ' comments in ' + secs + 's.' +
           (stopFlag ? ' (stopped early)'
                     : short ? ' Facebook stopped sending &mdash; press &#8635; to keep trying.' : ''));
  }

  var api = {
    get data() { return DATA; },
    toggle: function () {
      if (!host.isConnected) { (document.body || document.documentElement).appendChild(host); return; }
      var hidden = elWrap.style.display === 'none';
      elWrap.style.display = hidden ? '' : 'none';
      elGrip.style.display = hidden ? '' : 'none';
      if (!hidden) clearMarks();
    },
    rescan: function () { DATA = collect(); indexThreads(); render(); },
    close: function () {
      clearMarks();
      document.removeEventListener('keydown', onKey, true);
      host.remove();
      delete window[NS];
    }
  };
  window[NS] = api;

  DATA = collect();
  indexThreads();
  render();
  run(true);
})();
