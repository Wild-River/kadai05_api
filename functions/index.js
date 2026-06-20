const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getStorage } = require("firebase-admin/storage");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto");

initializeApp();
const db = getFirestore(); //Firestore
const bucket = getStorage().bucket(); //Storage

// シークレット定義（デプロイ時に firebase functions:secrets:set で登録）
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const ELEVENLABS_API_KEY = defineSecret("ELEVENLABS_API_KEY");

/**
 * Claude（vision）に写真を渡し、写真の雰囲気に合った音楽生成用の情報を作る。
 * 曲名・雰囲気の説明・ElevenLabs用プロンプト・インスト判定をJSONで受け取る。
 * @param {string} base64 - 画像のbase64データ（プレフィックスなし）
 * @param {string} mediaType - 画像のMIMEタイプ（例: "image/jpeg"）
 * @param {string} apiKey - Anthropic APIキー
 * @returns {Promise<{title: string, reading: string, prompt: string, instrumental: boolean}>}
 *   Claudeが生成した音楽メタ情報
 * @throws {HttpsError} Claude APIエラー、またはJSON解析に失敗した場合
 */
async function generateMusicPrompt(base64, mediaType, apiKey) {
    const instruction =
        "You are a music director who translates the atmosphere of a photograph " +
        "into a prompt for a text-to-music AI (ElevenLabs Music). " +
        "Respond with ONLY a JSON object, no markdown, no preamble. Keys: " +
        '"title" (a short, evocative song title that fits the mood — Japanese or English, whichever suits the photo better. If Japanese, max 10 characters; if English, max 20 characters), ' +
        '"reading" (a short Japanese sentence describing the mood, for the user to read), ' +
        '"prompt" (an English comma-separated music prompt: genre, instruments, tempo in BPM, ' +
        "key/chord feel, and mood — suitable for ElevenLabs Music, under 600 characters), " +
        '"instrumental" (boolean: true if the scene calls for instrumental-only). ' +
        "Base every choice on concrete visual evidence: color, time of day, light, subject, emotion.";

    const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
            model: "claude-sonnet-4-5",
            max_tokens: 1000,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
                        { type: "text", text: instruction },
                    ],
                },
            ],
        }),
    });

    if (!res.ok) {
        const detail = await res.text();
        throw new HttpsError("internal", `Claude API error ${res.status}: ${detail.slice(0, 200)}`);
    }

    const data = await res.json();
    const text = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");

    const clean = text.replace(/```json|```/g, "").trim();
    let parsed;
    try {
        parsed = JSON.parse(clean);
    } catch {
        const s = clean.indexOf("{");
        const e = clean.lastIndexOf("}");
        if (s !== -1 && e !== -1) parsed = JSON.parse(clean.slice(s, e + 1));
        else throw new HttpsError("internal", "音楽プロンプトの解析に失敗しました。");
    }
    return parsed; // { reading, prompt, instrumental }
}

/**
 * ElevenLabs Music APIにプロンプトを渡し、音楽を生成して音声バイナリを得る。
 * @param {string} prompt - 音楽生成用の英語プロンプト
 * @param {boolean} instrumental - true ならインストゥルメンタルのみで生成
 * @param {number} lengthMs - 曲の長さ（ミリ秒）
 * @param {string} apiKey - ElevenLabs APIキー
 * @returns {Promise<{buffer: Buffer, songId: (string|null)}>}
 *   生成された音声データと、ElevenLabs側の曲ID
 * @throws {HttpsError} ElevenLabs APIエラーの場合
 */
async function generateMusic(prompt, instrumental, lengthMs, apiKey) {
    const res = await fetch("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "xi-api-key": apiKey,
        },
        body: JSON.stringify({
            prompt: prompt,
            music_length_ms: lengthMs,
            force_instrumental: instrumental === true,
            model_id: "music_v1",
        }),
    });

    if (!res.ok) {
        const detail = await res.text();
        throw new HttpsError("internal", `ElevenLabs API error ${res.status}: ${detail.slice(0, 200)}`);
    }

    const songId = res.headers.get("song-id") || null;
    const arrayBuffer = await res.arrayBuffer(); // 音声バイナリが直接返る
    return { buffer: Buffer.from(arrayBuffer), songId };
}

/**
 * 音声バイナリをFirebase Storageに保存し、再生用の公開URLを返す。
 * ダウンロードトークンを付与して保存するため、署名URLなしで再生できる。
 * @param {Buffer} buffer - 保存する音声データ
 * @param {(string|null)} uid - 保存先を分けるためのユーザーID（未ログインなら "anon"）
 * @returns {Promise<{url: string, path: string}>}
 *   再生用の公開URLと、Storage上の保存パス
 */
async function saveToStorage(buffer, uid) {
    const id = crypto.randomUUID();
    const path = `bgm/${uid || "anon"}/${id}.mp3`;
    const file = bucket.file(path);

    // ダウンロードトークン付きで保存（署名URL不要で公開再生できる）
    const token = crypto.randomUUID();
    await file.save(buffer, {
        metadata: {
            contentType: "audio/mpeg",
            metadata: { firebaseStorageDownloadTokens: token },
        },
    });

    const encodedPath = encodeURIComponent(path);
    const url =
        `https://firebasestorage.googleapis.com/v0/b/${bucket.name}` +
        `/o/${encodedPath}?alt=media&token=${token}`;
    return { url, path };
}

/**
 * 画像（base64）をFirebase Storageに保存し、公開URLを返す。
 * ジャケット画像として一覧に表示するために使う。
 * @param {string} base64 - 画像のbase64データ（プレフィックスなし）
 * @param {string} mediaType - 画像のMIMEタイプ（例: "image/jpeg"）
 * @param {(string|null)} uid - 保存先を分けるためのユーザーID
 * @returns {Promise<{url: string, path: string}>} 画像の公開URLと保存パス
 */
async function saveImageToStorage(base64, mediaType, uid) {
    const id = crypto.randomUUID();
    const ext = "jpg"; //フロントの downscaleToBase64で、どんな画像もcanvasでJPEGに変換
    const path = `covers/${uid || "anon"}/${id}.${ext}`;
    const file = bucket.file(path);

    const token = crypto.randomUUID();
    const buffer = Buffer.from(base64, "base64");   // base64をバイナリに戻す
    await file.save(buffer, {
        metadata: {
            contentType: mediaType,
            metadata: { firebaseStorageDownloadTokens: token },
        },
    });

    const encodedPath = encodeURIComponent(path);
    const url =
        `https://firebasestorage.googleapis.com/v0/b/${bucket.name}` +
        `/o/${encodedPath}?alt=media&token=${token}`;
    return { url, path };
}

/**
 * 写真からBGMを生成するメインのCallable関数。
 * フロントから { imageBase64, mediaType, lengthMs } を受け取り、
 * 写真 → Claude（プロンプト生成）→ ElevenLabs（音楽生成）→ Storage（保存）
 * の順に処理して、曲名・コメント・再生URLなどを返す。
 * @returns {Promise<object>} title, reading, prompt, instrumental, audioUrl, storagePath, songId を含むオブジェクト
 * @throws {HttpsError} 画像データが無い場合、または各API処理で失敗した場合
 */
exports.composeBgmFromPhoto = onCall(
    {
        region: "asia-northeast1", // 東京リージョン
        secrets: [ANTHROPIC_API_KEY, ELEVENLABS_API_KEY],
        timeoutSeconds: 300, // 音楽生成の待ち時間を考慮
        memory: "512MiB",
    },
    async (request) => {
        const { imageBase64, mediaType, lengthMs } = request.data || {};

        if (!imageBase64 || !mediaType) {
            throw new HttpsError("invalid-argument", "画像データが必要です。");
        }

        // lengthMsを10000〜30000msの範囲に収める（未指定・異常値は20000にフォールバック）。
        // Math.max で下限10秒を保証し、Math.min で上限30秒を保証する。
        const safeLength = Math.min(Math.max(Number(lengthMs) || 20000, 10000), 30000);

        const uid = request.auth?.uid || null;

        // ① プロンプト生成
        const meta = await generateMusicPrompt(imageBase64, mediaType, ANTHROPIC_API_KEY.value());

        // ② 音楽生成
        const { buffer, songId } = await generateMusic(
            meta.prompt,
            meta.instrumental,
            safeLength,
            ELEVENLABS_API_KEY.value()
        );

        // ③ 保存
        const { url, path } = await saveToStorage(buffer, uid);
        const cover = await saveImageToStorage(imageBase64, mediaType, uid);

        let docId = null;
        try {
            const docRef = await db.collection("generated_music").add({
                uid,
                title: meta.title,
                reading: meta.reading,
                prompt: meta.prompt,
                instrumental: meta.instrumental === true,
                audioUrl: url,
                storagePath: path,
                coverUrl: cover.url,        // 追加：ジャケット画像URL
                coverPath: cover.path,      // 追加：画像の保存パス
                songId,
                createdAt: FieldValue.serverTimestamp(),
            });
            docId = docRef.id;
        } catch (e) {
            console.error("Firestore保存に失敗:", e);
            // 保存は失敗しても、生成した音楽は返す（ライブラリに残らないだけ）
        }

        return {
            id: docId,
            title: meta.title,
            reading: meta.reading,
            prompt: meta.prompt,
            instrumental: meta.instrumental === true,
            audioUrl: url,
            storagePath: path,
            coverUrl: cover.url,
            songId,
        };
    }
);

