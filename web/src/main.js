import "./style.css";
import { httpsCallable } from "firebase/functions";
import { functions, db } from "./firebase.js";
import { collection, getDocs, query, orderBy } from "firebase/firestore";

const composeBgm = httpsCallable(functions, "composeBgmFromPhoto");

// 要素を取得
const fileInput = document.getElementById("photo-input");
const photoFrame = document.getElementById("photo-frame");
const photoPreview = document.getElementById("photo-preview");
const photoPlaceholder = document.getElementById("photo-placeholder");
const trackTitle = document.getElementById("track-title");
const trackComment = document.getElementById("track-comment");
const player = document.getElementById("player");
const photoInner = document.querySelector(".photo-inner");

const btnPlay = document.getElementById("btn-play");
const btnBack = document.getElementById("btn-back");
const btnForward = document.getElementById("btn-forward");

const seekBar = document.getElementById("seek-bar");
const seekFill = document.getElementById("seek-fill");
const timeCurrent = document.getElementById("time-current");
const timeTotal = document.getElementById("time-total");

const generateMusic = document.getElementById("generated-music");

/**
 * 3つのコントロールボタン（再生・戻る・進む）の有効/無効をまとめて切り替える。
 * @param {boolean} enabled - true で有効（押せる）、false で無効（押せない）
 * @returns {void}
 */
function setControlsEnabled(enabled) {
  btnPlay.disabled = !enabled;
  btnBack.disabled = !enabled;
  btnForward.disabled = !enabled;
}
setControlsEnabled(false);   // 最初は押せない

// ===== 写真を選ぶ =====
photoFrame.onclick = () => fileInput.click();

fileInput.onchange = () => {
  const file = fileInput.files[0];
  if (!file) return;

  // プレビューを薄く表示（水アニメの下に）
  const previewUrl = URL.createObjectURL(file);
  photoPreview.src = previewUrl;
  photoPlaceholder.style.display = "none";

  generateBgm(file);
};

/**
 * 写真からBGMを生成する一連の処理。
 * 画像を縮小 → Cloud Functions（composeBgm）を呼び出し →
 * 返ってきた曲名・コメント・音声URLを画面に反映する。
 * 生成中・成功・失敗それぞれでボタンの有効状態を切り替える。
 * @param {File} file - ユーザーが選択した画像ファイル
 * @returns {Promise<void>} 生成と表示が完了すると解決する
 */
async function generateBgm(file) {
  photoFrame.disabled = true;
  setControlsEnabled(false); // 生成中は無効
  photoInner.classList.add("generating");   // 水アニメ開始

  // 満ちきったタイミングで filled を付ける（気泡が出る）
  const fillTime = 18000;  // CSSの fillUp の秒数に合わせる
  const fillTimer = setTimeout(() => {
    photoInner.classList.add("filled");
  }, fillTime);

  setBouncingText(trackTitle, "♪ 生成中…");
  trackComment.textContent = "写真から音楽を作っています（数十秒）";

  try {
    // ===== テストモード（クレジット消費なし）=====
    // await new Promise(resolve => setTimeout(resolve, fillTime));  // 指定秒待つ
    // trackTitle.textContent = "テスト曲名";
    // trackComment.textContent = "アニメーション確認用のダミーです";

    // ===== 本番モード（クレジット消費あり）=====
    const { base64, mediaType } = await downscaleToBase64(file, 1500, 0.85);
    const res = await composeBgm({ imageBase64: base64, mediaType, lengthMs: 20000 });
    const { title, reading, audioUrl } = res.data;

    trackTitle.textContent = title || "Untitled";
    trackComment.textContent = reading || "";
    player.src = audioUrl;
    setControlsEnabled(true);   // 曲ができたら有効に
    await showGeneratedMusic(); // Firestoreから一覧を再取得
  } catch (err) {
    console.error(err);
    trackTitle.textContent = "- - -";
    trackComment.textContent = "エラーが発生しました。もう一度お試しください";
    setControlsEnabled(false);          // 失敗時は無効のまま
  } finally {
    clearTimeout(fillTimer);
    photoFrame.disabled = false;
    photoInner.classList.remove("generating");   // 水アニメ終了
    photoInner.classList.remove("filled");
    photoPreview.style.display = "block";          // 写真をはっきり表示
  }
}

/**
 * 文字列を1文字ずつ<span>に分け、順番に跳ねるアニメーションを付けて表示する。
 * @param {HTMLElement} el - 表示先の要素
 * @param {string} text - 表示する文字列
 */
function setBouncingText(el, text) {
  el.innerHTML = "";   // 一旦空に
  [...text].forEach((char, i) => {
    const span = document.createElement("span");
    span.className = "bounce-char";
    span.textContent = char;
    span.style.animationDelay = `${i * 0.08}s`;   // 1文字ずつ遅らせる
    el.appendChild(span);
  });
}

// ===== 再生・ポーズ =====
btnPlay.onclick = () => {
  if (!player.src) return;
  if (player.paused) {
    player.play();
  } else {
    player.pause();
  }
};

// 再生状態に合わせてボタンの見た目を変える
player.onplay = () => {
  btnPlay.classList.add("playing");
};
player.onpause = () => {
  btnPlay.classList.remove("playing");
};

// ===== 10秒スキップ =====
btnBack.onclick = () => {
  if (!player.src) return;
  player.currentTime = Math.max(0, player.currentTime - 10);
};
btnForward.onclick = () => {
  if (!player.src) return;
  player.currentTime = Math.min(player.duration, player.currentTime + 10);
};

// ===== 再生バーの連動 =====
player.ontimeupdate = () => {
  if (!player.duration) return;
  const percent = (player.currentTime / player.duration) * 100;
  seekFill.style.width = percent + "%";
  timeCurrent.textContent = formatTime(player.currentTime);
};

player.onloadedmetadata = () => {
  timeTotal.textContent = formatTime(player.duration);
};

// 再生バーをクリックしてシーク
seekBar.onclick = (e) => {
  if (!player.duration) return;
  const rect = seekBar.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  player.currentTime = ratio * player.duration;
};

// 曲が終わったら
player.onended = () => {
  btnPlay.classList.remove("playing");
  seekFill.style.width = "0%";
};

/**
 * 秒数を「分:秒」形式（m:ss）の文字列に変換する。
 * @param {number} sec - 秒数（小数を含む場合あり）
 * @returns {string} "1:05" のような形式。NaN のときは "0:00"
 */
function formatTime(sec) {
  if (isNaN(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

/**
 * 画像ファイルを長辺max px以内に縮小し、base64文字列で返す。
 * canvasに描画し直すため、元画像のEXIF（GPS位置情報・撮影日時など）は
 * この時点で自動的に除去される（プライバシー保護）。
 * @param {File} file - 変換対象の画像ファイル
 * @param {number} max - 長辺の最大ピクセル数（例: 1500）
 * @param {number} quality - JPEG品質（0〜1、例: 0.85）
 * @returns {Promise<{base64: string, mediaType: string}>} base64データとMIMEタイプ
 */
function downscaleToBase64(file, max, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > max || height > max) {
          if (width >= height) { height = Math.round(height * max / width); width = max; }
          else { width = Math.round(width * max / height); height = max; }
        }
        const c = document.createElement("canvas");
        c.width = width; c.height = height;
        c.getContext("2d").drawImage(img, 0, 0, width, height);
        const dataUrl = c.toDataURL("image/jpeg", quality);
        resolve({ base64: dataUrl.split(",")[1], mediaType: "image/jpeg" });
      };
      img.onerror = () => reject(new Error("画像をデコードできませんでした。"));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error("ファイルの読み込みに失敗しました。"));
    reader.readAsDataURL(file);
  });
}

/**
 * Firestoreから生成済みの音楽を新しい順に取得し、一覧として表示する。
 * 各カードをクリックすると、その曲を再生する。
 * @returns {Promise<void>}
 */
async function showGeneratedMusic() {
  const q = query(
    collection(db, "generated_music"),
    orderBy("createdAt", "desc")
  );

  const snapshot = await getDocs(q);

  if (snapshot.empty) {
    generateMusic.innerHTML = "<p>まだ音楽がありません</p>";
    return;
  }

  generateMusic.innerHTML = "";

  snapshot.forEach((doc) => {
    const data = doc.data();

    const item = document.createElement("div");
    item.className = "music-card";

    item.innerHTML = /*html*/`
        <img class="music-cover" src="${data.coverUrl || ''}" alt="">
        <div class="music-info">
          <h3>${data.title}</h3>
          <p>${data.reading}</p>
        </div>
    `;

    item.addEventListener("click", () => {
      player.src = data.audioUrl;
      trackTitle.textContent = data.title;
      trackComment.textContent = data.reading;
      if (data.coverUrl) {
        photoPreview.src = data.coverUrl;
        photoPreview.style.display = "block";
        photoPlaceholder.style.display = "none";
      }
      player.play();
    })

    generateMusic.appendChild(item);
  })
}

showGeneratedMusic();