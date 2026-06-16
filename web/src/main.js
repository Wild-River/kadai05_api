import "./style.css";
import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase.js";

const composeBgm = httpsCallable(functions, "composeBgmFromPhoto");

// 要素を取得
const fileInput = document.getElementById("photo-input");
const generateBtn = document.getElementById("generate-btn");
const status = document.getElementById("status");
const player = document.getElementById("player");
const readingText = document.getElementById("reading");

generateBtn.onclick = async () => {
  const file = fileInput.files[0];
  if (!file) {
    status.textContent = "写真を選んでください";
    return;
  }

  // 待機状態に
  generateBtn.disabled = true;
  status.textContent = "音楽を生成中…（数十秒かかります）";
  player.style.display = "none";
  readingText.textContent = "";

  try {
    // 写真を縮小して、base64という文字列形式に変換（分割代入）
    const { base64, mediaType } = await downscaleToBase64(file, 1500, 0.85);

    // サーバー側の composeBgmFromPhoto 関数を呼び出す
    const res = await composeBgm({
      imageBase64: base64,
      mediaType, //キー名と変数名が同じときは省略できる
      lengthMs: 10000,// 10秒（テスト中はクレジット節約のため短め）
    });

    const { reading, audioUrl } = res.data;

    // 結果を表示
    readingText.textContent = reading;
    player.src = audioUrl;
    player.style.display = "block";
    status.textContent = "完成しました！";
  } catch (err) {
    console.error(err);
    status.textContent = "エラー: " + err.message;
  } finally {
    generateBtn.disabled = false;
  }
};

// 画像を長辺maxまで縮小し base64 で返す
function downscaleToBase64(file, max, quality) {
  // 画像読み込みは時間がかかるので、new Promise(...) で非同期処理
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // 「ファイルが読み込めたら」動く
    reader.onload = () => {
      const img = new Image();
      // 「画像として読み込めたら」次に進む
      img.onload = () => {
        let { width, height } = img;
        if (width > max || height > max) {
          if (width >= height) { height = Math.round(height * max / width); width = max; }
          else { width = Math.round(width * max / height); height = max; }
        }
        const c = document.createElement("canvas");
        c.width = width; c.height = height;
        c.getContext("2d").drawImage(img, 0, 0, width, height);
        // キャンバスの内容をJPEG形式のbase64文字列に変換
        const dataUrl = c.toDataURL("image/jpeg", quality);
        // 読み込みが終わったら resolve（成功）
        resolve({ base64: dataUrl.split(",")[1], mediaType: "image/jpeg" });
      };
      // 失敗したら reject（失敗）
      img.onerror = () => reject(new Error("画像をデコードできませんでした。"));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error("ファイルの読み込みに失敗しました。"));
    reader.readAsDataURL(file);
  });
}