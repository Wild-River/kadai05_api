import "./style.css";
import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase.js";

const composeBgm = httpsCallable(functions, "composeBgmFromPhoto");

// 要素を取得
const fileInput = document.getElementById("photo-input");
const photoFrame = document.getElementById("photo-frame");
const photoPreview = document.getElementById("photo-preview");
const photoPlaceholder = document.getElementById("photo-placeholder");
const trackTitle = document.getElementById("track-title");
const trackComment = document.getElementById("track-comment");
const player = document.getElementById("player");

const btnPlay = document.getElementById("btn-play");
const btnBack = document.getElementById("btn-back");
const btnForward = document.getElementById("btn-forward");

const seekBar = document.getElementById("seek-bar");
const seekFill = document.getElementById("seek-fill");
const timeCurrent = document.getElementById("time-current");
const timeTotal = document.getElementById("time-total");



// コントロールボタンの有効/無効をまとめて切り替え
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

  // プレビュー表示（丸い写真に）
  const previewUrl = URL.createObjectURL(file);
  photoPreview.src = previewUrl;
  photoPreview.style.display = "block";
  photoPlaceholder.style.display = "none";

  // すぐ生成を開始
  generateBgm(file);
};

// ===== BGM生成 =====
async function generateBgm(file) {
  photoFrame.disabled = true;
  setControlsEnabled(false); // 生成中は無効
  trackTitle.textContent = "♪ 生成中…";
  trackComment.textContent = "写真から音楽を作っています（数十秒）";

  try {
    const { base64, mediaType } = await downscaleToBase64(file, 1500, 0.85);
    const res = await composeBgm({ imageBase64: base64, mediaType, lengthMs: 20000 });
    const { title, reading, audioUrl } = res.data;

    trackTitle.textContent = title || "Untitled";
    trackComment.textContent = reading || "";
    player.src = audioUrl;
    setControlsEnabled(true);           // 曲ができたら有効に
  } catch (err) {
    console.error(err);
    trackTitle.textContent = "- - -";
    trackComment.textContent = "エラーが発生しました。もう一度お試しください";
    setControlsEnabled(false);          // 失敗時は無効のまま
  } finally {
    photoFrame.disabled = false;
  }

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
  btnPlay.textContent = "❚❚";
  btnPlay.classList.add("playing");
};
player.onpause = () => {
  btnPlay.textContent = "▶";
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
  btnPlay.textContent = "▶";
  btnPlay.classList.remove("playing");
  seekFill.style.width = "0%";
};

// 秒を m:ss 形式に
function formatTime(sec) {
  if (isNaN(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// ===== 画像を長辺maxまで縮小し base64 で返す =====
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