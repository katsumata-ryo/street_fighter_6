'use strict';

const els = {
  sync: document.getElementById('sync'),
  status: document.getElementById('status'),
  settings: document.getElementById('settings'),
  endpoint: document.getElementById('endpoint'),
  token: document.getElementById('token'),
  save: document.getElementById('save'),
};

function setStatus(message, kind) {
  els.status.textContent = message;
  els.status.className = kind ? `status ${kind}` : 'status';
}

async function loadSettings() {
  const { endpoint = '', token = '' } = await chrome.storage.sync.get(['endpoint', 'token']);
  els.endpoint.value = endpoint;
  els.token.value = token;
  // 未設定なら設定パネルを開いた状態で見せる
  if (!endpoint || !token) els.settings.open = true;
  return { endpoint, token };
}

els.save.addEventListener('click', async () => {
  const endpoint = els.endpoint.value.trim();
  const token = els.token.value.trim();

  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec/.test(endpoint)) {
    setStatus('URL が Apps Script の /exec の形式ではないみたい', 'ng');
    return;
  }
  if (!token) {
    setStatus('合言葉が空だよ', 'ng');
    return;
  }

  await chrome.storage.sync.set({ endpoint, token });
  els.settings.open = false;
  setStatus('保存したよ', 'ok');
});

els.sync.addEventListener('click', async () => {
  const { endpoint, token } = await loadSettings();
  if (!endpoint || !token) {
    els.settings.open = true;
    setStatus('先に Apps Script の URL と合言葉を設定してね', 'ng');
    return;
  }

  els.sync.disabled = true;
  setStatus('取得中…');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/www\.streetfighter\.com\/6\/buckler\/.*\/battlelog\//.test(tab.url || '')) {
      throw new Error('Buckler のバトルログのページで実行してね');
    }

    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectFromPage,
    });

    const collected = injected && injected.result;
    if (!collected) throw new Error('ページからデータを取得できなかった');
    if (collected.error) throw new Error(collected.error);

    const rows = collected.rows;
    if (rows.length === 0) throw new Error('取得できた試合が0件だった');

    setStatus(`${rows.length}件を取得。シートに送信中…`);

    const res = await fetch(endpoint, {
      method: 'POST',
      // text/plain にしておくと CORS のプリフライトが飛ばない
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token, rows }),
    });

    if (!res.ok) throw new Error(`シートへの送信に失敗 (HTTP ${res.status})`);

    const body = await res.json();
    if (!body.ok) throw new Error(body.error || 'シート側でエラーが起きた');

    setStatus(
      `✅ ${body.added}件を追記（既存 ${body.skipped}件はスキップ）\nLP増減を${body.lp_delta_filled}件ぶん確定`,
      'ok'
    );
  } catch (err) {
    setStatus(`❌ ${err.message}`, 'ng');
  } finally {
    els.sync.disabled = false;
  }
});

/**
 * ページ側で実行される。ログイン済みセッションをそのまま使えるので、
 * 認証情報を扱う必要がない。返り値は JSON 化できる形だけにすること。
 */
async function collectFromPage() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value || '').replace(/^\[t\]/, '');

  try {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return { error: '__NEXT_DATA__ が見つからない。ページを再読み込みしてみて' };

    const data = JSON.parse(el.textContent);
    const first = data.props && data.props.pageProps;
    if (!first) return { error: 'pageProps が読めなかった' };

    const login = first.common && first.common.loginUser;
    if (!login || !login.flg) return { error: 'ログインしてないみたい。ログインしてから再実行してね' };

    const sid = first.sid;
    if (!sid) return { error: 'sid が読めなかった。バトルログのページで実行してね' };

    const mode = (location.pathname.match(/\/battlelog\/([^/?#]+)/) || [])[1];
    if (!mode) return { error: 'バトルログのページで実行してね' };

    // pageProps の直下にページャ情報が無いページ構成なので、total_page には頼らず
    // 「空 or 1ページ未満の件数が返ったら終わり」で打ち切る。
    const PAGE_SIZE = 10;
    const MAX_PAGES = 200; // 無限ループ避けの保険
    const replays = [];
    let totalPage = null;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url =
        `${data.assetPrefix}/_next/data/${data.buildId}/${data.locale}` +
        `/profile/${sid}/battlelog/${mode}.json?sid=${sid}&page=${page}`;

      const res = await fetch(url, {
        headers: { 'x-nextjs-data': '1' },
        credentials: 'same-origin',
      });
      if (!res.ok) {
        // 1ページ目でコケたら何も取れていないので失敗扱い、
        // 途中でコケたぶんはそこまでの結果を活かす
        if (page === 1) return { error: `1ページ目の取得に失敗 (HTTP ${res.status})` };
        break;
      }

      const json = await res.json();
      const props = json.pageProps || {};
      const list = props.replay_list;

      if (!Array.isArray(list) || list.length === 0) break;
      replays.push(...list);

      if (totalPage === null && Number.isFinite(Number(props.total_page))) {
        totalPage = Number(props.total_page);
      }
      if (totalPage !== null && page >= totalPage) break;
      if (list.length < PAGE_SIZE) break;

      await sleep(300); // 連打しないための間隔
    }

    if (replays.length === 0) return { error: '試合が1件も取得できなかった' };

    const rows = replays.map((replay) => {
      const p1 = replay.player1_info;
      const p2 = replay.player2_info;
      const mine = p1.player.short_id === sid ? p1 : p2;
      const theirs = p1.player.short_id === sid ? p2 : p1;

      // round_results は 0 以外がそのラウンドを取ったことを表す（値の違いは決着の種類）
      const myRounds = mine.round_results.filter((v) => v !== 0).length;
      const theirRounds = theirs.round_results.filter((v) => v !== 0).length;

      return {
        replay_id: replay.replay_id,
        played_at: replay.uploaded_at,
        battle_type: clean(replay.replay_battle_type_name),
        result: myRounds > theirRounds ? 'WIN' : 'LOSE',
        rounds: `${myRounds}-${theirRounds}`,

        my_character: mine.playing_character_name,
        my_input: clean(mine.battle_input_type_name),
        my_league_rank: mine.league_rank,
        lp_before: mine.league_point,
        my_master_rating: mine.master_rating,
        // 値の意味（KO/パーフェクト/時間切れ等）は未解明なので生のまま残す
        my_round_results: mine.round_results.join(','),

        opponent: theirs.player.fighter_id,
        opponent_sid: theirs.player.short_id,
        opponent_character: theirs.playing_character_name,
        opponent_input: clean(theirs.battle_input_type_name),
        opponent_league_rank: theirs.league_rank,
        opponent_lp: theirs.league_point,
        opponent_master_rating: theirs.master_rating,
        opponent_round_results: theirs.round_results.join(','),
        opponent_platform: theirs.player.platform_name,
      };
    });

    return { sid, rows };
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) };
  }
}

loadSettings();
