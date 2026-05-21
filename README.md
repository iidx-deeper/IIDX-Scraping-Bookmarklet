# DEEPER — IIDX DP Score Importer Bookmarklet

A browser bookmarklet that scrapes your **beatmania IIDX Double Play (DP)** score
data from the [KONAMI e-AMUSEMENT GATE](https://p.eagate.573.jp/) difficulty
page and posts it directly to [DEEPER](https://deepers.site/).

This is a fork of [BPIManager/IIDX-Scraping-Bookmarklet](https://github.com/BPIManager/IIDX-Scraping-Bookmarklet)
(MIT). The original handles SP only and outputs CSV for the user to paste; this
fork is DP only and posts the data straight into DEEPER's `scores.php` API.

---

## Why a separate fork

- **DP only** — DEEPER's focus is IIDX Double Play. The GATE endpoint is queried
  with `style=1` instead of `style=0`.
- **Direct upload** — no clipboard / paste step. The bookmarklet POSTs an
  IIDX-official-compatible CSV to `https://deepers.site/api/scores.php`.
- **Branded UI** — DEEPER's purple `#6c5ce7` palette.

---

## Status

WIP (Phase 1 of the implementation plan). Not yet deployed.

---

## Important Security Notice

This bookmarklet runs arbitrary JavaScript on the e-AMUSEMENT GATE page using
your authenticated session. While this project is open source, executing
modified or untrusted code could expose session data. The script is also
served dynamically from this repository (or DEEPER's CDN), so the executed
code may change over time. Always verify the source and use at your own risk.

> **Disclaimer:** This project is an independent fan tool and is not affiliated
> with or endorsed by Konami Digital Entertainment Co., Ltd. Use responsibly
> and in accordance with the e-AMUSEMENT GATE Terms of Service.

---

## Development

**Prerequisites:** Node.js 18+.

```bash
git clone git@github.com:iidx-deeper/IIDX-Scraping-Bookmarklet.git
cd IIDX-Scraping-Bookmarklet
npm install
npm run build
# → dist/bookmarklet.js, dist/bookmarklet.min.js
```

## Deployment

The minified file at `dist/bookmarklet.min.js` is FTP-uploaded to CoreServer
alongside DEEPER. The user-facing bookmark URL is a tiny loader:

```javascript
javascript:(()=>{window.__DEEPER_IIDX_ID="XXXX-XXXX";const s=document.createElement('script');s.src='https://deepers.site/bookmarklet.min.js?v='+Date.now();document.head.appendChild(s);})()
```

(Phase 2 will generate a per-user customized loader from a DEEPER SPA page.)

---

## CSV format

The CSV posted to `scores.php` follows the IIDX official CSV column layout
(`scores.php` parses headers dynamically).

| Column group       | Columns |
| ------------------ | ------- |
| Song metadata      | バージョン, タイトル, ジャンル, アーティスト, プレー回数 |
| Per difficulty × 4 | `{DIFF} 難易度`, `{DIFF} スコア`, `{DIFF} PGreat`, `{DIFF} Great`, `{DIFF} ミスカウント`, `{DIFF} クリアタイプ`, `{DIFF} DJ LEVEL` |
| Timestamp          | 最終プレー日時 |

Difficulties (DP): `NORMAL`, `HYPER`, `ANOTHER`, `LEGGENDARIA`. (`BEGINNER` is
SP-only and omitted.)

Fields not available on GATE (version, genre, artist, miss count, last play
time) are exported as `---`. `scores.php` treats `---` as NULL for miss count.

---

## Caveats

- **Authentication required** — the bookmarklet uses `credentials: "include"`,
  so you must be logged in to e-AMUSEMENT GATE in the same browser.
- **Miss count not available** — the GATE difficulty page does not expose
  miss counts. DEEPER's 3-axis Voltage (CV / FV / SV) does not depend on miss
  count, so this does not affect Voltage accuracy.
- **Rate limiting** — 400 ms delay between paginated requests; scraping all
  ☆1–☆12 takes ~1–2 minutes. Do not navigate away.
- **DOM selectors** — parsing relies on KONAMI's current HTML structure.
  Front-end changes may break the bookmarklet; re-build and re-deploy when
  that happens.

---

## License

MIT — see [LICENSE.md](LICENSE.md). Forked from BPIManager/IIDX-Scraping-Bookmarklet.
