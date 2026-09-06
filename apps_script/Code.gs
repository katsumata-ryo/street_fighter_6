/**
 * SF6 バトルログ受け皿（Google Apps Script ウェブアプリ）
 *
 * Chrome 拡張から JSON を POST で受け取り、replay_id で重複を除いてシートに追記する。
 * league_point は「試合開始前」の LP なので、lp_delta は次の試合の lp_before との差で
 * 後追いで埋める（最新行は次回同期まで空欄）。
 */

// 拡張側の設定と同じ合言葉にする。
// このリポジトリは public なので、本物の値は Apps Script エディタ側だけで書き換えること。
// （スクリプトプロパティに置いてもよい: PropertiesService.getScriptProperties().getProperty('TOKEN')）
const TOKEN = 'CHANGE_ME';

const SHEET_NAME = 'battlelog';
const TIME_ZONE = 'Asia/Tokyo';

const HEADERS = [
  // 試合そのもの
  'replay_id',
  'played_at',
  'battle_type',
  'result',
  'rounds',
  // 自分
  'my_character',
  'my_input',
  'my_league_rank',
  'lp_before',
  'lp_delta',
  'my_master_rating',
  'my_round_results',
  // 相手
  'opponent',
  'opponent_sid',
  'opponent_character',
  'opponent_input',
  'opponent_league_rank',
  'opponent_lp',
  'opponent_master_rating',
  'opponent_round_results',
  'opponent_platform',
];

// round_results は "1,0,7" のような文字列。数値として解釈されないよう書式を固定する。
const TEXT_COLUMNS = ['my_round_results', 'opponent_round_results'];

const COL = HEADERS.reduce((acc, name, i) => {
  acc[name] = i;
  return acc;
}, {});

function doPost(e) {
  // 同時実行でシートが壊れないように直列化する
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    return jsonOut({ ok: false, error: '他の同期が実行中です。少し待って再実行してね' });
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonOut({ ok: false, error: 'リクエストボディが空です' });
    }

    const payload = JSON.parse(e.postData.contents);
    if (payload.token !== TOKEN) {
      return jsonOut({ ok: false, error: '合言葉が違います' });
    }

    const rows = payload.rows;
    if (!Array.isArray(rows)) {
      return jsonOut({ ok: false, error: 'rows が配列ではありません' });
    }

    const result = appendRows(rows);
    return jsonOut(Object.assign({ ok: true }, result));
  } catch (err) {
    return jsonOut({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

/** 動作確認用。ブラウザで URL を開くと reachable と返る。 */
function doGet() {
  return jsonOut({ ok: true, message: 'SF6 battlelog endpoint is alive' });
}

function appendRows(incoming) {
  const sheet = getSheet();
  const known = readKnownIds(sheet);

  // 同一ペイロード内の重複も潰しつつ、既存 replay_id を除外する
  const seen = {};
  const fresh = [];
  for (const row of incoming) {
    const id = row.replay_id;
    if (!id || known[id] || seen[id]) continue;
    seen[id] = true;
    fresh.push(row);
  }

  if (fresh.length > 0) {
    // 古い順に積むと lp_delta の計算が素直になる
    fresh.sort((a, b) => a.played_at - b.played_at);

    // lp_delta だけは受信データに無く、後段の backfill で埋める
    const values = fresh.map((row) =>
      HEADERS.map((name) => {
        if (name === 'lp_delta') return '';
        if (name === 'played_at') return new Date(row.played_at * 1000);
        return row[name] === undefined ? '' : row[name];
      })
    );

    sheet.getRange(sheet.getLastRow() + 1, 1, values.length, HEADERS.length).setValues(values);
    sortByPlayedAt(sheet);
  }

  const filled = backfillLpDelta(sheet);

  return {
    received: incoming.length,
    added: fresh.length,
    skipped: incoming.length - fresh.length,
    lp_delta_filled: filled,
  };
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // played_at は UNIX 秒から Date にして書くので、表示はシートのタイムゾーン任せになる。
  // 既定が太平洋時間だと JST から 16〜17 時間ズレて見えるため揃えておく。
  if (ss.getSpreadsheetTimeZone() !== TIME_ZONE) {
    ss.setSpreadsheetTimeZone(TIME_ZONE);
  }

  let sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }

  const lastRow = sheet.getLastRow();

  if (lastRow === 0) {
    initSheet(sheet);
    return sheet;
  }

  // 列構成が変わったまま追記すると値がズレるので、必ず突き合わせる
  const current = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (current.join('\t') !== HEADERS.join('\t')) {
    if (lastRow > 1) {
      throw new Error(
        `シート「${SHEET_NAME}」の列構成が古いままです。` +
        'シートごと削除してから同期し直してください（既存データは Buckler から取り直せます）'
      );
    }
    initSheet(sheet);
  }

  return sheet;
}

function initSheet(sheet) {
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);

  const bodyRows = sheet.getMaxRows() - 1;
  sheet.getRange(2, COL.played_at + 1, bodyRows, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  for (const name of TEXT_COLUMNS) {
    sheet.getRange(2, COL[name] + 1, bodyRows, 1).setNumberFormat('@');
  }
}

function readKnownIds(sheet) {
  const known = {};
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return known;

  const ids = sheet.getRange(2, COL.replay_id + 1, lastRow - 1, 1).getValues();
  for (const [id] of ids) {
    if (id) known[id] = true;
  }
  return known;
}

function sortByPlayedAt(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 3) return;
  sheet.getRange(2, 1, lastRow - 1, HEADERS.length)
    .sort({ column: COL.played_at + 1, ascending: true });
}

/**
 * lp_delta を埋める。
 * league_point はキャラごとに独立しているので、直後の試合が同じキャラのときだけ差分を出す。
 * 最新行は「次の試合」がまだ無いので空欄のまま（次回同期で埋まる）。
 */
function backfillLpDelta(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 3) return 0;

  const range = sheet.getRange(2, 1, lastRow - 1, HEADERS.length);
  const values = range.getValues();
  let filled = 0;

  for (let i = 0; i < values.length - 1; i++) {
    if (values[i][COL.lp_delta] !== '') continue;

    const next = values[i + 1];
    if (next[COL.my_character] !== values[i][COL.my_character]) continue;

    const before = Number(values[i][COL.lp_before]);
    const after = Number(next[COL.lp_before]);
    if (!isFinite(before) || !isFinite(after)) continue;

    values[i][COL.lp_delta] = after - before;
    filled++;
  }

  if (filled > 0) range.setValues(values);
  return filled;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
