/**
 * @file bookmarklet.ts
 * @description IIDX DP score importer bookmarklet for DEEPER
 *
 * Scrapes Double Play score data from the KONAMI e-AMUSEMENT GATE and POSTs an
 * IIDX-official-compatible CSV directly to DEEPER's `scores.php` API.
 *
 * Fork of BPIManager/IIDX-Scraping-Bookmarklet (MIT). Differences:
 *  - DP only (`style=1` instead of `style=0`)
 *  - Direct upload to DEEPER (no clipboard step)
 *  - BEGINNER removed (DP has no BEGINNER difficulty)
 *  - Miss-count placeholder is `---` (parsed as NULL by scores.php)
 *  - Tower data import removed (out of scope for DEEPER)
 *
 * @usage
 * Compile with `tsc --target ES2020 --lib ES2020,DOM bookmarklet.ts`, then
 * minify and paste as a `javascript:` bookmarklet URL.
 */

(async (): Promise<void> => {
  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  /**
   * Difficulty names used both as CSV column prefixes and POST parameters.
   * BEGINNER is intentionally omitted — DP has no BEGINNER difficulty.
   */
  const DIFFICULTIES = [
    "NORMAL",
    "HYPER",
    "ANOTHER",
    "LEGGENDARIA",
  ] as const;

  /** Union type of all supported difficulty names. */
  type Difficulty = (typeof DIFFICULTIES)[number];

  /**
   * Maps the numeric clear-flag value embedded in KONAMI's `clflg*.gif` image
   * filenames to the human-readable clear-type label used in the CSV.
   */
  const LAMP_MAP: Record<string, string> = {
    "0": "NO PLAY",
    "1": "FAILED",
    "2": "ASSIST CLEAR",
    "3": "EASY CLEAR",
    "4": "CLEAR",
    "5": "HARD CLEAR",
    "6": "EX HARD CLEAR",
    "7": "FULLCOMBO CLEAR",
  };

  /**
   * Display labels for difficulty levels ☆1 through ☆12.
   * Index 0 → "☆1", index 11 → "☆12".
   */
  const LEVEL_LABELS: string[] = [
    "☆1",
    "☆2",
    "☆3",
    "☆4",
    "☆5",
    "☆6",
    "☆7",
    "☆8",
    "☆9",
    "☆10",
    "☆11",
    "☆12",
  ];

  /**
   * CSV header row for Score data.
   */
  const HEADERS: string[] = [
    "バージョン",
    "タイトル",
    "ジャンル",
    "アーティスト",
    "プレー回数",
    ...DIFFICULTIES.flatMap((d) => [
      `${d} 難易度`,
      `${d} スコア`,
      `${d} PGreat`,
      `${d} Great`,
      `${d} ミスカウント`,
      `${d} クリアタイプ`,
      `${d} DJ LEVEL`,
    ]),
    "最終プレー日時",
  ];

  // ---------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------

  interface ChartScore {
    title: string;
    difficulty: string;
    level: string;
    score: string;
    pgreat: string;
    great: string;
    lamp: string;
    djLevel: string;
  }

  type SongEntry = Partial<Record<Difficulty, ChartScore>>;
  type SongMap = Record<string, SongEntry>;

  /** Scraping mode selected by the user in the UI. */
  type ScrapeMode = "all" | "1112";

  // ---------------------------------------------------------------------------
  // Helpers — URL / versioning
  // ---------------------------------------------------------------------------

  const detectVersion = (): string => {
    const match = location.href.match(/\/game\/2dx\/(\d+)\//);
    return match ? match[1] : "33";
  };

  const ver = detectVersion();

  const SCORE_POST_URL = `https://p.eagate.573.jp/game/2dx/${ver}/djdata/music/difficulty.html`;

  /** GATE profile page that exposes the player's IIDX ID. */
  const STATUS_URL = `https://p.eagate.573.jp/game/2dx/${ver}/djdata/status.html`;

  /** DEEPER score upload API. */
  const DEEPER_POST_URL = "https://deepers.site/api/scores.php";

  /** Public DEEPER URL — link target shown after success. */
  const DEEPER_HOME = "https://deepers.site/";

  /** Placeholder for fields not available on GATE; `scores.php` treats this as NULL. */
  const NA = "---";

  /** localStorage key for cached IIDX ID. */
  const LS_IIDX_ID_KEY = "__deeper_iidx_id";

  /** IIDX ID pre-baked by the per-user loader (Phase 2). Optional. */
  const PREBAKED_IIDX_ID: string | undefined =
    typeof (window as unknown as { __DEEPER_IIDX_ID?: string })
      .__DEEPER_IIDX_ID === "string"
      ? (window as unknown as { __DEEPER_IIDX_ID: string }).__DEEPER_IIDX_ID
      : undefined;

  // ---------------------------------------------------------------------------
  // Helpers — CSV encoding
  // ---------------------------------------------------------------------------

  const escapeCsv = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

  // ---------------------------------------------------------------------------
  // Helpers — HTML parsing (Scores)
  // ---------------------------------------------------------------------------

  const parseScoreTable = (html: string): ChartScore[] => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const rows = doc.querySelectorAll(".series-difficulty table tr");
    const results: ChartScore[] = [];

    rows.forEach((row) => {
      const tds = row.querySelectorAll("td");
      if (tds.length < 4) return;

      const titleEl = tds[0].querySelector("a");
      if (!titleEl) return;

      const title = titleEl.textContent?.trim() ?? "";
      const difficulty = tds[1].textContent?.trim() ?? "";

      const scoreMatch = (tds[3]?.textContent?.trim() ?? "").match(
        /(\d+)\s*\((\d+)\/(\d+)\)/,
      );

      const lampImg = tds[4]?.querySelector("img");
      const lampSrc = lampImg?.getAttribute("src") ?? "";
      const lampNum = lampSrc.match(/clflg(\d+)\.gif/)?.[1] ?? "0";

      const djImg = tds[2]?.querySelector("img");
      const djSrc = djImg?.getAttribute("src") ?? "";
      const djLevel = djSrc.match(/\/([^/]+)\.gif/)?.[1].toUpperCase() ?? "---";

      const thEl = row.closest("table")?.querySelector("th");
      const levelMatch = thEl?.textContent?.match(/LEVEL\s*(\d+)/i);

      results.push({
        title,
        difficulty,
        level: levelMatch ? levelMatch[1] : "-",
        score: scoreMatch ? scoreMatch[1] : "0",
        pgreat: scoreMatch ? scoreMatch[2] : "0",
        great: scoreMatch ? scoreMatch[3] : "0",
        lamp: LAMP_MAP[lampNum] ?? "NO PLAY",
        djLevel,
      });
    });

    return results;
  };

  // ---------------------------------------------------------------------------
  // Helpers — network
  // ---------------------------------------------------------------------------

  const fetchScorePage = async (
    difficult: number,
    offset: number,
  ): Promise<string> => {
    const body = new URLSearchParams({
      difficult: String(difficult),
      style: "1", // DP (Double Play)
      disp: "1",
    });
    if (offset > 0) body.append("offset", String(offset));

    const resp = await fetch(SCORE_POST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      credentials: "include",
    });

    if (!resp.ok) throw new Error(`HTTP Error: ${resp.status}`);
    return resp.text();
  };

  // ---------------------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------------------

  const injectStyles = (): void => {
    if (document.getElementById("__iidx_style")) return;
    const st = document.createElement("style");
    st.id = "__iidx_style";
    st.textContent = `
      @keyframes __iidx_spin { to { transform: rotate(360deg); } }
      .__iidx_btn { transition: all 0.2s; border: none; cursor: pointer; }
      .__iidx_btn:hover { opacity: 0.8; filter: brightness(1.1); }
      .__iidx_btn:active { transform: scale(0.98); }
    `;
    document.head.appendChild(st);
  };

  const buildOverlay = (): HTMLDivElement => {
    const overlay = document.createElement("div");
    overlay.id = "__iidx_overlay";
    Object.assign(overlay.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
      background: "rgba(0,0,0,0.5)",
      zIndex: "999999",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "sans-serif",
    });

    overlay.innerHTML = `
      <div style="background:#fff; color:#1a1a1a; border-radius:16px; width:480px; max-width:95vw; box-shadow:0 12px 48px rgba(0,0,0,0.25); overflow:hidden;">
        <div style="background:#4a3fb8; padding:18px 24px; display:flex; align-items:center; justify-content:space-between;">
          <div style="display:flex; align-items:center; gap:10px;">
            <span style="font-size:20px; font-weight:800; color:#fff; letter-spacing:1.5px;">DEEPER</span>
            <span style="font-size:12px; color:#d9d4ff; opacity:0.9;">DP Player Data Importer</span>
          </div>
          <button id="__iidx_btn_x" style="background:none; border:none; color:#fff; font-size:24px; cursor:pointer;">&times;</button>
        </div>

        <div style="padding:24px;">
          <div id="__iidx_step_id_fetching" style="text-align:center; padding:20px 0;">
            <div style="width:48px; height:48px; border:4px solid #ece9ff; border-top-color:#6c5ce7; border-radius:50%; animation:__iidx_spin 1s linear infinite; margin:0 auto 20px;"></div>
            <p style="margin:0; font-weight:700;">GATE から IIDX ID を取得中...</p>
            <p style="margin:8px 0 0; font-size:12px; color:#6b7280;">e-AMUSEMENT GATE のプロフィールページに問い合わせています</p>
          </div>

          <div id="__iidx_step_id_confirm" style="display:none;">
            <p style="margin:0 0 14px; font-weight:700;">プレイヤー情報を確認してください</p>
            <div style="background:#f5f3ff; border:2px solid #6c5ce7; border-radius:12px; padding:18px; text-align:center; margin-bottom:14px;">
              <div style="font-size:11px; color:#6b7280; letter-spacing:1px; margin-bottom:6px;">あなたの IIDX ID</div>
              <div id="__iidx_confirm_id_text" style="font-family:monospace; font-size:24px; font-weight:800; color:#4a3fb8; letter-spacing:3px;">-</div>
              <div id="__iidx_confirm_name_wrap" style="margin-top:14px; padding-top:14px; border-top:1px dashed #c0c0d8; display:none;">
                <div style="font-size:11px; color:#6b7280; letter-spacing:1px; margin-bottom:6px;">DJ NAME</div>
                <div id="__iidx_confirm_name_text" style="font-family:monospace; font-size:18px; font-weight:700; color:#4a3fb8;">-</div>
              </div>
            </div>
            <button id="__iidx_btn_id_confirm" class="__iidx_btn" style="width:100%; padding:12px; border-radius:8px; background:#6c5ce7; color:#fff; font-size:14px; font-weight:700;">この情報で進める</button>
            <p style="margin:12px 0 0; font-size:11px; color:#9ca3af; text-align:center;">DEEPER は GATE のログインセッションから自動取得しています</p>
          </div>

          <div id="__iidx_step_select_score" style="display:none;">
            <div style="display:flex; align-items:center; margin-bottom:10px; gap:8px;">
              <button id="__iidx_btn_back" style="background:none; border:none; color:#6b7280; cursor:pointer; font-size:14px; padding:0;">◀ 戻る</button>
              <p style="margin:0; font-weight:700;">取得範囲を選択してください</p>
            </div>
            <div style="display:flex; flex-direction:column; gap:12px;">
              <button id="__iidx_btn_all" class="__iidx_btn" style="padding:16px; border-radius:12px; background:#f5f3ff; border:2px solid #6c5ce7; text-align:left;">
                <div style="font-weight:700; color:#1a1a1a;">全楽曲を取得する (☆1-12)</div>
                <div style="font-size:12px; color:#6c5ce7;">目安: 1〜2分</div>
              </button>
              <button id="__iidx_btn_1112" class="__iidx_btn" style="padding:16px; border-radius:12px; background:#f5f3ff; border:2px solid #6c5ce7; text-align:left;">
                <div style="font-weight:700; color:#1a1a1a;">☆11・☆12 のみ取得する</div>
                <div style="font-size:12px; color:#6c5ce7;">目安: 約30秒</div>
              </button>
            </div>
          </div>

          <div id="__iidx_step_progress" style="display:none; text-align:center; padding:20px 0;">
            <div style="width:48px; height:48px; border:4px solid #ece9ff; border-top-color:#6c5ce7; border-radius:50%; animation:__iidx_spin 1s linear infinite; margin:0 auto 20px;"></div>
            <div id="__iidx_status_level" style="font-weight:700; font-size:16px; margin-bottom:4px;">Ready...</div>
            <div id="__iidx_status_page" style="font-size:13px; color:#6b7280; margin-bottom:24px;"></div>
            <div style="display:inline-flex; align-items:baseline; gap:8px; background:#f5f3ff; border-radius:12px; padding:12px 32px;">
              <span style="font-size:13px; color:#6b7280;">取得件数</span>
              <span id="__iidx_item_count" style="font-size:32px; font-weight:800; color:#4a3fb8;">0</span>
              <span style="font-size:13px; color:#6b7280;">曲</span>
            </div>
          </div>

          <div id="__iidx_step_result" style="display:none;">
            <div id="__iidx_result_banner" style="border-radius:12px; padding:14px; margin-bottom:16px; display:flex; align-items:center; gap:12px;">
              <span id="__iidx_result_icon" style="font-size:24px;"></span>
              <div>
                <div id="__iidx_result_title" style="font-weight:700;"></div>
                <div id="__iidx_result_summary" style="font-size:12px;"></div>
              </div>
            </div>
            <div id="__iidx_result_details" style="background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:12px; font-size:12px; color:#374151; line-height:1.6; max-height:160px; overflow-y:auto;"></div>
            <div style="display:flex; gap:10px; margin-top:16px;">
              <a id="__iidx_link_deeper" href="https://deepers.site/" target="_blank" style="flex:2; background:#6c5ce7; color:#fff; text-decoration:none; padding:12px; border-radius:8px; text-align:center; font-weight:700; font-size:14px;">DEEPERを開く</a>
              <button id="__iidx_btn_close2" style="flex:1; background:#fff; border:1px solid #e5e7eb; color:#6b7280; border-radius:8px; font-size:14px;">閉じる</button>
            </div>
          </div>

          <div id="__iidx_step_error" style="display:none;">
            <div style="background:#fef2f2; border:1px solid #fecaca; padding:16px; border-radius:12px;">
              <div style="font-weight:700; color:#991b1b;">エラー</div>
              <div id="__iidx_err_msg" style="font-size:13px; color:#b91c1c; margin-top:4px; word-break:break-all;"></div>
            </div>
            <button id="__iidx_btn_retry" style="margin-top:12px; width:100%; padding:10px; border-radius:8px; border:1px solid #6c5ce7; color:#6c5ce7; background:none;">最初からやり直す</button>
          </div>
        </div>
        <p style="margin:0; padding:0 24px 16px; font-size:12px; color:#6b7280; text-align:center;">問題が発生した場合は <a href="https://github.com/iidx-deeper/IIDX-Scraping-Bookmarklet" target="_blank" style="color:#6c5ce7;">GitHub</a> から Issue を報告してください</p>
      </div>
    `;

    return overlay;
  };

  type StepName =
    | "id_fetching"
    | "id_confirm"
    | "select_score"
    | "progress"
    | "result"
    | "error";

  const STEPS: readonly StepName[] = [
    "id_fetching",
    "id_confirm",
    "select_score",
    "progress",
    "result",
    "error",
  ];

  const showStep = (name: StepName): void => {
    STEPS.forEach((s) => {
      const el = document.getElementById(`__iidx_step_${s}`);
      if (el) el.style.display = s === name ? "block" : "none";
    });
  };

  // ---------------------------------------------------------------------------
  // Core scraping logic (Scores)
  // ---------------------------------------------------------------------------

  const scrapeLevel = async (
    songMap: SongMap,
    difficult: number,
    label: string,
    pageCounter: { value: number },
  ): Promise<void> => {
    let offset = 0;
    let pageNum = 1;

    while (true) {
      const statusLevel = document.getElementById("__iidx_status_level");
      const statusPage = document.getElementById("__iidx_status_page");
      const itemCountEl = document.getElementById("__iidx_item_count");

      if (statusLevel) statusLevel.textContent = `${label} を取得中...`;
      if (statusPage) statusPage.textContent = `${pageNum} ページ目`;

      const html = await fetchScorePage(difficult, offset);
      const rows = parseScoreTable(html);

      if (rows.length === 0) break;

      rows.forEach((r) => {
        if (!songMap[r.title]) songMap[r.title] = {};
        if ((DIFFICULTIES as ReadonlyArray<string>).includes(r.difficulty)) {
          songMap[r.title][r.difficulty as Difficulty] = { ...r };
        }
      });

      if (itemCountEl) {
        itemCountEl.textContent = String(Object.keys(songMap).length);
      }

      pageCounter.value += 1;
      offset += 50;
      pageNum += 1;

      // Brief pause to avoid hammering the server.
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
    }
  };

  const buildScoreCsv = (songMap: SongMap): string => {
    const csvRows: string[] = [HEADERS.join(",")];

    Object.keys(songMap)
      .sort()
      .forEach((title) => {
        const data = songMap[title];
        // Metadata not exposed on GATE: version / genre / artist / plays.
        const row: string[] = [NA, escapeCsv(title), NA, NA, NA];

        DIFFICULTIES.forEach((diff) => {
          const d = data[diff];
          if (d) {
            // Miss count is not exposed on the GATE difficulty page → NA.
            // `scores.php` parses NA ("---") as NULL for miss count.
            row.push(d.level, d.score, d.pgreat, d.great, NA, d.lamp, d.djLevel);
          } else {
            row.push(NA, "0", "0", "0", NA, "NO PLAY", "---");
          }
        });

        row.push(NA); // 最終プレー日時 (not available on GATE)
        csvRows.push(row.join(","));
      });

    return csvRows.join("\n");
  };

  // ---------------------------------------------------------------------------
  // Helpers — IIDX ID
  // ---------------------------------------------------------------------------

  /** Strict format check for IIDX ID (XXXX-XXXX). */
  const isValidIidxId = (s: string): boolean => /^\d{4}-\d{4}$/.test(s);

  interface PlayerInfo {
    iidxId: string;
    djName: string | null;
  }

  /**
   * Fetch the player's IIDX ID and DJ NAME from GATE status.html.
   *
   * The page contains labelled rows of the form:
   *   <tr><td>IIDX ID</td><td>9277-6969</td></tr>
   *   <tr><td>DJ NAME</td><td>FOO</td></tr>
   * Regexes are anchored to the labels so we don't false-match other values.
   */
  const fetchPlayerInfoFromStatus = async (): Promise<PlayerInfo | null> => {
    try {
      const resp = await fetch(STATUS_URL, { credentials: "include" });
      if (!resp.ok) return null;
      const html = await resp.text();
      const idMatch = html.match(
        /<td[^>]*>\s*IIDX\s*ID\s*<\/td>\s*<td[^>]*>\s*(\d{4}-\d{4})\s*<\/td>/i,
      );
      if (!idMatch || !isValidIidxId(idMatch[1])) return null;
      const nameMatch = html.match(
        /<td[^>]*>\s*DJ\s*NAME\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>/i,
      );
      const djName = nameMatch ? nameMatch[1].trim() : null;
      return { iidxId: idMatch[1], djName: djName || null };
    } catch {
      return null;
    }
  };

  const saveIidxId = (id: string): void => {
    try {
      localStorage.setItem(LS_IIDX_ID_KEY, id);
    } catch {
      /* ignore */
    }
  };

  // ---------------------------------------------------------------------------
  // Helpers — upload to DEEPER
  // ---------------------------------------------------------------------------

  interface DeeperUploadResult {
    ok: boolean;
    status: number;
    body: Record<string, unknown> | null;
    raw: string;
  }

  const uploadCsvToDeeper = async (
    csv: string,
    iidxId: string,
    djName: string | null,
  ): Promise<DeeperUploadResult> => {
    const form = new FormData();
    form.append("iidx_id", iidxId);
    if (djName) form.append("dj_name", djName);
    const blob = new Blob([csv], { type: "text/csv" });
    form.append("file", blob, "deeper_dp.csv");

    const resp = await fetch(DEEPER_POST_URL, {
      method: "POST",
      body: form,
      // No credentials: DEEPER's scores.php is open (rate-limited by IP+player).
    });

    const raw = await resp.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      body = null;
    }
    return { ok: resp.ok, status: resp.status, body, raw };
  };

  /**
   * Trigger DEEPER's Voltage recalc for this player. The DEEPER SPA upload
   * flow does this after scores.php returns; the bookmarklet must do the
   * same or new players land with name=Unknown and CV/FV/SV=0.
   */
  const triggerAbilityRecalc = async (
    playerId: number,
    uploadId: number | undefined,
  ): Promise<void> => {
    const params = new URLSearchParams({
      player_id: String(playerId),
      trigger_player_id: String(playerId),
    });
    if (uploadId !== undefined) params.append("upload_id", String(uploadId));
    try {
      await fetch(
        `https://deepers.site/api/ability.php?${params.toString()}`,
        { method: "POST" },
      );
    } catch (e) {
      // Non-fatal: the score data is already imported. The Voltage just
      // won't update until someone else triggers a recalc.
      console.warn("DEEPER ability recalc failed:", e);
    }
  };

  // ---------------------------------------------------------------------------
  // Main run loop
  // ---------------------------------------------------------------------------

  const renderSuccess = (
    itemCount: number,
    pageCount: number,
    upload: DeeperUploadResult,
  ): void => {
    const banner = document.getElementById("__iidx_result_banner");
    const icon = document.getElementById("__iidx_result_icon");
    const title = document.getElementById("__iidx_result_title");
    const summary = document.getElementById("__iidx_result_summary");
    const details = document.getElementById("__iidx_result_details");

    if (banner)
      Object.assign(banner.style, {
        background: "#f0fdf4",
        border: "1px solid #bbf7d0",
      });
    if (icon) icon.textContent = "✅";
    if (title) {
      title.textContent = "DEEPERへの取り込みが完了しました";
      title.style.color = "#166534";
    }
    if (summary) {
      summary.textContent = `${itemCount}曲 / ${pageCount}ページ取得`;
      summary.style.color = "#15803d";
    }

    if (details) {
      const body = upload.body ?? {};
      const lines: string[] = [];
      if (typeof body.imported === "number") {
        lines.push(`取込済み: <strong>${body.imported}</strong> 件`);
      }
      if (typeof body.changes === "number") {
        lines.push(
          `<span style="color:#6b7280;">うち更新（ランプ/スコア向上）:</span> <strong>${body.changes}</strong> 件`,
        );
      }
      if (typeof body.songs_added === "number" && body.songs_added > 0) {
        lines.push(
          `DB に新規追加された譜面: <strong>${body.songs_added}</strong>`,
        );
      }
      if (typeof body.skipped === "number" && body.skipped > 0) {
        lines.push(
          `<span style="color:#6b7280;">未プレイ等でスキップ:</span> ${body.skipped} 件`,
        );
      }
      if (Array.isArray(body.warnings) && body.warnings.length > 0) {
        lines.push(
          `<details><summary>警告 (${body.warnings.length})</summary>${(body.warnings as string[]).slice(0, 20).join("<br>")}</details>`,
        );
      }
      details.innerHTML =
        lines.length > 0
          ? lines.join("<br>")
          : "DEEPER のレスポンスを解釈できませんでした（生レスポンスは DevTools で確認）";
    }
  };

  const renderUploadFailure = (upload: DeeperUploadResult): void => {
    const banner = document.getElementById("__iidx_result_banner");
    const icon = document.getElementById("__iidx_result_icon");
    const title = document.getElementById("__iidx_result_title");
    const summary = document.getElementById("__iidx_result_summary");
    const details = document.getElementById("__iidx_result_details");

    if (banner)
      Object.assign(banner.style, {
        background: "#fef2f2",
        border: "1px solid #fecaca",
      });
    if (icon) icon.textContent = "⚠️";
    if (title) {
      title.textContent = "DEEPER への取り込みに失敗しました";
      title.style.color = "#991b1b";
    }
    if (summary) {
      summary.textContent = `HTTP ${upload.status}`;
      summary.style.color = "#b91c1c";
    }
    if (details) {
      const err =
        (upload.body && typeof upload.body.error === "string"
          ? upload.body.error
          : null) ?? upload.raw.slice(0, 600);
      details.innerHTML = `<div style="color:#b91c1c; word-break:break-all;">${err}</div>`;
    }
  };

  const run = async (
    mode: ScrapeMode,
    iidxId: string,
    djName: string | null,
  ): Promise<void> => {
    showStep("progress");

    try {
      const levelIndices: number[] =
        mode === "all" ? [...Array(12).keys()] : [10, 11];
      const songMap: SongMap = {};
      const pageCounter = { value: 0 };

      for (const lv of levelIndices) {
        await scrapeLevel(songMap, lv, LEVEL_LABELS[lv], pageCounter);
      }

      const finalCsv = buildScoreCsv(songMap);
      const itemCount = Object.keys(songMap).length;
      const pageCount = pageCounter.value;

      // POST to DEEPER
      const statusLevel = document.getElementById("__iidx_status_level");
      if (statusLevel) statusLevel.textContent = "DEEPER に送信中...";

      const upload = await uploadCsvToDeeper(finalCsv, iidxId, djName);

      // Trigger Voltage recalc — DEEPER's SPA upload does this after the
      // import; the bookmarklet must do it too or the player's Voltage is
      // left stale (0 for new players).
      if (upload.ok && upload.body) {
        const playerId =
          typeof upload.body.player_id === "number" ? upload.body.player_id : null;
        const uploadId =
          typeof upload.body.upload_id === "number" ? upload.body.upload_id : undefined;
        if (playerId !== null) {
          if (statusLevel) statusLevel.textContent = "Voltage を再計算中...";
          await triggerAbilityRecalc(playerId, uploadId);
        }
      }

      if (upload.ok) {
        renderSuccess(itemCount, pageCount, upload);
      } else {
        renderUploadFailure(upload);
      }
      showStep("result");
    } catch (e: unknown) {
      const msgEl = document.getElementById("__iidx_err_msg");
      if (msgEl) {
        msgEl.textContent = e instanceof Error ? e.message : String(e);
      }
      showStep("error");
    }
  };

  // ---------------------------------------------------------------------------
  // Bootstrap — inject UI and wire events
  // ---------------------------------------------------------------------------

  injectStyles();
  const overlay = buildOverlay();
  document.body.appendChild(overlay);

  // Mutable state across steps.
  let resolvedIidxId: string | null = null;
  let resolvedDjName: string | null = null;

  const closeModal = (): void => {
    if (document.body.contains(overlay)) {
      document.body.removeChild(overlay);
    }
  };

  const showIidxIdError = (msg: string): void => {
    const el = document.getElementById("__iidx_err_msg");
    if (el) el.textContent = msg;
    showStep("error");
  };

  // Resolve player info: PREBAKED first, otherwise fetch from GATE status.html.
  // No manual input fallback — if GATE doesn't return an ID, the bookmarklet
  // refuses to proceed.
  const initIidxId = async (): Promise<void> => {
    if (PREBAKED_IIDX_ID && isValidIidxId(PREBAKED_IIDX_ID)) {
      resolvedIidxId = PREBAKED_IIDX_ID;
      resolvedDjName = null;
      saveIidxId(PREBAKED_IIDX_ID);
      showStep("select_score");
      return;
    }
    showStep("id_fetching");
    const info = await fetchPlayerInfoFromStatus();
    if (!info) {
      showIidxIdError(
        "GATE から IIDX ID を取得できませんでした。e-AMUSEMENT GATE にログインした状態で、いずれかの IIDX ページから実行してください。",
      );
      return;
    }
    resolvedIidxId = info.iidxId;
    resolvedDjName = info.djName;
    saveIidxId(info.iidxId);
    const idTxt = document.getElementById("__iidx_confirm_id_text");
    if (idTxt) idTxt.textContent = info.iidxId;
    const nameWrap = document.getElementById("__iidx_confirm_name_wrap");
    const nameTxt = document.getElementById("__iidx_confirm_name_text");
    if (info.djName && nameWrap && nameTxt) {
      nameTxt.textContent = info.djName;
      nameWrap.style.display = "block";
    } else if (nameWrap) {
      nameWrap.style.display = "none";
    }
    showStep("id_confirm");
  };

  void initIidxId();

  // Step: IIDX ID confirm
  (
    document.getElementById("__iidx_btn_id_confirm") as HTMLButtonElement
  ).onclick = () => showStep("select_score");

  // Step: Score range select
  (document.getElementById("__iidx_btn_back") as HTMLButtonElement).onclick =
    () => showStep(resolvedIidxId ? "id_confirm" : "id_fetching");
  (document.getElementById("__iidx_btn_all") as HTMLButtonElement).onclick =
    () => resolvedIidxId && run("all", resolvedIidxId, resolvedDjName);
  (document.getElementById("__iidx_btn_1112") as HTMLButtonElement).onclick =
    () => resolvedIidxId && run("1112", resolvedIidxId, resolvedDjName);

  // Global Actions
  (document.getElementById("__iidx_btn_x") as HTMLButtonElement).onclick =
    closeModal;
  (document.getElementById("__iidx_btn_close2") as HTMLButtonElement).onclick =
    closeModal;
  (document.getElementById("__iidx_btn_retry") as HTMLButtonElement).onclick =
    () => void initIidxId();

  // Close on backdrop click.
  overlay.addEventListener("click", (e: MouseEvent) => {
    if (e.target === overlay) closeModal();
  });
})();
